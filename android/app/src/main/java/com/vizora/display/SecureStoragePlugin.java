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

    // volatile: written on the background HandlerThread in ensureSecurePrefs() (F44 lazy
    // init) and read by every @PluginMethod handler on that same thread; volatile also
    // closes F53 (the API<23 floor path writes on main). initAttempted + initLock make the
    // lazy init idempotent and once-per-process (stays unavailable until restart, matching
    // F39 semantics).
    private volatile SharedPreferences securePrefs;
    private volatile boolean secureStorageAvailable = false;
    private volatile boolean initAttempted = false;
    private final Object initLock = new Object();

    @Override
    public void load() {
        // F44: Capacitor calls load() on the MAIN thread (from the Bridge ctor). Keystore
        // work (MasterKeys.getOrCreate + EncryptedSharedPreferences.create) can stall for
        // seconds on a wedged keystore — the very devices F39 targets — so doing it here
        // risks a startup ANR. On API >= 23 we do NO keystore work in load(): securePrefs
        // stays null and init is deferred to ensureSecurePrefs(), which runs lazily on the
        // background HandlerThread on first plugin use. Only the API < 23 floor path (no
        // keystore work) initializes synchronously here.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            // minSdk is 23, so this is effectively unreachable in the fleet; kept as the
            // documented floor. Regular SharedPreferences is the platform's best available
            // below API 23 — this is NOT the F39 plaintext-downgrade path. Cheap, no keystore
            // work, so main-thread is fine; mark initAttempted so ensureSecurePrefs() no-ops.
            securePrefs = getContext().getSharedPreferences(FALLBACK_PREFS_NAME, Context.MODE_PRIVATE);
            secureStorageAvailable = true;
            initAttempted = true;
            Log.w(TAG, "API < 23, using regular SharedPreferences (documented floor)");
        }
    }

    /**
     * Lazily initialize keystore-backed storage on the calling (background HandlerThread)
     * thread. Idempotent + once-per-process: after the first attempt (success OR persistent
     * failure) it never retries until the app restarts, matching F39 semantics. Runs off the
     * main thread (F44), so bounded backoff between attempts is safe.
     *
     * On PERSISTENT failure, FAIL CLOSED (F39): do NOT fall back to a plaintext store — the
     * device JWT must never be written in plaintext. securePrefs stays null and every op
     * rejects with SECURE_STORAGE_UNAVAILABLE so the web layer surfaces a loud, visible error
     * state + telemetry rather than a silent downgrade.
     */
    private void ensureSecurePrefs() {
        synchronized (initLock) {
            if (initAttempted) {
                return;
            }
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
                    initAttempted = true;
                    Log.i(TAG, "Using EncryptedSharedPreferences (API " + Build.VERSION.SDK_INT + ")");
                    return;
                } catch (Exception e) {
                    Log.e(TAG, "EncryptedSharedPreferences init failed (attempt " + attempt
                        + "/" + KEYSTORE_INIT_MAX_ATTEMPTS + ")", e);
                    // Bounded backoff between attempts (~100ms then ~300ms) — safe now that
                    // this runs off the main thread. A transient keystore-service hiccup can
                    // clear within a few hundred ms.
                    if (attempt < KEYSTORE_INIT_MAX_ATTEMPTS) {
                        try {
                            Thread.sleep(attempt == 1 ? 100L : 300L);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            break;
                        }
                    }
                }
            }
            securePrefs = null;
            secureStorageAvailable = false;
            initAttempted = true;
            Log.e(TAG, "Secure storage UNAVAILABLE after " + KEYSTORE_INIT_MAX_ATTEMPTS
                + " attempts — failing closed, no plaintext fallback (F39)");
        }
    }

    /** Reject the call (returning true) when secure storage failed to initialize —
     *  fail closed per F39 so credentials are never read from / written to plaintext.
     *  Triggers the lazy off-main init (F44) on first use before the availability check. */
    private boolean rejectIfUnavailable(PluginCall call) {
        ensureSecurePrefs();
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
            // F49: commit() (synchronous) not apply() — this runs off-main on the
            // HandlerThread so blocking is fine, and it prevents JWT loss if the process is
            // crashed/SIGKILLed in the pairing→first-render window before apply() flushes.
            securePrefs.edit().putString(key, value).commit();
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
            // F56: keyset/entry decrypt corruption (e.g. AEADBadTagException) on an EXISTING
            // entry — distinct from keystore-INIT failure. Init failure rejects
            // SECURE_STORAGE_UNAVAILABLE and routes to the F39 fail-closed holding screen; a
            // corrupt existing entry must instead route through the web F37 path to
            // re-pairing. Clear ONLY the corrupt ENTRY (not the whole store — clearing all
            // keys would wipe device_token/device_id and silently de-pair, defeating F42's
            // non-fatal tenant_id recovery) so the subsequent re-pair/rewrite of this key
            // lands on clean storage, then reject with the GENERIC retryable code (NOT
            // SECURE_STORAGE_UNAVAILABLE) so the web layer takes the re-pair path.
            Log.e(TAG, "Failed to get secure value — clearing corrupt entry (F56)", e);
            try {
                securePrefs.edit().remove(key).commit();
            } catch (Exception clearEx) {
                Log.e(TAG, "Failed to clear corrupt secure entry", clearEx);
            }
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
            // commit() (synchronous) not apply() — same durability class as F49's set():
            // a credential PURGE (revocation/unpair) must be flushed before an immediate
            // SIGKILL, or a revoked token could survive on disk. Off-main, so blocking is fine.
            securePrefs.edit().remove(key).commit();
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
