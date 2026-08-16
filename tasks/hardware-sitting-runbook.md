# Hardware sitting runbook — native crash-recovery lane

Branch `work/fix-native` (PR #39). Applies to `com.vizora.display` 1.3.15 / versionCode 10145
plus the commits on this branch.

**Purpose.** Every remaining blocker in this lane is blocked on the same kind of fact: what a
real Google TV box does with an activity start that our code has already issued correctly. Unit
tests cannot answer that. This document is the whole sitting — execute it top to bottom without
reconstructing the reasoning behind it.

**What this document does NOT claim.** Nothing here asserts that an alarm-fired `startActivity`
against a dead process relaunches the app on a certified Google TV. That is the open question,
not an assumption. Test 1 exists to answer it.

---

## The three launch postures

There is no single "background activity launch" question in this lane. There are three, and a
result for one is **not** a result for another. Record them separately.

| | Where | Posture | Gated? |
|---|---|---|---|
| **P1** | `CrashRecoveryHandler` relaunch alarm | fires against a **dead** process | yes |
| **P2** | `BootReceiver.java:48` | `startActivity` from `onReceive`, **no foreground** | yes, and independently of P1 |
| **P3** | `MainActivity.java:192` (F36 renderer recovery) | `startActivity` from a **live foreground** activity | no — not a background launch |

P3 is included only so it is not mistakenly re-tested as if it were gated. A device could permit
P1 and block P2, or the reverse.

---

## Equipment and preconditions

- A certified Google TV / Android TV box, Android 12+ (the restricted regime). Note the exact
  model, Android version and build fingerprint in the results table — findings do not generalise
  across OEMs.
- `adb` over network or USB.
- A **debug** build of this branch installed. Debug is required for Test 1's crash trigger.
- The device on mains power and idle, i.e. the normal fielded posture.
- `adb logcat -s VizoraCrashRecovery VizoraMainActivity VizoraBootReceiver` running throughout
  and captured to a file. Several tests read from the same log.
- **Do not** use `adb shell am force-stop` to simulate a crash anywhere in this runbook. A
  force-stop cancels the app's alarms, so it would answer a different question and look like a
  P1 failure.

---

## Test 1 — the single-exception test  ⚑ HIGHEST DISCRIMINATING POWER, RUN FIRST

**Resolves:** B1 (unattended crash recovery), and by extension B2 (the ladder's benefit). Also
classifies which world every "correct-under-both" item is operating in.

**Posture:** P1.

**Method.** Start the app, let it reach normal playback, then trigger one uncaught Java
exception from the debug build. **Then do not touch the box at all** — no remote, no `adb
shell am start`, no power button. Touching it invalidates the result, because a foreground
start is P3 and would tell you nothing about P1.

**Observe.** The screen, and the log line `Restart scheduled in 3000ms`, then whether the app
returns.

**What each result means:**

| Result | Meaning |
|---|---|
| App returns on its own in roughly 3 s (allow up to ~9 min, see Test 2) | **World A.** P1 permitted. B1 and B2 resolved affirmatively. The ladder does what it was built to do. |
| `Restart scheduled` is logged but the app never returns; screen stays dark until you intervene | **World B.** P1 blocked. B1 and B2 are **not** achievable by this mechanism; the ladder is inert (it is not harmful — see the classification — but it does not recover the device). Escalate: unattended crash recovery needs a different mechanism, not a tuning change. |
| No `Restart scheduled` line at all | Neither world — a defect in our code, not a platform limit. Capture the full log and stop; this contradicts the unit tests and needs investigation before anything else in this runbook is meaningful. |

**Repeat once** after a reboot, to distinguish a permitted-but-flaky launch from a blocked one.

---

## Test 2 — restart latency and the idle quota

**Resolves:** B4 (delivered latency of `setAndAllowWhileIdle`), and B6 (whether a scheduled
alarm survives process death on this OEM build).

**Only meaningful if Test 1 returned World A.** In World B nothing is delivered that does
anything, so skip and record as "not applicable — P1 blocked".

**Method.** From Test 1, measure wall-clock time between the `Restart scheduled in 3000ms` log
line and the app reappearing. Then repeat with the screen off / device idle for 15 minutes
first, to put the box in whatever idle state it actually uses.

**Observe.** Requested delay vs. actual delay, for the 3 s rung specifically — it is the rung
most sensitive to deferral.

**What each result means:**

| Result | Meaning |
|---|---|
| Actual ≈ requested (seconds) | The inexact alarm is being delivered promptly on this hardware. B4 closed. |
| Actual is minutes late, bounded (≲ 9 min) | The `setAndAllowWhileIdle` quota is biting. Expected and acceptable — the ladder still works, the first rung is just slower. Record the observed figure. |
| Actual is unbounded / never fires when idle | The alarm is being deferred indefinitely despite the idle exemption. B4 fails; the recovery mechanism needs revisiting for idle boxes. |

**Note this is a product question, not a correctness one, on API 24+.** See "Retired question"
below.

---

## Test 3 — the process-uptime measurement  ⚑ 30 SECONDS, DO IT IN THE SAME SITTING

**Resolves:** the disclosed residual risk introduced by this wave — whether
`Process.getStartElapsedRealtime()` returns a true process start on this OEM build.

**Posture:** none — this is a pure measurement, valid in both worlds.

**Why it matters.** The crash ladder decays on measured process uptime. If this build returns a
wrong-but-plausible value, measured uptime becomes something other than "how long the app ran",
every crash can look like a healthy run, and loop containment is silently disabled while every
unit test stays green. A value of exactly 0 is already rejected in code (it degrades to the
older gap heuristic rather than to no containment), so this test is looking for the case the
code **cannot** detect from inside: a plausible but incorrect non-zero value.

**Method.** During Test 1, read the crash-path log line:

```
Crash 1 (uncaught_exception) on the ladder, process uptime <N>ms
```

**Observe.** `<N>`, against how long the app had actually been running before you crashed it.

**What each result means:**

| Result | Meaning |
|---|---|
| `<N>` ≈ the time the app was actually up (low seconds if you crashed it shortly after start) | Correct. Risk closed. |
| `<N>` ≈ device uptime (hours on a box that has been on all day) | The platform is reporting boot time, not process start, and the value is non-zero so the in-code guard did not catch it. **Loop containment is disabled on this build.** One-line fix available (treat this build as unmeasurable and fall back to the gap rule); do not ship to this OEM until it is applied. |
| `<N>` is negative or absurd | Falls back to the gap heuristic automatically; record it, no action needed beyond noting the model. |

Crash the app **twice** — once shortly after launch, once after ~15 minutes of uptime — and
check that `<N>` differs accordingly. A single reading cannot distinguish the two failure modes.

---

## Test 4 — BootReceiver, run once per broadcast

**Resolves:** B3. **Posture P2 — and P2 is not answered by Test 1.** Even if Test 1 showed
World A, run all three of these.

Record each broadcast separately; they are delivered under different conditions and one working
does not imply another does.

### 4a. `BOOT_COMPLETED`
**Method.** Reboot the device normally. Do not touch the remote.
**Observe.** Log line `Relaunch signal received (android.intent.action.BOOT_COMPLETED)`, then
whether MainActivity actually appears.

### 4b. `QUICKBOOT_POWERON`
**Method.** Use the device's own fast-boot / standby-resume path (power button from standby
rather than a cold reboot), which is what sends this on the boxes that send it at all.
**Observe.** Whether the `Relaunch signal received` line names a QUICKBOOT action. If no such
line appears on any resume, this box does not send those broadcasts and the branch is untestable
here — record as "not applicable on this model", not as a failure.

### 4c. `MY_PACKAGE_REPLACED`
**Method.** Install an updated APK over the running app (`adb install -r`), then do not touch
the device.
**Observe.** `Relaunch signal received (android.intent.action.MY_PACKAGE_REPLACED)`, then
whether the app reappears.

**What each result means, for all three:**

| Result | Meaning |
|---|---|
| Log line present **and** app appears | P2 permitted for that broadcast. That item of B3 resolved affirmatively. |
| Log line present, app does **not** appear | P2 blocked for that broadcast. Our receiver ran and issued the start; the platform refused it. This is the documented possibility — the code disclaims it. B3 stands as blocked for that broadcast. |
| No log line | The broadcast was never delivered to us. Distinguish: manifest registration issue (a code defect) vs. this OEM not sending it (4b especially). Check the manifest registration test passes on this build before concluding. |

---

## Test 5 — the stale-alarm teardown (N3 cancel)

**Resolves:** confirms the `cancelPendingRelaunch` trade behaves as classified. Lower priority —
this item is classified correct-under-both, so this test is confirmation, not a gate.

**Method.** Crash the app enough times in quick succession to reach the 60-minute rung (watch
for `Crash 4 ... on the ladder` and `Restart scheduled in 3600000ms`). Then bring the app back
**yourself** immediately, from the launcher. Leave it playing and wait out the hour.

**Observe.** Whether playback is torn down and restarted at roughly the 60-minute mark.

**What each result means:**

| Result | Meaning |
|---|---|
| Playback continues uninterrupted | The cancel worked. Expected. |
| Playback is torn down ~60 min later | The cancel did not take effect on this build — a real defect, since the alarm fired against a **foreground** app (posture P3, which is not BAL-restricted). Capture logs. |

---

## Test 6 — screen-on policy

**Resolves:** B5 (`FLAG_KEEP_SCREEN_ON` vs OEM eco / no-signal power modes). Unrelated to the
BAL premise; included because it is a hardware-gated claim in the same lane.

**Method.** Leave the app playing, untouched, for longer than the device's configured screen
timeout — and separately, with any OEM "eco"/"power saving" mode enabled.

**Observe.** Whether the panel sleeps, dims, or shows a screensaver.

**What each result means:** panel stays on in both configurations → B5 closed. Panel sleeps with
eco mode on → the OEM policy sits below the app layer, as the code comment predicts; this needs
a device-settings change in the deployment guide, not a code change.

---

## Retired question — record it, do not re-ask it

**"Does alarm delivery lateness break the crash ladder's decay rule?"** — retired as a
correctness question on API 24+.

It used to matter: the ladder inferred uptime from the interval between crashes, so an alarm
delivered late looked like an app that had stayed up, and the ladder would reset itself. The
decay rule now measures process uptime directly, and that clock starts when the process starts —
an alarm firing an hour late still yields an uptime of milliseconds if the app dies on startup.

It survives in two reduced forms only:
- On **API 23**, where the measurement is unavailable and the gap heuristic is the sole rule.
  Not applicable to Android 12+ boxes, i.e. not to this sitting.
- As a **product** question — how long a fielded screen stays dark — which is Test 2.

A retired question is a result. It is recorded here so nobody re-derives it as an open one.

---

## Results table — fill in during the sitting

| Item | Test | Result | World / notes |
|---|---|---|---|
| Device model / Android version / build fingerprint | — | | |
| B1 unattended crash recovery | 1 | | |
| B2 ladder benefit | 1 (implied) | | |
| B4 alarm latency + quota | 2 | | |
| B6 alarm survives process death | 2 | | |
| Process-uptime measurement | 3 | | |
| B3a `BOOT_COMPLETED` | 4a | | |
| B3b `QUICKBOOT_POWERON` | 4b | | |
| B3c `MY_PACKAGE_REPLACED` | 4c | | |
| N3 stale-alarm cancel | 5 | | |
| B5 screen-on policy | 6 | | |

---

## What is NOT in this runbook, and why

Items classified **correct-under-both-branches** are not tested here, because hardware would
only tell us which world they are operating in — an observability question, not a safety one.
They behave correctly either way: the measured-uptime decay rule, the `cancelPendingRelaunch`
trade, in-process renderer recovery (P3), the renderer-loop decision to yield the process, storm
reporting, capped-not-terminal as a design choice, marker durability, always-schedules /
never-throws, and `setAndAllowWhileIdle` as a choice over `setWindow`.

Test 1's result tells you which world those items are operating in, which is why it is first.
