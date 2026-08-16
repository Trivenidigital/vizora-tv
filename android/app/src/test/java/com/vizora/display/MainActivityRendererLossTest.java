package com.vizora.display;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.SystemClock;
import android.webkit.WebView;

import com.getcapacitor.BridgeTestAccess;
import com.getcapacitor.WebViewListener;

import java.time.Duration;
import java.util.List;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowAlarmManager;
import org.robolectric.shadows.ShadowSystemClock;
import org.robolectric.shadows.ShadowWebView;

/**
 * CALL-SITE tests for the F36 renderer-loss path.
 *
 * Why they exist: {@link CrashRecoveryHandlerWiringTest} calls
 * {@code recordAndScheduleRelaunch} DIRECTLY, so it proved the handler works when called and
 * nothing at all about whether MainActivity calls it. Four mutations were executed against the
 * shipped code and ALL of them left the Java suite green — including deleting the
 * recordAndScheduleRelaunch call from the renderer-loop branch, which restores the exact
 * dark-screen bug this release exists to fix, and swapping its reason tag, which makes the
 * operator marker report the wrong cause. That is the same "the checker never touches the
 * production call site" defect the wiring tests were themselves added to fix, reproduced one
 * call frame up.
 *
 * So these tests build the REAL MainActivity, pull the WebViewListener the activity actually
 * registered out of the Capacitor Bridge, and drive onRenderProcessGone through it. Nothing
 * here re-implements the wiring it is checking.
 */
@RunWith(RobolectricTestRunner.class)
public class MainActivityRendererLossTest {

    private Context context;
    private ShadowAlarmManager shadowAlarmManager;
    private MainActivity activity;
    private WebViewListener rendererListener;
    private Thread.UncaughtExceptionHandler previousDefaultHandler;

    @Before
    public void setUp() {
        // Capacitor's Bridge refuses to build if it cannot read the system WebView package,
        // which Robolectric does not populate by default.
        PackageInfo webViewPackage = new PackageInfo();
        webViewPackage.packageName = "com.google.android.webview";
        webViewPackage.versionName = "999.0.0.0";
        ShadowWebView.setCurrentWebViewPackage(webViewPackage);

        context = RuntimeEnvironment.getApplication();
        shadowAlarmManager =
            shadowOf((AlarmManager) context.getSystemService(Context.ALARM_SERVICE));
        ShadowAlarmManager.setCanScheduleExactAlarms(true);

        // MainActivity's statics deliberately survive an activity relaunch, and Robolectric
        // shares one classloader across these methods, so they must be reset or test order
        // decides which branch the first death takes — and, for the crash handler, whether the
        // activity re-installs it at all.
        MainActivity.resetProcessStaticsForTests();

        // Robolectric does not reset Thread's default-handler slot between methods either, so
        // without this the "MainActivity installs the crash handler" assertion below would pass
        // on the handler left behind by the previous method.
        previousDefaultHandler = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(null);
    }

    @After
    public void tearDown() {
        // Leave the JVM as we found it: the handler installed by MainActivity has a null
        // delegate here, and its production fallback is System.exit(1).
        Thread.setDefaultUncaughtExceptionHandler(previousDefaultHandler);
    }

    private void launchActivity() {
        activity = Robolectric.buildActivity(MainActivity.class).create().get();
        List<WebViewListener> listeners = BridgeTestAccess.webViewListeners(activity.getBridge());
        assertEquals("MainActivity must register exactly one renderer-loss listener; without it "
            + "a renderer death is a blank screen until a power-cycle", 1, listeners.size());
        rendererListener = listeners.get(0);
        assertTrue("MainActivity must install the crash handler; without it an uncaught "
                + "exception is a dark screen",
            Thread.getDefaultUncaughtExceptionHandler() instanceof CrashRecoveryHandler);
        shadowOf(activity).clearNextStartedActivities();
    }

    /** Drive a renderer death through the listener the activity really registered. */
    private boolean rendererDies() {
        WebView webView = activity.getBridge().getWebView();
        return rendererListener.onRenderProcessGone(webView, null);
    }

    /** Move past the in-process guard interval so the next death is not read as a tight loop. */
    private void waitOutTheGuardInterval() {
        ShadowSystemClock.advanceBy(Duration.ofMillis(RendererRecoveryGuard.MIN_INTERVAL_MS * 2));
    }

    private ShadowAlarmManager.ScheduledAlarm lastAlarm() {
        List<ShadowAlarmManager.ScheduledAlarm> alarms = shadowAlarmManager.getScheduledAlarms();
        assertTrue("expected a relaunch alarm to have been scheduled", alarms.size() > 0);
        return alarms.get(alarms.size() - 1);
    }

    private long scheduledDelayMs(ShadowAlarmManager.ScheduledAlarm alarm) {
        return alarm.getTriggerAtMs() - SystemClock.elapsedRealtime();
    }

    private String marker() {
        return context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
            .getString(CrashRecoveryHandler.KEY_CAPPED_MARKER, null);
    }

    // ---- the recover branch ----------------------------------------------------------------

    @Test
    public void anIsolatedRendererDeathIsRecoveredInProcess() {
        launchActivity();

        assertTrue("returning false here hands the process to the framework and blanks the "
            + "screen; an isolated death must be handled in-process", rendererDies());

        Intent relaunch = shadowOf(activity).getNextStartedActivity();
        assertNotNull("no fresh MainActivity was started — the dead WebView would be reused",
            relaunch);
        assertEquals(MainActivity.class.getName(), relaunch.getComponent().getClassName());
        assertTrue("the old activity must be torn down", activity.isFinishing());
        assertEquals("an in-process recovery must not schedule a process restart",
            0, shadowAlarmManager.getScheduledAlarms().size());
    }

    // ---- the loop branch (BLOCKER: this is the release's headline fix) ----------------------

    @Test
    public void aRendererLoopSchedulesARestartInsteadOfSchedulingNothing() {
        // THE regression test for the dark screen. Deleting the recordAndScheduleRelaunch call
        // from MainActivity's loop branch used to leave every Java test green.
        //
        // Named for scheduling, not for recovering: whether the alarm's activity start is
        // permitted against a dead process is the unsettled BAL question. Scheduling nothing
        // is certainly a dark screen; scheduling something is the most this can prove.
        launchActivity();
        rendererDies();               // recovered in-process
        shadowOf(activity).clearNextStartedActivities();

        assertFalse("a second death inside the guard interval must NOT hot-loop in-process",
            rendererDies());

        assertEquals("the framework is about to kill this process and nothing else would bring "
                + "the app back — the loop branch must schedule the restart itself",
            1, shadowAlarmManager.getScheduledAlarms().size());
        assertEquals("first event on the crash ladder takes the first rung",
            CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(lastAlarm()));
        assertNull("the loop branch must not also relaunch in-process",
            shadowOf(activity).getNextStartedActivity());
    }

    @Test
    public void aRendererLoopEscalatesOnTheCrashLadder() {
        // Each loop trip is a real process-loss event and must back off, or the device restarts
        // every 3s forever — the behaviour CrashLoopGuard exists to contain.
        launchActivity();
        rendererDies(); // recovered

        for (int i = 0; i < CrashLoopGuard.BACKOFF_MS.length; i++) {
            rendererDies(); // loop: inside the guard interval, no clock advance
            assertEquals("loop trip " + (i + 1) + " scheduled the wrong rung",
                CrashLoopGuard.BACKOFF_MS[i], scheduledDelayMs(lastAlarm()));
        }
    }

    @Test
    public void aRendererLoopIsReportedAsARendererLoopNotAsACrash() {
        // The marker's reason field is the only thing that tells an operator which of the two
        // process-loss causes degraded this device. Swapping the tag at the call site for
        // REASON_UNCAUGHT_EXCEPTION made the marker lie, and no test noticed.
        launchActivity();
        rendererDies(); // recovered
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            rendererDies(); // loop trips until the ladder is exhausted
        }

        String marker = marker();
        assertNotNull("an exhausted ladder must not be silent", marker);
        assertEquals("reason", CrashRecoveryHandler.REASON_RENDERER_LOOP, marker.split(":")[2]);
    }

    // ---- N5: deaths that keep recovering just outside the guard interval --------------------

    @Test
    public void aStormOfRecoveredRendererDeathsIsReported() {
        // N5. A renderer that dies just OUTSIDE the guard interval — a heavy asset in a
        // rotating playlist is exactly that shape — recovers in-process every time and never
        // trips the loop branch. Before this, that device relaunched its activity forever while
        // the fleet saw an uninterrupted healthy heartbeat: no escalation, no marker, no report.
        launchActivity();
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            assertTrue("each of these deaths still recovers in-process", rendererDies());
            waitOutTheGuardInterval();
        }

        String marker = marker();
        assertNotNull("a device flickering indefinitely must not look healthy to the fleet",
            marker);
        assertEquals("reason", CrashRecoveryHandler.REASON_RENDERER_RECOVERY_STORM,
            marker.split(":")[2]);
        assertTrue("the marker must carry how many recoveries were seen",
            Integer.parseInt(marker.split(":")[1]) > CrashLoopGuard.BACKOFF_MS.length);
    }

    @Test
    public void recoveredDeathsAreNeverPutOnTheRestartLadder() {
        // The other half of the N5 decision, and the reason the recovery history is a separate
        // key: a recovery is a SUCCESS (the screen came back in under a second). If recoveries
        // counted on the restart ladder, four of them would leave the next unrelated crash
        // waiting an hour in the dark instead of 3 seconds — trading a flicker for exactly the
        // dark screen this release exists to remove.
        launchActivity();
        for (int i = 0; i <= CrashLoopGuard.BACKOFF_MS.length; i++) {
            rendererDies();
            waitOutTheGuardInterval();
        }
        assertEquals("an in-process recovery must never schedule anything",
            0, shadowAlarmManager.getScheduledAlarms().size());

        // Now a real process-loss event: it must still get the FAST rung.
        rendererDies(); // recovered (guard interval already elapsed)
        rendererDies(); // loop trip — the first entry on the crash ladder

        assertEquals("recoveries inflated the restart backoff",
            CrashLoopGuard.BACKOFF_MS[0], scheduledDelayMs(lastAlarm()));
    }

    // ---- N3: a stale relaunch alarm must not fire into a healthy device ---------------------

    @Test
    public void comingBackUpCancelsAPendingRelaunchAlarm() {
        // N3. Nothing cancelled the relaunch PendingIntent. A device that took the 60-minute
        // rung and then came back by another route (launcher, operator, MY_PACKAGE_REPLACED)
        // kept a live alarm carrying CLEAR_TASK, which tears down a working display
        // mid-playback up to an hour later.
        CrashRecoveryHandler.recordAndScheduleRelaunch(
            context, CrashRecoveryHandler.REASON_UNCAUGHT_EXCEPTION);
        assertEquals(1, shadowAlarmManager.getScheduledAlarms().size());

        launchActivity();

        assertEquals("the app is demonstrably up; the pending relaunch must be cancelled",
            0, shadowAlarmManager.getScheduledAlarms().size());
    }

    @Test
    public void startingUpWithNoPendingRelaunchDoesNotCreateOne() {
        // Negative control for the cancel: FLAG_NO_CREATE means "look it up", not "make one".
        // A cancel path that manufactured the PendingIntent would leave one registered on every
        // normal boot.
        launchActivity();

        assertEquals(0, shadowAlarmManager.getScheduledAlarms().size());
        SharedPreferences crashPrefs =
            context.getSharedPreferences("vizora_crash_recovery", Context.MODE_PRIVATE);
        assertNull("a clean boot is not a crash", crashPrefs.getString("crash_history_ms", null));
    }
}
