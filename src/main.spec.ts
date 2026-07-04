/**
 * Unit tests for pure utility functions in utils.ts
 */

import { describe, it, expect } from 'vitest';
import { transformContentUrl, injectContentSecurityPolicy, computePlaylistSignature } from './utils';

describe('computePlaylistSignature (PD-1 playback idempotency)', () => {
  const P = (id: string, items: Array<{ contentId: string; order: number; duration: number }>) => ({ id, items });

  it('is stable for the same content — a redundant re-send is a no-op', () => {
    const a = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }, { contentId: 'c2', order: 1, duration: 20 }]);
    const b = P('pl-1', [{ contentId: 'c1', order: 0, duration: 10 }, { contentId: 'c2', order: 1, duration: 20 }]);
    expect(computePlaylistSignature(a)).toBe(computePlaylistSignature(b));
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
