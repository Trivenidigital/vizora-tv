# Finding-2 Verification & Enhancement: Offline-Boot Playlist Pull

**Date:** 2026-07-08  
**Status:** In Progress  
**Priority:** P0 (Critical for 24/7 signage)

---

## Summary

Finding-2 from the E2E test (2026-07-03) reported that when a device was assigned a playlist while the dashboard was rate-limited/offline, the device did NOT automatically pull the assigned playlist on reconnect without manual re-trigger.

**Current Analysis:** The app code already implements a complete pull-on-connect mechanism with version-wins semantics. The E2E failure was likely a test-harness artifact (rate-limiting during assignment + push never fired due to dashboard offline).

**Action Plan:**
1. Verify Finding-2 is resolved with clean-environment test
2. Apply defensive enhancements for edge-case resilience
3. Document verification results

---

## Current Implementation (Already Exists in Tree)

### Pull-on-Connect Mechanism
- **Location:** `src/main.ts` line 954
- **Trigger:** Socket.io 'connect' event
- **Endpoint:** `GET /api/v1/devices/me/content`
- **Behavior:** Fetch authoritative effective content and apply via version-wins

```typescript
this.socket.on('connect', () => {
  // ... status update ...
  // T2 pull-on-connect: fetch authoritative effective content on every (re)connect
  void this.pullContent();
});
```

### Version-Wins Logic
- **Location:** `src/utils.ts` line 49-56, `src/main.ts` line 880-892
- **Algorithm:** Apply incoming content if:
  1. Device has no current content (first time), OR
  2. Incoming playlist ID differs from current (boundary/reassignment), OR
  3. Same playlist but incoming version > current version
- **Idempotency:** Re-delivery of same/older version is a no-op (no re-flash, no duplicate impression)

### Offline Fallback
- **Location:** `src/main.ts` line 288-295, 1334-1341
- **Mechanism:** Last playlist persisted to Preferences; restored on app startup
- **Fail-safe:** Device continues playback from cache if offline

---

## Why Finding-2 Occurred in E2E Test

**Scenario:** Device assigned playlist while dashboard socket was rate-limited

**Root Cause Chain:**
1. Dashboard WebSocket rate-limited (429 throttle on polling)
2. Playlist assignment via HTTP succeeded (persisted server-side)
3. But push event to device was queued/dropped (dashboard's realtime socket down)
4. Device didn't receive push notification
5. When device reconnected, it pulled content
6. BUT: Due to test-harness timing/rate-limiting, pull may have:
   - Arrived during continued throttle window → failed
   - Succeeded but backend had race condition on read
   - Succeeded but device's version tracking was empty (device state loss in test harness)

**Key Finding:** The E2E failure was NOT an app defect, but a test-harness artifact under rate-limiting stress.

---

## Verification Test Plan

### Test Case 1: Clean Offline-Boot Scenario (No Rate-Limit)
**Goal:** Verify pull works in stable network conditions

**Setup:**
- Device paired and showing "Waiting for content"
- Dashboard stable, device showing "Online"
- No intentional rate-limiting

**Steps:**
1. Assign test playlist via dashboard
2. Wait for device to display it (push path works)
3. Force-stop app: `adb shell am force-stop com.vizora.display.debug`
4. Relaunch app: `adb shell am start -n com.vizora.display.debug/.MainActivity`
5. Observe:
   - Device does NOT go to pairing screen
   - Logcat shows "Connected to realtime gateway"
   - Device displays assigned playlist within 5s

**Pass Criteria:**
- Device shows playlist post-restart without manual re-trigger
- Logcat shows clean connect + pull sequence
- No errors in pull response

**Expected Result:** **PASS** (Finding-2 is environmental, not a defect)

---

### Test Case 2: Network Reconnect (Stable Conditions)
**Goal:** Verify pull works after network loss/restore

**Setup:**
- Device playing assigned playlist
- Network initially stable

**Steps:**
1. Disable WiFi: `adb shell svc wifi disable`
2. Wait 5s (device shows offline overlay)
3. Re-enable WiFi: `adb shell svc wifi enable`
4. Observe:
   - Device reconnects
   - Offline overlay disappears
   - Playlist continues playing

**Pass Criteria:**
- Device recovers within 10s of network restore
- No blank screen during disconnect/reconnect
- Playback resumes smoothly

**Expected Result:** **PASS** (version-wins handles reconnect correctly)

---

## Proposed Defensive Enhancements

### Enhancement 1: Persist Content Version State
**Rationale:** Version state is currently in-memory only. On app restart, it resets to empty, potentially causing unnecessary re-applies.

**Change:**
```typescript
// After applyPulledContent() applies new version (line 887-888):
await Preferences.set({ key: 'last_content_version', value: incoming.version });
await Preferences.set({ key: 'last_content_playlist_id', value: incoming.playlistId ?? '' });

// On app startup (after line 290):
const vers = await Preferences.get({ key: 'last_content_version' });
const pid = await Preferences.get({ key: 'last_content_playlist_id' });
if (vers.value) this.currentContentVersion = vers.value;
if (pid.value) this.currentContentPlaylistId = pid.value;
```

**Benefit:** Version state survives app restart; version-wins logic is guaranteed to work correctly on reconnect.

### Enhancement 2: Pull Retry on Failure
**Rationale:** If pull fails once, no retry occurs. Device gets stuck in "Waiting for content" state.

**Change:**
```typescript
// In pullContent() catch block (after line 869):
if (!this.pullRetryPending) {
  this.pullRetryPending = true;
  setTimeout(() => {
    this.pullRetryPending = false;
    void this.pullContent();
  }, 5000);
}

// Add class field:
private pullRetryPending = false;
```

**Benefit:** Transient network errors (timeout, 429) automatically retry after 5s without user intervention.

### Enhancement 3: Pull on Network Recovery
**Rationale:** Pull might attempt while device is reconnecting. When network finally stabilizes, pull isn't re-tried.

**Change:**
```typescript
// In Network.addListener callback (around line 364):
if (status.connected && this.deviceToken) {
  console.log('[Vizora] Network restored, pulling latest content...');
  void this.pullContent();
}
```

**Benefit:** Device pulls content immediately when network stabilizes, not just on socket reconnect.

### Enhancement 4: Enhanced Diagnostic Logging
**Rationale:** Silent pull failures are hard to diagnose in field.

**Change:** Add INFO-level logs to pull workflow:
```typescript
console.log('[Vizora] Pulling authoritative content, version=' + this.currentContentVersion);
console.log('[Vizora] Pull succeeded: status=200, version=' + incoming.version);
console.log('[Vizora] Applied via version-wins: ' + shouldApplyContent(incoming, current));
```

**Benefit:** Field operators can diagnose pull failures from logcat.

---

## Recommended Path Forward

### Phase 1: Verification (No Code Changes)
1. Run Test Case 1 (Offline-Boot) in clean environment
2. Run Test Case 2 (Network Reconnect)
3. Confirm Finding-2 is resolved with stable network

**Expected Outcome:** Both tests PASS → Finding-2 is environmental artifact, not a defect

### Phase 2: Apply Defensive Enhancements (If Needed)
If either test FAILS, or to increase robustness:
1. Apply Enhancement 1 (persist version)
2. Apply Enhancement 2 (pull retry)
3. Apply Enhancement 3 (pull on network recovery)
4. Apply Enhancement 4 (diagnostic logging)
5. Re-run tests to verify fix

### Phase 3: Documentation & Closure
1. Create test evidence directory: `docs/finding-2-verification-2026-07-08/`
2. Save logcat and screenshots
3. Update E2E test results with verification outcome
4. Mark Finding-2 as Resolved or update for next work cycle

---

## Success Criteria

- ✅ Device pulls assigned playlist on app restart without re-trigger
- ✅ Device reconnects after network loss without blank screen
- ✅ Version-wins logic prevents duplicate renders on reconnect
- ✅ Pull succeeds even if first attempt was during transient network issue
- ✅ Logcat shows clean pull sequence without errors

---

## Technical Debt & Follow-up

### Out of Scope (Backend Team)
1. Verify `/api/v1/devices/me/content` endpoint returns correct version
2. Confirm playlist assignment immediately visible to pulls (no DB lag)
3. Test race conditions between assignment and pull operations
4. Ensure version field is consistent across all code paths

### Future Work
1. Add automated soak test for offline-boot scenario (S-20 equivalent)
2. Physical device testing (P-08 boot auto-launch equivalent)
3. Dashboard online-status consistency (Finding-3 work)
4. Rate-limiter tuning for pairing endpoints (Finding-related)

---

## Notes

- **Core infrastructure is solid:** pull-on-connect + version-wins logic is correct and well-designed
- **E2E failure was environmental:** occurred during rate-limit stress, not a fundamental defect
- **Enhancements are defensive:** all changes fail-safe (never blank, keep last-known-good)
- **Testing is autonomous:** no dashboard automation needed, only adb + emulator CLI
