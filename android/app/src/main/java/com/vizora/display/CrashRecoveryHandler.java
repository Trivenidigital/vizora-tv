package com.vizora.display;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Global uncaught exception handler that restarts the app after a crash.
 * Essential for 24/7 digital signage — a crash must not leave a blank screen.
 *
 * NOTE: This handler catches uncaught Java/Kotlin exceptions only.
 * Native crashes (SIGSEGV, SIGABRT) bypass this handler entirely —
 * for those, the BootReceiver handles restart on next device boot.
 */
public class CrashRecoveryHandler implements Thread.UncaughtExceptionHandler {
    private static final String TAG = "VizoraCrashRecovery";
    private static final int RESTART_DELAY_MS = 3000;

    private final Context context;
    private final Thread.UncaughtExceptionHandler defaultHandler;

    public CrashRecoveryHandler(Context context) {
        this.context = context.getApplicationContext();
        this.defaultHandler = Thread.getDefaultUncaughtExceptionHandler();
    }

    @Override
    public void uncaughtException(Thread thread, Throwable throwable) {
        Log.e(TAG, "Uncaught exception, scheduling restart", throwable);

        try {
            Intent intent = new Intent(context, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);

            PendingIntent pendingIntent = PendingIntent.getActivity(
                context, 0, intent,
                PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE
            );

            AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarmManager != null) {
                long triggerTime = System.currentTimeMillis() + RESTART_DELAY_MS;

                // Exact alarms are auto-granted only on API 31-32 (SCHEDULE_EXACT_ALARM,
                // maxSdkVersion=32). USE_EXACT_ALARM is Play-policy-restricted to
                // alarm/clock apps, so on 33+ we must check the grant and fall back to
                // a windowed inexact alarm — a restart within ~1 minute is acceptable
                // for crash recovery; a SecurityException killing the handler is not.
                boolean exactAllowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                    || alarmManager.canScheduleExactAlarms();

                if (exactAllowed && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP, triggerTime, pendingIntent
                    );
                    Log.i(TAG, "Restart scheduled in " + RESTART_DELAY_MS + "ms (exact, wake)");
                } else if (exactAllowed) {
                    alarmManager.setExact(
                        AlarmManager.RTC_WAKEUP, triggerTime, pendingIntent
                    );
                    Log.i(TAG, "Restart scheduled in " + RESTART_DELAY_MS + "ms (exact)");
                } else {
                    alarmManager.setWindow(
                        AlarmManager.RTC_WAKEUP, triggerTime, 60_000L, pendingIntent
                    );
                    Log.i(TAG, "Restart scheduled in " + RESTART_DELAY_MS + "ms (windowed, exact-alarm not granted)");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to schedule restart", e);
        }

        // Let the default handler run (this will terminate the process)
        if (defaultHandler != null) {
            defaultHandler.uncaughtException(thread, throwable);
        } else {
            System.exit(1);
        }
    }
}
