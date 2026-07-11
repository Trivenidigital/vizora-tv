package com.vizora.display;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Receives BOOT_COMPLETED broadcast to auto-start the Vizora Display app.
 * Essential for 24/7 digital signage — the display must start without user interaction.
 *
 * Declared in AndroidManifest.xml with RECEIVE_BOOT_COMPLETED permission.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "VizoraBootReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        // F55: honor the OEM quick-boot / fast-boot broadcasts registered in the manifest
        // alongside BOOT_COMPLETED — some TV boxes send only QUICKBOOT_POWERON. Without this
        // guard the manifest registration is a no-op (broadcast received, then dropped).
        // NOTE: on Android 12+ the background-activity-launch restriction (F1) still gates the
        // actual foreground startActivity() on modern boxes; this only helps pre-BAL devices.
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            Log.i(TAG, "Boot signal received (" + action + "), launching Vizora Display...");

            Intent launchIntent = new Intent(context, MainActivity.class);
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(launchIntent);
        }
    }
}
