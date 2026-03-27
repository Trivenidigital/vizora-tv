# Vizora TV E2E Test Results

**Date:** 2026-03-27
**Environment:** Vizora_TV emulator (API 34, x86_64) ↔ vizora.cloud (VPIN VPS)
**APK:** vizora-display-1.0.0-debug.apk (4.2 MB, built Mar 27 14:28)
**Package:** com.vizora.display.debug

---

## Execution Summary

| Test | Name | Result | Evidence |
|------|------|--------|----------|
| P-01 | Fresh pairing happy path | ✅ PASS | p01_pairing.png, p01_paired.png |
| P-03 | Pairing with no network → recovery | ✅ PASS | p03_offline.png, p03_recovered.png |
| P-07 | Pairing survives app restart | ⚠️ PARTIAL | p07_restart.png — credentials survived, content black screen |
| P-08 | Pairing survives device reboot | ⏭️ SKIPPED | Requires physical device (emulator adb reboot flaky) |
| S-01 | Image content display | ✅ PASS | Verified during P-01 (Timberlin Village image) |
| S-02 | Video content display | ⏭️ SKIPPED | Requires dashboard to assign video playlist |
| S-05 | Multi-item playlist rotation | ⏭️ SKIPPED | Requires dashboard to assign multi-item playlist |
| S-06 | Offline playback from cache | ⚠️ INCONCLUSIVE | Emulator has cellular fallback; WiFi-only disconnect didn't fully offline |
| S-08 | Playlist update mid-playback | ⏭️ SKIPPED | Requires dashboard to push new playlist |
| S-11 | WebSocket reconnection | ⚠️ INCONCLUSIVE | Same cellular fallback issue |
| S-12 | Expired token → re-pairing | ✅ PASS | s12_repairing.png — new code R5EHC4 after credential wipe |
| S-17 | Token not leaked to third parties | ✅ PASS | Logcat grep: zero token= on non-vizora URLs |
| S-17b | API content loads with token | ✅ PASS | Content downloaded + cached with ?token= param |
| S-18 | D-pad navigation | ✅ PASS | s18_dpad.png — no crash, Back doesn't exit |
| S-19 | Crash recovery | ❌ FAIL | SIGSEGV killed app but CrashRecoveryHandler did NOT restart |

---

## Results: 7 PASS, 1 FAIL, 2 PARTIAL, 1 INCONCLUSIVE, 4 SKIPPED (need dashboard)

---

## Bugs Found

### BUG-1: Black screen after app restart (P-07) — SEVERITY: HIGH

**Steps to reproduce:**
1. Pair device, content displays normally
2. Force-stop app (`adb shell am force-stop`)
3. Relaunch app

**Expected:** Content screen with restored playlist visible
**Actual:** Content screen shown (not pairing), status shows "Connected" (green), but content area is completely black

**Root cause hypothesis:** The restored playlist from Preferences is loaded, `showScreen('content')` is called, and WebSocket connects — but `playContent()` is never called on the restored playlist after restart. The code at main.ts:163-181 restores the playlist but only calls `playContent()` inside the socket `connect` handler (line 704) when `!this.playbackTimer` AND `this.currentPlaylist.items?.length > 0`. If the WebSocket connects before the playlist is restored from async Preferences, the check fails.

**Impact:** After any app restart (force-stop, crash recovery, OOM kill), user sees black screen until server pushes a new playlist:update event. This defeats the purpose of offline playlist persistence.

**Screenshot:** docs/p07_restart.png

---

### BUG-2: CrashRecoveryHandler doesn't restart app (S-19) — SEVERITY: HIGH

**Steps to reproduce:**
1. App running on emulator
2. `adb shell "run-as com.vizora.display.debug kill -11 $(pidof com.vizora.display.debug)"`
3. Wait 10+ seconds

**Expected:** App auto-restarts within 3-5s via AlarmManager PendingIntent
**Actual:** App process dies and never restarts. AlarmManager shows no pending vizora intents.

**Root cause hypothesis:** On API 34 (Android 14), `PendingIntent.FLAG_ONE_SHOT | FLAG_IMMUTABLE` with `AlarmManager.set()` may be restricted by battery optimization or exact alarm policies. Android 12+ requires `SCHEDULE_EXACT_ALARM` permission for exact alarms. The CrashRecoveryHandler uses `AlarmManager.set()` (non-exact) which should still work, but the emulator's AlarmManager implementation may behave differently from physical devices.

**NOTE:** This should be retested on a physical Android TV device before concluding it's a real bug. Emulator AlarmManager behavior is known to be inconsistent.

**Impact:** If this fails on real devices too, the app won't auto-recover from native crashes — leaving a blank screen on a 24/7 signage display until manual intervention.

---

### BUG-3: S-06 offline test blocked by cellular fallback — SEVERITY: LOW (test environment issue)

Not a code bug. The emulator falls back to cellular (3G) when WiFi is disabled via `svc wifi disable`, so the app never detects "offline" state. On a real Android TV device (which has no cellular radio), this test would work correctly.

**Workaround for emulator:** Use `adb shell svc wifi disable && adb shell svc data disable` to fully disconnect. However, the emulator's cellular radio re-enables automatically in some cases.

---

## Tests Requiring Dashboard Interaction

These tests could not be executed autonomously and need a human operator:

| Test | What's needed |
|------|---------------|
| S-02 | Assign a video playlist to the device from vizora.cloud dashboard |
| S-05 | Assign a multi-item playlist (3+ items: image, video, image) |
| S-08 | While content is playing, assign a different playlist |
| S-11 | Observe WebSocket disconnect/reconnect during a server restart |
| P-08 | Test on physical Android TV device (emulator reboot is flaky) |

---

## Test Evidence (Screenshots)

| File | Description |
|------|-------------|
| p01_pairing.png | Pairing screen: code RQPNKF, QR code, countdown 4:38 |
| p01_paired.png | Content screen: Timberlin Village image, "Connected" status |
| p03_offline.png | Error screen: "No network connection" with warning icon |
| p03_recovered.png | Pairing screen: code DVW893 after network restore |
| p07_restart.png | Black content screen after restart (BUG-1) |
| s06_*.png | Black screen throughout offline test (pre-existing from BUG-1) |
| s12_repairing.png | Pairing screen: code R5EHC4 after credential wipe |
| s18_dpad.png | Pairing screen still visible after D-pad + Back key |

---

## Recommendations Before Play Store Submission

### Must Fix (P0)
1. **BUG-1 (black screen after restart):** Ensure `playContent()` is called after playlist restoration, regardless of WebSocket timing. Suggested fix: call `this.playContent()` immediately after restoring playlist from Preferences (line ~175), not just in the socket connect handler.

2. **BUG-2 (crash recovery):** Retest on physical device first. If confirmed, check if `SCHEDULE_EXACT_ALARM` permission is needed on API 31+ or if `setAndAllowWhileIdle()` is required.

### Must Execute with Dashboard (P0)
3. S-02 (video playback), S-05 (playlist rotation), S-08 (mid-playback update) — these cover the primary user-facing functionality and must pass before submission.

### Safe to Ship
4. All pairing flows work correctly (P-01, P-03, S-12)
5. Token security verified (S-17, S-17b)
6. D-pad navigation doesn't crash (S-18)
7. No ANRs detected in any test
