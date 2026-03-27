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

                // Use setExactAndAllowWhileIdle for reliable restart on API 23+.
                // Plain AlarmManager.set() is inexact on API 19+ and may be deferred
                // by battery optimization on API 31+, which is unacceptable for 24/7 signage.
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP, triggerTime, pendingIntent
                    );
                } else {
                    alarmManager.setExact(
                        AlarmManager.RTC_WAKEUP, triggerTime, pendingIntent
                    );
                }
                Log.i(TAG, "Restart scheduled in " + RESTART_DELAY_MS + "ms (exact, wake)");
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
