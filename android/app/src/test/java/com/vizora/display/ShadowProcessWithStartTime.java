package com.vizora.display;

import android.os.Process;

import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;
import org.robolectric.shadows.ShadowProcess;

/**
 * Test-only shadow that makes {@link Process#getStartElapsedRealtime()} controllable.
 *
 * Robolectric's built-in ShadowProcess does not implement it and the real method returns 0 under
 * the sandbox. Depending on that 0 was a trap: it is indistinguishable from an OEM build that
 * stubs the method, so the tests could only exercise process-start values that a broken device
 * also produces, and production could not treat 0 as implausible without going untested.
 *
 * Driving the value here instead of through a production seam keeps the mutable state entirely
 * in the test source set — no test-only setter on the shipped class, and no static that a
 * forgotten reset could leak into production behaviour. Same idiom as BridgeTestAccess and
 * CapacitorPreferencesReader.
 */
@Implements(Process.class)
public class ShadowProcessWithStartTime extends ShadowProcess {

    /** A plausible default: the app started 60s after boot, as it would on a real device. */
    static final long DEFAULT_START_ELAPSED_MS = 60_000L;

    private static long startElapsedRealtimeMs = DEFAULT_START_ELAPSED_MS;

    /** Robolectric shares a classloader across test methods, so tests must reset this. */
    static void setStartElapsedRealtime(long ms) {
        startElapsedRealtimeMs = ms;
    }

    @Implementation
    protected static long getStartElapsedRealtime() {
        return startElapsedRealtimeMs;
    }
}
