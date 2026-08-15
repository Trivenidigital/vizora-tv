package com.vizora.display;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

/**
 * Global uncaught exception handler that restarts the app after a crash.
 * Essential for 24/7 digital signage — a crash must not leave a blank screen.
 *
 * NOTE: This handler catches uncaught Java/Kotlin exceptions only.
 * Native crashes (SIGSEGV, SIGABRT) bypass this handler entirely —
 * for those, the BootReceiver handles restart on next device boot.
 *
 * N2: the restart delay is no longer fixed. Crash timestamps are persisted here and the delay
 * comes from {@link CrashLoopGuard} (pure, host-JVM-testable), so a deterministic
 * crash-on-startup escalates 3s → 30s → 5min → 60min/attempt instead of hot-looping the
 * activity every 3 seconds forever. The ladder is CAPPED, never terminal: there is no branch
 * on which this handler declines to schedule a restart, because nothing else in the app would
 * ever bring the screen back (see {@link CrashLoopGuard} for the full argument).
 *
 * Also the relaunch path for an unrecoverable WebView renderer-loss loop — see
 * {@link #recordAndScheduleRelaunch}, called from MainActivity. A renderer death raises no
 * Java exception, so it cannot reach {@link #uncaughtException}; routing it here anyway means
 * both process-loss causes share ONE escalation ladder and one alarm path.
 */
public class CrashRecoveryHandler implements Thread.UncaughtExceptionHandler {
    private static final String TAG = "VizoraCrashRecovery";

    private static final String CRASH_PREFS_NAME = "vizora_crash_recovery";
    private static final String KEY_CRASH_HISTORY = "crash_history_ms";

    /**
     * Capacitor's Preferences plugin stores everything in this SharedPreferences file under
     * the raw key (see PreferencesConfiguration.DEFAULTS.group and Preferences.get). Writing
     * the degradation marker here — rather than into our private crash prefs — is what lets
     * src/main.ts read it with the Preferences API it already uses, with no new plugin.
     */
    private static final String CAPACITOR_PREFS_NAME = "CapacitorStorage";

    /** Read + cleared by src/main.ts on the next successful boot; see MARKER format below. */
    static final String KEY_CAPPED_MARKER = "crash_loop_capped";

    /** Reason tags recorded in the marker so telemetry can tell the two causes apart. */
    static final String REASON_UNCAUGHT_EXCEPTION = "uncaught_exception";
    static final String REASON_RENDERER_LOOP = "renderer_loop";

    private final Context context;
    private final Thread.UncaughtExceptionHandler defaultHandler;

    public CrashRecoveryHandler(Context context) {
        this.context = context.getApplicationContext();
        this.defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
    }

    @Override
    public void uncaughtException(Thread thread, Throwable throwable) {
        Log.e(TAG, "Uncaught exception, evaluating restart", throwable);

        // catch Throwable, not Exception: OutOfMemoryError is the likeliest thing to hit us
        // here (it is a common ORIGINAL crash cause, and the bookkeeping below allocates, does
        // an XML serialization and writes to disk on an already-dying process). An Error
        // escaping this block would skip the defaultHandler/System.exit below and leave the
        // process in an undefined state — no restart, and possibly no termination either.
        try {
            recordAndScheduleRelaunch(context, REASON_UNCAUGHT_EXCEPTION);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to schedule restart", t);
        }

        // Let the default handler run (this will terminate the process)
        if (defaultHandler != null) {
            defaultHandler.uncaughtException(thread, throwable);
        } else {
            System.exit(1);
        }
    }

    /**
     * Record this process-loss event against the crash-loop ladder and schedule the relaunch
     * alarm. Shared by the uncaught-exception path and MainActivity's renderer-loss path, so
     * a device flapping between the two escalates on one ladder instead of two independent
     * ones that each look fine.
     *
     * ALWAYS schedules. {@link CrashLoopGuard#decide} has no give-up value.
     */
    static void recordAndScheduleRelaunch(Context context, String reason) {
        long now = System.currentTimeMillis();
        long restartDelayMs = recordCrashAndDecide(context, now, reason);
        scheduleRestart(context, restartDelayMs);
    }

    /**
     * Persist this crash and ask {@link CrashLoopGuard} what to do. Uses commit() not
     * apply(): the process is dying, and apply()'s background flush may never run.
     *
     * FAILS OPEN. If the history cannot be read or written (prefs unavailable this early in
     * a crashing process, disk full, ...) we return the first rung rather than letting the
     * throwable escape. Letting it escape would mean a bookkeeping failure suppressed the
     * restart entirely — strictly worse than the unconditional 3s restart this replaced.
     *
     * @return the restart delay in ms (always schedulable)
     */
    private static long recordCrashAndDecide(Context context, long nowMs, String reason) {
        try {
            SharedPreferences prefs =
                context.getSharedPreferences(CRASH_PREFS_NAME, Context.MODE_PRIVATE);
            long[] history = CrashLoopGuard.parseHistory(prefs.getString(KEY_CRASH_HISTORY, null));
            long[] updated = CrashLoopGuard.recordCrash(history, nowMs);
            boolean persisted = prefs.edit()
                .putString(KEY_CRASH_HISTORY, CrashLoopGuard.serializeHistory(updated))
                .commit();
            if (!persisted) {
                // Disk full is entirely plausible on a signage box with a full media cache.
                // The history then never advances, every crash reads the same state, and the
                // ladder silently degenerates back to the unbounded 3s relaunch loop this
                // class exists to prevent. Say so loudly rather than containing nothing while
                // appearing to contain something.
                Log.e(TAG, "crash history not persisted — loop containment is INACTIVE");
            }
            Log.w(TAG, "Crash " + updated.length + " (" + reason + ") inside the "
                + CrashLoopGuard.WINDOW_MS + "ms window");
            if (CrashLoopGuard.isLadderExhausted(updated)) {
                writeCappedMarker(context, nowMs, updated.length, reason);
            }
            return CrashLoopGuard.decide(updated);
        } catch (Throwable t) {
            // Throwable, not Exception — same OOM argument as uncaughtException. A secondary
            // OOM raised by the allocation/serialization above must not cost us the restart.
            Log.e(TAG, "Crash-history bookkeeping failed — falling back to the first backoff "
                + "rung so the restart still happens", t);
            return CrashLoopGuard.BACKOFF_MS[0];
        }
    }

    /**
     * Persist the operator-visible marker for "this device has degraded to the slow retry
     * rung". CLAUDE.md §12b: an automated state change that degrades the device must surface
     * to the operator, and none of the obvious channels work from here — reportEvent() is
     * JS-side and this process is dying, and Log.e reaches nobody on a fielded box. So we
     * leave a durable breadcrumb and let src/main.ts report it via the existing telemetry on
     * the next boot that gets far enough to read it.
     *
     * MARKER format: "&lt;wallClockMs&gt;:&lt;crashesInWindow&gt;:&lt;reason&gt;". Colon-delimited rather
     * than JSON deliberately — it is built and parsed on both sides of a process that is
     * already failing, and a half-written JSON value would throw in the reader.
     *
     * Best effort and non-fatal: never let telemetry bookkeeping cost us the restart.
     */
    private static void writeCappedMarker(Context context, long nowMs, int crashes, String reason) {
        try {
            context.getSharedPreferences(CAPACITOR_PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_CAPPED_MARKER, nowMs + ":" + crashes + ":" + reason)
                .commit();
            Log.e(TAG, "Crash ladder exhausted (" + crashes + " in "
                + CrashLoopGuard.WINDOW_MS + "ms) — degraded to a "
                + CrashLoopGuard.CAPPED_RETRY_MS + "ms retry rung; marker persisted for "
                + "operator telemetry");
        } catch (Throwable t) {
            Log.e(TAG, "Failed to persist crash-loop marker", t);
        }
    }

    /** Unchanged exact→windowed alarm fallback; only the delay and the clock changed. */
    private static void scheduleRestart(Context context, long restartDelayMs) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);

        PendingIntent pendingIntent = PendingIntent.getActivity(
            context, 0, intent,
            PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE
        );

        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            // ELAPSED_REALTIME_WAKEUP, not RTC_WAKEUP. We are expressing a RELATIVE delay
            // ("restart me in 5 minutes"), and RTC alarms are anchored to wall clock: a
            // backward clock jump between scheduling and firing — routine on a TV box that
            // boots with no network and then gets NTP — strands the alarm that far in the
            // future, i.e. no restart at all. Monotonic elapsed-realtime cannot jump, and it
            // continues to advance in deep sleep, which is what *_WAKEUP needs. This matters
            // much more since the ladder gained 5-minute and 60-minute rungs: the window in
            // which a clock correction can land grew by ~100x.
            long triggerAtElapsed = SystemClock.elapsedRealtime() + restartDelayMs;

            // Exact alarms are auto-granted only on API 31-32 (SCHEDULE_EXACT_ALARM,
            // maxSdkVersion=32). USE_EXACT_ALARM is Play-policy-restricted to
            // alarm/clock apps, so on 33+ we must check the grant and fall back to
            // a windowed inexact alarm — a restart within ~1 minute is acceptable
            // for crash recovery; a SecurityException killing the handler is not.
            boolean exactAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || alarmManager.canScheduleExactAlarms();

            if (exactAllowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAtElapsed, pendingIntent
                );
                Log.i(TAG, "Restart scheduled in " + restartDelayMs + "ms (exact, wake)");
            } else if (exactAllowed) {
                alarmManager.setExact(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAtElapsed, pendingIntent
                );
                Log.i(TAG, "Restart scheduled in " + restartDelayMs + "ms (exact)");
            } else {
                // Same clock as the exact branches — a windowed alarm anchored to a
                // different time base would reintroduce exactly the bug above.
                alarmManager.setWindow(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAtElapsed, 60_000L, pendingIntent
                );
                Log.i(TAG, "Restart scheduled in " + restartDelayMs + "ms (windowed, exact-alarm not granted)");
            }
        }
    }
}
