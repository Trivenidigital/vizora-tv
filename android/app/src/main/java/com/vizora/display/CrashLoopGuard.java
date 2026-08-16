package com.vizora.display;

/**
 * Pure decision logic for crash-loop containment (N2), extracted from
 * {@link CrashRecoveryHandler} so it is unit-testable on the host JVM — same idiom as
 * {@link RendererRecoveryGuard}. No Android imports.
 *
 * Why this exists: CrashRecoveryHandler rescheduled the activity unconditionally 3s after
 * every uncaught exception. A deterministic crash-on-startup therefore became an unbounded
 * 3-second relaunch loop: flash wear, thermal load, and a screen that flickers forever
 * instead of settling into a diagnosable state.
 *
 * Model: the handler persists a history of crash timestamps (wall clock,
 * System.currentTimeMillis()). On each crash it calls {@link #recordCrash} to get the new
 * history to persist, then {@link #decide} to get the restart delay.
 *
 * Decay rule: PRUNE ON READ, against UPTIME rather than against elapsed time. The chain
 * survives while the app came back and died again faster than the delay it was told to wait,
 * plus {@link #GRACE_MS}; it is cleared entirely once the app managed to stay up for about
 * {@link #GRACE_MS}. Pruning happens only when the history is next touched — and the only
 * thing that touches it is the NEXT crash. Nothing clears the history during a successful run,
 * so "the history decays" describes what the next crash sees, not a background reset.
 *
 * N2/F1 — why the threshold is the penalty and not a fixed window. This has been wrong twice
 * in opposite directions, and both failures were invisible to every pure test of {@link #decide}:
 *
 *  - A fixed 10-minute ABSOLUTE window (drop every entry older than the window) made the cap
 *    UNREACHABLE. A deterministic startup crash escalated 3s → 30s → 5min → capped at ~5m35s,
 *    and the next crash landed ~65 minutes later, by which point every earlier entry was
 *    pruned: history length 1, back to the 3s rung, forever. Real steady state was ~4 crashes
 *    per ~65min (~88/day) rather than the advertised ~24/day, and the marker always reported
 *    exactly 4 crashes, so a week-long loop looked identical to a single episode.
 *  - Fixing that with a fixed 90-minute CHAIN window (gap measured from the previous crash)
 *    made the cap sticky but broke the opposite case, because a chain window has to outlast
 *    the 60-minute capped rung and therefore also compounds crashes 45 minutes apart. A box
 *    OOMing on one oversized playlist asset ~25 minutes after each start — the exact TRANSIENT
 *    cause cited below as the reason for capping rather than giving up — climbed to the hourly
 *    rung and PINNED there: ~29% uptime where the absolute window gave ~100%.
 *
 * Both fixed thresholds fail because a raw gap conflates the delay we imposed with the time
 * the app actually survived. Comparing the gap to {@code decide(history) + GRACE_MS} subtracts
 * the penalty back out, so the rule is simply "reset if the app stayed up for GRACE_MS" —
 * sticky at ~0 uptime (the loop), and fast-rung at any uptime that resembles working.
 *
 * Escalation ladder: crash N in the chain takes rung N of {@link #BACKOFF_MS}
 * (3s → 30s → 5min). The ladder is CAPPED, NOT TERMINAL — once it is exhausted every further
 * crash in the chain returns {@link #CAPPED_RETRY_MS} (60min) and a restart is still
 * scheduled.
 *
 * Why capped rather than terminal (this is the whole point of the class, so it is worth
 * stating): an earlier revision returned a HOLD sentinel and scheduled NO alarm. On a fielded
 * signage box that is a permanent dark screen. Nothing else restarts the app — MainActivity
 * has no watchdog or service, BootReceiver fires only on boot / quickboot / package-replace,
 * and this history is pruned only inside the crash handler, which cannot run while the process
 * is dead. So HOLD meant "dark until a human power-cycles the TV", and it was reachable from
 * purely TRANSIENT causes: four OOMs on an oversized asset (OutOfMemoryError is a Throwable and
 * reaches uncaughtException) would strand the device even though swapping the asset fixes it.
 * A 60-minute rung is ~24 restarts/day — negligible flash/thermal cost — and the device heals
 * itself the moment the transient cause clears. Availability beats wear here.
 *
 * HONESTY: everything above assumes the scheduled alarm actually produces a relaunch. It
 * schedules one; whether the activity start is permitted when the alarm fires on a dead
 * process is a background-activity-launch question we have NOT settled on hardware — see the
 * HONESTY note on {@link CrashRecoveryHandler}. If that launch is blocked on modern Google TV,
 * the difference between the capped rung and the old HOLD is invisible to the operator and the
 * screen is dark either way. The capped-over-terminal argument is unchanged (it cannot be
 * worse), but its benefit is unrealised until hardware says otherwise.
 */
final class CrashLoopGuard {

    /**
     * How long the app must stay UP for the ladder to forget the chain, over and above the
     * delay it was just told to wait. The chain survives while
     * {@code gap < decide(history) + GRACE_MS}; since {@code gap} is the delay we imposed plus
     * however long the app then ran, that reduces to one sentence:
     *
     *     THE LADDER RESETS IF THE APP STAYED UP FOR ROUGHLY GRACE_MS.
     *
     * That is the property worth having, and it is why the threshold is measured against the
     * penalty rather than being a fixed quiet window — see the N2/F1 note on the class.
     *
     * Value: it must exceed the worst-case LATENESS of our own restart alarm, or a
     * startup-crash loop whose alarm was merely delivered late would look like an app that
     * stayed up and would reset its own ladder. On API 33+ the relaunch is an inexact
     * {@code setAndAllowWhileIdle} alarm whose per-app quota is ~9 minutes (see
     * {@link CrashRecoveryHandler}), so 10 minutes is the smallest honest value. Residual, and
     * it is real: an alarm delivered MORE than ~10 minutes late is indistinguishable from a
     * healthy run and does reset the ladder.
     */
    static final long GRACE_MS = 10 * 60 * 1000L; // 10 minutes

    /**
     * Restart delay by crash-count-inside-window: 1st → 3s (unchanged from the previous
     * fixed behaviour, so a one-off crash still recovers fast), 2nd → 30s, 3rd → 5min.
     */
    static final long[] BACKOFF_MS = { 3_000L, 30_000L, 5 * 60_000L };

    /**
     * The rung used once {@link #BACKOFF_MS} is exhausted, i.e. from crash
     * {@code BACKOFF_MS.length + 1} onwards inside the window. This is a REAL delay, not a
     * sentinel: {@link #decide} never tells the caller to give up, so there is no code path
     * on which the device stops trying to come back.
     */
    static final long CAPPED_RETRY_MS = 60 * 60 * 1000L; // 60 minutes

    /**
     * Cap on retained entries. Pruning bounds the history in time; this bounds it in size so a
     * long chain cannot grow the persisted string without limit. Safe for the decision because
     * {@link #decide} only compares the count against the ladder length — but note it also
     * saturates the count reported in the operator marker, which must therefore be read as
     * "at least MAX_HISTORY events in this chain", not as a total.
     */
    static final int MAX_HISTORY = 16;

    private CrashLoopGuard() {}

    /**
     * Record a RESTART-LADDER event (an uncaught exception, or a renderer loop that gave the
     * process up). Decays against the penalty already imposed — see {@link #pruneChain}.
     *
     * @param historyMs persisted crash timestamps, oldest first (may be empty/null)
     * @param nowMs     System.currentTimeMillis() of the crash being recorded
     * @return the history to persist: the surviving chain plus nowMs
     */
    static long[] recordCrash(long[] historyMs, long nowMs) {
        return append(pruneChain(historyMs, nowMs), nowMs);
    }

    /**
     * Record a REPORT-ONLY event (a renderer death that recovered in-process). Decays against a
     * plain {@link #GRACE_MS} of quiet, NOT against a restart penalty: this chain never
     * schedules anything, so there is no darkness to compare the uptime to, and borrowing the
     * ladder's penalty term would keep a storm chain alive for over an hour after it ended —
     * which would silently merge two separate episodes into one and suppress the report for the
     * second (the marker fires only on the transition; see
     * {@link CrashRecoveryHandler#recordRendererRecovery}).
     */
    static long[] recordRecovery(long[] historyMs, long nowMs) {
        return append(pruneQuiet(historyMs, nowMs, GRACE_MS), nowMs);
    }

    /** Append nowMs, dropping the OLDEST entries if that would exceed {@link #MAX_HISTORY}. */
    private static long[] append(long[] kept, long nowMs) {
        int keptCount = Math.min(kept.length, MAX_HISTORY - 1);
        int dropped = kept.length - keptCount; // drop OLDEST first when capped
        long[] updated = new long[keptCount + 1];
        System.arraycopy(kept, dropped, updated, 0, keptCount);
        updated[keptCount] = nowMs;
        return updated;
    }

    /**
     * @param historyMs the history returned by {@link #recordCrash} (already pruned and
     *                  already including the current crash)
     * @return the restart delay in ms. ALWAYS a schedulable delay — never a give-up sentinel.
     */
    static long decide(long[] historyMs) {
        int crashesInWindow = historyMs == null ? 0 : historyMs.length;
        if (crashesInWindow <= 0) {
            // Defensive: a caller that lost the history still gets the fast first rung.
            // Favour bringing the signage back.
            return BACKOFF_MS[0];
        }
        if (crashesInWindow > BACKOFF_MS.length) {
            return CAPPED_RETRY_MS;
        }
        return BACKOFF_MS[crashesInWindow - 1];
    }

    /**
     * True when this crash fell off the end of {@link #BACKOFF_MS} and is therefore being
     * retried on the slow {@link #CAPPED_RETRY_MS} rung. The handler uses this to persist an
     * operator-visible marker: a device that has degraded to one restart attempt per hour is a
     * device in trouble, and an automated degradation that nobody is told about is exactly the
     * silent failure this whole change exists to remove.
     *
     * A separate predicate rather than {@code delay == CAPPED_RETRY_MS} so the marker cannot
     * start misfiring if a ladder rung is ever tuned to the same value.
     */
    static boolean isLadderExhausted(long[] historyMs) {
        return historyMs != null && historyMs.length > BACKOFF_MS.length;
    }

    /**
     * Prune the restart-ladder chain: keep it while the app came back and died again FASTER
     * than the penalty it was given, drop it once the app managed to stay up.
     *
     * F1 — why this is measured against the penalty and not against a fixed quiet window. A
     * fixed window compares an interval to a constant, which cannot distinguish "died instantly,
     * four times" from "ran fine for 25 minutes, four times"; the window has to be long enough
     * to outlast the 60-minute capped rung (or the cap is not a reachable steady state), and a
     * window that long then compounds crashes that are three quarters of an hour apart. That was
     * a real regression and in the worst direction: with a 90-minute window, a box that OOMs on
     * one oversized playlist asset ~25 minutes after each start — the exact TRANSIENT cause this
     * class's javadoc cites as the reason for capping rather than giving up — climbed to the
     * hourly rung and stayed there, going from ~100% uptime to ~29%.
     *
     * Subtracting the penalty removes the coupling. {@code gap} is always
     * {@code (the delay we imposed) + (how long the app then ran)}, so the surviving condition
     * {@code gap < decide(history) + GRACE_MS} reduces to {@code uptime < GRACE_MS} on every
     * rung: a device that cannot stay up for ten minutes keeps escalating and stays capped, and
     * a device that CAN gets the fast rung back, whatever rung it was on before.
     *
     * Entries in the FUTURE relative to nowMs are dropped: the timestamps are wall clock, and a
     * TV box that boots without a network can jump its clock by years when NTP lands. A future
     * entry would otherwise sit in the chain forever and pin the device on the slow
     * {@link #CAPPED_RETRY_MS} rung. Dropping fails open — the device restarts fast — which is
     * the right bias for signage.
     */
    static long[] pruneChain(long[] historyMs, long nowMs) {
        return pruneQuiet(historyMs, nowMs, decide(historyMs) + GRACE_MS);
    }

    /**
     * Drop the whole chain once {@code quietMs} has passed since its most recent entry (or the
     * clock jumped backwards past it); otherwise keep every entry that is not itself in the
     * future. Shared by both chains, which differ only in how {@code quietMs} is derived.
     */
    static long[] pruneQuiet(long[] historyMs, long nowMs, long quietMs) {
        if (historyMs == null || historyMs.length == 0) {
            return new long[0];
        }
        long newest = historyMs[historyMs.length - 1];
        if (newest > nowMs || nowMs - newest >= quietMs) {
            // Clock jumped backwards, or the app stayed up long enough. Start over.
            return new long[0];
        }
        long[] scratch = new long[historyMs.length];
        int n = 0;
        for (long t : historyMs) {
            if (t <= nowMs) {
                scratch[n++] = t;
            }
        }
        long[] kept = new long[n];
        System.arraycopy(scratch, 0, kept, 0, n);
        return kept;
    }

    /**
     * Parse the persisted form. Total garbage (or a partially-written value) yields an empty
     * history rather than an exception — this runs inside an uncaught-exception handler on a
     * dying process, where throwing would lose the restart entirely.
     */
    static long[] parseHistory(String serialized) {
        if (serialized == null || serialized.isEmpty()) {
            return new long[0];
        }
        String[] parts = serialized.split(",");
        long[] scratch = new long[parts.length];
        int n = 0;
        for (String part : parts) {
            try {
                scratch[n] = Long.parseLong(part.trim());
                n++;
            } catch (NumberFormatException ignored) {
                // Skip the unparseable entry; a corrupt history must not block recovery.
            }
        }
        long[] parsed = new long[n];
        System.arraycopy(scratch, 0, parsed, 0, n);
        return parsed;
    }

    /** Inverse of {@link #parseHistory}. */
    static String serializeHistory(long[] historyMs) {
        if (historyMs == null || historyMs.length == 0) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < historyMs.length; i++) {
            if (i > 0) {
                sb.append(',');
            }
            sb.append(historyMs[i]);
        }
        return sb.toString();
    }
}
