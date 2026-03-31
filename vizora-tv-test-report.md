# Vizora TV — Pre-Submission Test Report
**Date:** 2026-03-31
**App Version:** 1.0.1 (versionCode: 10135)
**Target SDK:** 34
**Min SDK:** 23
**Tested on:** Android TV Emulator — sdk_gphone64_x86_64, API 34, 1920x1080, density 320

## Overall Verdict: READY FOR SUBMISSION

Three bugs were found and fixed during testing. All fixes are merged to master.

---

## Google Play TV Quality Criteria

| Criterion | Status | Notes |
|-----------|--------|-------|
| LEANBACK_LAUNCHER | PASS | Present in manifest activity resolver |
| D-pad navigation | PASS | All screens navigable; Back doesn't crash |
| No touchscreen dependency | PASS | No `uses-feature` touchscreen required |
| TV banner (320x180) | PASS | Displays on home screen |
| Landscape orientation | PASS | sensorLandscape (satisfies Play Store) |
| No prohibited permissions | PASS | Only INTERNET, ACCESS_NETWORK_STATE, BOOT_COMPLETED, WAKE_LOCK, USE_EXACT_ALARM |
| Memory limits | PASS | 88-106MB (well under 256MB limit) |
| Screen saver prevention | PASS | `keepScreenOn=true`; `mWakefulness=Awake` confirmed |
| Fullscreen (no status bar) | PASS | Fixed: immersive mode added (was visible before fix) |
| Target SDK >= 34 | PASS | targetSdk=34 |
| 64-bit support | PASS | WebView-based (Capacitor); no native libs |

## Functionality Test Results

| Suite | Tests | Passed | Failed | Notes |
|-------|-------|--------|--------|-------|
| 1. TV Quality Criteria | 11 | 11 | 0 | All pass after fullscreen fix |
| 2. Pairing Flow | 5 | 5 | 0 | QR code, pairing code, countdown, persistence |
| 3. Content Display | 5 | 5 | 0 | Templates render after renderedHtml fix |
| 4. WebSocket & Network | 4 | 4 | 0 | Connect, disconnect/reconnect, no crash |
| 5. Fleet Commands | 2 | 2 | 0 | Playlist push verified |
| 6. Offline & Caching | 3 | 3 | 0 | Cached content survives offline; no crash |
| 7. Auto-Start & Persistence | 3 | 3 | 0 | Token persists across restarts; boot receiver registered |
| 8. Token & Security | 3 | 3 | 0 | Token in EncryptedSharedPreferences; not in plaintext |
| 9. Error Handling | 2 | 2 | 0 | No crash on network loss, D-pad, back button |
| 10. WebView Security | 3 | 3 | 0 | CSP active; sandbox allow-scripts only; HTTPS |
| 11. Play Store Compliance | 3 | 3 | 0 | Privacy policy accessible; target SDK 34 |
| 12. Store Assets | 1 | 1 | 0 | Pairing screenshot captured |
| **TOTAL** | **45** | **45** | **0** | |

## Critical Issues Found and Fixed

| Bug | Severity | Status | Fix |
|-----|----------|--------|-----|
| Status bar visible on TV | BLOCKING | FIXED | Added immersive mode flags in MainActivity.java |
| Templates not rendering (blank) | CRITICAL | FIXED | Read `metadata.renderedHtml` instead of empty `content.url` |
| Google Fonts blocked by CSP | HIGH | FIXED | Updated CSP to allow fonts.googleapis.com/gstatic.com |

All three fixes merged to master via PR #5.

## Warnings (Non-blocking)

| Item | Severity | Notes |
|------|----------|-------|
| `setSystemUiVisibility` deprecated | LOW | Works on API 34; migrate to WindowInsetsController before targeting API 35+ |
| `img-src https:` in CSP | LOW | Allows loading images from any HTTPS domain; acceptable for controlled signage |
| Test image is 1x1 pixel (337 bytes) | INFO | Content appears black; real content renders fine (Tandoor template verified) |

## Performance Metrics

| Metric | Value |
|--------|-------|
| App startup to pairing screen | ~10s |
| Pairing code entry to paired | ~3s |
| WebSocket connection after launch | ~8s |
| Content push latency (playlist assign) | ~5s |
| Memory at launch | 88 MB |
| Memory after content + reconnect cycle | 106 MB |
| Memory growth rate | Stable (~6% over 15 min, no leak) |
| Screen timeout setting | 2147483647 (max int — stays awake) |

## Unit Test Results

- **181/181 tests pass** (2 skipped)
- 3 test files: main.spec.ts (18), cache-manager.spec.ts (29), vizora-app.spec.ts (134)
- Zero failures, stable across 5 consecutive runs

## Screenshots Captured

| File | Description |
|------|-------------|
| test_pairing_screen.png | Pairing screen with QR code and LJNK8R code |
| test_tandoor_template.png | Tandoor & Kebab restaurant template rendering |
| test_fullscreen2.png | Fullscreen mode verified (no status bar) |
| test_paired_screen.png | Post-pairing connected state |
| test_suite4_offline.png | App during WiFi disconnect |
| test_suite4_reconnect.png | App after WiFi reconnect |
| test_suite7_restart.png | App after force-stop and relaunch |

## Recommendation

**SUBMIT** — All Google Play TV quality criteria pass. Three critical bugs were found and fixed during testing. The app renders content correctly, handles network interruptions gracefully, persists pairing across restarts, and runs fullscreen without status bar. Memory usage is stable at ~100MB.

Before submission:
1. Build release bundle (not debug APK) with version 10135/1.0.1
2. Verify on physical Android TV device if available
3. Capture final Play Store screenshots from the release build
