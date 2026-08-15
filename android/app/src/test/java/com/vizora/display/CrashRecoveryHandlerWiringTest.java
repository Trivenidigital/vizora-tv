package com.vizora.display;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.AlarmManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;

import java.util.List;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowAlarmManager;

/**
 * WIRING tests for {@link CrashRecoveryHandler}.
 *
 * CrashLoopGuardTest pins the pure decision function; this file pins that the decision is
 * actually CONNECTED to an alarm and to persistent state. That distinction was a real gap:
 * every pure test stayed green while the ladder's terminal rung scheduled nothing at all, so
 * "the guard says 60 minutes" and "the device restarts in 60 minutes" were not the same claim.
 *
 * Uses Robolectric so the SharedPreferences round-trip and the AlarmManager call are the real
 * framework APIs rather than mocks of them.
 */
@RunWith(RobolectricTestRunner.class)
public class CrashRecoveryHandlerWiringTest {

    private Context context;
    private AlarmManager alarmManager;
    private ShadowAlarmManager shadowAlarmManager;

    @Before
    public void setUp() {
        context = RuntimeEnvironment.getApplication();
        alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        shadowAlarmManager = shadowOf(alarmManager);
        ShadowAlarmManager.setCanScheduleExactAlarms(true);
    }

    private ShadowAlarmManager.ScheduledAlarm lastAlarm() {
        List<ShadowAlarmManager.ScheduledAlarm> alarms = shadowAlarmManager.getScheduledAlarms();
        assertTrue("expected an alarm to have been scheduled", alarms.size() > 0);
        return alarms.get(alarms.size() - 1);
    }

    /** Delay implied by an alarm, relative to the clock it is anchored to. */
    private long scheduledDelayMs(ShadowAlarmManager.ScheduledAlarm alarm) {
        return alarm.getTriggerAtMs() - SystemClock.elapsedRealtime();
    }

    private SharedPreferences capacitorPrefs() {
        return context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE);
    }

    // ---- an alarm is always scheduled ------------------------------------------------------

    @Test
    public void firstCrashSchedulesTheFastRung() {
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertEquals(1, shadowAlarmManager.getScheduledAlarms().size());
        assertEquals(CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(lastAlarm()));
    }

    @Test
    public void everyCrashPastTheLadderStillSchedulesAnAlarm() {
        // THE regression test for the dark-screen bug, at the wiring level. Previously the
        // 4th crash hit a HOLD sentinel and scheduled NOTHING, and no pure test could see it
        // because the pure function was "correctly" returning the sentinel it was asked for.
        //
        // Asserted per-iteration rather than by counting alarms at the end: the relaunch
        // PendingIntent is a stable (requestCode 0, FLAG_ONE_SHOT) intent, so re-scheduling
        // REPLACES the pending alarm instead of accumulating one per crash. That is the
        // behaviour we want — one pending relaunch, not a queue of them — so the property to
        // pin is "after every single crash there is a future alarm outstanding".
        //
        // Asserted per-iteration against the EXPECTED rung, not by counting alarms: the
        // relaunch PendingIntent is stable (requestCode 0, FLAG_ONE_SHOT), so re-scheduling
        // REPLACES the pending alarm rather than accumulating one per crash. That is the
        // behaviour we want — one pending relaunch, not a queue — but it means a crash that
        // scheduled NOTHING would leave the previous crash's alarm outstanding and a bare
        // "an alarm exists" check would pass. Every rung is a distinct value, so asserting
        // the exact expected delay is what proves THIS call scheduled something.
        int crashes = CrashLoopGuard.BACKOFF_MS.length + 4;
        for (int i = 0; i < crashes; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

            long expected = i < CrashLoopGuard.BACKOFF_MS.length
                ? CrashLoopGuard.BACKOFF_MS[i]
                : CrashLoopGuard.CAPPED_RETRY_MS;
            assertTrue("crash " + (i + 1) + " scheduled no relaunch at all",
                shadowAlarmManager.getScheduledAlarms().size() > 0);
            assertEquals("crash " + (i + 1) + " did not schedule its own relaunch",
                expected, scheduledDelayMs(lastAlarm()));
        }
    }

    @Test
    public void crashPastTheLadderSchedulesTheSlowRungNotTheFastOne() {
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length + 1; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }

        assertEquals("expected the capped rung, not a ladder rung",
            CrashLoopGuard.CAPPED_RETRY_MS, scheduledDelayMs(lastAlarm()));
    }

    @Test
    public void ladderEscalatesThroughTheRealAlarmManager() {
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
            assertEquals("crash " + (i + 1) + " scheduled the wrong rung",
                CrashLoopGuard.BACKOFF_MS[i], scheduledDelayMs(lastAlarm()));
        }
    }

    // ---- clock choice (F10) ----------------------------------------------------------------

    @Test
    public void alarmsUseTheMonotonicElapsedRealtimeClock() {
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        ShadowAlarmManager.ScheduledAlarm alarm = lastAlarm();
        assertEquals("a RELATIVE delay must not be anchored to wall clock: a backward clock "
                + "jump would strand the alarm and the device would never restart",
            AlarmManager.ELAPSED_REALTIME_WAKEUP, alarm.getType());

        // Independent of the type constant: the trigger must be near the elapsed-realtime
        // clock, not near System.currentTimeMillis() (which is ~1.7e12 apart). This is what
        // actually catches a revert to RTC_WAKEUP even if the assertion above were relaxed.
        long fromElapsed = Math.abs(alarm.getTriggerAtMs() - SystemClock.elapsedRealtime());
        long fromWallClock = Math.abs(alarm.getTriggerAtMs() - System.currentTimeMillis());
        assertTrue("trigger time is anchored to the wrong clock", fromElapsed < fromWallClock);
    }

    @Test
    public void windowedFallbackUsesTheSameClockAsTheExactPath() {
        // The inexact fallback taken when SCHEDULE_EXACT_ALARM is not granted must not
        // reintroduce the wall-clock anchoring on a different branch.
        ShadowAlarmManager.setCanScheduleExactAlarms(false);

        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        ShadowAlarmManager.ScheduledAlarm alarm = lastAlarm();
        assertEquals(AlarmManager.ELAPSED_REALTIME_WAKEUP, alarm.getType());
        assertEquals(CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(alarm));
    }

    // ---- persistence -----------------------------------------------------------------------

    @Test
    public void crashHistoryIsReadableImmediatelyAfterTheCallReturns() {
        // The handler runs on a dying process, so the write must be visible without waiting
        // for a background flush. NOTE the honest limit of this assertion: Robolectric applies
        // apply() synchronously too, so this pins "the history is persisted and re-read across
        // handles", NOT commit()-vs-apply() itself — that distinction is not observable in
        // this harness and is held by code review.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        SharedPreferences fresh =
            context.getSharedPreferences("vizora_crash_recovery", Context.MODE_PRIVATE);
        long[] history = CrashLoopGuard.parseHistory(fresh.getString("crash_history_ms", null));
        assertEquals(1, history.length);
    }

    @Test
    public void historyAccumulatesAcrossCallsSoTheLadderActuallyEscalates() {
        // If the read-modify-write were broken (e.g. always writing a fresh single-entry
        // history) every crash would look like the first and the ladder would never escalate,
        // while every pure test stayed green.
        for (int i = 1; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
            SharedPreferences fresh =
                context.getSharedPreferences("vizora_crash_recovery", Context.MODE_PRIVATE);
            long[] history =
                CrashLoopGuard.parseHistory(fresh.getString("crash_history_ms", null));
            assertEquals("history did not accumulate", i, history.length);
        }
    }

    // ---- the degradation marker (CLAUDE.md 12b) --------------------------------------------

    @Test
    public void noMarkerIsWrittenWhileStillOnTheLadder() {
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }
        assertNull("a device still escalating normally is not a degraded device",
            capacitorPrefs().getString(CrashRecoveryHandler.KEY_CAPPED_MARKER, null));
    }

    @Test
    public void markerIsWrittenWhenTheLadderIsExhausted() {
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length + 1; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }

        String marker = capacitorPrefs().getString(CrashRecoveryHandler.KEY_CAPPED_MARKER, null);
        assertNotNull("degradation to the slow rung must not be silent", marker);

        String[] parts = marker.split(":");
        assertEquals(3, parts.length);
        assertEquals("crash count", CrashLoopGuard.BACKOFF_MS.length + 1,
            Integer.parseInt(parts[1]));
        assertEquals("reason", CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION, parts[2]);
        assertTrue("timestamp", Long.parseLong(parts[0]) > 0L);
    }

    @Test
    public void markerIsWrittenToTheStoreTheWebLayerActuallyReads() {
        // The marker is only useful if src/main.ts can see it. main.ts uses the Capacitor
        // Preferences API, which is backed by the "CapacitorStorage" SharedPreferences file
        // under the raw key — writing it into our own private crash prefs would be invisible
        // to the reader and the operator would still never be told.
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length + 1; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_RENDERER_LOOP);
        }

        assertNotNull(context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .getString("crash_loop_capped", null));
    }

    @Test
    public void rendererLoopIsRecordedOnTheSameLadderAsCrashes() {
        // A device alternating between renderer deaths and Java crashes must still escalate;
        // two independent ladders would each look healthy while the screen flapped.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_RENDERER_LOOP);
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertEquals("second event must take the second rung, not the first",
            CrashLoopGuard.BACKOFF_MS[1], scheduledDelayMs(lastAlarm()));
    }
}
