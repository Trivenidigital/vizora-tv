package com.vizora.display;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.util.Log;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKeys;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor plugin for secure credential storage using AndroidX EncryptedSharedPreferences.
 * Uses Android Keystore-backed encryption on API 23+, falls back to regular SharedPreferences
 * on older devices (API 22).
 */
@CapacitorPlugin(name = "SecureStorage")
public class SecureStoragePlugin extends Plugin {
    private static final String TAG = "SecureStorage";
    private static final String ENCRYPTED_PREFS_NAME = "vizora_secure_prefs";
    private static final String FALLBACK_PREFS_NAME = "vizora_secure_fallback";
    private static final int KEYSTORE_INIT_MAX_ATTEMPTS = 3;
    private static final String ERR_UNAVAILABLE = "SECURE_STORAGE_UNAVAILABLE";

    private SharedPreferences securePrefs;
    private boolean secureStorageAvailable = false;

    @Override
    public void load() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            // minSdk is 23, so this is effectively unreachable in the fleet; kept as the
            // documented floor. Regular SharedPreferences is the platform's best available
            // below API 23 — this is NOT the F39 plaintext-downgrade path.
            securePrefs = getContext().getSharedPreferences(FALLBACK_PREFS_NAME, Context.MODE_PRIVATE);
            secureStorageAvailable = true;
            Log.w(TAG, "API < 23, using regular SharedPreferences (documented floor)");
            return;
        }
        // Retry keystore-backed init a few times (a transient keystore-service hiccup can
        // clear). On PERSISTENT failure, FAIL CLOSED (F39): do NOT silently fall back to a
        // plaintext store — the device JWT must never be written in plaintext. securePrefs
        // stays null and every op rejects with SECURE_STORAGE_UNAVAILABLE so the web layer
        // surfaces a loud, visible error state + telemetry rather than a silent downgrade.
        for (int attempt = 1; attempt <= KEYSTORE_INIT_MAX_ATTEMPTS; attempt++) {
            try {
                String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
                securePrefs = EncryptedSharedPreferences.create(
                    ENCRYPTED_PREFS_NAME,
                    masterKeyAlias,
                    getContext(),
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                );
                secureStorageAvailable = true;
                Log.i(TAG, "Using EncryptedSharedPreferences (API " + Build.VERSION.SDK_INT + ")");
                return;
            } catch (Exception e) {
                Log.e(TAG, "EncryptedSharedPreferences init failed (attempt " + attempt
                    + "/" + KEYSTORE_INIT_MAX_ATTEMPTS + ")", e);
            }
        }
        securePrefs = null;
        secureStorageAvailable = false;
        Log.e(TAG, "Secure storage UNAVAILABLE after " + KEYSTORE_INIT_MAX_ATTEMPTS
            + " attempts — failing closed, no plaintext fallback (F39)");
    }

    /** Reject the call (returning true) when secure storage failed to initialize —
     *  fail closed per F39 so credentials are never read from / written to plaintext. */
    private boolean rejectIfUnavailable(PluginCall call) {
        if (!secureStorageAvailable || securePrefs == null) {
            call.reject("Secure storage unavailable", ERR_UNAVAILABLE);
            return true;
        }
        return false;
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");

        if (key == null) {
            call.reject("Key is required");
            return;
        }

        if (rejectIfUnavailable(call)) return;

        try {
            securePrefs.edit().putString(key, value).apply();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to set secure value", e);
            call.reject("Failed to store value: " + e.getMessage());
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");

        if (key == null) {
            call.reject("Key is required");
            return;
        }

        if (rejectIfUnavailable(call)) return;

        try {
            String value = securePrefs.getString(key, null);
            JSObject result = new JSObject();
            result.put("value", value != null ? value : JSObject.NULL);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "Failed to get secure value", e);
            call.reject("Failed to retrieve value: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");

        if (key == null) {
            call.reject("Key is required");
            return;
        }

        if (rejectIfUnavailable(call)) return;

        try {
            securePrefs.edit().remove(key).apply();
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "Failed to remove secure value", e);
            call.reject("Failed to remove value: " + e.getMessage());
        }
    }

    @PluginMethod
    public void has(PluginCall call) {
        String key = call.getString("key");

        if (key == null) {
            call.reject("Key is required");
            return;
        }

        if (rejectIfUnavailable(call)) return;

        try {
            boolean exists = securePrefs.contains(key);
            JSObject result = new JSObject();
            result.put("value", exists);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "Failed to check secure value", e);
            call.reject("Failed to check value: " + e.getMessage());
        }
    }
}
