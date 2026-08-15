package com.vizora.display;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Host-JVM unit tests for the N2 crash-loop guard.
 *
 * Two regressions are pinned here, pulling in opposite directions:
 *  - CrashRecoveryHandler once rescheduled unconditionally 3s after every uncaught exception,
 *    so a deterministic crash-on-startup relaunched forever. The escalation ladder fixes that.
 *  - The first fix for THAT returned a terminal HOLD sentinel and scheduled no alarm, which on
 *    a fielded box is a permanent dark screen reachable from purely transient causes. The
 *    ladder is now CAPPED, and {@link #ladderIsCappedNotTerminal} plus
 *    {@link #decideNeverReturnsANonSchedulableDelay} exist specifically so a give-up value
 *    cannot be reintroduced without a red test.
 */
public class CrashLoopGuardTest {

    private static final long T0 = 1_700_000_000_000L; // arbitrary wall-clock base

    // ---- escalation ladder -----------------------------------------------------------------

    @Test
    public void firstCrashUsesFirstRung() {
        long[] h = CrashLoopGuard.recordCrash(new long[0], T0);
        assertArrayEquals(new long[] { T0 }, h);
        assertEquals(3_000L, CrashLoopGuard.decide(h));
    }

    @Test
    public void exactEscalationSequenceThenCappedRetry() {
        // Four crashes 1 minute apart — all inside the 10-minute window.
        long[] h = new long[0];

        h = CrashLoopGuard.recordCrash(h, T0);
        assertEquals("1st crash -> 3s", 3_000L, CrashLoopGuard.decide(h));

        h = CrashLoopGuard.recordCrash(h, T0 + 60_000L);
        assertEquals("2nd crash -> 30s", 30_000L, CrashLoopGuard.decide(h));

        h = CrashLoopGuard.recordCrash(h, T0 + 120_000L);
        assertEquals("3rd crash -> 5min", 300_000L, CrashLoopGuard.decide(h));

        h = CrashLoopGuard.recordCrash(h, T0 + 180_000L);
        assertEquals("4th crash -> 60min, NOT a give-up",
            60L * 60 * 1000L, CrashLoopGuard.decide(h));
    }

    @Test
    public void ladderIsCappedNotTerminal() {
        // THE regression test for the dark-screen bug. Past the end of the ladder the guard
        // must still hand back a delay that something can actually be scheduled for. A device
        // that stops trying to come back is a truck roll; ~24 restarts/day is not.
        long[] h = new long[0];
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length + 3; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i * 30_000L);
        }
        assertTrue("ladder should be exhausted", CrashLoopGuard.isLadderExhausted(h));
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));
        assertTrue("capped rung must be a real, positive delay", CrashLoopGuard.decide(h) > 0L);
    }

    @Test
    public void decideNeverReturnsANonSchedulableDelay() {
        // Sweep well past both the ladder and the history cap: there is no crash count at
        // which decide() returns a sentinel, a negative, or zero.
        long[] h = new long[0];
        for (int i = 0; i < CrashLoopGuard.MAX_HISTORY + 10; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L);
            long delay = CrashLoopGuard.decide(h);
            assertTrue("crash " + (i + 1) + " produced a non-schedulable delay: " + delay,
                delay > 0L);
        }
    }

    @Test
    public void ladderExhaustionTracksTheLadderLengthExactly() {
        // Behavioural, not tautological: exactly BACKOFF_MS.length crashes is the LAST rung
        // (not exhausted); one more is the capped rung. Pins the off-by-one from both sides
        // without asserting a constant against its own definition.
        long[] atLadderEnd = new long[CrashLoopGuard.BACKOFF_MS.length];
        for (int i = 0; i < atLadderEnd.length; i++) {
            atLadderEnd[i] = T0 + i;
        }
        assertFalse(CrashLoopGuard.isLadderExhausted(atLadderEnd));
        assertEquals(CrashLoopGuard.BACKOFF_MS[CrashLoopGuard.BACKOFF_MS.length - 1],
            CrashLoopGuard.decide(atLadderEnd));

        long[] oneMore = CrashLoopGuard.recordCrash(atLadderEnd, T0 + atLadderEnd.length);
        assertTrue(CrashLoopGuard.isLadderExhausted(oneMore));
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(oneMore));
    }

    @Test
    public void cappedRungIsSlowerThanEveryLadderRung() {
        // The cap only makes sense as the SLOWEST rung; a cap below a ladder rung would make
        // escalation non-monotonic.
        for (long rung : CrashLoopGuard.BACKOFF_MS) {
            assertTrue("capped rung must exceed ladder rung " + rung,
                CrashLoopGuard.CAPPED_RETRY_MS > rung);
        }
    }

    @Test
    public void ladderIsNotExhaustedBeforeItRunsOut() {
        long[] h = new long[0];
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L);
            assertFalse("crash " + (i + 1) + " is still on the ladder",
                CrashLoopGuard.isLadderExhausted(h));
        }
        assertFalse(CrashLoopGuard.isLadderExhausted(null));
        assertFalse(CrashLoopGuard.isLadderExhausted(new long[0]));
    }

    // ---- window / decay --------------------------------------------------------------------

    @Test
    public void crashInsideWindowCompounds() {
        long[] first = CrashLoopGuard.recordCrash(new long[0], T0);
        long[] second = CrashLoopGuard.recordCrash(first, T0 + CrashLoopGuard.WINDOW_MS - 1);
        assertEquals(2, second.length);
        assertEquals(30_000L, CrashLoopGuard.decide(second));
    }

    @Test
    public void crashOutsideWindowDoesNotCompound() {
        long[] first = CrashLoopGuard.recordCrash(new long[0], T0);
        long[] second = CrashLoopGuard.recordCrash(first, T0 + CrashLoopGuard.WINDOW_MS);
        assertArrayEquals("stale entry pruned", new long[] { T0 + CrashLoopGuard.WINDOW_MS }, second);
        assertEquals("back to the first rung", 3_000L, CrashLoopGuard.decide(second));
    }

    @Test
    public void crashAfterWindowClearsAnExhaustedHistory() {
        // Decay rule = prune on read. Note precisely what this does and does not say: nothing
        // clears the history during a clean run — the pruning happens when the NEXT crash
        // reads it. So this asserts that a crash occurring after the window sees an empty
        // history and drops back to the first rung, NOT that surviving the window resets
        // anything by itself.
        long[] h = new long[0];
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L);
        }
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));

        long later = T0 + CrashLoopGuard.WINDOW_MS + 60_000L;
        assertEquals(0, CrashLoopGuard.pruneToWindow(h, later).length);
        assertEquals(3_000L, CrashLoopGuard.decide(CrashLoopGuard.recordCrash(h, later)));
    }

    @Test
    public void pruneKeepsTheWholeChainWhileCrashesKeepArriving() {
        // The window is measured from the PREVIOUS crash, not from each entry independently:
        // as long as the chain is unbroken the older entries stay, however long the chain has
        // been running. Measuring each entry against now is what made the cap unreachable —
        // see theCappedRungIsAReachableSteadyState.
        long now = T0 + CrashLoopGuard.WINDOW_MS;
        long[] history = { T0 - 1, T0, T0 + 1, now };
        assertArrayEquals(history, CrashLoopGuard.pruneToWindow(history, now));
    }

    @Test
    public void pruneDropsTheChainOnceTheDeviceHasBeenQuietForAWindow() {
        long[] history = { T0, T0 + 1_000L, T0 + 2_000L };
        long now = T0 + 2_000L + CrashLoopGuard.WINDOW_MS;
        assertEquals(0, CrashLoopGuard.pruneToWindow(history, now).length);
    }

    // ---- N2: the cap has to be a steady state, not a place the ladder passes through -------

    @Test
    public void windowIsLongerThanTheCappedRetryInterval() {
        // Not a style constraint. If the quiet window is shorter than the capped retry
        // interval, a device sitting on the capped rung prunes its own chain between attempts
        // and drops straight back to the fast rung — the ladder restarts from the bottom
        // forever and the cap is decorative.
        assertTrue("WINDOW_MS (" + CrashLoopGuard.WINDOW_MS + ") must exceed CAPPED_RETRY_MS ("
                + CrashLoopGuard.CAPPED_RETRY_MS + ")",
            CrashLoopGuard.WINDOW_MS > CrashLoopGuard.CAPPED_RETRY_MS);
    }

    @Test
    public void theCappedRungIsAReachableSteadyState() {
        // Simulates the case the ladder exists for: a deterministic crash on startup, where
        // each crash lands as soon as the scheduled restart delivers. Walk a full day of it
        // using the delays the guard itself hands back.
        //
        // The old absolute-window prune failed here on the 5th crash: it landed ~65 minutes
        // after the 4th, by which point every earlier entry was outside a 10-minute window, so
        // the guard saw a history of length 1 and handed back 3s. Real steady state was ~4
        // crashes per ~65min (~88/day), not the ~24/day the cap advertises.
        long[] h = new long[0];
        long t = T0;
        long delay = 0L;
        for (int crash = 1; crash <= 24; crash++) {
            t += delay;
            h = CrashLoopGuard.recordCrash(h, t);
            delay = CrashLoopGuard.decide(h);
            if (crash > CrashLoopGuard.BACKOFF_MS.length) {
                assertEquals("crash " + crash + " (t+" + (t - T0) + "ms) fell off the capped "
                        + "rung and restarted the ladder", CrashLoopGuard.CAPPED_RETRY_MS, delay);
            }
        }
    }

    @Test
    public void aLongLoopIsDistinguishableFromAShortOneInTheMarkerCount() {
        // The marker reports historyMs.length. Under the old prune that count was ALWAYS
        // BACKOFF_MS.length + 1, so a device that had looped for a week reported exactly the
        // same number as one that looped four times and recovered.
        long[] h = new long[0];
        long t = T0;
        long delay = 0L;
        for (int crash = 1; crash <= 24; crash++) {
            t += delay;
            h = CrashLoopGuard.recordCrash(h, t);
            delay = CrashLoopGuard.decide(h);
        }
        assertTrue("a day of crash-looping still reports only " + h.length + " events",
            h.length > CrashLoopGuard.BACKOFF_MS.length + 1);
        assertEquals("and it saturates at the size cap, so read it as 'at least this many'",
            CrashLoopGuard.MAX_HISTORY, h.length);
    }

    @Test
    public void aDeviceThatStopsCrashingLeavesTheCappedRung() {
        // The cap must be sticky, not permanent: the transient-cause argument for capping
        // (rather than giving up) depends on the device healing itself once the cause clears.
        long[] h = new long[0];
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L);
        }
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));

        long afterAQuietWindow = T0 + CrashLoopGuard.WINDOW_MS + 60_000L;
        assertEquals(3_000L,
            CrashLoopGuard.decide(CrashLoopGuard.recordCrash(h, afterAQuietWindow)));
    }

    @Test
    public void futureEntriesArePrunedSoAClockJumpCannotPinUsOnTheSlowRung() {
        // Wall clock can jump years on a TV box that boots without a network. A stored
        // timestamp in the future would otherwise stay "inside the window" forever.
        long[] history = { T0 + 5L * 365 * 24 * 60 * 60 * 1000L, T0 + 1_000L };
        assertEquals(0, CrashLoopGuard.pruneToWindow(history, T0).length);
        assertEquals(3_000L, CrashLoopGuard.decide(CrashLoopGuard.recordCrash(history, T0)));
    }

    @Test
    public void historyIsCappedAndKeepsTheMostRecent() {
        long[] h = new long[0];
        for (int i = 0; i < CrashLoopGuard.MAX_HISTORY + 5; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i);
        }
        assertEquals(CrashLoopGuard.MAX_HISTORY, h.length);
        assertEquals(T0 + CrashLoopGuard.MAX_HISTORY + 4, h[h.length - 1]);
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));
    }

    // ---- defensive inputs ------------------------------------------------------------------

    @Test
    public void nullOrEmptyHistoryFailsOpenToARestart() {
        assertEquals(3_000L, CrashLoopGuard.decide(null));
        assertEquals(3_000L, CrashLoopGuard.decide(new long[0]));
        assertArrayEquals(new long[] { T0 }, CrashLoopGuard.recordCrash(null, T0));
    }

    // ---- persisted form --------------------------------------------------------------------

    @Test
    public void serializeParseRoundTrips() {
        long[] history = { T0, T0 + 1_000L, T0 + 2_000L };
        assertArrayEquals(history,
            CrashLoopGuard.parseHistory(CrashLoopGuard.serializeHistory(history)));
    }

    @Test
    public void emptyHistorySerializesToEmptyString() {
        assertEquals("", CrashLoopGuard.serializeHistory(new long[0]));
        assertEquals("", CrashLoopGuard.serializeHistory(null));
    }

    @Test
    public void corruptPersistedHistoryDoesNotThrowAndDoesNotBlockRecovery() {
        assertEquals(0, CrashLoopGuard.parseHistory(null).length);
        assertEquals(0, CrashLoopGuard.parseHistory("").length);
        assertEquals(0, CrashLoopGuard.parseHistory("garbage").length);
        assertArrayEquals(new long[] { T0 }, CrashLoopGuard.parseHistory("garbage," + T0));
    }
}
