package com.vizora.display;

import java.security.GeneralSecurityException;

import javax.crypto.AEADBadTagException;

/**
 * Pure decision logic for "is this SecureStorage read failure an UNRECOVERABLE corruption
 * of this one entry, or a transient fault?" — extracted from SecureStoragePlugin so it is
 * unit-testable on the host JVM (the plugin extends Capacitor's Plugin, which drags in the
 * Android runtime). Same idiom as {@link RendererRecoveryGuard}: no Android imports.
 *
 * Why this exists (N1): SecureStoragePlugin.get() used to self-heal by deleting the entry on
 * ANY exception thrown by the read. That is destructive-by-default, and the damage landed
 * BEFORE anything could retry:
 *
 *   src/main.ts calls SecureStorage.get('device_token') TWICE on the boot path. The first call
 *   is inside migrateCredentialsToSecureStorage() (main.ts ~:635), whose catch only logs. The
 *   guarded read with the CRED_READ_MAX_RETRIES=3 budget comes AFTER it (~:292). So any
 *   exception at all — of any class — deleted device_token during migration, and the guarded
 *   read then succeeded returning null. The retry budget was never consulted, the
 *   'secure_storage_read_failed' telemetry never fired, and the device fell through to "No
 *   credentials found" and put a pairing code on a fielded screen. A truck roll, silently.
 *
 * With this classifier the entry survives anything not provably dead, so the second read
 * throws too, the retry budget is actually spent, and the telemetry actually fires.
 *
 * HONESTY / mechanism correction: an earlier version of this comment blamed "a transient
 * Android Keystore fault during get()". That is NOT what happens, and the distinction matters
 * because it changes which failures are plausibly recoverable. Verified by decompiling
 * androidx.security:security-crypto:1.0.0 and tink-android:1.5.0:
 * EncryptedSharedPreferences.getString() performs NO Android Keystore operation. The keystore
 * master key is consumed once, inside EncryptedSharedPreferences.create() (which is why a
 * wedged keystore surfaces in SecureStoragePlugin.ensureSecurePrefs() as
 * SECURE_STORAGE_UNAVAILABLE, a path this class does not touch). The per-value primitive is
 * Tink's AesGcmJce — pure JCE over key material already unwrapped in memory. So the
 * justification for preserving an entry is NOT "the keystore might recover"; it is the weaker
 * but sufficient "this exception is not proof the ciphertext is dead" — an IOException or
 * IllegalStateException from the backing prefs file, an OOM, a Tink internal state error.
 *
 * The fix is therefore to make the destructive branch NARROW. F56's intent — a genuinely
 * corrupt entry still self-heals so the re-pair rewrite lands on clean storage — is preserved
 * for the failures that really are unrecoverable at the entry level: an AEAD integrity failure
 * (the ciphertext does not authenticate) and a malformed base64 envelope (the stored string is
 * not decodable at all). Everything else leaves the entry ALONE.
 *
 * Deliberately conservative: a false NEGATIVE here costs one extra pairing round-trip (the
 * entry stays corrupt, the read keeps failing, main.ts routes to pairing after its retries,
 * and the re-pair overwrites the key). A false POSITIVE destroys a working credential. So the
 * bar for returning true is high.
 */
final class SecureStorageFailureClassifier {

    /**
     * Bound on the cause chain walk. Also what makes the walk cycle-safe: a cyclic
     * getCause() chain (a → b → a) cannot spin, it just exhausts the depth budget.
     */
    static final int MAX_CAUSE_DEPTH = 16;

    /**
     * Lowercased message fragments that identify an AEAD tag / MAC / decrypt-integrity
     * failure raised as a plain GeneralSecurityException rather than AEADBadTagException.
     * Tink (which backs EncryptedSharedPreferences) wraps the underlying tag mismatch and
     * rethrows its own GeneralSecurityException, so the type alone is not enough.
     */
    /**
     * The message an undecodable base64 envelope raises. Verified from the bytecode of
     * com.google.crypto.tink.subtle.Base64 (shipped inside tink-android:1.5.0), which is what
     * EncryptedSharedPreferences.getDecryptedObject() actually calls before handing the bytes
     * to the AEAD — NOT android.util.Base64, though Tink's copy is a verbatim port of it and
     * uses the identical literal. It is the ONLY IllegalArgumentException that class
     * constructs, on any decode overload, so matching this one string is both narrow and
     * complete for the production path.
     *
     * Note for anyone writing a test: on the host JVM java.util.Base64 says "Illegal base64
     * character ..." instead, so a test that produces a REAL host-JVM base64 failure would not
     * exercise this rule. The tests construct the production exception explicitly.
     */
    private static final String BAD_BASE64_MESSAGE = "bad base-64";

    private static final String[] CORRUPTION_MESSAGE_FRAGMENTS = {
        "aeadbadtag",
        "tag mismatch",
        "bad tag",
        "mac check",
        "decryption failed",
        "failed to decrypt",
        "cannot decrypt",
        "unable to decrypt",
        "decrypt error",
        "integrity check failed",
    };

    private SecureStorageFailureClassifier() {}

    /**
     * @param failure the exception thrown by the entry read (may be null)
     * @return true only if the cause chain shows an AEAD/MAC integrity failure or an
     *         undecodable base64 envelope — i.e. this entry's stored value can never be
     *         decrypted again, so clearing it is the only way forward. false for EVERY other
     *         failure (IllegalStateException, IOException, RuntimeException, an unrelated
     *         IllegalArgumentException, null, ...), which must be left un-mutated so the
     *         caller's retry budget is real.
     */
    static boolean isUnrecoverableEntryCorruption(Throwable failure) {
        Throwable current = failure;
        for (int depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
            if (indicatesCorruption(current)) {
                return true;
            }
            Throwable next = current.getCause();
            if (next == current) {
                break; // self-referencing cause (the common JDK cycle)
            }
            current = next;
        }
        return false;
    }

    private static boolean indicatesCorruption(Throwable t) {
        // AEADBadTagException is definitional: the GCM tag did not verify.
        if (t instanceof AEADBadTagException) {
            return true;
        }
        // A stored value whose base64 envelope is damaged. This is NOT a GeneralSecurityException
        // — Tink's Base64.decode raises a plain IllegalArgumentException, and androidx's only
        // catch in getDecryptedObject() is for GeneralSecurityException, so it arrives here raw.
        // It is durable disk corruption by construction: no transient or environmental
        // condition rewrites a stored string into invalid base64, and nothing can ever decode
        // it. Left unhandled it was a genuine regression rather than a missed optimisation:
        // for tenant_id, main.ts sets tenantReadFailed on every boot, F4 then fails the
        // tenant-bound cache closed, and an offline device holds a blank screen FOREVER —
        // where the old unconditional remove() let boot #2 render cached content in grace mode.
        // Kept narrow by matching the message, so an unrelated IllegalArgumentException
        // (a bad argument, a NumberFormatException) still preserves the entry.
        if (t instanceof IllegalArgumentException) {
            String iaeMessage = t.getMessage();
            return iaeMessage != null
                && iaeMessage.toLowerCase(java.util.Locale.ROOT).contains(BAD_BASE64_MESSAGE);
        }
        // Any other exception type is out of scope even if its message mentions decryption —
        // an IOException saying "decryption failed" is not proof the ciphertext is dead.
        if (!(t instanceof GeneralSecurityException)) {
            return false;
        }
        String message = t.getMessage();
        if (message == null) {
            return false;
        }
        String lower = message.toLowerCase(java.util.Locale.ROOT);
        for (String fragment : CORRUPTION_MESSAGE_FRAGMENTS) {
            if (lower.contains(fragment)) {
                return true;
            }
        }
        return false;
    }
}
