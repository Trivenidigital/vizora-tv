package com.vizora.display;

import android.os.Bundle;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Register SecureStorage plugin before super.onCreate (which initializes the bridge)
        registerPlugin(SecureStoragePlugin.class);

        super.onCreate(savedInstanceState);

        // C5: Register crash recovery handler for auto-restart
        Thread.setDefaultUncaughtExceptionHandler(new CrashRecoveryHandler(this));

        // C9: Only allow mixed content in debug builds (needed for local dev with MinIO)
        if (BuildConfig.DEBUG) {
            getBridge().getWebView().getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
    }
}
