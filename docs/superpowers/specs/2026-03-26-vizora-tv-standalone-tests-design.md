# Vizora TV Standalone Test Suite — Design Spec

**Date:** 2026-03-26
**Goal:** Comprehensive unit test coverage for the Vizora Android TV app before Play Store submission.
**Scope:** Standalone TV app only (Step 1). Integration tests with Vizora backend are Step 2 (deferred).
**Approach:** Option A — test existing class methods directly with mocks. No refactoring of production code.

---

## Current State

| File | Tests | Coverage |
|------|-------|----------|
| `src/main.spec.ts` | 18 | `transformContentUrl` (13), `injectContentSecurityPolicy` (5) — utils only |
| `src/cache-manager.spec.ts` | 3 | Smoke tests: instantiation + method existence check |
| **Total** | **21** | **Zero coverage of VizoraAndroidTV class (~1300 lines)** |

## Target State

| File | Est. Tests | Coverage |
|------|-----------|----------|
| `src/main.spec.ts` | 18 (unchanged) | `transformContentUrl`, `injectContentSecurityPolicy` |
| `src/cache-manager.spec.ts` | ~28 | Full behavioral coverage of AndroidCacheManager |
| `src/vizora-app.spec.ts` | ~120 | All VizoraAndroidTV methods and flows |
| **Total** | **~166** | All critical paths covered |

Note: utils tests stay in `main.spec.ts` (no rename — avoids unnecessary churn before release).

---

## Mock Strategy

### Principle: Fakes Over Mocks Where Possible

Per user guidance — use in-memory fakes for stateful dependencies to keep tests readable and less brittle. Reserve `vi.fn()` mocks for fire-and-forget or assertion-only calls.

### Capacitor Plugin Mocks

```
Preferences       → In-memory Map<string, string>. Supports get/set/remove.
SecureStorage      → In-memory Map<string, string>. Supports get/set/remove/has.
CapacitorHttp      → Configurable response factory. Returns { status, data } per URL pattern.
Network            → Fake with settable status. addListener stores callbacks for manual trigger.
App                → Fake with addListener storing callbacks for appStateChange, backButton.
SplashScreen       → vi.fn() stub (hide called once, no behavior to test).
Filesystem         → In-memory file tree. Supports readFile/writeFile/deleteFile/mkdir/stat/getUri/rmdir.
Capacitor          → { convertFileSrc: (uri) => uri } identity stub.
```

### Socket.IO Mock

Factory function returning a mock socket:
- `on(event, handler)` — stores handlers in a Map
- `emit(event, data, ack?)` — records calls, optionally invokes ack
- `connect()` / `disconnect()` — triggers stored handlers
- `connected` — settable boolean
- `removeAllListeners()` — clears handler map

The `io()` factory is mocked at module level to return this mock socket.

### DOM Mock

Vitest runs in `node` environment (per vite.config.ts). Tests will:
- Use `vi.stubGlobal` for `document`, `window`, `navigator`, `performance`
- Create a minimal DOM fake with the following minimum API surface:

**Required DOM APIs (used by production code):**
```
document.getElementById(id)        → returns element stub or null
document.createElement(tag)        → returns new element stub (img, video, iframe, div, canvas)
document.querySelectorAll(selector) → returns array of element stubs
document.activeElement              → settable reference
document.addEventListener(event, handler)
document.body.appendChild(child)    → for offline overlay

Element stub properties:
  textContent, innerHTML, id, className, src, alt, autoplay, muted, loop, playsInline
  style (object with cssText and individual properties: position, zIndex, top, bottom, left, right, etc.)
  classList { add, remove, toggle, contains }
  sandbox { add }                   → for iframe sandbox
  appendChild(child), removeChild(child), remove(), firstChild
  focus(), click()
  querySelectorAll(selector)        → for nested queries (video cleanup)
  setAttribute(name, value)
  onerror, onload, onended          → event handlers (settable)

window.location.reload             → vi.fn()
window.screen                      → { width: 1920, height: 1080, colorDepth: 24 }
window.devicePixelRatio             → 1
navigator.userAgent                 → 'test-agent'
navigator.language                  → 'en-US'
performance.memory                  → { usedJSHeapSize, jsHeapSizeLimit } (optional)
```

### QRCode Module Mock

```typescript
vi.mock('qrcode', () => ({
  toCanvas: vi.fn().mockResolvedValue(undefined),
}));
```

---

## Test Naming Convention

Follow the existing `main.spec.ts` style: `it('verb phrase', ...)` inside `describe` blocks.

```typescript
describe('VizoraAndroidTV', () => {
  describe('Config Loading', () => {
    it('uses VITE env defaults when no overrides exist', () => { ... });
    it('gives URL params priority over stored Preferences', () => { ... });
  });
});
```

---

## Test File 1: `src/cache-manager.spec.ts` (~25 tests)

Full rewrite. Replaces the 3 existing smoke tests.

### Setup
- Mock `@capacitor/filesystem` with in-memory file tree
- Mock `@capacitor/core` (CapacitorHttp, Capacitor.convertFileSrc)

### Test Groups

#### 1. Initialization (4 tests)
- `init()` creates cache directory via `Filesystem.mkdir`
- `init()` loads existing manifest from disk
- `init()` handles missing manifest gracefully (fresh start)
- `init()` is idempotent — calling twice doesn't recreate directory or reload manifest

#### 2. Download & Cache (5 tests)
- `downloadContent()` downloads via CapacitorHttp, writes file, updates manifest, returns WebView URL
- `downloadContent()` returns `null` on HTTP error (non-200)
- `downloadContent()` returns `null` on write failure (logs error)
- `downloadContent()` skips if content already cached (returns cached URI)
- `downloadContent()` guards against concurrent downloads of same ID (returns null if in-flight)

#### 3. Cache Lookup (4 tests)
- `getCachedUri()` returns WebView URL for cached content
- `getCachedUri()` returns `null` for uncached content
- `getCachedUri()` removes manifest entry if file is missing on disk (self-healing)
- `getCachedUri()` updates `lastAccessed` timestamp (for LRU eviction)

#### 4. Manifest Persistence (4 tests)
- `downloadContent()` saves manifest immediately after download
- `getCachedUri()` debounces manifest saves (doesn't write on every access)
- Debounced save fires after 60s interval
- Rapid sequential `getCachedUri()` calls within debounce window only trigger one save

#### 5. Cache Eviction (5 tests)
- `enforceMaxCacheSize()` is a no-op when under limit
- `enforceMaxCacheSize()` evicts least-recently-accessed entries first (LRU)
- `enforceMaxCacheSize()` stops evicting once under limit
- `enforceMaxCacheSize()` handles file deletion errors gracefully (continues evicting, saves manifest)
- `enforceMaxCacheSize()` with orphaned manifest entries (file missing): skips silently, entry persists in manifest (known limitation — does NOT self-heal here, only `getCachedUri()` does)

#### 6. Cache Clear (2 tests)
- `clearCache()` removes directory, resets manifest, recreates directory
- `clearCache()` handles rmdir failure gracefully

#### 7. Cache Stats (1 test)
- `getCacheStats()` returns correct itemCount, totalSizeMB, maxSizeMB

#### 8. Extension Parsing (4 tests)
- Extracts extension from URL path (jpg, png, mp4, etc.)
- Falls back to MIME type mapping when URL has no valid extension
- Returns `bin` for unknown MIME types
- Rejects extensions not in allowlist (e.g., `exe`, `html`)

---

## Test File 2: `src/vizora-app.spec.ts` (~100 tests)

New file. Tests the `VizoraAndroidTV` class.

### Setup

The class auto-constructs via `new VizoraAndroidTV()` which calls `this.init()`. Tests need to control initialization:

```typescript
// Mock all Capacitor plugins, socket.io, DOM, and qrcode at module level
// Import the module which triggers construction
// Use beforeEach to reset all fakes and re-import if needed
```

### Test Groups

#### 1. Config Loading (6 tests)
- Uses VITE env defaults when no overrides exist
- URL params override defaults (`?api_url=...`)
- Stored Preferences override defaults
- URL params take priority over stored Preferences
- Handles missing Preferences gracefully
- Asserts console.log called with config object containing apiUrl, realtimeUrl, dashboardUrl

#### 1b. Capacitor Setup (4 tests)
- Network status change (offline → online) while authenticated: triggers `connectToRealtime()`
- Network status change while unauthenticated: does not trigger reconnect
- App returns to foreground (appStateChange `isActive: true`) with token but no socket: reconnects
- App goes to background: clears offline timeout

#### 2. Credential Migration (6 tests)
- Migrates token from Preferences to SecureStorage on first run
- Migrates deviceId alongside token
- Migrates token even when deviceId is null/missing (partial migration)
- Removes plaintext credentials after migration
- Skips migration if SecureStorage already has token (idempotent)
- Handles migration failure gracefully (logs error, continues)

#### 3. Initialization Flow (5 tests)
- With stored credentials: shows content screen, connects to realtime
- Without credentials: starts pairing flow
- Restores last playlist from Preferences on init
- Handles corrupt stored playlist JSON gracefully
- Hides splash screen after init

#### 4. Pairing — Request (9 tests)
- Shows pairing screen
- Sends POST to `/api/v1/devices/pairing/request` with device info
- Pairing request passes `connectTimeout: 10000` and `readTimeout: 15000` to CapacitorHttp (H4 regression)
- Pairing response handling logs `data.code.length` but NOT the full pairing code (H3 regression)
- Displays received pairing code in DOM
- Generates QR code with dashboard URL + code
- Uses server-provided QR data URL if available
- Starts countdown timer with expiry from response
- Starts polling for pairing status
- Handles `getDeviceInfo()` failure (Network.getStatus throws)
- Falls back to QR-unavailable text when QRCode module import fails

#### 5. Pairing — Polling (6 tests)
- Polls GET `/api/v1/devices/pairing/status/{code}` every 2 seconds
- On `status: paired` with valid token: stores credentials, connects to realtime
- Skips poll when offline (`isOnline = false`)
- On 404: requests new pairing code (code expired)
- On network error: logs and continues polling
- Validates response shape (requires string deviceToken)

#### 6. Pairing — Retry & Backoff (5 tests)
- Retries with exponential backoff on request failure (5s, 10s, 20s, ...)
- Caps backoff at 300 seconds (5 minutes)
- Caps retry count at 6
- Resets retry count on successful online attempt
- Retries on offline with backoff, doesn't hit network

#### 7. Pairing — Countdown Timer (4 tests)
- Displays `M:SS` countdown format
- Shows "Code expired" message when timer reaches 0
- Stops countdown interval on expiry
- Stops countdown when pairing succeeds

#### 8. WebSocket Connection (8 tests)
- Connects to `config.realtimeUrl` with device token in auth
- Uses WebSocket transport with polling fallback
- Reconnection enabled with exponential backoff (1s to 60s)
- On connect: updates status to "online", starts heartbeat, hides offline overlay
- On disconnect: updates status to "offline", stops heartbeat
- On disconnect: shows offline overlay after 60 seconds
- On connect_error with "unauthorized": clears credentials, restarts pairing
- Disconnects existing socket before creating new connection

#### 9. WebSocket Event Handlers (5 tests)
- `playlist:update` event calls `updatePlaylist()`
- `command` event calls `handleCommand()`
- `config` event with `qrOverlay` renders QR overlay
- `qr-overlay:update` event renders QR overlay
- On connect with restored playlist: starts playback immediately (assert content container has child elements)

#### 10. Heartbeat (6 tests)
- Sends heartbeat every 15 seconds
- First heartbeat sent immediately on connect
- Heartbeat payload includes: uptime, appVersion, metrics, currentContent
- Memory usage calculated from `performance.memory` when available
- Falls back to 50% default memory when `performance.memory` unavailable
- Processes commands from heartbeat ack response

#### 11. Playlist Playback (10 tests)
- `updatePlaylist()` stores playlist, resets index to 0, starts playback
- `updatePlaylist()` persists playlist to Preferences (offline resilience)
- `playContent()` renders current item based on content type
- `playContent()` emits `content:impression` event
- `playContent()` advances after `duration * 1000` ms for non-video content
- `playContent()` skips items with null content
- `nextContent()` wraps to index 0 when `loopPlaylist !== false`
- `nextContent()` stops at end when `loopPlaylist === false`
- `nextContent()` emits completion impression with duration and percentage
- `updatePlaylist()` with empty items array: no crash, no playback

#### 12. Content Rendering (10 tests)
- **Image:** creates `<img>` with src, alt, onerror handler
- **Video:** creates `<video>` with autoplay, playsInline, onerror, onended
- **Video (zone):** muted and looping when `muteVideo`/`loopVideo` options set
- **Webpage/URL:** creates `<iframe>` with src, allow="autoplay; fullscreen"
- **HTML/Template:** creates sandboxed `<iframe>` with `srcdoc`, CSP injected
- **HTML/Template:** sandbox only allows `allow-scripts` (no allow-same-origin)
- **HTML/Template:** 10s load timeout triggers error handler
- **Unknown type:** logs warning, appends empty contentDiv, playback timer still fires and advances to next item after duration
- **Image/Video with cache:** resolves through `cacheManager.getCachedUri()` first
- **Cache miss:** falls back to direct URL download via cache manager

#### 13. Content Preloading (3 tests)
- Preloads first 5 items on playlist update
- Uses `Promise.allSettled()` (parallel, failure-tolerant)
- Skips preload for non-media content types (html, url)

#### 14. Command Handling (8 tests)
- `reload`: calls `window.location.reload()`
- `clear_cache`: clears cache manager, then reloads
- `unpair`: removes credentials from SecureStorage, reloads
- `update_config` with `apiUrl`: reads from `command.apiUrl` (NOT `command.payload.apiUrl`), stores to Preferences, reloads
- `update_config` with `realtimeUrl`: reads from `command.realtimeUrl`, stores to Preferences, reloads
- `update_config` with `dashboardUrl`: reads from `command.dashboardUrl`, stores to Preferences, reloads
- `push_content`: calls `handleContentPush()` with content and duration
- `push_content` with malformed payload (null content, missing fields): logs warning, does not modify state
- `qr-overlay-update`: calls `renderQrOverlay()` with config
- Unknown command: logs warning, doesn't crash

#### 15. Temporary Content Push (6 tests)
- Saves current playlist state before pushing
- Clears current playback timer
- Renders pushed content in content container
- Sets resume timer for `duration` minutes
- On timer expiry: restores playlist state and resumes playback
- Nested push: replaces previous push, doesn't double-save playlist state
- Push when content container is missing (DOM element not found): logs error, doesn't crash
- Resume with no saved playlist state: clears content container without crashing

#### 16. QR Overlay (5 tests)
- Renders QR code at specified position (top-left, top-right, bottom-left, bottom-right)
- Applies size, margin, backgroundColor, opacity settings
- Displays label text below QR code when provided
- Hides overlay when `enabled: false`
- Hides overlay when config is undefined
- Falls back gracefully when QRCode.toCanvas rejects (logs error)

#### 17. Multi-Zone Layout (7 tests)
- Creates CSS grid with `gridTemplateColumns` and `gridTemplateRows`
- Each zone renders at its `gridArea`
- Zone with `resolvedPlaylist`: plays items in rotation with per-item duration
- Zone with `resolvedContent`: renders single content item
- Zone videos are muted and looping
- `cleanupLayout()` clears all zone timers and indices
- Empty zone (no resolvedPlaylist or resolvedContent): renders empty div, no crash
- Zone content rendering is fire-and-forget (not awaited) — error in async render doesn't crash layout

#### 18. D-pad Navigation (6 tests)
- ArrowDown/ArrowRight: moves focus to next focusable element
- ArrowUp/ArrowLeft: moves focus to previous focusable element
- Wraps around at end of list (last → first)
- Wraps around at start of list (first → last)
- Enter: clicks currently focused element
- Escape (Back): prevents default, doesn't exit app

#### 19. Offline Resilience (5 tests)
- Restores playlist from Preferences on startup when credentials exist
- Starts offline playback when network unavailable but playlist restored
- Shows offline overlay after 60s sustained disconnect
- Hides offline overlay on reconnect
- Clears offline timeout when app goes to background

#### 20. Media Cleanup (3 tests)
- Pauses all `<video>` elements in container
- Removes `src` attribute from videos
- Calls `video.load()` to release media resources

#### 21. Screen Management (3 tests)
- `showScreen('pairing')` hides all other screens, shows pairing
- `showScreen('content')` hides all other screens, shows content
- `showError()` sets error message text and shows error screen

---

## Test File 3: `src/main.spec.ts` (18 tests — unchanged)

Keep existing utils tests as-is. No modifications needed.

---

## What Is NOT Covered (Deferred to Step 2: Integration Tests)

| Area | Reason |
|------|--------|
| Real HTTP calls to Vizora API | Integration scope |
| Real WebSocket connection to realtime server | Integration scope |
| Android native plugin behavior (EncryptedSharedPreferences, BootReceiver, CrashRecoveryHandler) | Requires Android instrumentation tests |
| Visual rendering correctness | Requires Android TV emulator + screenshot comparison |
| Capacitor bridge behavior | Requires real Capacitor runtime |
| Network config XML (cleartext rules) | Build-level verification |
| Gradle build + APK signing | CI/CD scope |

---

## Success Criteria

1. All tests pass (`npm test` exits 0)
2. No test depends on execution order (each test is independently runnable)
3. No real network calls, file I/O, or timers (all faked)
4. Every public method of `VizoraAndroidTV` has at least one test
5. Every content type (image, video, webpage, html, template, layout) has rendering tests
6. Every command type has a handler test
7. Error paths tested: network failures, malformed responses, missing DOM elements, cache failures
