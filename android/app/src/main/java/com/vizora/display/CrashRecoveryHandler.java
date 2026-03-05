package com.vizora.display;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Global uncaught exception handler that restarts the app after a crash.
 * Essential for 24/7 digital signage — a crash must not leave a blank screen.
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
                alarmManager.set(
                    AlarmManager.RTC,
                    System.currentTimeMillis() + RESTART_DELAY_MS,
                    pendingIntent
                );
                Log.i(TAG, "Restart scheduled in " + RESTART_DELAY_MS + "ms");
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
