package com.vizora.display;

import android.content.Context;
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
    // again on every in-process renderer-recovery relaunch (handleRendererGone); each
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

        // N3: we are demonstrably up, so drop any relaunch alarm still pending. It may have
        // been scheduled up to an hour ago by a crash we have already come back from (via the
        // launcher, an operator, or MY_PACKAGE_REPLACED); left armed it would fire
        // FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK into a healthy display and tear
        // down playback for no reason.
        //
        // COST, stated rather than left implicit: this discards the only ARMED backstop against
        // a later process death that raises no Java exception — LMK, native SIGSEGV/SIGABRT, an
        // ANR kill, an operator force-stop. None of those reach CrashRecoveryHandler, so after
        // this line the next such death has nothing scheduled and waits for the next boot. That
        // is consistent with the model already documented on CrashRecoveryHandler (those causes
        // were never on the ladder to begin with) and it is the right trade: a pending alarm is
        // a stale relaunch of a HEALTHY app with certainty, versus a speculative rescue of a
        // future death that may never happen and whose activity start is subject to the same
        // unverified background-activity-launch restriction anyway.
        CrashRecoveryHandler.cancelPendingRelaunch(getApplicationContext());

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
        // SYSTEM_ALERT_WINDOW / kiosk-posture dependency (orthogonal to F1/F2). That holds
        // for the RECOVER branch only; the loop branch schedules an alarm that fires against
        // a dead process and IS a background activity launch — see handleRendererGone.
        // Hardware acceptance: P0-3 test S-19d.
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                return handleRendererGone(
                    getApplicationContext(),
                    SystemClock.elapsedRealtime(),
                    detail != null && detail.didCrash(),
                    MainActivity.this::relaunchForFreshWebView);
            }
        });
    }

    /**
     * The renderer-death decision, as a static seam.
     *
     * Static and context-passed on purpose: MainActivity extends BridgeActivity, and until this
     * was extracted NOTHING tested this branch through a call site — CrashRecoveryHandlerWiring
     * Test called recordAndScheduleRelaunch() directly, so deleting the call below (or swapping
     * its reason tag for the wrong one) left all 65 Java tests green while restoring the exact
     * dark-screen bug this release exists to fix. MainActivityRendererLossTest now drives the
     * real registered WebViewListener into this method.
     *
     * @param relaunchInProcess tears down the dead WebView and rebuilds the Bridge; run only on
     *                          the recover branch, injected so the decision is testable without
     *                          a live Activity.
     * @return what onRenderProcessGone must return: true = handled in-process, false = let the
     *         framework terminate the app process (a restart is scheduled first).
     */
    static boolean handleRendererGone(
            Context appContext, long now, boolean didCrash, Runnable relaunchInProcess) {
        Log.e(TAG, "WebView renderer gone (didCrash=" + didCrash + ") — recovering in-process");

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
            // Safe to SCHEDULE now: we are still on the live foreground main thread of a
            // healthy process (only the renderer died), so AlarmManager is fully usable —
            // unlike the uncaught-exception caller, which is mid-teardown.
            //
            // HONESTY: that argument covers the scheduling call and nothing more. When the
            // alarm fires this process is dead, so the activity start it carries is a
            // BACKGROUND ACTIVITY LAUNCH under the Android 10+/12+ restrictions — the same
            // restriction BootReceiver disclaims for the boot path, where we also have NO
            // hardware evidence either way. If it is blocked on modern Google TV, this branch
            // schedules something that never runs and the screen stays dark until a
            // power-cycle. It is still strictly better than the unbounded relaunch loop it
            // replaced, but do not read it as an observed recovery.
            //
            // Routing through recordAndScheduleRelaunch puts renderer LOOPS on the same
            // escalation ladder as Java crashes, so a device alternating between them still
            // backs off instead of restarting every 3s forever. Renderer deaths that recover
            // in-process are deliberately NOT on this ladder — see the recover branch below.
            Log.e(TAG, "Renderer gone again within " + RendererRecoveryGuard.MIN_INTERVAL_MS
                + "ms — scheduling a process restart and letting the framework kill us");
            try {
                CrashRecoveryHandler.recordAndScheduleRelaunch(
                    appContext, CrashRecoveryHandler.REASON_RENDERER_LOOP);
            } catch (Throwable t) {
                // Never let the relaunch bookkeeping change what we return: a throw here
                // would propagate into the framework's onRenderProcessGone caller.
                Log.e(TAG, "Failed to schedule restart after renderer loop", t);
            }
            return false;
        }
        lastRendererRecoveryAt = now;

        // Relaunch cleanly — see relaunchForFreshWebView.
        relaunchInProcess.run();

        // N5: and record it. The recovery worked, so this must not lengthen any restart
        // delay — but a renderer that keeps dying just OUTSIDE the guard interval (a heavy
        // asset in a rotating playlist is exactly that shape) would otherwise relaunch the
        // activity forever with the fleet seeing an uninterrupted healthy heartbeat: the
        // screen flickers and nobody is ever told. recordRendererRecovery is report-only for
        // that reason; see its javadoc for why escalating a working recovery would be a
        // regression, not a fix.
        //
        // After the relaunch, not before: the relaunch is the safety action and the
        // bookkeeping is not allowed to delay or (via a throw) cancel it.
        try {
            CrashRecoveryHandler.recordRendererRecovery(appContext);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to record an in-process renderer recovery", t);
        }
        return true; // handled — do not let the framework kill the app process
    }

    /**
     * Tear down the dead WebView and rebuild the Bridge. The dead WebView must not be reused;
     * finishing the activity tears it down and a fresh Intent rebuilds Bridge + WebView.
     */
    private void relaunchForFreshWebView() {
        Intent intent = new Intent(getApplicationContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivity(intent);
        finish();
    }

    /**
     * Test seam covering EVERY static in this class.
     *
     * Both fields exist to survive an in-process relaunch, which means neither is reset by
     * building a new Activity — and Robolectric shares one instrumented classloader across the
     * test methods of a class, so both leak from one test into the next. That is not a
     * theoretical tidiness point: {@link #crashHandlerInstalled} leaking meant an assertion that
     * MainActivity installs the crash handler passed on state left by the FIRST test method
     * while methods 2..n never re-installed anything. A seam that resets one static and not the
     * other is worse than none, because it looks like the leak was handled.
     *
     * Not called in production; the production seeds are the field initialisers.
     */
    static void resetProcessStaticsForTests() {
        lastRendererRecoveryAt = RendererRecoveryGuard.SENTINEL;
        crashHandlerInstalled = false;
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
     * again on the in-process renderer-recovery relaunch (handleRendererGone),
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
