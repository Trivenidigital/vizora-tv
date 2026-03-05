# Code Review Fix Plan

All issues from the deep code review, prioritized by severity.
Target: fix in a single branch `fix/code-review-issues` with atomic commits per issue.

---

## CRITICAL (fix first)

### C1: Token leak to third-party URLs
**File**: `src/main.ts:48-51` (`transformContentUrl`)
**Problem**: Device JWT appended as `?token=` to ALL content URLs, including third-party domains. Token ends up in server logs, CDN logs, browser cache.
**Fix**: Only append token when URL origin matches `this.config.apiUrl`.
```typescript
// Before appending token, check origin matches our API
if (deviceToken && (result.startsWith('http://') || result.startsWith('https://'))) {
  try {
    const resultOrigin = new URL(result).origin;
    const apiOrigin = new URL(apiUrl).origin;
    if (resultOrigin === apiOrigin) {
      const separator = result.includes('?') ? '&' : '?';
      result += `${separator}token=${encodeURIComponent(deviceToken)}`;
    }
  } catch { /* invalid URL, skip token */ }
}
```
**Test**: Verify content loads from API with token. Verify third-party URLs don't get token.

### C2: Rename misleading `sanitizeHtmlContent`
**File**: `src/main.ts:1351`
**Problem**: Function name implies sanitization but only injects CSP meta tag. No actual HTML sanitization.
**Fix**: Rename to `injectContentSecurityPolicy`. Add a comment explaining the security model (CSP + iframe sandbox).
**Test**: Grep for all callers, update references.

### C3: No validation on pairing response data
**File**: `src/main.ts:404-408`
**Problem**: `data.code` and `data.deviceId` used without type checks. Malformed response could crash the app.
**Fix**: Add runtime validation:
```typescript
if (typeof data.code !== 'string' || !data.code) {
  throw new Error('Invalid pairing response: missing code');
}
if (data.deviceId && typeof data.deviceId !== 'string') {
  throw new Error('Invalid pairing response: invalid deviceId');
}
```
Also validate pairing status response (line 501).
**Test**: App handles malformed API responses gracefully (falls through to retry).

---

## HIGH (fix second)

### H1: Manifest write on every cache hit
**File**: `src/cache-manager.ts:151-152`
**Problem**: `getCachedUri()` saves manifest to disk on every access (updates `lastAccessed`). Causes excessive I/O during playback.
**Fix**: Debounce manifest saves. Track dirty state, flush every 60s or on `downloadContent`/`clearCache`.
```typescript
private manifestDirty = false;
private saveTimer: ReturnType<typeof setTimeout> | null = null;

private markManifestDirty() {
  this.manifestDirty = true;
  if (!this.saveTimer) {
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.manifestDirty) {
        this.saveManifest();
        this.manifestDirty = false;
      }
    }, 60000);
  }
}
```
Update `getCachedUri` to call `markManifestDirty()` instead of `saveManifest()`. Keep immediate saves in `downloadContent`, `enforceMaxCacheSize`, `clearCache`.
**Test**: Verify cache still works. Verify manifest file isn't written on every cache lookup.

### H2: Unhandled async constructor
**File**: `src/main.ts:157-159`
**Problem**: `this.init()` called without `.catch()`. Unhandled promise rejection if init fails.
**Fix**:
```typescript
constructor() {
  this.init().catch(err => {
    console.error('[Vizora] Fatal initialization error:', err);
    this.showError('Failed to initialize. Please restart the app.');
  });
}
```
**Test**: App shows error screen if init fails (e.g., SecureStorage unavailable).

### H3: Pairing code logged in console
**File**: `src/main.ts:406`
**Problem**: `JSON.stringify(data)` logs pairing code and potentially sensitive data. Terser strips in production, but not in debug.
**Fix**: Log only non-sensitive fields:
```typescript
console.log('[Vizora] Pairing data received, code length:', data.code?.length);
```
**Test**: Verify pairing still works. Check console output doesn't contain code.

### H4: No timeout on HTTP requests
**File**: `src/main.ts:388, 484`
**Problem**: `CapacitorHttp.post()` and `.get()` have no timeout. App could hang on flaky network.
**Fix**: Add `connectTimeout` and `readTimeout` to all CapacitorHttp calls:
```typescript
const response = await CapacitorHttp.post({
  url: `${this.config.apiUrl}/api/v1/devices/pairing/request`,
  headers: { 'Content-Type': 'application/json' },
  data: { deviceIdentifier, metadata: deviceInfo },
  connectTimeout: 10000,
  readTimeout: 15000,
});
```
**Test**: App retries cleanly when server is unreachable.

---

## MEDIUM (fix third)

### M1: Triplicated content rendering logic
**File**: `src/main.ts` — `playContent()`, `renderTemporaryContent()`, `renderZoneContent()`
**Problem**: Same switch statement (image/video/html/url) appears 3 times with subtle differences. Zone renderer doesn't use caching.
**Fix**: Extract a shared `renderContentElement(content, container, options?)` method that handles all content types. Options control caching, error handling, and video behavior.
```typescript
private async renderContentElement(
  content: { id: string; name: string; type: string; url: string; mimeType?: string },
  container: HTMLElement,
  options?: { useCache?: boolean; onVideoEnd?: () => void; onError?: () => void }
): Promise<void> { ... }
```
Update all three callers to use it.
**Test**: All content types render correctly in playlist, push, and layout modes. Zone content now benefits from caching.

### M2: `clear_cache` also clears config
**File**: `src/main.ts:946-951`
**Problem**: `clear_cache` command removes server URL config in addition to content cache. Unexpected side effect.
**Fix**: Remove the config preference clearing from `clear_cache`. If needed, the `update_config` command already exists for config changes.
```typescript
case 'clear_cache':
  await this.cacheManager.clearCache();
  window.location.reload();
  break;
```
**Test**: After `clear_cache`, verify server URLs are preserved.

### M3: Alpha `security-crypto` dependency
**File**: `android/app/build.gradle:94`
**Problem**: `androidx.security:security-crypto:1.1.0-alpha06` — alpha in production.
**Fix**: Pin to stable `1.0.0`:
```gradle
implementation "androidx.security:security-crypto:1.0.0"
```
Note: `1.0.0` requires API 23+ (no `MasterKeys.getOrCreate` differences). The fallback path in `SecureStoragePlugin.java` already handles API < 23.
**Test**: Build succeeds. SecureStorage still works on API 23+ device/emulator.

### M4: D-pad navigation is linear
**File**: `src/main.ts:310-318`
**Problem**: Up/Left and Down/Right are identical — no 2D grid awareness.
**Fix**: For now, add a comment documenting this is intentional for the current single-column UI. If grid layouts are added later, implement spatial navigation (find nearest focusable element in the direction pressed using bounding rect comparison).
**Scope**: Comment-only change for now. Not worth over-engineering until the UI has a grid.

### M5: Network security config in release builds
**File**: `android/app/src/main/res/xml/network_security_config.xml`
**Problem**: Cleartext traffic allowed for `10.0.2.2`, `localhost`, `127.0.0.1` even in release.
**Fix**: Use Android build-type-specific resource overrides:
1. Move current file to `android/app/src/debug/res/xml/network_security_config.xml`
2. Create `android/app/src/release/res/xml/network_security_config.xml` with cleartext disabled:
```xml
<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
</network-security-config>
```
**Test**: Debug build still connects to localhost. Release build blocks cleartext.

---

## LOW (fix last, batch together)

### L1: Sequential preloading
**File**: `src/main.ts:915-935`
**Fix**: Use `Promise.allSettled()` for parallel downloads:
```typescript
private async preloadContent(items: PlaylistItem[]) {
  const tasks = items
    .filter(item => item.content && (item.content.type === 'image' || item.content.type === 'video'))
    .map(async (item) => {
      const url = transformContentUrl(item.content!.url, this.config.apiUrl, this.deviceToken);
      const cached = await this.cacheManager.getCachedUri(item.content!.id);
      if (!cached) {
        await this.cacheManager.downloadContent(
          item.content!.id, url,
          item.content!.mimeType || (item.content!.type === 'video' ? 'video/mp4' : 'image/jpeg')
        );
      }
    });
  await Promise.allSettled(tasks);
}
```

### L2: Unbounded pairing retry count
**File**: `src/main.ts:371, 428`
**Fix**: Cap `pairingRetryCount` at the max useful value (where delay = 300000ms). Since `5000 * 2^6 = 320000 > 300000`, cap at 6:
```typescript
this.pairingRetryCount = Math.min(this.pairingRetryCount + 1, 6);
```

### L3: Cache extension from URL path
**File**: `src/cache-manager.ts:228-230`
**Fix**: Validate extension against a whitelist:
```typescript
const allowedExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'mp4', 'webm', 'svg']);
if (ext && ext.length <= 5 && allowedExtensions.has(ext.toLowerCase())) return ext;
```

### L4: Unit tests for `transformContentUrl` and `injectContentSecurityPolicy`
**File**: New `src/main.spec.ts`
**Fix**: Extract these as pure functions (they don't use `this`) and add unit tests covering:
- Relative URL handling
- Localhost -> 10.0.2.2 rewriting
- Token appending only for same-origin
- CSP injection into `<head>`, `<html>`, and bare HTML

### L5: `package-lock.json` cleanup
**Fix**: Either commit to npm (keep lockfile) or switch to pnpm (replace with `pnpm-lock.yaml`). Not both. Since the monorepo uses pnpm, consider switching this repo too for consistency.

---

## Execution Order

| Phase | Issues | Commits | Risk |
|-------|--------|---------|------|
| 1 | C1, C2, C3 | 3 | Security fixes — highest priority |
| 2 | H1, H2, H3, H4 | 4 | Reliability fixes |
| 3 | M1, M2, M3, M5 | 4 | Quality improvements |
| 4 | M4, L1-L5 | 1 batch | Polish |

Estimated: 12 commits on `fix/code-review-issues` branch.

---

## Verification

After all fixes:
- [ ] `npm run build` passes
- [ ] `npx cap sync android` passes
- [ ] `npm test` passes (including new tests in L4)
- [ ] Manual test: pairing flow works
- [ ] Manual test: content playback works
- [ ] Manual test: offline playlist restoration works
- [ ] Grep for `token=` — only appears in same-origin context
- [ ] Grep for `sanitizeHtml` — renamed to `injectContentSecurityPolicy`
- [ ] `./gradlew assembleDebug` succeeds in Android Studio
