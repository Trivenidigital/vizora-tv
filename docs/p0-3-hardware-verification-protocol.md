# P0-3 Hardware Verification Protocol (cold-start runnable)

**Purpose:** prove or disprove boot auto-start (F1) and crash restart (F2) on real
hardware, and select the kiosk posture. Decision record: posture **B** (SYSTEM_ALERT_WINDOW
grant) approved conditionally; **if the SAW grant flow is unavailable on the certified
device, launcher mode (C) becomes primary without further approval**
(`docs/design/boot-survivability-investigation.md` §7).

**Acceptance for the P0-3 implementation slice:** P-08 and S-19 pass on hardware, plus
native crash capture wired (@sentry/capacitor) and verified on-device.

---

## 0. Prerequisites

- **Devices:** (D1) Onn 4K Pro or equivalent *certified Google TV* box, API 31+;
  (D2) one generic *AOSP* Android TV box (ideally API 28–30). Factory-reset both.
- **Host:** this repo checked out; Android SDK platform-tools (`adb`); USB or network adb
  to both devices (`adb connect <ip>:5555` after enabling developer options + network debugging).
- **Backend:** the local mock — `node scripts/mock-backend.mjs` — with the device on the same
  LAN. Build the app against the host's LAN IP (NOT 10.0.2.2, which is emulator-only):
  1. Copy `.env.smoke` → `.env.hw`; replace `10.0.2.2` with the host LAN IP (3 lines).
  2. `npx vite build --mode hw && npx cap sync android`
  3. `cd android && ./gradlew assembleDebug`
     (On this Windows host prepend `JAVA_TOOL_OPTIONS="-Djavax.net.ssl.trustStoreType=Windows-ROOT"`.)
  4. Note: the **debug** network-security config only whitelists localhost cleartext — for a
     LAN-IP mock either add the host IP to
     `android/app/src/debug/res/xml/network_security_config.xml` or serve the mock over
     HTTPS. Do the former; do not weaken the release config.
  - **NEVER pair these devices against production** (`api.vizora.io`). Staging is acceptable
    if credentials exist; the mock is the default.
- **Install:** `adb -s <serial> install -r android/app/build/outputs/apk/debug/vizora-display-1.0.1-debug.apk`
- Pair each device once against the mock (code `SMOKE1` auto-pairs) and confirm the smoke
  image plays before starting any test below.

## 1. SAW grant availability (posture decision input)

On **D1** (certified):
1. Settings → Apps → Special app access → *Display over other apps* — is `Vizora Display`
   listed and toggleable? Record yes/no + screenshot.
2. If the Settings path is absent, try `adb shell appops set com.vizora.display.debug SYSTEM_ALERT_WINDOW allow`
   then `adb shell appops get com.vizora.display.debug SYSTEM_ALERT_WINDOW` → expect `allow`.
3. **Decision:** if neither works on D1 → launcher mode (C) becomes the primary posture
   (pre-approved). Record the outcome in the decision record.

## 2. P-08 — boot auto-start

For each device, in each state ({SAW granted, SAW not granted} on D1; {default} on D2):

| Step | Command / action | Pass criterion |
|---|---|---|
| 1 | Confirm app playing content | image on screen |
| 2 | Pull power at the wall (not remote standby) | — |
| 3 | Wait 10s, restore power | — |
| 4 | Start a timer; do NOT touch the remote | app in foreground AND content rendering ≤ 3 min |
| 5 | `adb logcat -d \| grep VizoraBootReceiver` | receiver fired; if fired but no launch, capture the BAL denial line (`grep ActivityTaskManager.*background`) |
| 6 | Repeat ×5 | 5/5 for a PASS |

Record per-device/per-state results. Expected: D2 passes stock; D1 fails without SAW,
passes with SAW — if D1 fails **with** SAW, escalate to posture C/D immediately.

## 3. S-19 — crash restart

On each device (SAW state as decided in §1–2):

- **S-19a JVM crash:** `adb shell am crash com.vizora.display.debug`
  → PASS: app relaunches ≤ 30s and resumes playback; `VizoraCrashRecovery` log shows the
  scheduled restart.
- **S-19b native crash:** `adb shell "run-as com.vizora.display.debug kill -11 $(adb shell pidof com.vizora.display.debug)"`
  → documented gap: the Java handler never sees SIGSEGV. PASS = relaunch via any mechanism
  OR explicit FAIL recorded (this drives the native-capture requirement, not a blocker for
  the posture decision).
- **S-19c crash loop:** build a variant that throws in `MainActivity.onCreate` (one-line
  temporary patch), install, observe 15 min → PASS: restart back-off escalates (3s → 30s →
  5min per the P0-3 implementation) and the device does not thermal-runaway. *(Runnable only
  after the P0-3 implementation lands — the current code restarts at a fixed 3s.)*

## 4. UPD-1 — package-replaced relaunch

1. Bump `versionCode`, rebuild, `adb install -r` while content is playing.
2. PASS: app relaunches without human input ≤ 1 min. *(Requires the P0-3
   MY_PACKAGE_REPLACED receiver; on current code record the gap.)*

## 5. HOME-1 — remote interference

1. Press HOME on the physical remote.
2. Record: does anything relaunch the app? (Expected: no, on posture B.)
3. Verify from the mock log that heartbeats STOP (this is the fleet signal an operator
   would see). Record time-to-silence.
4. Relaunch manually; note this as the known limitation of posture B vs device-owner (D).

## 6. Native crash capture (slice acceptance)

After wiring @sentry/capacitor (P0-3 implementation): re-run S-19b with a DSN configured →
PASS: the SIGSEGV appears in Sentry with device tag and symbolicated native frames.

## 7. Reporting

Fill the table and commit as `docs/p0-3-hardware-results.md`:

| Test | D1 no-SAW | D1 SAW | D2 | Verdict |
|---|---|---|---|---|
| P-08 boot ×5 | | | | |
| S-19a JVM crash | | | | |
| S-19b native crash | | | | |
| S-19c crash loop | | | | |
| UPD-1 pkg replaced | | | | |
| HOME-1 | | | | |
| SAW grantable (§1) | n/a | | n/a | posture: B / C |

Attach logcat excerpts for every FAIL. The posture decision + these results gate the P0-3
implementation merge.
