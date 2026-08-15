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
 *
 * N3: also handles MY_PACKAGE_REPLACED (app update). Reused rather than given its own
 * receiver class because the action is identical — start MainActivity — and it is subject to
 * exactly the same background-activity-launch constraint, so a sibling class would duplicate
 * the code and the caveat with nothing to differentiate.
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
        //
        // N3: MY_PACKAGE_REPLACED is handled here too. A Play/sideload update kills our
        // process and nothing brings the app back, so a fielded screen stays dark until
        // someone power-cycles it.
        // HONESTY: this is subject to the SAME background-activity-launch restriction as the
        // boot path above. On a modern Google TV (Android 12+) this startActivity() may well
        // be silently blocked and this handler does NOTHING. We have NO hardware evidence
        // either way. It is landed because it closes the hole on permissive/AOSP boxes and
        // cannot regress the modern ones — not because it is known to fix post-update
        // relaunch. Do not read this as a fix for Android 12+ until hardware says so.
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            Log.i(TAG, "Relaunch signal received (" + action + "), launching Vizora Display...");

            Intent launchIntent = new Intent(context, MainActivity.class);
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(launchIntent);
        }
    }
}
