package com.vizora.display;

import android.content.Intent;
import android.os.Bundle;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register SecureStorage plugin before super.onCreate (which initializes the bridge)
        registerPlugin(SecureStoragePlugin.class);

        super.onCreate(savedInstanceState);

        enterImmersiveMode();

        // C5: Register crash recovery handler for auto-restart
        Thread.setDefaultUncaughtExceptionHandler(new CrashRecoveryHandler(this));

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
            // Renderer died again within the guard window — a tight loop. Don't
            // hot-loop: return false so the framework terminates the process and the
            // restart falls to the crash-recovery / next-boot path. (Full
            // renderer-loop safe-mode is folded into the F2/S-19c crash-loop work.)
            Log.e(TAG, "Renderer gone again within " + RendererRecoveryGuard.MIN_INTERVAL_MS
                + "ms — deferring to process restart");
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
