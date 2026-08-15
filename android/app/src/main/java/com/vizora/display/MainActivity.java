package com.vizora.display;

import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.view.WindowManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "VizoraMainActivity";

    // Renderer-recovery loop-guard state. The DECISION lives in RendererRecoveryGuard
    // (pure, host-JVM-testable); this field holds the mutable timestamp across the
    // in-process activity relaunch (static → survives the relaunch in the same
    // process). Seeded to SENTINEL so the first death — even within the boot window —
    // always recovers.
    private static long lastRendererRecoveryAt = RendererRecoveryGuard.SENTINEL;

    // F48: install the uncaught-exception handler exactly once per process. onCreate runs
    // again on every in-process renderer-recovery relaunch (recoverFromRendererGone); each
    // CrashRecoveryHandler captures the prior default as its delegate, so re-installing per
    // onCreate grows an unbounded handler chain across relaunches. static → survives the
    // relaunch in the same process.
    private static boolean crashHandlerInstalled = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register SecureStorage plugin before super.onCreate (which initializes the bridge)
        registerPlugin(SecureStoragePlugin.class);

        super.onCreate(savedInstanceState);

        keepScreenOn();
        enterImmersiveMode();

        // C5: Register crash recovery handler for auto-restart. F48: install once per
        // process — re-installing on every relaunch would chain handlers unboundedly.
        if (!crashHandlerInstalled) {
            Thread.setDefaultUncaughtExceptionHandler(new CrashRecoveryHandler(this));
            crashHandlerInstalled = true;
        }

        // C9: Only allow mixed content in debug builds (needed for local dev with MinIO)
        if (BuildConfig.DEBUG) {
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        // F36: recover from WebView renderer-process death in-process. A renderer
        // OOM/crash raises NO Java exception (so CrashRecoveryHandler never sees it)
        // and does not reboot the device (so BootReceiver never fires) — without this
        // the screen goes blank until a manual power-cycle. Capacitor's
        // BridgeWebViewClient.onRenderProcessGone delegates to registered
        // WebViewListeners (ORs their return values); a listener returning true
        // prevents the framework from killing the app process. We relaunch the
        // activity to rebuild a fresh Bridge + WebView. This fires in the still-alive
        // foreground process, so it is NOT a background activity launch — no
        // SYSTEM_ALERT_WINDOW / kiosk-posture dependency (orthogonal to F1/F2).
        // Hardware acceptance: P0-3 test S-19d.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                return recoverFromRendererGone(detail);
            }
        });
    }

    private boolean recoverFromRendererGone(RenderProcessGoneDetail detail) {
        boolean didCrash = detail != null && detail.didCrash();
        Log.e(TAG, "WebView renderer gone (didCrash=" + didCrash + ") — recovering in-process");

        long now = SystemClock.elapsedRealtime();
        if (!RendererRecoveryGuard.shouldRecover(now, lastRendererRecoveryAt)) {
            // Renderer died again within the guard window — a tight loop. Don't hot-loop
            // in-process: return false and let the framework terminate us.
            //
            // But returning false alone was a DARK SCREEN. The framework kills the process
            // with NO Java exception, so CrashRecoveryHandler.uncaughtException never runs;
            // BootReceiver only fires on boot/quickboot/package-replace; there is no service
            // or watchdog. Nothing was left to bring the app back — identical in effect to the
            // terminal HOLD that CrashLoopGuard no longer has. This comment used to defer the
            // fix to "the F2/S-19c crash-loop work"; this IS that work, so the restart is
            // scheduled here rather than promised elsewhere.
            //
            // Safe to do now: we are still on the live foreground main thread of a healthy
            // process (only the renderer died), so AlarmManager is fully usable — unlike the
            // uncaught-exception caller, which is mid-teardown. Routing through
            // recordAndScheduleRelaunch also puts renderer deaths on the SAME escalation
            // ladder as Java crashes, so a device alternating between them still backs off
            // instead of restarting every 3s forever.
            Log.e(TAG, "Renderer gone again within " + RendererRecoveryGuard.MIN_INTERVAL_MS
                + "ms — scheduling a process restart and letting the framework kill us");
            try {
                CrashRecoveryHandler.recordAndScheduleRelaunch(
                    getApplicationContext(), CrashRecoveryHandler.REASON_RENDERER_LOOP);
            } catch (Throwable t) {
                // Never let the relaunch bookkeeping change what we return: a throw here
                // would propagate into the framework's onRenderProcessGone caller.
                Log.e(TAG, "Failed to schedule restart after renderer loop", t);
            }
            return false;
        }
        lastRendererRecoveryAt = now;

        // Relaunch cleanly. The dead WebView must not be reused; finishing the
        // activity tears it down and a fresh Intent rebuilds the Bridge + WebView.
        Intent intent = new Intent(getApplicationContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
        return true; // handled — do not let the framework kill the app process
    }

    /**
     * Keep the panel awake for 24/7 signage.
     *
     * Until 1.3.12 this was attempted with android:keepScreenOn="true" on the
     * <activity> tag in AndroidManifest.xml. That silently did nothing —
     * keepScreenOn is a View attribute, so the manifest accepts it (it exists in
     * the android namespace) but ActivityInfo never reads it. The build did not
     * warn, so the app appeared to hold the screen on while every device just
     * followed its own sleep and screensaver policy.
     *
     * FLAG_KEEP_SCREEN_ON is the window-level equivalent and is the right tool
     * here: it needs no permission, it is scoped to this Activity being visible,
     * and it therefore cannot leak the way a WakeLock does if a release is missed.
     * It also suppresses the daydream/screensaver, not just the display timeout.
     *
     * Set after super.onCreate() alongside the other window setup. onCreate runs
     * again on the in-process renderer-recovery relaunch (recoverFromRendererGone),
     * so the flag is re-applied on the fresh Activity rather than being inherited —
     * there is a sub-second gap during the relaunch, which is far below any
     * screen-off timeout.
     *
     * Note this cannot defeat an OEM "eco"/no-signal power mode, which lives below
     * the app layer. Verify on real pilot hardware, not only an emulator.
     */
    private void keepScreenOn() {
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    /**
     * Fullscreen TV display via WindowInsetsController. The legacy
     * setSystemUiVisibility flags are ignored for apps targeting API 35
     * (edge-to-edge enforcement) — the compat controller works on all
     * supported API levels (min 23).
     */
    private void enterImmersiveMode() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        WindowInsetsControllerCompat controller =
            WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.hide(WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            enterImmersiveMode();
        }
    }
}
