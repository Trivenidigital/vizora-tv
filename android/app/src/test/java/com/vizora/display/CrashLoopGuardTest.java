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
    private static final long UNKNOWN = CrashLoopGuard.UPTIME_UNKNOWN;
    private static final long GRACE = CrashLoopGuard.GRACE_MS;

    // ---- escalation ladder -----------------------------------------------------------------

    @Test
    public void firstCrashUsesFirstRung() {
        long[] h = CrashLoopGuard.recordCrash(new long[0], T0, 0L);
        assertArrayEquals(new long[] { T0 }, h);
        assertEquals(3_000L, CrashLoopGuard.decide(h));
    }

    @Test
    public void exactEscalationSequenceThenCappedRetry() {
        // Four crashes 1 minute apart — all inside the 10-minute window.
        long[] h = new long[0];

        h = CrashLoopGuard.recordCrash(h, T0, 0L);
        assertEquals("1st crash -> 3s", 3_000L, CrashLoopGuard.decide(h));

        h = CrashLoopGuard.recordCrash(h, T0 + 60_000L, 0L);
        assertEquals("2nd crash -> 30s", 30_000L, CrashLoopGuard.decide(h));

        h = CrashLoopGuard.recordCrash(h, T0 + 120_000L, 0L);
        assertEquals("3rd crash -> 5min", 300_000L, CrashLoopGuard.decide(h));

        h = CrashLoopGuard.recordCrash(h, T0 + 180_000L, 0L);
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
            h = CrashLoopGuard.recordCrash(h, T0 + i * 30_000L, 0L);
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
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L, 0L);
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

        long[] oneMore = CrashLoopGuard.recordCrash(atLadderEnd, T0 + atLadderEnd.length, 0L);
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
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L, 0L);
            assertFalse("crash " + (i + 1) + " is still on the ladder",
                CrashLoopGuard.isLadderExhausted(h));
        }
        assertFalse(CrashLoopGuard.isLadderExhausted(null));
        assertFalse(CrashLoopGuard.isLadderExhausted(new long[0]));
    }

    // ---- decay ------------------------------------------------------------------------------

    @Test
    public void crashBeforeTheAppCouldStayUpCompounds() {
        long[] first = CrashLoopGuard.recordCrash(new long[0], T0, 0L);
        // 3s rung + almost all of the grace: the app never really came back.
        long[] second = CrashLoopGuard.recordCrash(
            first, T0 + 3_000L + GRACE - 1, GRACE - 1);
        assertEquals(2, second.length);
        assertEquals(30_000L, CrashLoopGuard.decide(second));
    }

    @Test
    public void crashAfterTheAppStayedUpDoesNotCompound() {
        long[] first = CrashLoopGuard.recordCrash(new long[0], T0, 0L);
        long later = T0 + 3_000L + GRACE;
        long[] second = CrashLoopGuard.recordCrash(first, later, GRACE);
        assertArrayEquals("stale entry pruned", new long[] { later }, second);
        assertEquals("back to the first rung", 3_000L, CrashLoopGuard.decide(second));
    }

    @Test
    public void aCrashAfterTheAppStayedUpClearsAnExhaustedHistory() {
        // Decay rule = prune on read. Note precisely what this does and does not say: nothing
        // clears the history during a clean run — the pruning happens when the NEXT crash
        // reads it. So this asserts that a crash occurring after a healthy run sees an empty
        // history and drops back to the first rung, NOT that surviving resets anything by
        // itself.
        long[] h = new long[0];
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L, 0L);
        }
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));

        long later = T0 + CrashLoopGuard.CAPPED_RETRY_MS + CrashLoopGuard.GRACE_MS + 60_000L;
        assertEquals(0, CrashLoopGuard.pruneChain(h, later, UNKNOWN).length);
        assertEquals(3_000L, CrashLoopGuard.decide(CrashLoopGuard.recordCrash(h, later, 0L)));
    }

    @Test
    public void pruneKeepsTheWholeChainWhileTheAppKeepsFailingToStayUp() {
        // The chain is kept or dropped as a whole, measured from its most recent entry: as long
        // as the app cannot stay up, the older entries stay, however long the chain has been
        // running. Measuring each entry against now independently is what made the cap
        // unreachable — see theCappedRungIsAReachableSteadyState.
        long now = T0 + 3_000L;
        long[] history = { T0 - 1, T0, T0 + 1, now };
        assertArrayEquals(history, CrashLoopGuard.pruneChain(history, now, UNKNOWN));
    }

    @Test
    public void pruneDropsTheChainOnceTheAppHasStayedUp() {
        long[] history = { T0, T0 + 1_000L, T0 + 2_000L };
        long now = T0 + 2_000L + CrashLoopGuard.CAPPED_RETRY_MS + CrashLoopGuard.GRACE_MS;
        assertEquals(0, CrashLoopGuard.pruneChain(history, now, UNKNOWN).length);
    }

    // ---- N2/F1: the cap must be sticky at ~0 uptime AND released by real uptime -------------

    @Test
    public void theResetThresholdAlwaysExceedsTheDelayItJustImposed() {
        // Replaces an earlier "WINDOW_MS > CAPPED_RETRY_MS" constraint, which was the same idea
        // stated for one rung only. This is the general invariant, and it is what makes the cap
        // reachable: if the chain could expire in less time than the device was told to wait,
        // a device that came back exactly on schedule would prune its own history and restart
        // the ladder from the bottom forever.
        long[] h = new long[0];
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length + 3; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i, 0L);
            long imposed = CrashLoopGuard.decide(h);
            // A crash arriving exactly when the restart was due must still be on the chain.
            long[] onSchedule = CrashLoopGuard.pruneChain(h, T0 + i + imposed, UNKNOWN);
            assertEquals("a crash " + imposed + "ms later — exactly when we told the device to "
                    + "come back — must not look like a healthy run", h.length, onSchedule.length);
        }
    }

    @Test
    public void aDeviceThatStaysUpBetweenCrashesIsNeverPinnedOnTheSlowRung() {
        // F1. THE regression test for the fixed-window rule. A box that OOMs on one oversized
        // playlist asset ~25 minutes after each start is the TRANSIENT cause this class's
        // javadoc cites as the reason for capping rather than giving up — it must recover fast
        // every time, not climb to the hourly rung.
        //
        // Under the fixed 90-minute chain window this failed on the 4th crash: the gaps (25min,
        // then 25min+delay) all sat inside the window, so the ladder escalated to the cap and
        // then PINNED there, because 60min of darkness plus 25min of uptime is still under 90
        // minutes. Uptime went from ~100% to ~29% for a device that was working perfectly
        // between crashes.
        long uptime = 25 * 60 * 1000L;
        long[] h = new long[0];
        long t = T0;
        for (int crash = 1; crash <= 8; crash++) {
            h = CrashLoopGuard.recordCrash(h, t, uptime);
            long delay = CrashLoopGuard.decide(h);
            assertEquals("crash " + crash + " (t+" + (t - T0) / 60000 + "min) escalated even "
                    + "though the app had been up for " + uptime / 60000 + " minutes",
                CrashLoopGuard.BACKOFF_MS[0], delay);
            assertFalse("a device that keeps coming back is not a degraded device",
                CrashLoopGuard.isLadderExhausted(h));
            t += delay + uptime;
        }
    }

    @Test
    public void theLadderResetsOnUptimeAlone_whateverRungItIsOn() {
        // The one-sentence statement of the rule: what clears the chain is the app STAYING UP
        // for GRACE_MS, and that is true from every rung, not just the fast ones. Walk the
        // ladder to the cap, then hand it a crash that arrives one grace period after the
        // restart was due.
        long[] h = new long[0];
        long t = T0;
        for (int crash = 1; crash <= CrashLoopGuard.BACKOFF_MS.length + 1; crash++) {
            h = CrashLoopGuard.recordCrash(h, t, 0L);
            t += CrashLoopGuard.decide(h);
        }
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));

        long[] afterAHealthyRun = CrashLoopGuard.recordCrash(h, t + GRACE, GRACE);
        assertEquals("the app stayed up for a full grace period; the ladder must forget",
            1, afterAHealthyRun.length);
        assertEquals(CrashLoopGuard.BACKOFF_MS[0], CrashLoopGuard.decide(afterAHealthyRun));
    }

    // ---- measured uptime, not inferred ------------------------------------------------------

    /** A chain sitting on the capped rung, most recent entry at T0. */
    private long[] chainOnTheCappedRung() {
        long[] h = new long[0];
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 - (CrashLoopGuard.BACKOFF_MS.length - i), 0L);
        }
        return h;
    }

    @Test
    public void measuredUptimeClearsTheChainEvenWhenTheGapSaysOtherwise() {
        // The operator case, and the reason the gap rule cannot be the primary signal. Device is
        // dark on the 60-minute rung. A human power-cycles it two minutes in, watches it run
        // happily for 40 minutes, and it hits the same transient again.
        //
        // The gap rule sees 42 minutes and demands 70, because it credits a 60-minute delay
        // that was never served — our alarm did not bring this device back, a person did. So it
        // keeps the chain and the operator watches the screen go dark for another hour, having
        // just been shown 40 minutes of proof that it works. The measurement sees 40 minutes of
        // uptime and resets.
        long[] chain = chainOnTheCappedRung();
        long gap = 42 * 60 * 1000L;
        long demonstratedUptime = 40 * 60 * 1000L;

        assertEquals("40 minutes of uptime must clear the streak",
            0, CrashLoopGuard.pruneChain(chain, T0 + gap, demonstratedUptime).length);
        assertEquals("first rung after a run that long",
            CrashLoopGuard.BACKOFF_MS[0],
            CrashLoopGuard.decide(CrashLoopGuard.recordCrash(chain, T0 + gap, demonstratedUptime)));

        // Contrast, so this test names what it is actually fixing: the gap rule alone keeps it.
        assertEquals("the gap heuristic on its own still pins this device — that is the defect "
                + "the measurement removes, not a behaviour to preserve",
            chain.length, CrashLoopGuard.pruneChain(chain, T0 + gap, UNKNOWN).length);
    }

    @Test
    public void measuredUptimeDoesNotRescueADeviceThatIsStillHotLooping() {
        // The other direction: a short run must NOT clear the streak, or the cap is unreachable
        // again. This is the startup-crash loop — the process dies seconds in, every time.
        long[] chain = chainOnTheCappedRung();

        long[] kept = CrashLoopGuard.pruneChain(chain, T0 + 3_000L, 2_000L);

        assertEquals("two seconds of uptime is not a recovery", chain.length, kept.length);
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS,
            CrashLoopGuard.decide(CrashLoopGuard.recordCrash(chain, T0 + 3_000L, 2_000L)));
    }

    @Test
    public void uptimeIsMeasuredAtTheBoundaryNotApproximately() {
        long[] chain = chainOnTheCappedRung();
        assertEquals("just under the grace period is still a failed start",
            chain.length, CrashLoopGuard.pruneChain(chain, T0 + 1_000L, GRACE - 1).length);
        assertEquals("exactly the grace period counts as having stayed up",
            0, CrashLoopGuard.pruneChain(chain, T0 + 1_000L, GRACE).length);
    }

    @Test
    public void anUnmeasurableUptimeFallsBackToTheGapRule() {
        // API < 24, or a platform that hands back something inconsistent. The fallback is the
        // behaviour that shipped before the measurement existed, so it must stay intact rather
        // than failing open to "always reset" or closed to "never reset".
        long[] chain = chainOnTheCappedRung();

        assertEquals("a crash that arrives on schedule still compounds",
            chain.length,
            CrashLoopGuard.pruneChain(chain, T0 + CrashLoopGuard.CAPPED_RETRY_MS, UNKNOWN).length);
        assertEquals("and a stale chain still decays",
            0,
            CrashLoopGuard.pruneChain(
                chain, T0 + CrashLoopGuard.CAPPED_RETRY_MS + GRACE, UNKNOWN).length);
    }

    @Test
    public void aStaleChainDecaysEvenWhenTheAppKeepsDyingInstantly() {
        // Why the gap rule is kept at all rather than replaced outright: measured uptime says
        // nothing about how OLD the streak is. A device that crashed four times last week, was
        // switched off, and now crashes two seconds after a cold start must not be sentenced to
        // the hourly rung on the strength of week-old history.
        long[] chain = chainOnTheCappedRung();
        long aWeek = 7L * 24 * 60 * 60 * 1000L;

        assertEquals(0, CrashLoopGuard.pruneChain(chain, T0 + aWeek, 2_000L).length);
    }

    // ---- the report-only recovery chain decays differently ----------------------------------

    @Test
    public void theRecoveryChainDecaysOnQuietAloneNotOnAPenalty() {
        // Recoveries schedule nothing, so there is no darkness to subtract: the chain must
        // decay on plain quiet. Borrowing the ladder's penalty term would keep an ended storm
        // alive for over an hour and silently merge the next episode into it — which, with a
        // transition-only marker, means the next episode is never reported at all.
        long[] h = new long[0];
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordRecovery(h, T0 + i * 1_000L);
        }
        assertTrue("four flickers in four seconds is a storm", CrashLoopGuard.isLadderExhausted(h));

        long[] next = CrashLoopGuard.recordRecovery(h, T0 + CrashLoopGuard.GRACE_MS + 4_000L);
        assertEquals("a lone flicker after a quiet period starts a new episode", 1, next.length);
    }

    @Test
    public void theRecoveryChainStillCompoundsWhileFlickersKeepArriving() {
        long[] h = new long[0];
        long t = T0;
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            h = CrashLoopGuard.recordRecovery(h, t);
            t += CrashLoopGuard.GRACE_MS - 1_000L; // just inside the quiet threshold
        }
        assertTrue(CrashLoopGuard.isLadderExhausted(h));
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
            h = CrashLoopGuard.recordCrash(h, t, 0L);
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
            h = CrashLoopGuard.recordCrash(h, t, 0L);
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
            h = CrashLoopGuard.recordCrash(h, T0 + i * 1_000L, 0L);
        }
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, CrashLoopGuard.decide(h));

        long afterAQuietWindow =
            T0 + CrashLoopGuard.CAPPED_RETRY_MS + CrashLoopGuard.GRACE_MS + 60_000L;
        assertEquals(3_000L,
            CrashLoopGuard.decide(CrashLoopGuard.recordCrash(h, afterAQuietWindow, 0L)));
    }

    @Test
    public void futureEntriesArePrunedSoAClockJumpCannotPinUsOnTheSlowRung() {
        // Wall clock can jump years on a TV box that boots without a network. A stored
        // timestamp in the future would otherwise keep the chain alive forever.
        long[] history = { T0 + 5L * 365 * 24 * 60 * 60 * 1000L, T0 + 1_000L };
        assertEquals(0, CrashLoopGuard.pruneChain(history, T0, UNKNOWN).length);
        assertEquals(3_000L, CrashLoopGuard.decide(CrashLoopGuard.recordCrash(history, T0, 0L)));
    }

    @Test
    public void historyIsCappedAndKeepsTheMostRecent() {
        long[] h = new long[0];
        for (int i = 0; i < CrashLoopGuard.MAX_HISTORY + 5; i++) {
            h = CrashLoopGuard.recordCrash(h, T0 + i, 0L);
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
        assertArrayEquals(new long[] { T0 }, CrashLoopGuard.recordCrash(null, T0, 0L));
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
