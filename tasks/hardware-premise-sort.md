# Hardware-gated claims, sorted by whether the premise matters

The unverified premise: **does an alarm-fired `startActivity` against a dead
process actually launch on a certified Google TV?** Android 12+ background-
activity-launch restrictions may block it, and we have no hardware evidence
either way.

"World A" = the launch is permitted. "World B" = it is blocked.

This file exists because "blocked pending hardware" was doing too much work. Some
items are **correct in both worlds** — hardware would only tell us *which world
we are in*, which is an observability question, not a safety one. Others are
correct in one world only, and those are genuinely blocked. Collapsing the two
misrepresents both.

**The list did not shrink.** It moved, and grew by one: the uptime rework added a
blocker of its own. `DEVELOPMENT_COMPLETE_WITH_HARDWARE_BLOCKERS` remains the
truthful terminal state.

---

## Three launch postures, not one

A prerequisite for the sort, and a trap to avoid at the sitting: these are
**separate measurements**, and a box may permit one while blocking another.

| | Posture | Gated? |
|---|---|---|
| **P1** | Alarm `PendingIntent` fired against a **dead** process (`CrashRecoveryHandler`) | BAL-gated |
| **P2** | `startActivity` from a **broadcast receiver** with no foreground (`BootReceiver.java:48`) | BAL-gated, and a **different instance** from P1 |
| **P3** | `startActivity` from a **live foreground activity** (`MainActivity.java:192`, F36 recovery) | Not a background launch; the premise does not apply |

**Do not let a P1 result stand in for P2.**

---

## CORRECT UNDER BOTH BRANCHES — not blocked for correctness

| # | Item | Why it holds in both worlds |
|---|---|---|
| 1 | **The measured-uptime decay rule** | Uptime is measured from **process start**, so neither branch enters the computation. World A: measurement agrees with the old inference. World B: restarts come only from a human/boot/package-replace, and the ladder still resets when the app genuinely stays up. Escalation changes no behaviour in World B — nothing that would run is being scheduled — so its only effect is a marker correctly reporting "this device keeps failing to start." **This is the item the uptime rework moved:** the previous gap rule credited a delay that was never served, making it *actively wrong* in World B |
| 2 | **`cancelPendingRelaunch`** | The harm it removes — a stale alarm tearing down healthy playback — occurs whenever the app is foreground at fire time, which is posture P3. The cost it pays (giving up the only armed backstop for a later LMK/native/ANR death) exists only in World A, where that backstop could have fired. **Strictly cheaper in World B.** Caveat: the foreground-exemption step is an argument from platform rules plus internal consistency with F36, not a measurement |
| 3 | **In-process renderer recovery** (F36 recover branch) | Posture P3. Not gated on the premise at all |
| 4 | **The renderer-loop `return false`** | Declining to hot-loop in-process is correct regardless; only what follows is premise-dependent. World B: framework kills, dark until a human — same as doing nothing, but the hot loop is still avoided and the event still recorded |
| 5 | **Storm reporting + per-episode latch** | The device is UP and flickering by definition on this path, so the web layer reloads on every in-process relaunch and reads the marker. Identical in both worlds |
| 6 | **Capped-not-terminal as a DESIGN DECISION** | World B: capped and terminal are behaviourally indistinguishable, so capping cannot be worse, and the code still never enters a give-up state. Strict non-regression in World B, intended behaviour in World A. (Its *benefit* is a separate item — B2 — and stays blocked) |
| 7 | **Marker durability / §12b record-keeping** | The write is unconditional and durable; only *timeliness* is premise-dependent. World B delivery latency is unbounded but the record is not lost — and that degradation is self-limiting, since a black screen on a wall is its own alert |
| 8 | **Always-schedules / never-throws, and the ordering** | A property of our own path, not of what the system does with the `PendingIntent` afterwards |
| 9 | **`setAndAllowWhileIdle` as a CHOICE over `setWindow`** | Strict improvement in World A, irrelevant and free in World B. It cannot be wrong in either. (Its delivered latency is B4) |

---

## CORRECT UNDER ONE BRANCH ONLY — genuinely blocked

| # | Claim | Posture | Consequence in the blocked world |
|---|---|---|---|
| **B1** | **Unattended crash recovery** — the release's headline capability | P1 | The screen stays dark until a human or a boot |
| **B2** | The ladder's *benefit* — self-healing when a transient clears; "~24 restarts/day" at the cap | P1 | No automatic restarts exist to space out |
| **B3** | **`BootReceiver` — three separate broadcasts** (`BOOT_COMPLETED`, `QUICKBOOT_POWERON` both variants, `MY_PACKAGE_REPLACED`) | **P2** | The box boots to the launcher and stays there — defeating "24/7 signage starts without user interaction" |
| **B4** | `setAndAllowWhileIdle` delivered latency and the ~9-min quota in practice | P1 | Only matters in World A. **Downgraded** by the uptime rework: no longer a correctness input on API 24+, only a product one (how fast the screen returns) |
| **B5** | `FLAG_KEEP_SCREEN_ON` vs OEM eco / no-signal power modes | — | A different premise entirely, not BAL. Unverified |
| **B6** | Whether a scheduled alarm **survives process death** on the target OEM build | P1 | Aggressive OEM power management drops alarms for killed apps. If it does, **B1 fails even in World A** |

---

## NEW BLOCKER introduced by this wave's own uptime rework

**B7 — `Process.getStartElapsedRealtime()` may be stubbed to `0` on an OEM build.**

Public API since 24, but if a vendor build returns 0, measured uptime silently
becomes *time since boot* rather than time since process start. Every crash on a
box that has been powered on for ten minutes then looks like a healthy run, the
chain resets every time, and **loop containment is silently disabled while every
test stays green.**

Not hypothetical as a shape: Robolectric returns exactly 0, which is how the
failure mode was identified.

Deliberately **not** pre-emptively guarded — the only available guard
(`start <= 0 → UNKNOWN`) would also disable the measured path under Robolectric
and cost the call-site binding for the whole rule. Instead the crash-path log now
carries the measured uptime (`535c442`, one line).

**Sitting check:** on a crash-looping device that line must read **low seconds,
not hours**. A 30-second logcat check settles it. If it reads wrong, the fix is
the one-line fallback.

---

## The cheapest discriminator

**One deliberate uncaught exception on a debug build, then do not touch the box.**
If it returns in ~3 seconds, we are in World A.

That single test resolves **B1**, and by extension **B2**, and tells us which
world every other classification above sits in. Run it first.

Then, separately, P2 for each of B3's three broadcasts — because a P1 result does
not answer P2.

**Nothing in this file asserts that an alarm-fired `startActivity` against a dead
process relaunches on a certified Google TV.** Where an item is correct under both
branches, the reason is stated for *each* world, including the world where nothing
relaunches.
