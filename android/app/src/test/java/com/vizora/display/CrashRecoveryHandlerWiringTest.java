package com.vizora.display;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.AlarmManager;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import android.os.SystemClock;

import com.capacitorjs.plugins.preferences.CapacitorPreferencesReader;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.shadows.ShadowSystemClock;

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

    // ---- the uncaught-exception call site ---------------------------------------------------

    /**
     * Drive the real {@link Thread.UncaughtExceptionHandler} entry point.
     *
     * Everything else in this file calls recordAndScheduleRelaunch() directly, which proved the
     * handler works when called and nothing about whether uncaughtException calls it — deleting
     * that one line restores "a Java crash leaves the screen dark" and left the whole suite
     * green. A no-op delegate is installed FIRST so the handler captures it as its default: with
     * no delegate the production path ends in System.exit(1), which would take the test JVM
     * with it.
     */
    private void crashTheApp() {
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> { /* swallow: this is the delegate */ });
        try {
            CrashRecoveryHandler handler = new CrashRecoveryHandler(context);
            handler.uncaughtException(Thread.currentThread(), new RuntimeException("boom"));
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(previous);
        }
    }

    @Test
    public void anUncaughtExceptionSchedulesTheRestartItself() {
        crashTheApp();

        assertEquals("nothing else in the app would bring the screen back",
            1, shadowAlarmManager.getScheduledAlarms().size());
        assertEquals(CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(lastAlarm()));
    }

    @Test
    public void anUncaughtExceptionIsReportedAsACrashNotAsARendererLoop() {
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            crashTheApp();
        }

        String marker = CapacitorPreferencesReader.get(context, "crash_loop_capped");
        assertNotNull(marker);
        assertEquals("reason", CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION,
            marker.split(":")[2]);
    }

    @Test
    public void aCrashStillReachesTheDelegateHandlerSoTheProcessDies() {
        // The restart is scheduled for a process that is going away. If the delegate stopped
        // being called the process would linger in an undefined state and the scheduled
        // relaunch would land on a half-dead app.
        boolean[] delegateRan = { false };
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> delegateRan[0] = true);
        try {
            new CrashRecoveryHandler(context)
                .uncaughtException(Thread.currentThread(), new RuntimeException("boom"));
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(previous);
        }
        assertTrue("the default handler must still terminate the process", delegateRan[0]);
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

    // ---- N1: the fallback branch must survive Doze ------------------------------------------

    @Test
    public void theInexactFallbackAsksForTheIdleExemption() {
        // NOTE the name: this observes that the exemption was REQUESTED, which is all a shadow
        // AlarmManager can show. It is deliberately not called "...IsNotDozeDeferrable", because
        // that would be false — setAndAllowWhileIdle is still deferrable, boundedly, by its
        // ~9-minute per-app quota. What is pinned here is the flag, not a delivery guarantee.
        // N1, and this is not an edge case: SCHEDULE_EXACT_ALARM is capped at
        // maxSdkVersion=32 and USE_EXACT_ALARM is deliberately not declared, so
        // canScheduleExactAlarms() is false on EVERY API 33+ box and this is the only branch
        // modern Google TV hardware ever takes. setWindow() carries no idle exemption, so the
        // whole ladder was deferrable to the next maintenance window on the only live branch —
        // and the app has just died, which is also the worst case for app-standby bucketing.
        ShadowAlarmManager.setCanScheduleExactAlarms(false);

        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertTrue("the fallback alarm is Doze-deferrable, so on API 33+ hardware the crash "
                + "ladder may never fire at all", lastAlarm().isAllowWhileIdle());
    }

    @Test
    public void theExactPathAlsoAsksForTheIdleExemption() {
        // The pre-33 branch already used setExactAndAllowWhileIdle; pinned so the two branches
        // cannot drift apart on the property that actually matters here.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertTrue(lastAlarm().isAllowWhileIdle());
    }

    // ---- N3: a stale relaunch must not fire into a healthy device ---------------------------

    @Test
    public void aPendingRelaunchCanBeCancelled() {
        // Nothing ever cancelled the relaunch PendingIntent. The 60-minute rung plus a device
        // that came back by another route = a working display torn down mid-playback up to an
        // hour later by CLEAR_TASK.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        assertEquals(1, shadowAlarmManager.getScheduledAlarms().size());

        CrashRecoveryHandler.cancelPendingRelaunch(context);

        assertEquals("the relaunch alarm is still armed",
            0, shadowAlarmManager.getScheduledAlarms().size());
    }

    @Test
    public void cancellingWithNothingPendingIsANoOp() {
        // Runs on every single app start, including the overwhelmingly common clean boot.
        CrashRecoveryHandler.cancelPendingRelaunch(context);
        CrashRecoveryHandler.cancelPendingRelaunch(context);

        assertEquals(0, shadowAlarmManager.getScheduledAlarms().size());
    }

    @Test
    public void cancellingDoesNotDisarmALaterRelaunch() {
        // Cancel must not poison the PendingIntent for future scheduling: the device may crash
        // again five minutes after coming back.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        CrashRecoveryHandler.cancelPendingRelaunch(context);

        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertEquals(1, shadowAlarmManager.getScheduledAlarms().size());
        assertEquals(CrashLoopGuard.BACKOFF_MS[1], scheduledDelayMs(lastAlarm()));
    }

    // ---- N4: the safety action must not sit behind two synchronous disk writes --------------

    @Test
    public void theAlarmIsSetBeforeTheSynchronousPrefsWrites() {
        // N4. MainActivity reaches this from the LIVE main thread inside a framework callback,
        // where two commit() flushes on a box with full flash are a real ANR contributor — and
        // an ANR-kill between the writes and the alarm cost us the restart entirely. Ordering
        // is the whole fix, so ordering is what is asserted: the AlarmManager lookup must
        // happen before the first prefs EDIT.
        OrderRecordingContext recorder = new OrderRecordingContext(context);

        CrashRecoveryHandler.recordAndScheduleRelaunch(
            recorder, CrashRecoveryHandler.REASON_RENDERER_LOOP);

        int scheduled = recorder.calls.indexOf("SCHEDULE");
        int persisted = recorder.calls.indexOf("PERSIST");
        assertTrue("no alarm was scheduled at all: " + recorder.calls, scheduled >= 0);
        assertTrue("nothing was persisted at all: " + recorder.calls, persisted >= 0);
        assertTrue("the restart alarm is scheduled AFTER the blocking prefs writes, so an ANR "
                + "between them loses the restart: " + recorder.calls, scheduled < persisted);
    }

    /**
     * Records the ORDER in which the handler touches its two collaborators: the alarm service
     * and the prefs editor. Both go through Context, so a wrapper sees the real sequence
     * without stubbing out either one.
     */
    private static final class OrderRecordingContext extends ContextWrapper {
        final List<String> calls = new ArrayList<>();

        OrderRecordingContext(Context base) {
            super(base);
        }

        @Override
        public Object getSystemService(String name) {
            if (Context.ALARM_SERVICE.equals(name)) {
                calls.add("SCHEDULE");
            }
            return super.getSystemService(name);
        }

        @Override
        public SharedPreferences getSharedPreferences(String name, int mode) {
            // Reads are fine before the alarm — it is the WRITE that blocks, so record edit().
            return new RecordingPreferences(super.getSharedPreferences(name, mode), calls);
        }
    }

    /** SharedPreferences delegate that notes when an edit is opened. */
    private static final class RecordingPreferences implements SharedPreferences {
        private final SharedPreferences delegate;
        private final List<String> calls;

        RecordingPreferences(SharedPreferences delegate, List<String> calls) {
            this.delegate = delegate;
            this.calls = calls;
        }

        @Override
        public Editor edit() {
            calls.add("PERSIST");
            return delegate.edit();
        }

        @Override
        public Map<String, ?> getAll() {
            return delegate.getAll();
        }

        @Override
        public String getString(String key, String defValue) {
            return delegate.getString(key, defValue);
        }

        @Override
        public Set<String> getStringSet(String key, Set<String> defValues) {
            return delegate.getStringSet(key, defValues);
        }

        @Override
        public int getInt(String key, int defValue) {
            return delegate.getInt(key, defValue);
        }

        @Override
        public long getLong(String key, long defValue) {
            return delegate.getLong(key, defValue);
        }

        @Override
        public float getFloat(String key, float defValue) {
            return delegate.getFloat(key, defValue);
        }

        @Override
        public boolean getBoolean(String key, boolean defValue) {
            return delegate.getBoolean(key, defValue);
        }

        @Override
        public boolean contains(String key) {
            return delegate.contains(key);
        }

        @Override
        public void registerOnSharedPreferenceChangeListener(
                OnSharedPreferenceChangeListener listener) {
            delegate.registerOnSharedPreferenceChangeListener(listener);
        }

        @Override
        public void unregisterOnSharedPreferenceChangeListener(
                OnSharedPreferenceChangeListener listener) {
            delegate.unregisterOnSharedPreferenceChangeListener(listener);
        }
    }

    // ---- N5: recovered renderer deaths are recorded, but not on the restart ladder ----------

    @Test
    public void aRecoveredRendererDeathSchedulesNothing() {
        CrashRecoveryHandler.recordRendererRecovery(context);

        assertEquals("the screen already came back; scheduling a restart on top of a working "
            + "recovery would tear it down again", 0, shadowAlarmManager.getScheduledAlarms().size());
    }

    @Test
    public void aRecoveredRendererDeathDoesNotLengthenTheRestartBackoff() {
        for (int i = 0; i < CrashLoopGuard.MAX_HISTORY; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }

        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertEquals("recoveries leaked onto the restart ladder — the next real crash would "
                + "wait an hour in the dark instead of 3 seconds",
            CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(lastAlarm()));
    }

    @Test
    public void aStormOfRecoveredRendererDeathsLeavesItsOwnMarker() {
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }

        String marker = CapacitorPreferencesReader.get(context, "crash_loop_capped");
        assertNotNull("a device that keeps recovering forever must not look healthy", marker);
        assertEquals("reason", CrashRecoveryHandler.REASON_RENDERER_RECOVERY_STORM,
            marker.split(":")[2]);
    }

    @Test
    public void anIsolatedRecoveredRendererDeathIsNotReported() {
        // Negative control: a single recovery is normal operation, not a degradation.
        CrashRecoveryHandler.recordRendererRecovery(context);

        assertNull(CapacitorPreferencesReader.get(context, "crash_loop_capped"));
    }

    @Test
    public void aStormIsReportedOncePerEpisodeNotOncePerFlicker() {
        // F2. This path is the ONLY marker writer that nothing rate-limits — the device is up
        // and flickering, so there is no restart delay between events. main.ts reads AND
        // removes the marker on every page load, and the in-process relaunch causes a page load
        // on every flicker, so a marker written per flicker becomes a telemetry event per
        // flicker: ~7.8k/device/day at the shape this path exists for. Clearing the marker
        // between calls is exactly what main.ts does, so a re-write here is a re-report.
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }
        assertNotNull("the storm must be reported at least once",
            CapacitorPreferencesReader.get(context, "crash_loop_capped"));
        consumeMarkerAsTheWebLayerWould();

        for (int i = 0; i < 20; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }

        assertNull("the same storm was re-reported on every flicker; an alert that fires "
                + "thousands of times a day is not an alert",
            CapacitorPreferencesReader.get(context, "crash_loop_capped"));
    }

    @Test
    public void aLaterStormEpisodeIsReportedAgain() {
        // The other half of "once per episode": reporting once must not mean reporting once
        // ever. A device that flickers, recovers for the day, then flickers again next week is
        // two episodes and must produce two reports — which is why the recovery chain decays on
        // quiet rather than borrowing the restart ladder's much longer penalty term.
        // The chain is keyed on wall clock, and Robolectric's shadow clock moves
        // elapsedRealtime only, so the quiet period is expressed by seeding a STALE chain
        // through the same prefs the handler reads rather than by moving time.
        seedRecoveryChain(CrashLoopGuard.BACKOFF_MS.length + 1,
            System.currentTimeMillis() - CrashLoopGuard.GRACE_MS - 60_000L);
        seedStormAlreadyReported();
        assertNull("precondition: nothing reported yet",
            CapacitorPreferencesReader.get(context, "crash_loop_capped"));

        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }

        assertNotNull("a fresh episode after a quiet period must be reported again; a chain "
                + "that never decays reports the first storm and then goes silent forever",
            CapacitorPreferencesReader.get(context, "crash_loop_capped"));
    }

    /** The previous episode was reported, so the latch is set. */
    private void seedStormAlreadyReported() {
        context.getSharedPreferences("vizora_crash_recovery", Context.MODE_PRIVATE)
            .edit().putBoolean("renderer_storm_reported", true).commit();
    }

    /** Write an already-exhausted recovery chain, all of it {@code atMs}, as prefs state. */
    private void seedRecoveryChain(int entries, long atMs) {
        long[] stale = new long[entries];
        for (int i = 0; i < entries; i++) {
            stale[i] = atMs + i;
        }
        context.getSharedPreferences("vizora_crash_recovery", Context.MODE_PRIVATE)
            .edit()
            .putString("renderer_recovery_ms", CrashLoopGuard.serializeHistory(stale))
            .commit();
    }

    /** What src/main.ts does with the marker on every page load: report it, then remove it. */
    private void consumeMarkerAsTheWebLayerWould() {
        capacitorPrefs().edit().remove(CrashRecoveryHandler.KEY_CAPPED_MARKER).commit();
    }

    // ---- the ladder decays on MEASURED uptime, at the call site -----------------------------

    @Test
    public void aCrashAfterALongHealthyRunGetsTheFastRungAgain() {
        // Binds the measurement to the production call site, and isolates it: Robolectric's
        // shadow clock moves elapsedRealtime (hence measured process uptime) WITHOUT moving
        // wall clock, so the gap between crash timestamps stays ~0 here. The gap rule therefore
        // still says "keep the chain"; only the uptime measurement can produce a reset.
        //
        // That is exactly the operator's case — a device brought back by something other than
        // our alarm, which then ran fine for a long time — and before the measurement existed
        // it took the 60-minute rung anyway.
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }
        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, scheduledDelayMs(lastAlarm()));

        ShadowSystemClock.advanceBy(Duration.ofMillis(CrashLoopGuard.GRACE_MS + 60_000L));
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertEquals("the app demonstrably stayed up for longer than the grace period, so the "
                + "streak of failed starts is over and this is a first crash again",
            CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(lastAlarm()));
    }

    @Test
    public void aCrashDuringStartupStillEscalates() {
        // Negative control for the test above: without advancing the clock the process has been
        // up for milliseconds, which must NOT be read as a healthy run — otherwise the
        // measurement would un-stick the very loop the ladder exists to contain.
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }

        assertEquals(CrashLoopGuard.CAPPED_RETRY_MS, scheduledDelayMs(lastAlarm()));
    }

    // ---- one key, shared by both causes: a write must not downgrade the record --------------

    private String markerReason() {
        String marker = CapacitorPreferencesReader.get(context, "crash_loop_capped");
        assertNotNull("no marker at all", marker);
        return marker.split(":")[2];
    }

    private void degradeOnTheRestartLadder() {
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }
    }

    private void flickerIntoAStorm() {
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }
    }

    @Test
    public void aStormMustNotOverwriteAnUnreportedRestartLadderMarker() {
        // Both causes write the SAME key, because it is the only key main.ts reads. That makes
        // the ordering matter: a device dark on the 60-minute rung whose record is replaced by
        // a flicker report tells the operator the opposite of the truth. And the record really
        // does sit there — main.ts keeps the marker when crash reporting is disabled rather
        // than deleting it on the strength of a reportEvent that sent nothing, so on a build
        // with no Sentry DSN "unreported" is the normal state, not a race.
        degradeOnTheRestartLadder();
        assertEquals(CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION, markerReason());

        flickerIntoAStorm();

        assertEquals("the storm overwrote a record of the device being DARK",
            CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION, markerReason());
    }

    @Test
    public void aRestartLadderMarkerMayReplaceAStormMarker() {
        // The rule is severity, not first-writer-wins: being dark outranks flickering, so this
        // direction must still overwrite or a device that degrades from flickering to dark
        // would report the milder state forever.
        flickerIntoAStorm();
        assertEquals(CrashRecoveryHandler.REASON_RENDERER_RECOVERY_STORM, markerReason());

        degradeOnTheRestartLadder();

        assertEquals(CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION, markerReason());
    }

    @Test
    public void aWorseningRestartLadderRecordKeepsBeingRefreshed() {
        // The no-clobber rule is about SEVERITY, and it must not freeze the record it protects.
        // CrashLoopGuard's javadoc claims the marker's count keeps climbing so that a device
        // looping for a week is distinguishable from one that looped four times and recovered —
        // that claim lives here, at the write, and nothing pinned it: a guard that refused every
        // overwrite kept the suite green while pinning the count at 4 forever, which is exactly
        // the defect the count was widened to fix.
        degradeOnTheRestartLadder();
        int atTransition = Integer.parseInt(
            CapacitorPreferencesReader.get(context, "crash_loop_capped").split(":")[1]);

        for (int i = 0; i < 5; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        }

        int afterMoreCrashes = Integer.parseInt(
            CapacitorPreferencesReader.get(context, "crash_loop_capped").split(":")[1]);
        assertTrue("the marker froze at " + atTransition + " crashes, so a week-long loop looks "
                + "identical to a single episode", afterMoreCrashes > atTransition);
    }

    @Test
    public void aStormReportRefusedByTheNoClobberRuleIsRetriedNotLost() {
        // The two rules interact badly if the storm report fires only on the exact transition:
        // that single write can be refused, and the recovery chain does NOT decay during a
        // continuous storm, so the length climbs past the transition and the episode is lost
        // silently — the exact failure class this marker exists to remove.
        //
        // And it is not a race. main.ts keeps the ladder marker when crash reporting is
        // disabled, which is the configuration this repo ships, so the refusal would persist
        // for the life of the device: a box that ever hit the cap could never again report a
        // flicker storm.
        degradeOnTheRestartLadder();
        flickerIntoAStorm();
        assertEquals("precondition: the storm report is refused while the worse record stands",
            CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION, markerReason());

        // The operator finally gets the ladder marker reported, freeing the slot.
        consumeMarkerAsTheWebLayerWould();

        // The storm is still going — one more flicker, well past the transition length.
        CrashRecoveryHandler.recordRendererRecovery(context);

        assertEquals("the storm report was dropped on the floor instead of retried",
            CrashRecoveryHandler.REASON_RENDERER_RECOVERY_STORM, markerReason());
    }

    @Test
    public void aRetriedStormReportStillOnlyLandsOnce() {
        // The retry must not become the flood the transition check was preventing.
        degradeOnTheRestartLadder();
        flickerIntoAStorm();
        consumeMarkerAsTheWebLayerWould();
        CrashRecoveryHandler.recordRendererRecovery(context);
        assertEquals(CrashRecoveryHandler.REASON_RENDERER_RECOVERY_STORM, markerReason());
        consumeMarkerAsTheWebLayerWould();

        for (int i = 0; i < 20; i++) {
            CrashRecoveryHandler.recordRendererRecovery(context);
        }

        assertNull("once the episode is reported it must stay quiet until a new one",
            CapacitorPreferencesReader.get(context, "crash_loop_capped"));
    }

    @Test
    public void aStormIsStillRecordedWhenNothingWorseIsPending() {
        // Negative control: the no-clobber rule must not turn into "storms are never reported".
        flickerIntoAStorm();

        assertEquals(CrashRecoveryHandler.REASON_RENDERER_RECOVERY_STORM, markerReason());
    }

    @Test
    public void aStormYieldsToATruncatedMarkerRatherThanDestroyingIt() {
        // Markers are written by processes that may be mid-death, so a half-written value is
        // expected. main.ts still reports a truncated marker, so it is a real record; a flicker
        // must not be what destroys it.
        capacitorPrefs().edit()
            .putString(CrashRecoveryHandler.KEY_CAPPED_MARKER, "1700000000000").commit();

        flickerIntoAStorm();

        assertEquals("a truncated record is still a record",
            "1700000000000", CapacitorPreferencesReader.get(context, "crash_loop_capped"));
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
    public void markerIsReadableThroughTheCapacitorPreferencesPluginItself() {
        // The marker is only useful if src/main.ts can see it, and main.ts reads it with
        // Preferences.get({key: 'crash_loop_capped'}).
        //
        // This test used to be called markerIsWrittenToTheStoreTheWebLayerActuallyReads and
        // then re-opened SharedPreferences with the same two string literals the writer had
        // just used — it could not have failed if BOTH the file name and the key were wrong
        // together, which is precisely the mistake it claimed to rule out. It now reads back
        // through the plugin's own storage layer (com.capacitorjs.plugins.preferences), with
        // the plugin's own default configuration, so the group name comes from the plugin
        // rather than from us.
        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length + 1; i++) {
            CrashRecoveryHandler.recordAndScheduleRelaunch(
                context, CrashRecoveryHandler.REASON_RENDERER_LOOP);
        }

        assertNotNull("the marker is not where the Preferences plugin looks — the operator is "
                + "never told, exactly as if it had not been written",
            CapacitorPreferencesReader.get(context, "crash_loop_capped"));
    }

    @Test
    public void thePrivateCrashHistoryIsNotVisibleToTheWebLayer() {
        // Negative control for the test above: the reader is sensitive to WHICH prefs file a
        // value lands in. The crash history is deliberately private (it is churn, not
        // telemetry) and must not appear in the store the web layer enumerates.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);

        assertNull("the plugin reader is reading the wrong file if it can see this",
            CapacitorPreferencesReader.get(context, "crash_history_ms"));
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
