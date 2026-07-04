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
 * Transforms content URLs for the Android TV environment:
 * - Relative URLs are prepended with apiUrl
 * - localhost/127.0.0.1 are rewritten to 10.0.2.2 (Android emulator host alias)
 * - Device JWT token is appended only for same-origin URLs (never leaked to third parties)
 */
export function transformContentUrl(url: string, apiUrl: string, deviceToken?: string | null): string {
  if (!url) return url;
  let result: string;

  // Handle relative URLs (e.g. /api/v1/...) by prepending apiUrl
  if (url.startsWith('/') && apiUrl) {
    result = apiUrl.replace(/\/$/, '') + url;
  } else if (apiUrl.includes('localhost') || apiUrl.includes('127.0.0.1')) {
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
