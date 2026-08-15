package com.vizora.display;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStoreException;

import javax.crypto.AEADBadTagException;

import org.junit.Test;

/**
 * Host-JVM unit tests for the N1 SecureStorage failure classifier.
 *
 * Regression focus: SecureStoragePlugin.get() used to delete the entry on ANY exception. That
 * destroyed device_token during migrateCredentialsToSecureStorage() — which runs BEFORE the
 * guarded read — so src/main.ts's CRED_READ_MAX_RETRIES=3 budget was never spent, the read
 * returned null, and a fielded screen fell through to "No credentials found" and displayed a
 * pairing code. These tests pin the narrow destructive branch: only a failure that proves the
 * stored value is undecryptable may clear the entry.
 *
 * Two such failures exist on the real read path, and both are pinned below with the exception
 * shapes production actually produces (not convenient stand-ins):
 *   - an AEAD integrity failure, which androidx rewraps as
 *     SecurityException("Could not decrypt value." + msg, GeneralSecurityException)
 *   - an undecodable base64 envelope, which arrives as a RAW IllegalArgumentException
 *     ("bad base-64") because androidx only catches GeneralSecurityException
 */
public class SecureStorageFailureClassifierTest {

    // ---- MUST clear: the entry really is unrecoverable ------------------------------------

    @Test
    public void aeadBadTagIsCorruption() {
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new AEADBadTagException("Tag mismatch!")));
    }

    @Test
    public void aeadBadTagWithNoMessageIsCorruption() {
        // Classified by TYPE, so a null message must not weaken it.
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new AEADBadTagException()));
    }

    @Test
    public void tinkStyleDecryptionFailedIsCorruption() {
        // Tink (which backs EncryptedSharedPreferences) swallows the tag mismatch and
        // rethrows its own GeneralSecurityException — type alone is not enough.
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new GeneralSecurityException("decryption failed")));
    }

    @Test
    public void aesSivIntegrityCheckFailedIsCorruption() {
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new GeneralSecurityException("Integrity check failed.")));
    }

    @Test
    public void corruptionNestedInCauseChainIsFound() {
        Throwable nested = new RuntimeException("could not read pref",
            new IllegalStateException("tink wrapper",
                new AEADBadTagException("Tag mismatch!")));
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(nested));
    }

    @Test
    public void corruptionDeepInCauseChainIsFound() {
        Throwable t = new AEADBadTagException("Tag mismatch!");
        for (int i = 0; i < SecureStorageFailureClassifier.MAX_CAUSE_DEPTH - 1; i++) {
            t = new RuntimeException("wrapper " + i, t);
        }
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(t));
    }

    // ---- MUST NOT clear: everything that might be transient --------------------------------

    @Test
    public void keystoreDaemonFaultIsNotCorruption() {
        // THE regression: a wedged/restarting keystore daemon. Deleting here is what unpaired
        // fielded screens.
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new KeyStoreException("Keystore operation failed")));
    }

    @Test
    public void runtimeExceptionIsNotCorruption() {
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IllegalStateException("keystore service not ready")));
    }

    @Test
    public void ioExceptionIsNotCorruption() {
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IOException("failed to read prefs file")));
    }

    @Test
    public void nonSecurityExceptionMentioningDecryptIsNotCorruption() {
        // An IOException whose text happens to say "decryption failed" is NOT proof the
        // ciphertext is dead — the message check is gated on GeneralSecurityException.
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IOException("decryption failed")));
    }

    @Test
    public void unrelatedGeneralSecurityExceptionIsNotCorruption() {
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new GeneralSecurityException("keystore unavailable")));
    }

    @Test
    public void generalSecurityExceptionWithNullMessageIsNotCorruption() {
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new GeneralSecurityException()));
    }

    @Test
    public void nullFailureIsNotCorruption() {
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(null));
    }

    @Test
    public void transientChainOfWrappersIsNotCorruption() {
        Throwable nested = new RuntimeException("outer",
            new IllegalStateException("middle",
                new KeyStoreException("Keystore operation failed")));
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(nested));
    }

    // ---- Chain walking must terminate ------------------------------------------------------

    @Test
    public void selfReferencingCauseTerminates() {
        // initCause() rejects self-reference, so build the cycle by subclassing getCause().
        Throwable selfCycle = new RuntimeException("wedged") {
            @Override
            public synchronized Throwable getCause() {
                return this;
            }
        };
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(selfCycle));
    }

    @Test
    public void twoNodeCauseCycleTerminates() {
        final Throwable[] pair = new Throwable[2];
        pair[0] = new RuntimeException("a") {
            @Override
            public synchronized Throwable getCause() {
                return pair[1];
            }
        };
        pair[1] = new RuntimeException("b") {
            @Override
            public synchronized Throwable getCause() {
                return pair[0];
            }
        };
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(pair[0]));
    }

    // ---- the shapes production actually throws --------------------------------------------

    @Test
    public void androidxRewrappedDecryptFailureIsCorruption() {
        // F11 / F56: THE shape the fleet produces on a corrupt entry. androidx's
        // EncryptedSharedPreferences.getDecryptedObject() catches GeneralSecurityException and
        // rethrows `new SecurityException("Could not decrypt value." + e.getMessage(), e)`.
        // Note SecurityException is a RuntimeException, NOT a GeneralSecurityException, so the
        // outer type alone tells the classifier nothing — this passes only because the cause
        // chain is walked. That walk is exactly what F56's self-heal depends on, and nothing
        // else in this file was binding it to the real wire shape.
        SecurityException production = new SecurityException(
            "Could not decrypt value.decryption failed",
            new GeneralSecurityException("decryption failed"));
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(production));
    }

    @Test
    public void androidxRewrappedAeadBadTagIsCorruption() {
        // Same wrapper, but with the concrete JCE exception AesGcmJce raises underneath.
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new SecurityException("Could not decrypt value.Tag mismatch!",
                new AEADBadTagException("Tag mismatch!"))));
    }

    @Test
    public void damagedBase64EnvelopeIsCorruption() {
        // F9. Tink's Base64.decode (called by getDecryptedObject BEFORE the AEAD) raises a
        // plain IllegalArgumentException("bad base-64"), and androidx's only catch there is
        // for GeneralSecurityException — so it propagates RAW, with no wrapping.
        //
        // Constructed explicitly rather than by feeding junk to a real decoder: the host JVM's
        // java.util.Base64 says "Illegal base64 character ..." instead, so a "realistic"
        // host-side failure would NOT be the production string and the test would prove
        // nothing about the device. The literal below is read off the bytecode of
        // com.google.crypto.tink.subtle.Base64 in tink-android:1.5.0.
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IllegalArgumentException("bad base-64")));
    }

    @Test
    public void damagedBase64IsCorruptionEvenWhenWrapped() {
        assertTrue(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new RuntimeException("read failed", new IllegalArgumentException("bad base-64"))));
    }

    @Test
    public void unrelatedIllegalArgumentExceptionIsNotCorruption() {
        // Keeps the base64 rule narrow. IllegalArgumentException is a broad type — treating
        // the whole class as corruption would re-open the destroy-a-good-credential bug, and
        // NumberFormatException is a subclass, so it is a live risk rather than a theoretical
        // one.
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IllegalArgumentException("key must not be empty")));
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IllegalArgumentException()));
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new NumberFormatException("For input string: \"abc\"")));
    }

    @Test
    public void hostJvmBase64WordingIsNotMatched() {
        // Documents the asymmetry deliberately rather than leaving it as a latent surprise:
        // java.util.Base64's wording is NOT the production wording and is NOT matched. If
        // someone later swaps the storage layer for one that uses java.util.Base64, this test
        // going stale is the signal to widen the rule on purpose.
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(
            new IllegalArgumentException("Illegal base64 character 2e")));
    }

    @Test
    public void corruptionBeyondDepthBudgetIsNotReported() {
        // Documents the bound: past MAX_CAUSE_DEPTH we give up and report "not corrupt",
        // which is the safe direction (we never destroy a credential we are unsure about).
        Throwable t = new AEADBadTagException("Tag mismatch!");
        for (int i = 0; i < SecureStorageFailureClassifier.MAX_CAUSE_DEPTH; i++) {
            t = new RuntimeException("wrapper " + i, t);
        }
        assertFalse(SecureStorageFailureClassifier.isUnrecoverableEntryCorruption(t));
    }
}
