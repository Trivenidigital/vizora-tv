# Vizora TV E2E Test Spec: Device Pairing & Content Streaming

**Date:** 2026-03-27
**Environment:** Android TV app ↔ vizora.cloud (VPIN VPS)
**Scope:** End-to-end testing of device pairing and content streaming against the live production backend.
**Test Type:** E2E (real network, real backend, real Android device/emulator)
**NOT in scope:** Unit tests, mock-based tests, or CI-headless tests. This spec requires a real Android TV device or emulator with network access to vizora.cloud.

---

## Environment Setup

### Prerequisites

| Component | Details |
|-----------|---------|
| **Backend** | vizora.cloud on VPIN VPS |
| **API URL** | `https://vizora.cloud/api/v1` |
| **WebSocket URL** | `wss://vizora.cloud` (Socket.IO) |
| **Dashboard URL** | `https://vizora.cloud` |
| **Android Device** | Android TV device or emulator (API 23+, landscape, network access) |
| **App Build** | Debug APK of `com.vizora.display` with `.env` pointing to vizora.cloud |
| **Dashboard Access** | Login credentials for vizora.cloud dashboard with permission to pair devices and manage content |
| **Content Assets** | Pre-uploaded to dashboard: 1 image, 1 video (MP4, 10-30s), 1 HTML template, 1 URL |
| **Network** | Stable WiFi/Ethernet; also need ability to toggle network on/off for offline tests |

### Android TV Emulator Setup

If no physical Android TV device is available:

```bash
# Install Android TV system image (API 34)
sdkmanager "system-images;android-34;google_atv;x86_64"

# Create the AVD
avdmanager create avd -n "TV_API34" \
  -k "system-images;android-34;google_atv;x86_64" \
  -d "tv_1080p"

# Launch the emulator
emulator -avd TV_API34

# Install the debug APK
adb install -r android/app/build/outputs/apk/debug/vizora-display-1.0.0-debug.apk
```

**Emulator limitations:**
- `adb reboot` is flaky on emulators — test P-08 (boot auto-launch) requires a physical device
- Network toggle: use `adb shell svc wifi disable` / `enable` instead of airplane mode
- D-pad navigation works via arrow keys on the emulator window

### .env Configuration (App)
```
VITE_API_URL=https://vizora.cloud
VITE_REALTIME_URL=wss://vizora.cloud
VITE_DASHBOARD_URL=https://vizora.cloud
```

### Pre-test Checklist
- [ ] vizora.cloud API is reachable (`curl https://vizora.cloud/api/v1/health`)
- [ ] Dashboard login works at `https://vizora.cloud`
- [ ] At least 1 image and 1 video content item uploaded to dashboard
- [ ] At least 1 playlist created with mixed content (image + video + URL)
- [ ] Android device/emulator is running, screen is on, landscape orientation
- [ ] App is installed and NOT previously paired (fresh install or after `adb shell pm clear com.vizora.display`)
- [ ] `adb logcat -s Vizora` running in separate terminal for log capture

---

## Test Suite 1: Device Pairing

### P-01: Fresh pairing — happy path (P0, must-have)

**Preconditions:**
- App freshly installed (no stored credentials)
- Device has network connectivity to vizora.cloud
- Dashboard open in browser, logged in

**Steps:**
1. Launch the app
2. Observe the pairing screen appears
3. Note the pairing code displayed (format: alphanumeric, ~8-12 chars)
4. Note the QR code is visible
5. Note the countdown timer shows `M:SS` format (starting from ~5:00)
6. Open dashboard at `https://vizora.cloud`
7. Navigate to device pairing section
8. Enter the pairing code displayed on the TV
9. Click "Pair Device"
10. Observe the TV app transitions to content screen

**Expected Results:**
- [ ] Pairing screen shows within 5s of app launch
- [ ] Pairing code is clearly readable (large font, high contrast)
- [ ] QR code is scannable and links to `https://vizora.cloud/pair?code={CODE}`
- [ ] Countdown timer ticks down every second in `M:SS` format
- [ ] Dashboard accepts the code and confirms pairing
- [ ] TV app transitions to content screen within 4s of dashboard confirmation (2s poll interval + processing)
- [ ] No crash, ANR, or blank screen at any point
- [ ] `adb logcat` shows: "Device paired successfully!" and "Connected to realtime gateway"

**Assertions:**
```
ASSERT: pairing-code element has non-empty text
ASSERT: qr-code element contains <img> or <canvas> child
ASSERT: pairing-countdown element text matches /\d:\d{2}/
ASSERT: After pairing, content-screen is visible AND pairing-screen is hidden
ASSERT: SecureStorage contains 'device_token' (non-null string)
ASSERT: SecureStorage contains 'device_id' (non-null string)
ASSERT: WebSocket connected (status-dot has class "online")
```

---

### P-02: Pairing code expiry and auto-renewal (P0)

**Wall-clock time:** ~5 minutes (waiting for code expiry). If the backend team can temporarily shorten `expiresInSeconds` to 30s for testing, this becomes a 30-second test.

**Preconditions:**
- App on pairing screen, code displayed
- Do NOT enter the code in dashboard

**Steps:**
1. Note the pairing code and countdown timer
2. Wait for countdown to reach 0:00 (default 5 minutes, or check `expiresInSeconds` from API)
3. Observe behavior when code expires

**Expected Results:**
- [ ] At 0:00, countdown text changes to "Code expired — requesting new code..."
- [ ] Within 5s, a NEW pairing code is displayed (different from the first)
- [ ] NEW QR code is generated
- [ ] Countdown timer restarts from ~5:00
- [ ] The old code is no longer valid on the dashboard (returns 404)
- [ ] No crash or frozen screen during renewal

**Assertions:**
```
ASSERT: New code !== old code
ASSERT: New countdown starts from > 4:00
ASSERT: Dashboard rejects old code with "code not found" or equivalent error
ASSERT: adb logcat shows "Pairing code expired, requesting new one..."
```

---

### P-03: Pairing with network interruption during code request (P0)

**Preconditions:**
- App freshly installed
- Network connectivity available

**Steps:**
1. Disable network (airplane mode or WiFi off) BEFORE launching app
2. Launch app
3. Observe error message
4. Wait 10 seconds
5. Re-enable network
6. Observe pairing code appears

**Expected Results:**
- [ ] App shows error: "No network connection. Please check your network settings."
- [ ] App does NOT crash or ANR
- [ ] After network restore, app automatically retries pairing request
- [ ] Pairing code appears without user intervention
- [ ] Exponential backoff visible in logs (5s, 10s, 20s...)

**Assertions:**
```
ASSERT: error-screen visible when offline
ASSERT: adb logcat shows "Pairing retry in {delay}ms"
ASSERT: After network restore, pairing-screen shows with valid code
ASSERT: No "Application Not Responding" dialog at any point
```

---

### P-04: Pairing with network loss during polling (P1)

**Preconditions:**
- App showing pairing screen with valid code
- Dashboard ready to pair

**Steps:**
1. Note the pairing code
2. Disable network on the TV device
3. Enter the code on dashboard and pair
4. Wait 10 seconds (poll should skip while offline)
5. Re-enable network on the TV device
6. Observe behavior

**Expected Results:**
- [ ] While offline, no HTTP errors in logcat (poll silently skips)
- [ ] After network restore, next poll detects "paired" status
- [ ] App transitions to content screen
- [ ] Credentials stored successfully

**Assertions:**
```
ASSERT: No "Pairing check error" logged while offline
ASSERT: After network restore, content-screen becomes visible
ASSERT: SecureStorage has device_token
```

---

### P-05: Server-provided QR code vs client-generated QR code (P2)

**Preconditions:**
- Fresh app install

**Steps:**
1. Launch app, observe QR code
2. Check logcat for whether server provided `qrCode` data URL or if client generated it
3. Scan QR code with phone camera
4. Verify URL is correct

**Expected Results:**
- [ ] If server provides `qrCode` field: `<img>` element with data URL displayed
- [ ] If server does NOT provide `qrCode`: `<canvas>` element generated by QRCode library
- [ ] QR code resolves to `https://vizora.cloud/pair?code={CODE}`
- [ ] URL is accessible in mobile browser

**Assertions:**
```
ASSERT: QR container has exactly 1 child (img OR canvas)
ASSERT: QR URL matches dashboard pair URL with correct code
```

---

### P-06: Multiple rapid pairing attempts (P2)

**Preconditions:**
- App on pairing screen

**Steps:**
1. Note pairing code
2. On dashboard, attempt to pair the code
3. Simultaneously (within 2s), attempt to pair the same code again from another browser tab
4. Observe TV app behavior

**Expected Results:**
- [ ] First pairing succeeds, TV transitions to content screen
- [ ] Second attempt on dashboard fails or is idempotent (no double-pair)
- [ ] TV app does NOT receive duplicate credentials
- [ ] No crash or inconsistent state on TV

---

### P-07: Pairing persistence after app restart (P0)

**Preconditions:**
- App successfully paired (from P-01)

**Steps:**
1. Force-stop the app (`adb shell am force-stop com.vizora.display`)
2. Relaunch the app
3. Observe behavior

**Expected Results:**
- [ ] App does NOT show pairing screen
- [ ] App goes directly to content screen
- [ ] WebSocket reconnects to vizora.cloud
- [ ] Last playlist restored from storage (if available)
- [ ] No blank screen flash (BUG #7 regression)

**Assertions:**
```
ASSERT: pairing-screen is NOT shown
ASSERT: content-screen is visible within 3s of launch
ASSERT: adb logcat shows "Found existing device credentials, connecting..."
ASSERT: adb logcat shows "Connected to realtime gateway"
```

---

### P-08: Pairing persistence after device reboot (P0)

**Requires physical device.** `adb reboot` on emulators is flaky and BootReceiver behavior varies. Skip this test on emulator and document as "deferred to physical device testing."

**Preconditions:**
- App successfully paired
- BootReceiver configured in manifest

**Steps:**
1. Reboot the Android TV device (`adb reboot`)
2. Wait for device to fully boot (up to 60s)
3. Observe app auto-launch behavior

**Expected Results:**
- [ ] App auto-launches after boot (via BootReceiver)
- [ ] App goes directly to content screen (credentials survived reboot)
- [ ] WebSocket connects
- [ ] Content playback resumes

**Assertions:**
```
ASSERT: App visible on screen within 30s of boot
ASSERT: content-screen shown (not pairing-screen)
ASSERT: adb logcat shows BootReceiver trigger
```

---

### P-09: Unpair command from dashboard (P1)

**Preconditions:**
- App paired and connected

**Steps:**
1. From dashboard, send "unpair" command to the device
2. Observe TV app behavior

**Expected Results:**
- [ ] App clears credentials from SecureStorage
- [ ] App reloads
- [ ] After reload, pairing screen appears (credentials gone)
- [ ] Device disappears from "paired devices" list on dashboard

**Assertions:**
```
ASSERT: SecureStorage 'device_token' is null after unpair
ASSERT: pairing-screen visible after reload
ASSERT: adb logcat shows "window.location.reload()"
```

---

### P-10: Credential migration from plaintext to encrypted storage (P1)

**Requires debug APK.** The `run-as` command below only works on debuggable builds. Release builds block `run-as`. Run this test with the debug APK only.

**Preconditions:**
- App previously stored credentials in plaintext Preferences (pre-migration build)
- OR manually set plaintext credentials via adb (debug APK only):
  ```
  adb shell "run-as com.vizora.display sh -c 'cat > /data/data/com.vizora.display/shared_prefs/CapacitorStorage.xml <<EOF
  <?xml version=\"1.0\" encoding=\"utf-8\"?>
  <map>
    <string name=\"device_token\">test-plain-token</string>
    <string name=\"device_id\">test-plain-device</string>
  </map>
  EOF'"
  ```

**Steps:**
1. Launch app
2. Check logcat for migration messages
3. Verify credentials are in SecureStorage
4. Verify plaintext credentials are removed from Preferences

**Expected Results:**
- [ ] Log: "Migrating credentials to secure storage..."
- [ ] Log: "Credential migration complete"
- [ ] SecureStorage has the token
- [ ] Plaintext Preferences no longer has `device_token` or `device_id`

---

## Test Suite 2: Content Streaming

### S-01: Receive and display image content (P0, must-have)

**Preconditions:**
- Device paired and connected to vizora.cloud
- Dashboard has a playlist with 1 image item assigned to this device

**Steps:**
1. From dashboard, assign the image playlist to the device
2. Observe TV app

**Expected Results:**
- [ ] Image appears on full screen within 5s of assignment
- [ ] Image is not stretched/distorted (maintains aspect ratio or fills screen per CSS)
- [ ] After `duration` seconds (default 10s), content advances to next item or loops
- [ ] `content:impression` event sent (visible in dashboard analytics or server logs)

**Assertions:**
```
ASSERT: content-container has <img> child element
ASSERT: img.src is a valid URL (either cached file:// or https:// URL)
ASSERT: adb logcat shows "Playing content 1/N: {image_name}"
ASSERT: After duration, next content starts OR image re-renders (loop)
```

---

### S-02: Receive and display video content (P0, must-have)

**Preconditions:**
- Playlist with 1 video item (MP4, 10-30s) assigned to device

**Steps:**
1. Assign video playlist from dashboard
2. Observe video playback on TV
3. Wait for video to finish

**Expected Results:**
- [ ] Video starts playing automatically (autoplay)
- [ ] Video has audio (NOT muted for main playlist)
- [ ] Video plays inline (not fullscreen overlay)
- [ ] After video ends (`onended`), next item starts or video loops
- [ ] Completion impression sent with actual duration and completion percentage

**Assertions:**
```
ASSERT: content-container has <video> child
ASSERT: video.autoplay === true
ASSERT: video.muted === false (main playlist, not zone)
ASSERT: video.playsInline === true
ASSERT: adb logcat shows content:impression with completionPercentage >= 90
```

---

### S-03: Receive and display webpage/URL content (P1)

**Preconditions:**
- Playlist with 1 URL item (e.g., `https://example.com`)

**Steps:**
1. Assign URL playlist from dashboard
2. Observe iframe rendering on TV

**Expected Results:**
- [ ] Iframe loads the URL
- [ ] `allow="autoplay; fullscreen"` attribute set
- [ ] Content advances after specified duration
- [ ] No navigation away from the app (iframe is contained)

**Assertions:**
```
ASSERT: content-container has <iframe> child
ASSERT: iframe.src contains the target URL
ASSERT: iframe.allow === "autoplay; fullscreen"
```

---

### S-04: Receive and display HTML template content (P1)

**Preconditions:**
- Playlist with 1 HTML template item

**Steps:**
1. Assign HTML playlist from dashboard
2. Observe sandboxed iframe rendering

**Expected Results:**
- [ ] Iframe renders HTML content via `srcdoc`
- [ ] CSP meta tag injected (blocks external network requests)
- [ ] iframe sandbox restricts to `allow-scripts` only (no `allow-same-origin`)
- [ ] Content cannot access parent DOM
- [ ] 10s load timeout fires error handler if iframe doesn't load

**Assertions:**
```
ASSERT: iframe.sandbox contains "allow-scripts"
ASSERT: iframe.sandbox does NOT contain "allow-same-origin"
ASSERT: iframe.srcdoc contains Content-Security-Policy meta tag
```

---

### S-05: Content rotation through multi-item playlist (P0, must-have)

**Preconditions:**
- Playlist with 3+ items: image (10s), video (15s), image (10s)
- Playlist `loopPlaylist: true`

**Steps:**
1. Assign playlist from dashboard
2. Observe content rotation
3. Wait for full loop (all items play, then restart from first)

**Expected Results:**
- [ ] Item 1 (image) displays for 10s, then advances
- [ ] Item 2 (video) plays until `onended`, then advances
- [ ] Item 3 (image) displays for 10s, then loops back to item 1
- [ ] Each item emits `content:impression` on start
- [ ] Completion impressions sent with duration and percentage
- [ ] No gaps, blank screens, or stuttering between transitions

**Assertions:**
```
ASSERT: adb logcat shows "Playing content 1/3", "Playing content 2/3", "Playing content 3/3", "Playing content 1/3" (loop)
ASSERT: content-container never empty for > 500ms during transitions
ASSERT: Socket emits content:impression for each item
```

---

### S-06: Content caching for offline playback (P0, must-have)

**Preconditions:**
- Device paired, playlist with image + video assigned
- Content has been displayed at least once (cached)

**Steps:**
1. Verify content plays normally while online
2. Disable network on TV device
3. Observe content continues playing from cache
4. Wait for full playlist loop
5. Re-enable network

**Expected Results:**
- [ ] Content continues playing from cache after network loss
- [ ] No error screen or blank display
- [ ] Offline overlay appears after 60s of sustained disconnect
- [ ] On network restore, WebSocket reconnects
- [ ] Offline overlay disappears on reconnect

**Assertions:**
```
ASSERT: Content container has visible content while offline
ASSERT: After 60s offline, "Device is offline" overlay is visible
ASSERT: Content continues rotating (cached items render without network)
NOTE: "Starting offline playback from restored playlist" only appears on app restart while offline, NOT on mid-playback network drop. For this test, verify visually that content keeps playing.
ASSERT: After network restore, adb logcat shows "Connected to realtime gateway"
ASSERT: Offline overlay removed after reconnect
```

---

### S-07: Content preloading (P2)

**Preconditions:**
- Playlist with 8+ image items, none previously cached

**Steps:**
1. Assign playlist from dashboard
2. Monitor logcat for cache activity

**Expected Results:**
- [ ] First 5 items preloaded in parallel (via `Promise.allSettled`)
- [ ] Logcat shows `[AndroidCache] Cached: {id}` for up to 5 items
- [ ] Items 6-8 are NOT preloaded (only first 5)
- [ ] Preloading doesn't block current item display

---

### S-08: Playlist update while content is playing (P0)

**Preconditions:**
- Device playing playlist A (image content)

**Steps:**
1. From dashboard, assign a different playlist B to the device
2. Observe TV behavior

**Expected Results:**
- [ ] Current content interrupted
- [ ] New playlist starts from item 1
- [ ] Previous playlist state discarded
- [ ] New content renders within 3s of assignment
- [ ] No crash during mid-playback switch

**Assertions:**
```
ASSERT: adb logcat shows "Received playlist update"
ASSERT: content-container shows new playlist's first item
ASSERT: No error messages in logcat
```

---

### S-09: Empty playlist handling (P1)

**Preconditions:**
- Device paired and connected

**Steps:**
1. From dashboard, assign an empty playlist (0 items)
2. Observe TV behavior

**Expected Results:**
- [ ] App does NOT crash
- [ ] Content screen remains (no switch to error screen)
- [ ] Logcat shows "Playlist is empty"
- [ ] Previous content is cleared

---

### S-10: Temporary content push (P1)

**Preconditions:**
- Device playing a regular playlist

**Steps:**
1. From dashboard, push temporary content (image) with duration 1 minute
2. Observe TV immediately shows pushed content
3. Wait 1 minute

**Expected Results:**
- [ ] Regular playlist interrupted immediately
- [ ] Pushed image displayed
- [ ] After 1 minute, original playlist resumes from where it left off
- [ ] Logcat shows "Pushing content: {name} for 1 min"
- [ ] Logcat shows "Resuming playlist after temporary content"

**Assertions:**
```
ASSERT: Pushed content visible within 2s of command
ASSERT: After duration, original playlist item re-renders
ASSERT: content:impression sent for temporary content
```

---

### S-11: WebSocket reconnection after server restart (P0)

**Preconditions:**
- Device paired and connected, playing content

**Steps:**
1. Simulate server restart (or wait for a natural disconnect)
2. Observe TV behavior during disconnect
3. Wait for automatic reconnection

**Expected Results:**
- [ ] Content continues playing from cache during disconnect
- [ ] Status changes to "offline" / "Disconnected"
- [ ] Heartbeat stops
- [ ] After 60s, offline overlay appears (if still disconnected)
- [ ] Socket.IO auto-reconnects with exponential backoff (1s → 2s → 4s → ... max 60s)
- [ ] On reconnect: status changes to "online", heartbeat restarts, overlay hides

**Assertions:**
```
ASSERT: adb logcat shows "Disconnected: {reason}"
ASSERT: adb logcat shows "Connected to realtime gateway" on reconnect
ASSERT: Heartbeat resumes (visible in server logs)
```

---

### S-12: Invalid/expired token triggers re-pairing (P0)

**Preconditions:**
- Device paired and connected

**How to invalidate the token (pick one, in order of preference):**
1. **Dashboard unpair** — If the dashboard has a "remove device" button, use it. This is the easiest path.
2. **Dashboard API** — If the dashboard exposes a device management API, call the delete endpoint.
3. **Corrupt the token on-device** — Use adb to clear just the token (debug APK only):
   ```
   adb shell run-as com.vizora.display sh -c "rm -f /data/data/com.vizora.display/shared_prefs/vizora_secure_prefs.xml"
   ```
   Then restart the app. The app will try to connect with a missing/empty token, triggering the "unauthorized" path.
4. **DB access** — If you have SSH access to VPIN VPS, delete the device record from the database.

**Steps:**
1. Invalidate the device token using one of the methods above
2. Force app to reconnect (`adb shell am force-stop com.vizora.display` then relaunch)
3. Observe behavior

**Expected Results:**
- [ ] WebSocket connect_error fires with "unauthorized" or "invalid token"
- [ ] App clears credentials from SecureStorage
- [ ] App starts fresh pairing flow
- [ ] Pairing screen appears with new code

**Assertions:**
```
ASSERT: adb logcat shows "Token invalid, clearing credentials..."
ASSERT: pairing-screen visible after credential clear
ASSERT: SecureStorage 'device_token' is null
```

---

### S-13: Heartbeat reporting (P1)

**Preconditions:**
- Device paired and playing content

**Steps:**
1. Observe server logs for heartbeat events
2. Wait 30+ seconds (at least 2 heartbeat cycles)
3. Check heartbeat payload content

**Expected Results:**
- [ ] Heartbeats received every 15 seconds
- [ ] First heartbeat sent immediately on connect
- [ ] Payload includes: uptime (seconds), appVersion, memoryUsage, currentContent
- [ ] `currentContent.contentId` matches currently playing item

**Assertions:**
```
ASSERT: Server receives >= 2 heartbeats in 30s
ASSERT: heartbeat.uptime is increasing
ASSERT: heartbeat.appVersion matches app's version
ASSERT: heartbeat.currentContent.contentId matches displayed content
```

---

### S-14: Remote commands via dashboard (P1)

**Preconditions:**
- Device paired and connected

**Subtest S-14a: Reload command**
1. Send "reload" from dashboard
2. App reloads (`window.location.reload`)
3. App reconnects and resumes content

**Subtest S-14b: Clear cache command**
1. Send "clear_cache" from dashboard
2. App clears cache and reloads
3. Content re-downloads from server on next play

**Subtest S-14c: Update config command**
1. Send "update_config" with a modified `dashboardUrl`
2. App stores new config and reloads
3. Verify new config is persisted (visible in Preferences)

**Assertions per subtest:**
```
ASSERT (a): App reloads within 2s of command, reconnects
ASSERT (b): Cache directory emptied, adb logcat shows "[AndroidCache] Cache cleared"
ASSERT (c): Preferences has updated config key
```

---

### S-15: QR overlay on content screen (P2)

**Preconditions:**
- Device playing content

**Steps:**
1. From dashboard, enable QR overlay with URL, position "bottom-right", label "Scan me"
2. Observe overlay on TV

**Expected Results:**
- [ ] QR code appears in bottom-right corner
- [ ] Label "Scan me" visible below QR
- [ ] QR is scannable and resolves to configured URL
- [ ] Overlay does not block main content (positioned with z-index)

**Subtest: Disable overlay**
1. Disable QR overlay from dashboard
2. Overlay disappears within 2s

---

### S-16: Multi-zone layout content (P2)

**Preconditions:**
- Playlist with layout content type containing 2+ zones

**Steps:**
1. Assign layout playlist from dashboard
2. Observe grid rendering

**Expected Results:**
- [ ] CSS grid rendered with correct column/row template
- [ ] Each zone renders at its specified grid area
- [ ] Zone playlists rotate independently (different timers per zone)
- [ ] Zone videos are muted and looping
- [ ] Cleanup works when switching away from layout

---

### S-17: Content URL token injection security (P0)

**Preconditions:**
- Device paired, content playing
- Playlist contains at least 1 image from vizora.cloud API

**Method: logcat-based (no proxy needed)**

The simplest approach is to enable WebView network logging and grep logcat. No HTTPS proxy setup required.

**Steps:**
1. Enable verbose logcat: `adb logcat -v time | tee e2e-network.log`
2. Play content from a playlist with vizora.cloud-hosted images
3. After content plays, search the log for URL patterns:
   ```bash
   grep -i "token=" e2e-network.log
   grep -i "vizora.cloud.*token=" e2e-network.log
   ```
4. If the playlist also has third-party URLs (e.g., `https://example.com/image.jpg`), verify those do NOT contain `token=`

**Expected Results:**
- [ ] Content from vizora.cloud loads successfully (image/video renders — proves token is present and valid)
- [ ] Logcat URLs to vizora.cloud contain `?token=` or `&token=`
- [ ] No `token=` substring appears in any URL to external domains

**Alternative: proxy-based (thorough but complex)**

For HTTPS interception, use a debug APK with a network security config allowing user CAs:
1. Install mitmproxy CA on device
2. Add `<trust-anchors><certificates src="user" /></trust-anchors>` to debug network security config
3. Route traffic through proxy
4. Inspect requests for token presence/absence

This is optional — the logcat method above is sufficient for Play Store release confidence.

**Assertions:**
```
ASSERT: vizora.cloud content loads (not 401) — proves token injection works
ASSERT: No token= in URLs to non-vizora.cloud domains (grep logcat)
```

---

### S-17b: API-origin content actually loads with token (P0)

**Preconditions:**
- Device paired, playlist has image hosted on vizora.cloud

**Steps:**
1. Assign playlist with vizora.cloud-hosted image
2. Observe image renders on TV

**Expected Results:**
- [ ] Image loads and displays (not a broken image icon)
- [ ] No 401/403 errors in logcat
- [ ] This proves token injection is working correctly end-to-end

**Assertions:**
```
ASSERT: Image visible on screen (not error placeholder)
ASSERT: adb logcat does NOT contain "401" or "403" for content URLs
```

---

### S-18: D-pad navigation on pairing screen (P2)

**Preconditions:**
- App on pairing screen, Android TV remote available

**Steps:**
1. Press ArrowDown, ArrowUp, ArrowLeft, ArrowRight
2. Press Enter on focused element
3. Press Back/Escape

**Expected Results:**
- [ ] Focus moves between focusable elements
- [ ] Focus wraps (last → first, first → last)
- [ ] Enter activates focused element
- [ ] Back/Escape does NOT exit the app

---

### S-19: Crash recovery (P0, Play Store rejection risk)

**Preconditions:**
- App running and playing content
- Debug APK installed (required for `run-as` method)

**Steps (pick one crash method, in order of reliability):**

**Method A — SIGKILL (works on all Android versions, debug APK):**
```bash
# Get PID
PID=$(adb shell pidof com.vizora.display)
echo "Before crash: PID=$PID"

# Send SIGSEGV to trigger CrashRecoveryHandler
adb shell "run-as com.vizora.display kill -11 $PID"

# Wait for restart
sleep 5

# Verify new PID
NEW_PID=$(adb shell pidof com.vizora.display)
echo "After crash: PID=$NEW_PID"
```

**Method B — force-stop + verify AlarmManager restart (works on release APK):**
```bash
# Force-stop kills the process without triggering CrashRecoveryHandler
# BUT the AlarmManager pending intent from a prior crash (if any) would still fire.
# This tests the restart path, not the crash handler itself.
adb shell am force-stop com.vizora.display
sleep 5
adb shell pidof com.vizora.display  # Should show a PID if AlarmManager restarted
```

**Method C — if neither works, manually verify:**
1. Observe the app is running
2. Check logcat for CrashRecoveryHandler registration: `Thread.setDefaultUncaughtExceptionHandler`
3. Verify the handler code exists in the APK (code review — already confirmed)

**Expected Results:**
- [ ] App process restarts automatically within 3-5 seconds
- [ ] After restart, app loads with existing credentials (no re-pairing needed)
- [ ] Content playback resumes (or at minimum, content screen shown)
- [ ] No permanent crash loop (app stabilizes after 1 restart)

**Assertions:**
```
ASSERT: NEW_PID is set and differs from PID (process restarted)
ASSERT: content-screen visible after restart (not pairing-screen)
ASSERT: No repeated crash in logcat (single restart, not loop)
```

---

### S-20: Memory pressure / long-running stability (P1)

**Wall-clock time:** 1 hour. Run this as a soak test overnight or while doing other work.

**Preconditions:**
- Device paired, playlist playing (ideally with video + image mix for max churn)

**Steps:**
1. Start the monitoring script below
2. Let the app run for 1 hour continuously
3. Review the output log for memory growth

**Automated monitoring script (run on host machine):**
```bash
#!/bin/bash
# save as monitor-vizora.sh, run: bash monitor-vizora.sh
LOG="vizora-stability-$(date +%Y%m%d-%H%M).log"
echo "Monitoring com.vizora.display — output: $LOG"
echo "timestamp,total_pss_kb,java_heap_kb,native_heap_kb" > "$LOG"

for i in $(seq 1 60); do
  TS=$(date +%H:%M:%S)
  MEM=$(adb shell dumpsys meminfo com.vizora.display 2>/dev/null | grep "TOTAL PSS" | awk '{print $3}')
  JAVA=$(adb shell dumpsys meminfo com.vizora.display 2>/dev/null | grep "Java Heap:" | awk '{print $3}')
  NATIVE=$(adb shell dumpsys meminfo com.vizora.display 2>/dev/null | grep "Native Heap:" | awk '{print $3}')

  if [ -z "$MEM" ]; then
    echo "$TS — APP NOT RUNNING (crashed?)" | tee -a "$LOG"
  else
    echo "$TS,$MEM,$JAVA,$NATIVE" | tee -a "$LOG"
  fi
  sleep 60
done

# Check for growth
FIRST=$(sed -n '2p' "$LOG" | cut -d',' -f2)
LAST=$(tail -1 "$LOG" | cut -d',' -f2)
if [ -n "$FIRST" ] && [ -n "$LAST" ]; then
  GROWTH=$(( (LAST - FIRST) * 100 / FIRST ))
  echo "Memory growth: ${GROWTH}% (${FIRST}KB → ${LAST}KB)"
  if [ "$GROWTH" -gt 20 ]; then
    echo "FAIL: Memory grew >20% — possible leak"
  else
    echo "PASS: Memory stable"
  fi
fi
```

**Expected Results:**
- [ ] No memory leaks (TOTAL PSS growth < 20% over 1 hour)
- [ ] Video elements are cleaned up on content transitions (pause, remove src, load)
- [ ] No accumulated DOM elements (innerHTML cleared on each render)
- [ ] Content rotation continues without stuttering
- [ ] Heartbeats continue at 15s intervals
- [ ] App process doesn't restart (PID stays the same)

---

## Test Priority Matrix

| Test | Priority | Play Store Risk | Effort | Dependency |
|------|----------|----------------|--------|------------|
| P-01 | P0 | Crash, ANR | Low | None |
| P-02 | P0 | Stuck screen | Medium | P-01 |
| P-03 | P0 | Crash, ANR | Medium | Network toggle |
| P-04 | P1 | Silent failure | Medium | P-01, Network toggle |
| P-05 | P2 | None | Low | P-01 |
| P-06 | P2 | None | Low | P-01 |
| P-07 | P0 | Blank screen | Low | P-01 |
| P-08 | P0 | Boot failure | Medium | P-01, Reboot |
| P-09 | P1 | None | Low | P-01 |
| P-10 | P1 | None | Medium | Manual setup |
| S-01 | P0 | Blank screen | Low | P-01 |
| S-02 | P0 | Blank screen | Low | P-01 |
| S-03 | P1 | None | Low | P-01 |
| S-04 | P1 | None | Low | P-01 |
| S-05 | P0 | Stuck/crash | Medium | P-01 |
| S-06 | P0 | Blank screen | Medium | S-05, Network toggle |
| S-07 | P2 | None | Low | S-05 |
| S-08 | P0 | Crash | Low | S-05 |
| S-09 | P1 | Crash | Low | P-01 |
| S-10 | P1 | None | Medium | S-05 |
| S-11 | P0 | Stuck offline | Medium | P-01 |
| S-12 | P0 | Stuck | Medium | P-01, Server-side |
| S-13 | P1 | None | Low | P-01 |
| S-14 | P1 | None | Medium | P-01 |
| S-15 | P2 | None | Low | S-01 |
| S-16 | P2 | None | Medium | Server layout content |
| S-17 | P0 | Data leak | Low | P-01, logcat only |
| S-18 | P2 | None | Low | TV remote |
| S-19 | P0 | Play Store reject | Medium | ADB |
| S-20 | P1 | ANR, crash | High (1 hour) | P-01 |

---

## Minimum Viable E2E Suite (for confident Play Store submission)

Execute in this order:

1. **P-01** Fresh pairing happy path
2. **P-07** Pairing survives app restart
3. **P-08** Pairing survives device reboot + auto-launch
4. **P-03** Pairing with no network → recovery
5. **S-01** Image content display
6. **S-02** Video content display + autoplay
7. **S-05** Multi-item playlist rotation + looping
8. **S-08** Playlist update mid-playback
9. **S-06** Offline playback from cache
10. **S-11** WebSocket reconnection
11. **S-12** Expired token → re-pairing
12. **S-19** Crash recovery
13. **S-17** Token not leaked to third-party URLs
14. **S-17b** API content loads with token (no 401)

**Total: 14 tests = minimum confident release**

---

## Known Risks / Open Issues

| Risk | Impact | Mitigation |
|------|--------|------------|
| ~~`push_content` with undefined `content` crashes at `content.name` (line 976)~~ | ~~Crash~~ | **FIXED** — `command.payload?.content != null` guard added, logs warning instead of crashing |
| `handleCommand` switch has no try/catch | Unhandled errors from any command crash the event handler | Wrap switch body in try/catch |
| Alpha `security-crypto:1.1.0-alpha06` dependency | Play Store review flag | Pin to stable `1.0.0` (already planned) |
| Cleartext traffic allowed in debug build | Play Store review if wrong build submitted | Use release build with cleartext disabled |
| No retry limit on WebSocket reconnection | Theoretical infinite reconnect loop | `reconnectionAttempts: Infinity` is intentional for 24/7 signage |

---

## Log Monitoring Reference

Key logcat filters during E2E testing:

```bash
# All Vizora logs
adb logcat -s Vizora

# Key patterns to watch for:
# Success: "Device paired successfully!"
# Success: "Connected to realtime gateway"
# Success: "Playing content N/M: {name}"
# Success: "[AndroidCache] Cached: {id}"
# Warning: "Playlist is empty"
# Warning: "Unknown content type: {type}"
# Error:   "Fatal initialization error"
# Error:   "Pairing request failed"
# Error:   "Connection error"
# Error:   "Token invalid, clearing credentials..."
```
