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
 * Decay rule (deliberately the simplest thing that is correct): PRUNE ON READ. Entries older
 * than {@link #WINDOW_MS} are dropped, but ONLY when the history is next touched — and the
 * only thing that touches it is the NEXT crash. Nothing clears the history on a successful
 * run. So "the history decays" describes what the next crash sees, not a background reset:
 * after a long clean run the next crash prunes everything and starts back at the first rung.
 *
 * Escalation ladder: crash N inside the window takes rung N of {@link #BACKOFF_MS}
 * (3s → 30s → 5min). The ladder is CAPPED, NOT TERMINAL — once it is exhausted every further
 * crash inside the window returns {@link #CAPPED_RETRY_MS} (60min) and a restart is still
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
 */
final class CrashLoopGuard {

    /** Crashes further apart than this are unrelated and do not compound. */
    static final long WINDOW_MS = 10 * 60 * 1000L; // 10 minutes

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
     * Cap on retained entries. Pruning already bounds the history in time; this bounds it in
     * size so a tight loop inside one window cannot grow the persisted string without limit.
     * Safe because {@link #decide} only compares the count against the ladder length.
     */
    static final int MAX_HISTORY = 16;

    private CrashLoopGuard() {}

    /**
     * @param historyMs persisted crash timestamps, oldest first (may be empty/null)
     * @param nowMs     System.currentTimeMillis() of the crash being recorded
     * @return the history to persist: prior entries still inside the window, plus nowMs
     */
    static long[] recordCrash(long[] historyMs, long nowMs) {
        long[] kept = pruneToWindow(historyMs, nowMs);
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
     * Drop entries outside the window. Entries in the FUTURE relative to nowMs are dropped
     * too: the timestamps are wall clock, and a TV box that boots without a network can jump
     * its clock by years when NTP lands. A future entry would otherwise satisfy
     * (now - t &lt; window) forever and pin the device on the slow {@link #CAPPED_RETRY_MS}
     * rung. Dropping fails open — the device restarts fast — which is the right bias for
     * signage.
     */
    static long[] pruneToWindow(long[] historyMs, long nowMs) {
        if (historyMs == null || historyMs.length == 0) {
            return new long[0];
        }
        long[] scratch = new long[historyMs.length];
        int n = 0;
        for (long t : historyMs) {
            if (t <= nowMs && nowMs - t < WINDOW_MS) {
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
