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
 * Global uncaught exception handler that schedules an app restart after a crash.
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
 * on which this handler declines to SCHEDULE a restart (see {@link CrashLoopGuard}).
 *
 * HONESTY — what "restart" means here, and what it does not.
 * This class reliably SCHEDULES an alarm whose PendingIntent starts MainActivity. It does NOT
 * establish that the activity actually starts. When the alarm fires our process is dead, so
 * the start is a BACKGROUND ACTIVITY LAUNCH, subject to exactly the same Android 10+/12+
 * restriction that {@link BootReceiver} documents for the boot path. We have NO hardware
 * evidence either way on a modern Google TV. If the launch is blocked there, every rung of the
 * ladder is decoration. The ladder is landed because it is strictly better than the unbounded
 * 3s relaunch loop it replaced and cannot regress anything — NOT because a relaunch has been
 * observed on hardware. Read every "restarts" in this file as "schedules a restart".
 * Hardware acceptance: this is the same sitting BootReceiver needs.
 *
 * Which process-loss causes reach this ladder: uncaught Java/Kotlin throwables
 * ({@link #uncaughtException}) and MainActivity's renderer-loss LOOP branch (see
 * {@link #recordAndScheduleRelaunch}). Those two, and only those two, share ONE escalation
 * ladder and one alarm path. Everything else that can take our process — low-memory kills,
 * ANRs, native SIGSEGV/SIGABRT, an operator force-stop — raises no Java exception and never
 * reaches this class at all; the only backstop for those is BootReceiver on the next boot.
 * Renderer deaths that DO recover in-process are recorded, but on a separate report-only
 * counter that never changes a restart delay — see {@link #recordRendererRecovery}.
 */
public class CrashRecoveryHandler implements Thread.UncaughtExceptionHandler {
    private static final String TAG = "VizoraCrashRecovery";

    private static final String CRASH_PREFS_NAME = "vizora_crash_recovery";
    private static final String KEY_CRASH_HISTORY = "crash_history_ms";

    /**
     * N5: history of renderer deaths that were RECOVERED in-process. Deliberately a different
     * key from {@link #KEY_CRASH_HISTORY} — see {@link #recordRendererRecovery} for why a
     * successful recovery must not lengthen the restart backoff.
     */
    private static final String KEY_RECOVERY_HISTORY = "renderer_recovery_ms";

    /**
     * Capacitor's Preferences plugin stores everything in this SharedPreferences file under
     * the raw key (see PreferencesConfiguration.DEFAULTS.group and Preferences.get). Writing
     * the degradation marker here — rather than into our private crash prefs — is what lets
     * src/main.ts read it with the Preferences API it already uses, with no new plugin.
     */
    private static final String CAPACITOR_PREFS_NAME = "CapacitorStorage";

    /** Read + cleared by src/main.ts on the next successful boot; see MARKER format below. */
    static final String KEY_CAPPED_MARKER = "crash_loop_capped";

    /** Reason tags recorded in the marker so telemetry can tell the causes apart. */
    static final String REASON_UNCAUGHT_EXCEPTION = "uncaught_exception";
    static final String REASON_RENDERER_LOOP = "renderer_loop";
    /** N5: renderer deaths that keep recovering in-process. Not a restart-ladder event. */
    static final String REASON_RENDERER_RECOVERY_STORM = "renderer_recovery_storm";

    /** Stable request code for the relaunch PendingIntent — schedule and cancel must agree. */
    private static final int RELAUNCH_REQUEST_CODE = 0;

    /**
     * Creation flags for the relaunch PendingIntent. {@link #cancelPendingRelaunch} must look
     * it up with EXACTLY these plus FLAG_NO_CREATE: a PendingIntent is identified by (type,
     * package, request code, filterEquals(intent), flags), and the flags comparison is not
     * courtesy — AOSP's PendingIntentRecord.Key.equals strips only NO_CREATE/CANCEL_CURRENT/
     * UPDATE_CURRENT before comparing, so a lookup that omits FLAG_ONE_SHOT silently matches
     * nothing and the cancel is a no-op that looks like it worked.
     */
    private static final int RELAUNCH_PENDING_INTENT_FLAGS =
        PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE;

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
     * alarm. Shared by the uncaught-exception path and MainActivity's renderer-LOOP path, so
     * a device flapping between the two escalates on one ladder instead of two independent
     * ones that each look fine.
     *
     * ALWAYS schedules. {@link CrashLoopGuard#decide} has no give-up value.
     *
     * N4 — ORDER MATTERS, and it is deliberately safety-action-first. The alarm is set BEFORE
     * the two synchronous prefs writes below. MainActivity calls this from the LIVE main thread
     * inside a framework callback (onRenderProcessGone), where two commit() flushes on a box
     * with full flash are a real ANR contributor; with the old order an ANR-kill between the
     * writes and the alarm cost us the restart entirely — the exact dark screen this class
     * exists to prevent. The cost of this order is the mirror-image failure: a kill between the
     * alarm and the write leaves the history un-advanced, so the NEXT crash re-reads a stale
     * ladder and under-escalates. That is the right trade — under-escalating retries too fast,
     * which is recoverable; losing the alarm is a dark screen until a human power-cycles the TV.
     */
    static void recordAndScheduleRelaunch(Context context, String reason) {
        long now = System.currentTimeMillis();
        long[] updated = evaluate(context, KEY_CRASH_HISTORY, now, CrashLoopGuard::recordCrash);

        // SAFETY ACTION FIRST — see the N4 note above.
        scheduleRestart(context, CrashLoopGuard.decide(updated));

        // Bookkeeping second. commit(), not apply(): the uncaught-exception caller is on a
        // dying process and apply()'s background flush may never run.
        persist(context, KEY_CRASH_HISTORY, updated, true);
        Log.w(TAG, "Crash " + updated.length + " (" + reason + ") on the ladder");
        if (CrashLoopGuard.isLadderExhausted(updated)) {
            writeCappedMarker(context, now, updated.length, reason, true);
        }
    }

    /**
     * N5: record a renderer death that was RECOVERED in-process (MainActivity rebuilt the
     * Bridge and the screen came back). Report-only — this NEVER schedules and never touches
     * the restart ladder.
     *
     * Why it is recorded at all: without it, a renderer that dies just outside
     * {@link RendererRecoveryGuard#MIN_INTERVAL_MS} — the shape a heavy asset in a rotating
     * playlist actually produces — relaunches the activity forever, and the fleet sees a
     * perfectly healthy heartbeat throughout. The screen flickers and nobody is ever told.
     * A chain of recoveries now exhausts {@link CrashLoopGuard} on its own history and leaves
     * the same operator marker every other degradation leaves, tagged
     * {@link #REASON_RENDERER_RECOVERY_STORM}. src/main.ts reports it on the next boot, and on
     * this path there IS a next boot — the in-process relaunch reloads the web app every time.
     *
     * F2 — the marker is written ONCE, on the transition onto the exhausted rung, and that is
     * load-bearing rather than tidy. Every other marker writer is rate-limited by the delay it
     * just imposed (at worst one per hour on the capped rung); this one is not rate-limited by
     * anything, because the device is up and flickering. Writing it on every recovery past the
     * threshold, at the storm shape this method exists for (deaths just outside the ~10s guard
     * interval), is ~7.8k markers/day — and since main.ts reads AND removes the marker on every
     * page load, and the in-process relaunch triggers a page load on every flicker, each one
     * becomes a distinct telemetry event. An alert that fires thousands of times a day is not
     * an alert, and it would burn the reporting quota that the rest of this class's §12b
     * argument depends on. Once per episode is the whole signal: "this device is flickering".
     * A genuinely new episode re-arms it, because the recovery chain decays after
     * {@link CrashLoopGuard#GRACE_MS} of quiet (see {@link CrashLoopGuard#recordRecovery}).
     *
     * Why a SEPARATE history rather than the restart ladder: entries on the restart ladder
     * lengthen the next restart delay. A recovery is a SUCCESS — the screen came back in under
     * a second — and counting four of them would mean the next unrelated Java crash waited an
     * hour in the dark instead of 3 seconds. That trades a flicker for exactly the failure mode
     * this whole release exists to remove. Escalating a working recovery is not an improvement;
     * making it visible is.
     *
     * apply(), not commit(): unlike every other writer here, this one runs on a HEALTHY
     * foreground process on the main thread. There is no dying-process durability argument,
     * and a synchronous flush here is the ANR risk described in N4.
     */
    static void recordRendererRecovery(Context context) {
        long now = System.currentTimeMillis();
        long[] updated =
            evaluate(context, KEY_RECOVERY_HISTORY, now, CrashLoopGuard::recordRecovery);
        persist(context, KEY_RECOVERY_HISTORY, updated, false);
        Log.w(TAG, "Renderer recovered in-process (" + updated.length + " in this chain)");
        if (updated.length == CrashLoopGuard.BACKOFF_MS.length + 1) {
            // Exactly the transition, not every event past it — see F2 above.
            writeCappedMarker(context, now, updated.length, REASON_RENDERER_RECOVERY_STORM, false);
        }
    }

    /**
     * N3: drop any relaunch alarm still pending, called from MainActivity.onCreate.
     *
     * Without this, nothing ever cancels a scheduled relaunch. A device that took the 60-minute
     * rung and then came back by ANY other route — the launcher, an operator, MY_PACKAGE_REPLACED
     * — keeps a live alarm carrying FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK, which
     * tears down a healthy display mid-playback up to an hour later. The relaunch is only wanted
     * while the app is still gone; we are demonstrably back.
     *
     * FLAG_NO_CREATE so this is a pure lookup: null means there was nothing pending (the common
     * case — a normal boot) and we must not manufacture one just to cancel it.
     */
    static void cancelPendingRelaunch(Context context) {
        try {
            PendingIntent pending = relaunchPendingIntent(
                context, RELAUNCH_PENDING_INTENT_FLAGS | PendingIntent.FLAG_NO_CREATE);
            if (pending == null) {
                return;
            }
            AlarmManager alarmManager =
                (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarmManager != null) {
                alarmManager.cancel(pending);
            }
            pending.cancel();
            Log.i(TAG, "Cancelled a pending relaunch alarm — the app is up by another route");
        } catch (Throwable t) {
            // Startup path: never let cleanup of a stale alarm stop the app from coming up.
            Log.e(TAG, "Failed to cancel a pending relaunch alarm", t);
        }
    }

    /**
     * Which decay rule this history follows. The two chains are NOT interchangeable — the
     * restart ladder decays against the penalty it imposed, the report-only recovery chain
     * against plain quiet — so the choice is passed in rather than inferred from the key.
     */
    private interface Recorder {
        long[] record(long[] historyMs, long nowMs);
    }

    /**
     * Read the persisted history for {@code key} and fold in this event. NO WRITES — the caller
     * schedules first and persists afterwards (see the N4 note on
     * {@link #recordAndScheduleRelaunch}).
     *
     * FAILS OPEN. If the history cannot be read (prefs unavailable this early in a crashing
     * process, disk full, corrupt value, ...) we return a single-entry history rather than
     * letting the throwable escape, so the caller still gets the first rung and still schedules.
     * Letting it escape would mean a bookkeeping failure suppressed the restart entirely —
     * strictly worse than the unconditional 3s restart this replaced.
     */
    private static long[] evaluate(Context context, String key, long nowMs, Recorder recorder) {
        try {
            SharedPreferences prefs =
                context.getSharedPreferences(CRASH_PREFS_NAME, Context.MODE_PRIVATE);
            long[] history = CrashLoopGuard.parseHistory(prefs.getString(key, null));
            return recorder.record(history, nowMs);
        } catch (Throwable t) {
            // Throwable, not Exception — same OOM argument as uncaughtException. A secondary
            // OOM raised by the allocation/parse above must not cost us the restart.
            Log.e(TAG, "History read failed — falling back to a single-entry history so the "
                + "first backoff rung still applies", t);
            return new long[] { nowMs };
        }
    }

    /**
     * Persist the history computed by {@link #evaluate}. Best effort: the alarm is already set
     * by the time this runs, so a failure here costs escalation accuracy, not the restart.
     *
     * @param durable true → commit() (caller's process is dying, apply()'s background flush may
     *                never run); false → apply() (caller is healthy and on the main thread).
     */
    private static void persist(Context context, String key, long[] history, boolean durable) {
        try {
            SharedPreferences.Editor editor =
                context.getSharedPreferences(CRASH_PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putString(key, CrashLoopGuard.serializeHistory(history));
            if (!durable) {
                editor.apply();
                return;
            }
            if (!editor.commit()) {
                // Disk full is entirely plausible on a signage box with a full media cache.
                // The history then never advances, every crash reads the same state, and the
                // ladder silently degenerates back to the unbounded 3s relaunch loop this
                // class exists to prevent. Say so loudly rather than containing nothing while
                // appearing to contain something.
                Log.e(TAG, "history '" + key + "' not persisted — loop containment is INACTIVE");
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to persist history '" + key + "'", t);
        }
    }

    /**
     * Persist the operator-visible marker for "this device has degraded". CLAUDE.md §12b: an
     * automated state change that degrades the device must surface to the operator, and none of
     * the obvious channels work from here — reportEvent() is JS-side and (on the crash path)
     * this process is dying, and Log.e reaches nobody on a fielded box. So we leave a durable
     * breadcrumb and let src/main.ts report it via the existing telemetry on the next boot that
     * gets far enough to read it.
     *
     * MARKER format: "&lt;wallClockMs&gt;:&lt;eventsInWindow&gt;:&lt;reason&gt;". Colon-delimited rather
     * than JSON deliberately — it is built and parsed on both sides of a process that may
     * already be failing, and a half-written JSON value would throw in the reader.
     *
     * The count saturates at {@link CrashLoopGuard#MAX_HISTORY}: read it as "at least N", not
     * as a total. The reason tag is what distinguishes a restart-ladder degradation
     * (uncaught_exception / renderer_loop — the device IS on the slow retry rung) from a
     * renderer_recovery_storm, where the screen keeps coming back on its own and no restart
     * delay has changed.
     *
     * ONE KEY, AND A NO-CLOBBER RULE. Both causes write this single key, because it is the only
     * key src/main.ts reads — a second key would be written here and read by nobody, which is
     * the silent failure this marker exists to remove, and it would stay silent until a
     * coordinated change landed on the JS side. The cost of sharing the key is that a
     * renderer_recovery_storm could overwrite an UNREPORTED restart-ladder record, and the web
     * layer would then tell the operator "the screen keeps coming back on its own" about a
     * device that is actually sitting dark on the 60-minute rung. That is not a narrow window:
     * main.ts deliberately KEEPS the marker when crash reporting is disabled (it refuses to
     * delete the only record of a crash loop on the strength of a reportEvent that sent
     * nothing), so on any build without a Sentry DSN an unreported marker persists indefinitely.
     *
     * So a write never downgrades an unreported record: the storm reason yields to a
     * restart-ladder reason that is still sitting there. The reverse is allowed — being dark
     * outranks flickering — and same-severity writes refresh the count and timestamp as before.
     * An existing marker we cannot parse is treated as the more severe case, because the one
     * thing worse than an imprecise breadcrumb is destroying one.
     *
     * Best effort and non-fatal: never let telemetry bookkeeping cost us the restart.
     */
    private static void writeCappedMarker(
            Context context, long nowMs, int events, String reason, boolean durable) {
        try {
            SharedPreferences markerPrefs =
                context.getSharedPreferences(CAPACITOR_PREFS_NAME, Context.MODE_PRIVATE);
            if (!isRestartLadderReason(reason)
                    && wouldDowngradeAnUnreportedMarker(markerPrefs)) {
                Log.w(TAG, "Keeping the existing unreported degradation marker; a " + reason
                    + " must not overwrite a record of the device being dark");
                return;
            }
            SharedPreferences.Editor editor = markerPrefs
                    .edit()
                    .putString(KEY_CAPPED_MARKER, nowMs + ":" + events + ":" + reason);
            if (durable) {
                editor.commit();
            } else {
                editor.apply();
            }
            Log.e(TAG, "Degradation marker persisted (" + reason + ", " + events
                + " events in the window) for operator telemetry");
        } catch (Throwable t) {
            Log.e(TAG, "Failed to persist crash-loop marker", t);
        }
    }

    /**
     * True for the reasons that mean the device is on the slow restart rung — i.e. DARK between
     * attempts. {@link #REASON_RENDERER_RECOVERY_STORM} is not one of them: there the screen
     * keeps coming back by itself and no restart delay has changed.
     */
    private static boolean isRestartLadderReason(String reason) {
        return REASON_UNCAUGHT_EXCEPTION.equals(reason) || REASON_RENDERER_LOOP.equals(reason);
    }

    /**
     * True when a marker is already sitting there unreported AND it records something worse
     * than a storm. An existing marker whose reason cannot be read counts as worse: markers are
     * written by processes that may be mid-death, so a truncated value is expected, and losing
     * a real degradation record to a flicker report is the worse of the two errors.
     */
    private static boolean wouldDowngradeAnUnreportedMarker(SharedPreferences markerPrefs) {
        String existing = markerPrefs.getString(KEY_CAPPED_MARKER, null);
        if (existing == null || existing.isEmpty()) {
            return false;
        }
        String[] parts = existing.split(":");
        return parts.length < 3 || isRestartLadderReason(parts[2]);
    }

    /** The relaunch intent. Shared so {@link #cancelPendingRelaunch} cannot drift from it. */
    private static PendingIntent relaunchPendingIntent(Context context, int flags) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        return PendingIntent.getActivity(context, RELAUNCH_REQUEST_CODE, intent, flags);
    }

    /** Unchanged exact→windowed alarm fallback; only the delay and the clock changed. */
    private static void scheduleRestart(Context context, long restartDelayMs) {
        PendingIntent pendingIntent =
            relaunchPendingIntent(context, RELAUNCH_PENDING_INTENT_FLAGS);

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
            // maxSdkVersion=32). USE_EXACT_ALARM is Play-policy-restricted to alarm/clock
            // apps, so on 33+ we must check the grant and fall back — a SecurityException
            // killing the handler is not an option.
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
                // N1: setAndAllowWhileIdle, NOT setWindow. This branch is not an edge case —
                // SCHEDULE_EXACT_ALARM is capped at maxSdkVersion=32 and USE_EXACT_ALARM is
                // deliberately not declared, so canScheduleExactAlarms() is false on every
                // API 33+ box and this is the ONLY branch modern Google TV hardware takes.
                //
                // setWindow carries no idle exemption: when the system is in an idle state
                // the alarm is held to the next maintenance window, which is minutes to
                // hours, not the "~1 minute" this comment used to promise. And the app has
                // just died, so it is also the worst case for app-standby bucketing — a
                // crashed, unused app is exactly what gets demoted. Deferring the ladder
                // indefinitely on the only live branch means it effectively does not fire.
                // setAndAllowWhileIdle is exempted from those restrictions, subject to its
                // own ~9-minute-per-app quota: that quota degrades the 3s rung but is
                // BOUNDED, unlike indefinite deferral, and the 5min/60min rungs are unaffected.
                //
                // HONESTY on the premise: classic Doze requires the device to be UNPLUGGED,
                // and a signage box is mains-powered, so we have not established that these
                // boxes enter classic Doze at all — the exposure we are actually sure of is
                // app-standby/OEM standby, plus the plain fact that setWindow is inexact by
                // contract. The change is landed because the idle exemption is strictly more
                // reliable and costs nothing, NOT because deferral has been observed on
                // hardware. Either way this remains an INEXACT alarm: the delay is a floor.
                alarmManager.setAndAllowWhileIdle(
                    AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAtElapsed, pendingIntent
                );
                Log.i(TAG, "Restart scheduled in " + restartDelayMs
                    + "ms (inexact + allowWhileIdle, exact-alarm not granted)");
            }
        }
    }
}
