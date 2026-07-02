# P0-3 Gate — Boot Auto-Start & Crash-Restart Investigation

**Status:** FINDINGS — awaiting operator decision on kiosk posture before implementation.
**Findings addressed:** F1 (boot auto-start broken on API 29+), F2 (crash restart unproven +
no loop back-off), F18-part (no relaunch after Play update).
**Acceptance tests for the eventual slice (per operator):** P-08 (reboot E2E) and a re-run of
S-19 (crash restart) on physical hardware — the two tests that were skipped/failed in March.

---

## 1. The mechanism that is broken, precisely

Both survival paths funnel through a **background activity launch (BAL)**:

- `BootReceiver.java:22-24` — `context.startActivity()` from a `BOOT_COMPLETED` receiver.
- `CrashRecoveryHandler.java:36-58` — `AlarmManager` firing a `PendingIntent.getActivity()`
  after the process died.

Since Android 10 (API 29), apps without an exemption cannot start activities from the
background. The documented exemption relevant to signage: **the app holds
`SYSTEM_ALERT_WINDOW` ("Display over other apps")**. Others (foreground task back-stack,
recent-user-interaction, companion device) don't apply to a freshly booted or crashed box.
Consequence: on any Play-certified Android 10+ device, both mechanisms silently no-op — the
alarm fires, the intent is dropped, logcat notes a blocked BAL, the screen stays dark.

Empirical record: S-19 (crash restart) **failed** on the API 34 emulator; P-08 (reboot) was
never run. Nothing in the repo has ever observed either mechanism working on API 29+.

## 2. Target hardware reality

`docs/samsung-tv-deployment.md` establishes the recommended fleet device: **Onn 4K Pro
(~$50, Walmart) — a Google-certified Google TV device**, plus whatever customers already own
(mixed AOSP boxes). This matters because the options below split on certification:

- **Certified Google TV** (Onn, Chromecast, most retail boxes 2021+): third-party HOME
  replacement is effectively unavailable (Google TV pins its launcher; "set default launcher"
  UI does not exist; FLAG_HOME workarounds are fragile and policy-hostile). `SYSTEM_ALERT_WINDOW`
  **is grantable** via Settings → Apps → Special app access → Display over other apps, and via
  `adb shell appops set com.vizora.display SYSTEM_ALERT_WINDOW allow`.
- **Generic AOSP TV boxes** (much of the signage aftermarket): launcher replacement works and is
  the industry-standard kiosk posture; many also still deliver receiver `startActivity` (OEMs
  relax BAL), which is why the current code *appears* to work in some vendor demos.

## 3. Option matrix

| # | Option | Boot restart | Crash restart | HOME-button recovery | Play policy | Works on Onn/Google TV | Ops burden |
|---|---|---|---|---|---|---|---|
| A | Status quo (receiver + alarm) | ✗ on 29+ | ✗ on 29+ | ✗ | clean | ✗ | none — and it doesn't work |
| B | **A + `SYSTEM_ALERT_WINDOW` grant** | ✓ (BAL exemption) | ✓ (same exemption) | partial (watchdog possible) | SAW needs a declared use case; kiosk/signage is an accepted justification, must be described in the listing | ✓ | one-time per-device grant (Settings or adb), guided in-app |
| C | Launcher replacement (HOME intent) | ✓ (OS launches launcher) | ✓ (launcher respawned) | ✓ (HOME = us) | fine (launcher category) | ✗ (certified GTV) | user sets default launcher; AOSP only |
| D | Device Owner provisioning (`dpm set-device-owner`) + lock task | ✓ | ✓ | ✓ (lock task blocks HOME) | fine (device management) | ✓ | factory-fresh provisioning per device; not installable-from-Play-then-done; right answer for managed B2B fleets |
| E | Foreground service + full-screen intent | — | — | — | FSI restricted to calls/alarms on API 34+; rejection | ✗ | — |

## 4. Recommendation (pending your approval)

**Layered posture, B as the Play-shipped baseline, C and D as documented deployment modes:**

1. **Ship B in-app:** keep receiver + alarm; add a first-run/pairing-screen step that detects
   `Settings.canDrawOverlays()` and walks the installer through granting "Display over other
   apps" (with the adb one-liner shown for fleet installers). Telemetry reports grant state in
   the heartbeat so the dashboard can flag unprotected devices. Declare the SAW justification in
   the Play listing (signage auto-recovery).
2. **Crash-restart hardening regardless of posture:** persisted crash-timestamp ring buffer;
   back-off 3s → 30s → 5min; after 3 crashes in 10 min, stop auto-restarting *the same session*
   and rely on the next boot/alarm window (prevents the infinite 3s loop); every scheduled
   restart writes a breadcrumb so the next launch can report `recovered_from_crash` telemetry.
3. **Add `ACTION_MY_PACKAGE_REPLACED` receiver** (same BAL rules — works once SAW is granted):
   closes the Play-update-leaves-app-dead hole (F18-part).
4. **Document C (AOSP launcher mode) and D (device-owner kiosk)** in the deployment guide as the
   recommended postures for unattended fleets; D additionally solves the HOME-button exposure
   (§1.7 of the review) which B only mitigates.

Not recommended: E (policy-dead), or betting on A (empirically dead).

## 5. Hardware verification protocol (must run BEFORE merging implementation)

Devices: one Onn 4K Pro (Google TV, API 31+) and one generic AOSP TV box (ideally API 28-era),
both paired to **staging** only.

| Test | Steps | Pass criterion |
|---|---|---|
| P-08a boot, no SAW | pair → pull power → restore | (expected fail on certified; record exact logcat BAL denial) |
| P-08b boot, SAW granted | grant overlay → pull power → restore | app foreground + content rendering ≤ 3 min, ×5 runs |
| S-19a Java crash | `adb shell am crash com.vizora.display` | relaunch ≤ 30s with SAW; breadcrumb telemetry present |
| S-19b native crash | inject SIGSEGV (documented bypass — handler never sees it) | relaunched by next boot OR document as known gap |
| S-19c crash loop | build with crash-on-start flag | back-off observed: 3s, 30s, 5min, then hold; no thermal runaway |
| UPD-1 package replaced | `adb install -r` newer build | app relaunches without human input |
| HOME-1 remote interference | press HOME | B: dashboard flags device non-foreground (heartbeat gap) ≤ 60s; D: HOME blocked |

Live-safety: staging backend, test devices only, no Play uploads, no production pairing.

## 6. Decision needed from operator

1. Approve posture **B baseline + C/D documented** (or direct otherwise — e.g., D-only for a
   fully managed fleet, which changes the Play story since device-owner installs bypass Play).
2. Confirm access to the two physical test devices, or authorize purchasing them — §5 cannot run
   on emulators (the March report's failure to catch F1/F2 is exactly emulator blindness).
3. Confirm SAW justification text can be added to the Play listing/data-safety narrative.

---

## 7. DECISION RECORD (operator, 2026-07-02)

Posture **B approved conditionally**: proceed to hardware verification on both
devices (Onn 4K Pro certified Google TV + one generic AOSP box). If the
"Display over other apps" grant flow is unavailable on the certified device,
**launcher mode (C) becomes the primary posture without further approval**.
Acceptance tests for the implementation slice: **P-08 (reboot E2E) and a
re-run of S-19 (crash restart) on physical hardware**, plus **native crash
capture** (e.g. @sentry/capacitor) which is now part of this slice's
acceptance criteria — not deferred.
