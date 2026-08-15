package com.vizora.display;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.security.GeneralSecurityException;

import javax.crypto.AEADBadTagException;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;

/**
 * WIRING tests for {@link SecureStoragePlugin#get}.
 *
 * SecureStorageFailureClassifierTest pins the pure predicate. This file pins that the predicate
 * is actually CONSULTED before the destructive branch — the gap that mattered, because deleting
 * the whole `if (SecureStorageFailureClassifier...)` guard and reverting to an unconditional
 * remove() left every pure test green while re-opening the credential-destroying bug.
 *
 * Method: the plugin's securePrefs field is replaced with a dynamic proxy that delegates every
 * call to a REAL Robolectric-backed SharedPreferences except getString(), which throws the
 * exception under test. So contains()/edit()/remove()/commit() are the genuine framework
 * implementations and "was the entry destroyed?" is answered by an actual store round-trip
 * rather than by a mock's recorded interactions.
 */
@RunWith(RobolectricTestRunner.class)
public class SecureStoragePluginWiringTest {

    private static final String KEY = "device_token";
    private static final String VALUE = "jwt-value";

    private SecureStoragePlugin plugin;
    private SharedPreferences backing;

    @Before
    public void setUp() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        backing = context.getSharedPreferences("wiring_test_prefs", Context.MODE_PRIVATE);
        backing.edit().clear().commit();
        backing.edit().putString(KEY, VALUE).commit();

        plugin = new SecureStoragePlugin();
    }

    /**
     * Install a securePrefs that throws {@code failure} from getString and delegates
     * everything else to the real store. Also marks init as already-attempted so
     * ensureSecurePrefs() short-circuits (it would otherwise need a Bridge for getContext()).
     */
    private void installThrowingPrefs(Throwable failure) throws Exception {
        SharedPreferences throwing = (SharedPreferences) Proxy.newProxyInstance(
            SharedPreferences.class.getClassLoader(),
            new Class<?>[] { SharedPreferences.class },
            new InvocationHandler() {
                @Override
                public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
                    if ("getString".equals(method.getName())) {
                        throw failure;
                    }
                    return method.invoke(backing, args);
                }
            });

        setField("securePrefs", throwing);
        setField("secureStorageAvailable", true);
        setField("initAttempted", true);
    }

    private void setField(String name, Object value) throws Exception {
        Field field = SecureStoragePlugin.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(plugin, value);
    }

    /** PluginCall with no MessageHandler; every terminal resolve/reject is captured instead. */
    private static final class RecordingCall extends PluginCall {
        String rejectMessage;
        String rejectCode;
        boolean resolved;

        RecordingCall(String key) {
            super(null, "SecureStorage", "cb", "get", buildData(key));
        }

        private static JSObject buildData(String key) {
            JSObject data = new JSObject();
            data.put("key", key);
            return data;
        }

        @Override
        public void reject(String msg, String code, Exception ex, JSObject data) {
            this.rejectMessage = msg;
            this.rejectCode = code;
        }

        @Override
        public void resolve(JSObject data) {
            this.resolved = true;
        }

        @Override
        public void resolve() {
            this.resolved = true;
        }
    }

    // ---- the entry must SURVIVE anything not provably dead ----------------------------------

    @Test
    public void transientLookingFailurePreservesTheEntry() throws Exception {
        installThrowingPrefs(new IllegalStateException("keystore busy"));

        RecordingCall call = new RecordingCall(KEY);
        plugin.get(call);

        assertTrue("the entry must survive: main.ts reads device_token during migration BEFORE "
                + "its retry budget applies, so destroying it here unpairs the device",
            backing.contains(KEY));
        assertEquals(VALUE, backing.getString(KEY, null));
        assertNotNull("the call must still be rejected", call.rejectMessage);
        assertFalse(call.resolved);
    }

    @Test
    public void rejectionDoesNotUseTheFailClosedCode() throws Exception {
        // main.ts branches on SECURE_STORAGE_UNAVAILABLE to show the terminal holding screen.
        // An entry-level read failure must NOT take that branch — it must stay retryable.
        installThrowingPrefs(new IllegalStateException("keystore busy"));

        RecordingCall call = new RecordingCall(KEY);
        plugin.get(call);

        assertFalse("SECURE_STORAGE_UNAVAILABLE".equals(call.rejectCode));
    }

    @Test
    public void unrelatedIllegalArgumentExceptionPreservesTheEntry() throws Exception {
        // Guards the narrowness of the base64 rule at the wiring level, not just in the
        // predicate: broadening it to all IllegalArgumentException would destroy credentials.
        installThrowingPrefs(new IllegalArgumentException("some unrelated bad argument"));

        plugin.get(new RecordingCall(KEY));

        assertTrue(backing.contains(KEY));
    }

    // ---- the entry must be CLEARED when it really is dead -----------------------------------

    @Test
    public void aeadCorruptionClearsTheEntry() throws Exception {
        // The production shape: androidx rewraps the GeneralSecurityException in a
        // SecurityException, so this only passes if the cause chain is walked.
        installThrowingPrefs(new SecurityException("Could not decrypt value.decryption failed",
            new AEADBadTagException("Tag mismatch!")));

        RecordingCall call = new RecordingCall(KEY);
        plugin.get(call);

        assertFalse("a genuinely undecryptable entry must self-heal so the re-pair rewrite "
            + "lands on clean storage (F56)", backing.contains(KEY));
        assertNotNull(call.rejectMessage);
    }

    @Test
    public void damagedBase64ClearsTheEntry() throws Exception {
        // F9. Left preserved, a base64-damaged tenant_id makes main.ts set tenantReadFailed on
        // EVERY boot, F4 then fails the tenant-bound cache closed, and an offline device holds
        // a blank screen forever.
        installThrowingPrefs(new IllegalArgumentException("bad base-64"));

        plugin.get(new RecordingCall(KEY));

        assertFalse(backing.contains(KEY));
    }

    @Test
    public void clearingRemovesOnlyTheFailingKey() throws Exception {
        // Clearing the whole store would wipe device_token/device_id and silently de-pair the
        // device — the failure mode F42's non-fatal tenant_id recovery exists to avoid.
        backing.edit().putString("device_id", "dev-1").putString("tenant_id", "ten-1").commit();
        installThrowingPrefs(new SecurityException("Could not decrypt value.decryption failed",
            new GeneralSecurityException("decryption failed")));

        plugin.get(new RecordingCall(KEY));

        assertFalse(backing.contains(KEY));
        assertEquals("dev-1", backing.getString("device_id", null));
        assertEquals("ten-1", backing.getString("tenant_id", null));
    }

    // ---- happy path -------------------------------------------------------------------------

    @Test
    public void successfulReadResolvesAndTouchesNothing() throws Exception {
        setField("securePrefs", backing);
        setField("secureStorageAvailable", true);
        setField("initAttempted", true);

        RecordingCall call = new RecordingCall(KEY);
        plugin.get(call);

        assertTrue(call.resolved);
        assertEquals(VALUE, backing.getString(KEY, null));
    }
}
