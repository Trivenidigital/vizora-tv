# Google Play Submission Checklist — Vizora Display (Android TV)

**Status basis:** P0-4 slice (branch `feat/p0-4-play-readiness`), 2026-07-02.
**Gate:** Per operator direction, do NOT submit to Play until P0-1 (playback state
machine), P0-2 (revocation contract), and P0-3 (boot survivability) are merged —
Play approval of the current build would ship the fleet de-pair bomb (F3).

## 1. Technical requirements

| Item | Status | Evidence |
|---|---|---|
| Target API 35 (required for new apps since 2025-08-31) | ✅ code | `android/variables.gradle` (compile+target 35); AGP 8.7.2, Gradle 8.11.1 |
| Legacy immersive flags replaced (ignored under target 35 edge-to-edge) | ✅ code | `MainActivity.java` — WindowInsetsControllerCompat |
| `USE_EXACT_ALARM` removed (Play policy: alarm/calendar apps only) | ✅ | `AndroidManifest.xml`; `CrashRecoveryHandler` falls back to windowed alarm when exact-alarm not granted (API 33+) |
| AAB packaging | ✅ config | `capacitor.config.ts` releaseType AAB; build via `cd android && ./gradlew bundleRelease` |
| Debug build compiles under SDK 35 | ⬜ verify | `./gradlew assembleDebug` (run in this slice — see PR description for result) |
| Emulator smoke on API 35 image | ⬜ manual | pair→play→kill-network→recover per repo test spec |
| **On-device sanity of WindowInsets fullscreen** | ⬜ manual | Prior report only verified the legacy flags; re-verify no status bar on API 34+35 emulator |

## 2. TV quality requirements

| Item | Status | Evidence |
|---|---|---|
| LEANBACK_LAUNCHER intent | ✅ | `AndroidManifest.xml:39` |
| Touchscreen/leanback features not required | ✅ | `AndroidManifest.xml:13-14` |
| TV banner 320×180 (real banner, not stretched launcher icon) | ✅ | `res/drawable-xhdpi/tv_banner.png`, manifest `android:banner="@drawable/tv_banner"` |
| Landscape orientation | ✅ | `sensorLandscape` |
| D-pad: no crash, Back doesn't exit | ✅ | unit + prior E2E S-18 |

## 3. Listing & policy

| Item | Status | Notes |
|---|---|---|
| Privacy policy URL live | ⬜ manual | https://vizora.io/privacy (verify it resolves before submission) |
| Data-safety form | ⬜ manual | Declare: **device/diagnostic data collected** — device model/screen metrics/user-agent (at pairing), uptime/memory/screen-state (heartbeat, 15s), content-playback IDs (impressions), optional crash reports (Sentry, if DSN configured). No personal data, no ads, data encrypted in transit, not shared with third parties (Sentry = service provider if enabled). The old "No personal data collection" claim in `store-listing/PLAY_STORE_LISTING.md:49` is *defensible* but the diagnostic-data declarations above are still mandatory. |
| Crash reporting disclosure | ⬜ manual | If `VITE_SENTRY_DSN` is set in the release build, list Sentry as a data processor in the privacy policy |
| SYSTEM_ALERT_WINDOW justification | ⏸ pending P0-3 | Only needed if the approved kiosk posture (boot-survivability investigation §4) adds the overlay permission — write the declared-use text then |
| App category / content rating questionnaire | ⬜ manual | Business tools; no user-generated public content |

## 4. Release hygiene

| Item | Status | Notes |
|---|---|---|
| Keystore outside the repo tree | ⬜ **manual — do this before the next release build** | `android/vizora-release.jks` currently sits inside the working tree (gitignored via `android/.gitignore:56`, never committed — verified with `git log --all`). Move it to a secrets location, e.g. `%USERPROFILE%\.vizora\keys\vizora-release.jks`, update `android/keystore.properties` `storeFile=` to the absolute path, and record the backup location + passwords in the password manager. The publishing guide's own warning (`GOOGLE_PLAY_PUBLISHING.md`) already mandates this. |
| `keystore.properties` not committed | ✅ | gitignored; `keystore.properties.example` is the template |
| Version alignment | ✅ | `package.json` 1.0.1 == `versionName` 1.0.1 (heartbeat now reports the true version); bump `versionCode` (10135 → next) at release cut |
| R8 mapping retention | ⬜ manual | `android/app/build/outputs/mapping/release/mapping.txt` — upload to Play (deobfuscation) and to Sentry if DSN enabled; archive per release |
| Staged rollout plan | ⬜ manual | Internal testing track → closed track (own devices ≥1 week soak) → production at 10% → 100%. Halt criteria: any crash-rate rise or a `playback_holding` event storm in Sentry |
| Bad-build runbook | ⏸ P1-3 | "Bad build on 200 TVs": halt rollout in Play Console, roll forward with a fixed versionCode (Play has no true rollback), remotely `reload`-command devices post-update; document fully in P1-3 |

## 5. Crash reporting (F14 partial closure)

- `src/crash-reporting.ts`: @sentry/browser — JS exceptions, unhandled rejections,
  breadcrumbs; tagged with `deviceId`; release tagged `vizora-tv@<version>`.
- **No-DSN builds are a strict no-op** (nothing initialized or sent).
- Native (Java/NDK) crash capture requires `@sentry/capacitor` (adds a native
  module): scheduled with the P0-3 hardware pass so the gradle change is
  verified on a real device. Until then, native crashes are visible only as
  heartbeat gaps.
