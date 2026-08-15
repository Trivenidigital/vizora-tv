/**
 * Pure utility functions used by the Vizora Android TV client.
 * Extracted for testability — no Capacitor/DOM/WebSocket dependencies.
 */

/**
 * Playback-identity signature (PD-1 + PD-7). Same signature = same content in the
 * same order/timing, so re-applying it is a visual no-op — no rotation restart, no
 * re-render flash, no duplicate content:impression.
 *
 * Includes contentId + order + duration AND `content.updatedAt` (PD-7): an in-place
 * edit — a template's regenerated HTML or a file replacement — keeps the same
 * content id and (id-keyed) url, so WITHOUT updatedAt the signature would collide
 * and the reconnect re-push (the primary delivery path for edits, since
 * content.updated doesn't push) would be absorbed as a no-op → edits never
 * propagate. `updatedAt` is the mutation discriminator (auto-bumped on any content
 * edit), so an edit changes the signature and re-renders. Name/loop don't affect
 * frames and are excluded. Empty string for null/empty — never equals a real
 * playlist's signature, so a stranded device (holding, currentPlaylist empty)
 * always re-renders on a re-send.
 */
export function computePlaylistSignature(
  p: {
    id: string;
    items?: Array<{
      contentId: string;
      order: number;
      duration: number;
      content?: { updatedAt?: string | number | null } | null;
    }>;
  } | null,
): string {
  if (!p || !p.items || p.items.length === 0) return '';
  return `${p.id}|${p.items
    .map((i) => `${i.contentId}@${i.order}x${i.duration}~${i.content?.updatedAt ?? ''}`)
    .join(',')}`;
}

/**
 * Version-wins decision (T2 idempotency layer) — the CLIENT half of the coherence
 * model the server resolver produces. Apply the resolver's answer when it is a
 * DIFFERENT playlist (schedule boundary / reassignment — always, even if its version
 * is older) OR a NEWER version of the SAME playlist; ignore a same-or-older re-delivery
 * of the same playlist (a stale push arriving after a pull, or an exact re-send — the
 * PD-1/PD-7 re-flash this closes end-to-end because the CLIENT honors the version).
 * Must match the server's shouldApplyContent (@vizora/database) exactly. ISO version
 * strings compare chronologically as strings.
 */
export function shouldApplyContent(
  incoming: { playlistId: string | null; version: string },
  current: { playlistId: string | null; version: string } | null,
): boolean {
  if (incoming.playlistId == null) return false; // nothing to show
  if (!current || current.playlistId == null) return true; // first content
  if (incoming.playlistId !== current.playlistId) return true; // boundary / reassignment
  return incoming.version > current.version; // same playlist → newer wins, older ignored
}

/**
 * Injects a Content-Security-Policy meta tag into HTML content.
 * Security model: iframe sandbox (allow-scripts only) + restrictive CSP.
 * This does NOT sanitize HTML — it relies on CSP to block network access
 * and sandbox to prevent parent DOM access.
 */
export function injectContentSecurityPolicy(html: string): string {
  const cspTag = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\' https://fonts.googleapis.com; script-src \'unsafe-inline\'; img-src data: blob: https:; font-src data: https://fonts.gstatic.com;">';
  if (html.includes('<head>')) {
    return html.replace('<head>', '<head>' + cspTag);
  } else if (html.includes('<html>')) {
    return html.replace('<html>', '<html><head>' + cspTag + '</head>');
  }
  return cspTag + html;
}

/**
 * Transforms content URLs for the TV display environment:
 * - Relative URLs are prepended with apiUrl
 * - localhost/127.0.0.1 are rewritten to 10.0.2.2 — the ANDROID EMULATOR host
 *   alias only, so callers on other platforms (Tizen/webOS/browser) disable it
 *   via `rewriteLocalhostForEmulator: false` (10.0.2.2 resolves nowhere there)
 * - Device JWT token is appended only for same-origin URLs (never leaked to third parties)
 */
export function transformContentUrl(
  url: string,
  apiUrl: string,
  deviceToken?: string | null,
  options?: { rewriteLocalhostForEmulator?: boolean },
): string {
  if (!url) return url;
  const rewriteForEmulator = options?.rewriteLocalhostForEmulator ?? true;
  let result: string;

  // Handle relative URLs (e.g. /api/v1/...) by prepending apiUrl
  if (url.startsWith('/') && apiUrl) {
    result = apiUrl.replace(/\/$/, '') + url;
  } else if (rewriteForEmulator && (apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1'))) {
    result = url.replace(/http:\/\/localhost/g, 'http://10.0.2.2')
                .replace(/http:\/\/127\.0\.0\.1/g, 'http://10.0.2.2');
  } else {
    result = url.replace(/http:\/\/localhost:\d+/g, apiUrl)
                .replace(/http:\/\/127\.0\.0\.1:\d+/g, apiUrl);
  }

  // Append device JWT token only for same-origin URLs (img/video tags can't send headers).
  // Never leak token to third-party domains — it would appear in their server logs.
  // Normalize www/non-www to handle API_BASE_URL mismatches (e.g. vizora.cloud vs www.vizora.cloud).
  if (deviceToken && (result.startsWith('http://') || result.startsWith('https://'))) {
    try {
      const normalize = (o: string) => o.replace('://www.', '://');
      const resultOrigin = normalize(new URL(result).origin);
      const apiOrigin = normalize(new URL(apiUrl).origin);
      if (resultOrigin === apiOrigin) {
        const separator = result.includes('?') ? '&' : '?';
        result += `${separator}token=${encodeURIComponent(deviceToken)}`;
      }
    } catch { /* invalid URL, skip token */ }
  }

  return result;
}

/**
 * Key under which the Android native crash handler leaves its degradation marker.
 * Written by CrashRecoveryHandler.writeCappedMarker() into the "CapacitorStorage"
 * SharedPreferences file, which is exactly what the Capacitor Preferences plugin reads,
 * so no new plugin or bridge is involved.
 */
export const CRASH_LOOP_MARKER_KEY = 'crash_loop_capped';

export interface CrashLoopMarker {
  at: number | null;
  crashes: number | null;
  reason: string | null;
}

/**
 * Parse the native crash-loop degradation marker.
 *
 * Wire format is "<wallClockMs>:<crashesInWindow>:<reason>" — colon-delimited rather than
 * JSON on purpose, because it is written by a process that is in the middle of dying and a
 * half-written JSON value would throw in the reader.
 *
 * Why this exists at all: when the native crash ladder is exhausted the device drops to one
 * relaunch attempt per hour. That is an automated state change that materially degrades the
 * device, and nothing else can tell the operator about it — the native side cannot report
 * telemetry (reportEvent is here, in JS, and that process is terminating) and logcat reaches
 * nobody on a fielded screen. So the native side leaves this breadcrumb and the next boot
 * that gets far enough reports it (CLAUDE.md 12b).
 *
 * TOLERANT BY DESIGN: a truncated or garbled marker still yields an event with whatever
 * fields survived, because "this device was crash-looping" is the load-bearing signal and
 * losing it to a strict parse would reintroduce the silence this is meant to remove.
 * Returns null only when there is genuinely nothing to report.
 */
export function parseCrashLoopMarker(raw: string | null | undefined): CrashLoopMarker | null {
  if (!raw) {
    return null;
  }
  const parts = raw.split(':');
  const num = (part: string | undefined): number | null => {
    if (part === undefined || part.trim() === '') return null;
    const parsed = Number(part);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return {
    at: num(parts[0]),
    crashes: num(parts[1]),
    reason: parts[2] !== undefined && parts[2] !== '' ? parts[2] : null,
  };
}
