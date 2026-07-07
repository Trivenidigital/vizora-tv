package com.vizora.display;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Host-JVM unit tests for the F36 renderer-death recovery guard.
 *
 * Regression focus: the BOOT WINDOW. SystemClock.elapsedRealtime() is ms since boot,
 * and a renderer OOM is most likely early (the heavy first render). A prior sentinel
 * of 0 made the FIRST death within MIN_INTERVAL_MS of boot fail the guard and skip the
 * in-process recovery F36 exists to perform. The SENTINEL seed fixes that; these pin it.
 */
public class RendererRecoveryGuardTest {

    @Test
    public void recoversOnFirstDeathWithinBootWindow() {
        // elapsedRealtime() < MIN_INTERVAL_MS (5s since boot), first death of the process.
        assertTrue(RendererRecoveryGuard.shouldRecover(5_000L, RendererRecoveryGuard.SENTINEL));
    }

    @Test
    public void recoversOnFirstDeathAtBootInstant() {
        assertTrue(RendererRecoveryGuard.shouldRecover(0L, RendererRecoveryGuard.SENTINEL));
    }

    @Test
    public void oldZeroSentinelWouldHaveSkippedBootWindowRecovery() {
        // Documents the fixed defect: with the pre-fix sentinel of 0, a death 5s after
        // boot was (wrongly) treated as a rapid re-death and recovery was skipped.
        assertFalse(RendererRecoveryGuard.shouldRecover(5_000L, 0L));
    }

    @Test
    public void defersOnRapidReDeath() {
        // Second death 7s after a recovery at t=5s → inside the 10s window → defer.
        assertFalse(RendererRecoveryGuard.shouldRecover(12_000L, 5_000L));
    }

    @Test
    public void recoversAfterIntervalElapsed() {
        // Second death 15s after a recovery → outside the window → recover.
        assertTrue(RendererRecoveryGuard.shouldRecover(20_000L, 5_000L));
    }
}
