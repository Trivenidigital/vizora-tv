package com.vizora.display;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import android.content.pm.ResolveInfo;

import java.util.List;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.shadows.ShadowApplication;

/**
 * CALL-SITE tests for {@link BootReceiver}.
 *
 * These exist because there were none, and their absence was not theoretical: deleting
 * {@code Intent.ACTION_MY_PACKAGE_REPLACED} from the action guard — which restores the
 * "screen stays dark after a Play/sideload update until someone power-cycles it" hole — left
 * the entire Java suite green. Nothing drove onReceive(); the relaunch was asserted only where
 * it was already known to work.
 *
 * Each accepted action gets its own case rather than a loop, so a regression names the broadcast
 * it broke.
 */
@RunWith(RobolectricTestRunner.class)
public class BootReceiverTest {

    private Application application;

    @Before
    public void setUp() {
        application = RuntimeEnvironment.getApplication();
        shadowOf(application).clearNextStartedActivities();
    }

    /** The activity BootReceiver started, or null if it started nothing. */
    private Intent relaunchIntent() {
        return shadowOf(application).getNextStartedActivity();
    }

    private void deliver(String action) {
        new BootReceiver().onReceive(application, new Intent(action));
    }

    private void assertRelaunchedMainActivity(String action) {
        Intent started = relaunchIntent();
        assertNotNull(action + " must relaunch the app; nothing was started", started);
        assertNotNull("relaunch intent has no component", started.getComponent());
        assertEquals(MainActivity.class.getName(), started.getComponent().getClassName());
        assertTrue("a relaunch from a receiver has no task to join, so it needs NEW_TASK",
            (started.getFlags() & Intent.FLAG_ACTIVITY_NEW_TASK) != 0);
    }

    @Test
    public void bootCompletedRelaunchesTheApp() {
        deliver(Intent.ACTION_BOOT_COMPLETED);
        assertRelaunchedMainActivity("BOOT_COMPLETED");
    }

    @Test
    public void packageReplacedRelaunchesTheApp() {
        // N3. A Play/sideload update kills our process and nothing else brings it back.
        deliver(Intent.ACTION_MY_PACKAGE_REPLACED);
        assertRelaunchedMainActivity("MY_PACKAGE_REPLACED");
    }

    @Test
    public void aospQuickbootRelaunchesTheApp() {
        // F55: some TV boxes send only the quick-boot broadcast, never BOOT_COMPLETED.
        deliver("android.intent.action.QUICKBOOT_POWERON");
        assertRelaunchedMainActivity("QUICKBOOT_POWERON");
    }

    @Test
    public void htcQuickbootRelaunchesTheApp() {
        deliver("com.htc.intent.action.QUICKBOOT_POWERON");
        assertRelaunchedMainActivity("com.htc QUICKBOOT_POWERON");
    }

    @Test
    public void unrelatedBroadcastsStartNothing() {
        // Negative control: the guard must be what selects the relaunch, not the mere fact
        // that onReceive ran. Without this, a receiver that started MainActivity
        // unconditionally would pass every case above.
        deliver(Intent.ACTION_SCREEN_ON);
        assertNull("only the relaunch signals may start the app", relaunchIntent());
    }

    @Test
    public void anActionlessBroadcastStartsNothing() {
        new BootReceiver().onReceive(application, new Intent());
        assertNull("a null action must not NPE or relaunch", relaunchIntent());
    }

    @Test
    public void theManifestActuallyRegistersTheReceiverForEveryHandledAction() {
        // The Java guard is only half the wiring: an action the manifest does not register is
        // never delivered, so the branch above it is unreachable in production. This resolves
        // the broadcasts against the MERGED manifest, which is what ships.
        for (String action : new String[] {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            "android.intent.action.QUICKBOOT_POWERON",
            "com.htc.intent.action.QUICKBOOT_POWERON",
        }) {
            Intent intent = new Intent(action);
            intent.setPackage(application.getPackageName());
            List<ResolveInfo> receivers =
                application.getPackageManager().queryBroadcastReceivers(intent, 0);
            boolean registered = false;
            for (ResolveInfo info : receivers) {
                if (BootReceiver.class.getName().equals(info.activityInfo.name)) {
                    registered = true;
                    break;
                }
            }
            assertTrue(action + " is handled in BootReceiver.java but not registered in "
                + "AndroidManifest.xml — it will never be delivered", registered);
        }
    }

    @Test
    public void receiverIsNotStartedTwiceForOneBroadcast() {
        // Guards the shape of the fix: one broadcast, one launch.
        deliver(Intent.ACTION_MY_PACKAGE_REPLACED);
        ShadowApplication shadow = shadowOf(application);
        assertNotNull(shadow.getNextStartedActivity());
        assertNull("one broadcast must produce exactly one relaunch",
            shadow.getNextStartedActivity());
    }
}
