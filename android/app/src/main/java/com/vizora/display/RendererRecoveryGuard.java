package com.vizora.display;

/**
 * Pure decision logic for F36 WebView renderer-death recovery, extracted from
 * MainActivity so the boot-window edge is unit-testable on the host JVM. (MainActivity
 * extends BridgeActivity, which cannot load in a plain unit test — a static method on
 * it would drag in the Android runtime.)
 */
final class RendererRecoveryGuard {

    /**
     * Minimum spacing between in-process recoveries. A second renderer death within
     * this window is treated as a tight loop and deferred to the process-restart path
     * rather than hot-looping the activity relaunch.
     */
    static final long MIN_INTERVAL_MS = 10_000L;

    /**
     * Initial "last recovery" seed: one interval in the past — NOT 0 — because
     * SystemClock.elapsedRealtime() is ms since BOOT. With 0, the FIRST renderer death
     * within {@link #MIN_INTERVAL_MS} of boot (the highest-probability renderer-death
     * window — heavy first render) would satisfy (now - 0 &lt; interval) and wrongly
     * skip recovery. Using -interval (not Long.MIN_VALUE) avoids subtraction overflow.
     */
    static final long SENTINEL = -MIN_INTERVAL_MS;

    private RendererRecoveryGuard() {}

    /**
     * @param nowMs            SystemClock.elapsedRealtime() at the current renderer death
     * @param lastRecoveryAtMs elapsedRealtime of the previous recovery (or {@link #SENTINEL})
     * @return true to recover in-process; false to defer to the process-restart path
     */
    static boolean shouldRecover(long nowMs, long lastRecoveryAtMs) {
        return nowMs - lastRecoveryAtMs >= MIN_INTERVAL_MS;
    }
}
