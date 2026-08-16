/**
 * Unit tests for pure utility functions in utils.ts
 */

import { describe, it, expect } from 'vitest';
import { transformContentUrl, injectContentSecurityPolicy, computePlaylistSignature, shouldApplyContent, parseCrashLoopMarker } from './utils';
import { scrubUrl, scrubBreadcrumb, scrubEvent, crashReportingOptions } from './crash-reporting';

describe('scrubUrl (F51 — Sentry credential scrubbing)', () => {
  it('strips a token query param entirely', () => {
    expect(scrubUrl('https://api.vizora.io/dev-content/1/file?token=secret-jwt')).toBe(
      'https://api.vizora.io/dev-content/1/file',
    );
  });

  it('strips token but preserves other query params', () => {
    const out = scrubUrl('https://api.vizora.io/file?w=100&token=secret-jwt&h=50');
    expect(out).not.toContain('secret-jwt');
    expect(out).toContain('w=100');
    expect(out).toContain('h=50');
  });

  it('strips a capital-case token param (case-insensitive)', () => {
    expect(scrubUrl('https://api.vizora.io/file?Token=secret-jwt')).not.toContain('secret-jwt');
    expect(scrubUrl('https://api.vizora.io/file?TOKEN=secret-jwt')).not.toContain('secret-jwt');
    expect(scrubUrl('https://api.vizora.io/file?w=1&Token=secret-jwt')).toContain('w=1');
  });

  it('is a no-op for URLs without a token', () => {
    expect(scrubUrl('https://api.vizora.io/file?w=100')).toBe('https://api.vizora.io/file?w=100');
  });

  it('does not throw on a non-URL string', () => {
    expect(() => scrubUrl('not-a-url token=secret')).not.toThrow();
  });

  it('handles empty input', () => {
    expect(scrubUrl('')).toBe('');
  });
});

// ============================================================================
// S2: the Sentry scrubbers cover free TEXT, not only structured URL fields
// ============================================================================
//
// Bound to crashReportingOptions() — the object initCrashReporting() actually hands
// to Sentry.init — rather than to the exported functions on their own. A test that
// imports `scrubEvent` and exercises it proves a function works; it does not prove
// that function is the one installed. `import.meta.env.VITE_SENTRY_DSN` is replaced
// at build time, so a test cannot make Sentry.init run at all; the factory is the
// construction site the assertion can still reach.

describe('Sentry scrubbing (S2 — free-text paths)', () => {
  const opts = crashReportingOptions('https://key@o0.ingest.sentry.io/1');
  const TOKENED = 'https://api.vizora.io/dev-content/9/file?token=eyJhbGciOi.SECRET.sig';

  it('installs the scrubbers on the options handed to Sentry.init', () => {
    expect(typeof opts.beforeBreadcrumb).toBe('function');
    expect(typeof opts.beforeSend).toBe('function');
    expect(opts.beforeBreadcrumb).toBe(scrubBreadcrumb);
    expect(opts.beforeSend).toBe(scrubEvent);
  });

  it('scrubs breadcrumb.message — where the console integration puts a logged URL', () => {
    // Sentry's default integrations capture console output verbatim. This client logs
    // asset URLs through console.warn/console.error on failure paths, so a single
    // `console.error('… ' + urlWithToken)` shipped the device JWT while the structured
    // data.url beside it was spotless.
    const out = opts.beforeBreadcrumb!(
      { category: 'console', level: 'error', message: `[Vizora] Content failed: ${TOKENED}` },
      {},
    );
    expect(out!.message).not.toContain('SECRET');
    expect(out!.message).toContain('/dev-content/9/file'); // still diagnosable
  });

  it('scrubs event.message — the payload of every reportEvent/captureMessage', () => {
    const out = opts.beforeSend!(
      { message: `pullContent failed for ${TOKENED}` } as Parameters<NonNullable<typeof opts.beforeSend>>[0],
      {},
    ) as { message: string };
    expect(out.message).not.toContain('SECRET');
  });

  it('scrubs event.exception.values[].value — where a thrown Error puts the URL', () => {
    const out = opts.beforeSend!(
      {
        exception: {
          values: [
            { type: 'TypeError', value: `Failed to fetch ${TOKENED}` },
            { type: 'Error', value: `retry of ${TOKENED} failed` },
          ],
        },
      } as Parameters<NonNullable<typeof opts.beforeSend>>[0],
      {},
    ) as { exception: { values: Array<{ value: string }> } };
    // Cardinality first: the loop below asserts nothing at all if scrubEvent ever
    // returns an empty (or dropped) values array, and a vacuous loop reports green.
    // The count is production output, so it has to be pinned before it is iterated.
    expect(out.exception.values).toHaveLength(2);
    for (const v of out.exception.values) {
      expect(v.value).not.toContain('SECRET');
    }
  });

  it('still scrubs the structured fields it always covered', () => {
    const bc = opts.beforeBreadcrumb!(
      { category: 'navigation', data: { url: TOKENED, to: TOKENED, from: TOKENED } },
      {},
    );
    const data = bc!.data as Record<string, string>;
    expect(`${data.url}${data.to}${data.from}`).not.toContain('SECRET');

    const ev = opts.beforeSend!(
      {
        request: { url: TOKENED, headers: { Authorization: 'Bearer eyJ.SECRET.sig', 'X-Trace': 'keep-me' } },
      } as Parameters<NonNullable<typeof opts.beforeSend>>[0],
      {},
    ) as { request: { url: string; headers: Record<string, string> } };
    expect(ev.request.url).not.toContain('SECRET');
    expect(ev.request.headers.Authorization).toBe('REDACTED');
    expect(ev.request.headers['X-Trace']).toBe('keep-me');
  });

  it('NEGATIVE CONTROL: token-free text is passed through unchanged', () => {
    // Proves the scrubbers are not just blanking every string they are handed —
    // an event body that has been emptied is as useless as one that leaked.
    const msg = '[Vizora] playback_holding reason=no_renderable_content playlistId=pl-7';
    const bc = opts.beforeBreadcrumb!({ category: 'console', message: msg }, {});
    expect(bc!.message).toBe(msg);
    const ev = opts.beforeSend!(
      { message: msg, exception: { values: [{ value: 'boom, no url here' }] } } as Parameters<NonNullable<typeof opts.beforeSend>>[0],
      {},
    ) as { message: string; exception: { values: Array<{ value: string }> } };
    expect(ev.message).toBe(msg);
    expect(ev.exception.values[0].value).toBe('boom, no url here');
  });
});

describe('computePlaylistSignature (PD-1 playback idempotency)', () => {
  const P = (id: string, items: Array<{ contentId: string; order: number; duration: number }>) => ({ id, items });

  it('is stable for the same content — a redundant re-send is a no-op', () => {
    const a = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }, { contentId: 'c2', order: 1, duration: 20 }]);
    const b = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }, { contentId: 'c2', order: 1, duration: 20 }]);
    expect(computePlaylistSignature(a)).toBe(computePlaylistSignature(b));
  });

  describe('PD-7 — in-place content edit must change the signature (not absorbed as a no-op)', () => {
    // Same contentId + order + duration + url, but the content was edited
    // (template re-render / file replacement) → updatedAt bumps. The reconnect
    // re-push is the ONLY delivery path for edits, so the signature MUST differ or
    // "edit the sign → device updates" never heals.
    it('a bumped content.updatedAt changes the signature', () => {
      const before = { id: 'pl-1', items: [{ contentId: 'c1', order: 0, duration: 10, content: { updatedAt: '2026-07-04T10:00:00Z' } }] };
      const after = { id: 'pl-1', items: [{ contentId: 'c1', order: 0, duration: 10, content: { updatedAt: '2026-07-04T11:30:00Z' } }] };
      expect(computePlaylistSignature(before)).not.toBe(computePlaylistSignature(after));
    });

    it('same content + same updatedAt is still a no-op (idempotency preserved)', () => {
      const a = { id: 'pl-1', items: [{ contentId: 'c1', order: 0, duration: 10, content: { updatedAt: '2026-07-04T10:00:00Z' } }] };
      const b = { id: 'pl-1', items: [{ contentId: 'c1', order: 0, duration: 10, content: { updatedAt: '2026-07-04T10:00:00Z' } }] };
      expect(computePlaylistSignature(a)).toBe(computePlaylistSignature(b));
    });

    it('is backward-compatible with payloads lacking updatedAt (undefined → stable empty discriminator)', () => {
      const a = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }]);
      const b = { id: 'pl-1', items: [{ contentId: 'c1', order: 0, duration: 10, content: null }] };
      expect(computePlaylistSignature(a)).toBe(computePlaylistSignature(b));
    });
  });

  it('a STRANDED device (empty/null current) never matches a real playlist — it re-renders', () => {
    const real = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }]);
    expect(computePlaylistSignature(null)).toBe('');
    expect(computePlaylistSignature(P('pl-1', []))).toBe('');
    expect(computePlaylistSignature(real)).not.toBe(computePlaylistSignature(null));
    expect(computePlaylistSignature(real)).not.toBe(''); // '' guard means holding→render
  });

  it('an EDITED playlist (same id, changed items) has a different signature — it re-renders', () => {
    const base = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }]);
    expect(computePlaylistSignature(base)).not.toBe(
      computePlaylistSignature(P('pl-1', [{ contentId: 'c1', order: 0, duration: 15 }])), // duration changed
    );
    expect(computePlaylistSignature(base)).not.toBe(
      computePlaylistSignature(P('pl-1', [{ contentId: 'c2', order: 0, duration: 10 }])), // content swapped
    );
    expect(computePlaylistSignature(P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }, { contentId: 'c2', order: 1, duration: 10 }]))).not.toBe(
      computePlaylistSignature(P('pl-1', [{ contentId: 'c2', order: 0, duration: 10 }, { contentId: 'c1', order: 1, duration: 10 }])), // reorder
    );
  });

  it('a DIFFERENT playlist id has a different signature', () => {
    const items = [{ contentId: 'c1', order: 0, duration: 10 }];
    expect(computePlaylistSignature(P('pl-1', items))).not.toBe(computePlaylistSignature(P('pl-2', items)));
  });
});

describe('transformContentUrl', () => {
  const API = 'https://api.vizora.io';

  it('prepends apiUrl to relative URLs', () => {
    expect(transformContentUrl('/api/v1/content/123/file', API)).toBe(
      'https://api.vizora.io/api/v1/content/123/file',
    );
  });

  it('strips trailing slash from apiUrl when prepending', () => {
    expect(transformContentUrl('/image.png', 'https://api.vizora.io/')).toBe(
      'https://api.vizora.io/image.png',
    );
  });

  it('rewrites localhost to 10.0.2.2 when apiUrl is localhost', () => {
    const result = transformContentUrl(
      'http://localhost:3000/api/v1/content/file',
      'http://localhost:3000',
    );
    expect(result).toContain('10.0.2.2');
    expect(result).not.toContain('localhost');
  });

  it('rewrites 127.0.0.1 to 10.0.2.2 when apiUrl is localhost', () => {
    const result = transformContentUrl(
      'http://127.0.0.1:3000/file.png',
      'http://localhost:3000',
    );
    expect(result).toContain('10.0.2.2');
  });

  it('replaces localhost URLs with apiUrl for production', () => {
    const result = transformContentUrl(
      'http://localhost:9000/bucket/file.png',
      API,
    );
    expect(result).toBe('https://api.vizora.io/bucket/file.png');
  });

  it('appends token only for same-origin URLs', () => {
    const result = transformContentUrl('/image.png', API, 'my-token');
    expect(result).toContain('token=my-token');
    expect(result).toBe('https://api.vizora.io/image.png?token=my-token');
  });

  it('does NOT append token for third-party URLs', () => {
    const result = transformContentUrl(
      'https://cdn.example.com/image.png',
      API,
      'my-token',
    );
    expect(result).not.toContain('token=');
    expect(result).toBe('https://cdn.example.com/image.png');
  });

  it('does not append token when token is null', () => {
    const result = transformContentUrl('/image.png', API, null);
    expect(result).not.toContain('token=');
  });

  it('returns empty string for empty url', () => {
    expect(transformContentUrl('', API)).toBe('');
  });

  it('encodes token value in query param', () => {
    const result = transformContentUrl('/file', API, 'tok en+special');
    expect(result).toContain('token=tok%20en%2Bspecial');
  });

  it('uses & separator when URL already has query params', () => {
    const result = transformContentUrl('/file?w=100', API, 'tok');
    expect(result).toBe('https://api.vizora.io/file?w=100&token=tok');
  });

  it('appends token when content URL has www but apiUrl does not', () => {
    const result = transformContentUrl(
      'https://www.api.vizora.io/api/v1/device-content/123/file',
      API,
      'my-token',
    );
    expect(result).toContain('token=my-token');
  });

  it('appends token when apiUrl has www but content URL does not', () => {
    const result = transformContentUrl(
      '/api/v1/device-content/123/file',
      'https://www.api.vizora.io',
      'my-token',
    );
    expect(result).toContain('token=my-token');
  });
});

describe('injectContentSecurityPolicy', () => {
  const CSP_PREFIX = '<meta http-equiv="Content-Security-Policy"';

  it('injects CSP after <head> tag', () => {
    const html = '<html><head><title>Test</title></head><body></body></html>';
    const result = injectContentSecurityPolicy(html);
    expect(result).toContain('<head>' + '<meta http-equiv="Content-Security-Policy"');
    expect(result).toContain('<title>Test</title>');
  });

  it('wraps with <head> when only <html> exists', () => {
    const html = '<html><body>Hello</body></html>';
    const result = injectContentSecurityPolicy(html);
    expect(result).toContain('<html><head>');
    expect(result).toContain(CSP_PREFIX);
    expect(result).toContain('</head>');
  });

  it('prepends CSP when no html/head tags', () => {
    const html = '<div>Simple content</div>';
    const result = injectContentSecurityPolicy(html);
    expect(result.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(result).toContain('<div>Simple content</div>');
  });

  it('CSP blocks network requests by default', () => {
    const result = injectContentSecurityPolicy('<head></head>');
    expect(result).toContain("default-src 'none'");
  });

  it('CSP allows inline styles and scripts', () => {
    const result = injectContentSecurityPolicy('<head></head>');
    expect(result).toContain("style-src 'unsafe-inline'");
    expect(result).toContain("script-src 'unsafe-inline'");
  });
});

describe('shouldApplyContent — T2 client version-wins (increment 5 acceptance)', () => {
  const V = (playlistId: string | null, version: string) => ({ playlistId, version });

  it('ACCEPTANCE 1 — pull-on-connect applies fresh content (no current)', () => {
    expect(shouldApplyContent(V('pl-1', '2026-02-01T00:00:00.000Z'), null)).toBe(true);
  });

  it('ACCEPTANCE 2 (CRITICAL) — a same-version delivery after a pull does NOT re-apply (no re-flash)', () => {
    // This is where the PD-1/PD-7 re-flash actually closes: the CLIENT honors the version,
    // so a same-version push arriving after a pull is a no-op → no duplicate content:impression.
    const cur = V('pl-1', '2026-02-01T00:00:00.000Z');
    expect(shouldApplyContent({ ...cur }, cur)).toBe(false);
  });

  it('ACCEPTANCE 3 — a newer version of the same playlist applies (boundary re-pull / drift reconcile)', () => {
    const cur = V('pl-1', '2026-02-01T00:00:00.000Z');
    expect(shouldApplyContent(V('pl-1', '2026-06-01T00:00:00.000Z'), cur)).toBe(true);
  });

  it('ACCEPTANCE 4 — a different playlist (schedule boundary / reassignment) ALWAYS applies, even if older', () => {
    const cur = V('pl-A', '2026-06-01T00:00:00.000Z');
    expect(shouldApplyContent(V('pl-B', '2026-01-01T00:00:00.000Z'), cur)).toBe(true);
  });

  it('a stale older-version re-delivery of the same playlist is ignored (push↔pull race)', () => {
    const cur = V('pl-1', '2026-06-01T00:00:00.000Z');
    expect(shouldApplyContent(V('pl-1', '2026-01-01T00:00:00.000Z'), cur)).toBe(false);
  });

  it('a null-playlist resolution never applies (holding stays put, never blanks to a wrong payload)', () => {
    expect(shouldApplyContent({ playlistId: null, version: '' }, V('pl-1', 'v'))).toBe(false);
  });

  it('matches the server definition exactly (same signature/semantics as @vizora/database)', () => {
    // Identical logic both sides → pull and push are reconciled to the same decision.
    const cur = V('pl-1', 'v2');
    expect(shouldApplyContent(V('pl-1', 'v2'), cur)).toBe(false); // equal → no-op
    expect(shouldApplyContent(V('pl-1', 'v3'), cur)).toBe(true); // newer → apply
    expect(shouldApplyContent(V('pl-1', 'v1'), cur)).toBe(false); // older → ignore
  });
});

describe('parseCrashLoopMarker (native crash-loop degradation marker)', () => {
  it('parses the exact wire format the native handler writes', () => {
    // "<wallClockMs>:<crashesInWindow>:<reason>" — see
    // CrashRecoveryHandler.writeCappedMarker().
    expect(parseCrashLoopMarker('1700000000000:4:uncaught_exception')).toEqual({
      at: 1700000000000,
      crashes: 4,
      reason: 'uncaught_exception',
    });
  });

  it('parses the renderer-loop reason tag', () => {
    expect(parseCrashLoopMarker('1700000000000:5:renderer_loop')?.reason).toBe('renderer_loop');
  });

  it('returns null when there is nothing to report', () => {
    expect(parseCrashLoopMarker(null)).toBeNull();
    expect(parseCrashLoopMarker(undefined)).toBeNull();
    expect(parseCrashLoopMarker('')).toBeNull();
  });

  it('still reports the episode when the marker is truncated', () => {
    // Written by a dying process, so a partial value is plausible. Losing the whole signal
    // to a strict parse would reintroduce exactly the silence the marker exists to remove.
    expect(parseCrashLoopMarker('1700000000000')).toEqual({
      at: 1700000000000,
      crashes: null,
      reason: null,
    });
    expect(parseCrashLoopMarker('1700000000000:4')).toEqual({
      at: 1700000000000,
      crashes: 4,
      reason: null,
    });
  });

  it('does not throw or invent numbers for a garbled marker', () => {
    expect(parseCrashLoopMarker('garbage')).toEqual({ at: null, crashes: null, reason: null });
    expect(parseCrashLoopMarker('::')).toEqual({ at: null, crashes: null, reason: null });
  });
});
