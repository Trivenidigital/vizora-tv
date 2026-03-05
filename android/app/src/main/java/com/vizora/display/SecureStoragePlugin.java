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

    private SharedPreferences securePrefs;

    @Override
    public void load() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                String masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC);
                securePrefs = EncryptedSharedPreferences.create(
                    ENCRYPTED_PREFS_NAME,
                    masterKeyAlias,
                    getContext(),
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                );
                Log.i(TAG, "Using EncryptedSharedPreferences (API " + Build.VERSION.SDK_INT + ")");
            } else {
                securePrefs = getContext().getSharedPreferences(FALLBACK_PREFS_NAME, Context.MODE_PRIVATE);
                Log.w(TAG, "API < 23, falling back to regular SharedPreferences");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to initialize encrypted storage, using fallback", e);
            securePrefs = getContext().getSharedPreferences(FALLBACK_PREFS_NAME, Context.MODE_PRIVATE);
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");

        if (key == null) {
            call.reject("Key is required");
            return;
        }

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
