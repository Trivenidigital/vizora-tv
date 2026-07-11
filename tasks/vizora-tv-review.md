# Vizora TV — Field-Readiness Audit (Fleet-Grade Review)

**Date:** 2026-07-02
**Auditor:** Claude Code (boundary-depth session)
**Scope:** Entire device-side app (6 TS + 4 Java files, manifest, gradle, docs), judged against the north-star invariant: *the screen never shows wrong/expired/unapproved content, and never goes black or shows an error surface while valid cached content exists.*
**Method:** Every claim below was verified by reading the cited code. No fixes have been applied — this is the Phase 2 checkpoint deliverable.

> **STATUS UPDATE (2026-07-07).** The "no fixes applied" framing reflects the 2026-07-02 checkpoint. Since then **P0-1** (playback state machine / never-black — `422f194`; closes F5–F9, F11, F12, F19, F35), **P0-2** (confirmed revocation + transport fail-open + tenant binding — `e6a6726`; closes F3, F4), and **P0-4** (Play readiness — `dcec659`; closes F10/F10b, F29) are MERGED, plus the T2 delivery layer (pull-on-connect / heartbeat-reconcile / version-wins / PD-1 `b0a7aaa` / PD-7 `9fec12f`). **P0-3** (survivability — F1, F2, F18-part) remains OPEN and is where the 2026-07-06 audit's **F36/F37** land. Read this register alongside git history; the 2026-07-06 disposition and clear-path split are in **§5.1**, and the new backend open questions are in **§1.10**.

---

## 1. Current-State Map (Phase 0)

### 1.1 Stack & topology

- **Capacitor 6 + Vite + TypeScript** single-activity WebView app (`MainActivity extends BridgeActivity`, `MainActivity.java:10`). ALL playback logic is web-side in one class `VizoraAndroidTV` (`src/main.ts:106`). No ExoPlayer — video is a WebView `<video>` element (`main.ts:1300-1312`).
- Native Java surface: boot receiver (`BootReceiver.java`), crash restart (`CrashRecoveryHandler.java`), encrypted prefs plugin (`SecureStoragePlugin.java`), fullscreen/immersive setup (`MainActivity.java:19-27`).
- **Content paths through the WebView:**
  - `image`/`video`: `<img>`/`<video>` from cache URI or direct URL (`main.ts:1292-1312`).
  - `webpage`/`url`: **un-sandboxed** `<iframe src>` (`main.ts:1314-1322`).
  - `html`/`template`: sandboxed `<iframe srcdoc>` (`allow-scripts` only, no `allow-same-origin`) + injected CSP (`main.ts:1324-1337`, `utils.ts:12-20`). CSP allows `img-src https:` (any host) and inline script.
- WebView privileges: no JS bridges exposed to content (content renders in iframes, not the app document); Capacitor bridge lives in the parent document only. `webContentsDebuggingEnabled: false`, `allowMixedContent: false` in release (`capacitor.config.ts:29-38`, `MainActivity.java:33-35` gates mixed content to debug).

### 1.2 Full playback data flow (as implemented)

```
BOOT ──▶ BootReceiver.startActivity()          [BROKEN on Android 10+, see F1]
  └▶ MainActivity → WebView → main.ts init() (main.ts:146)
       ├─ loadConfig (env < stored prefs < URL params)     main.ts:198-220
       ├─ SecureStorage.get(device_token / device_id)      main.ts:157-161
       ├─ HAVE CREDS: restore last_playlist from plain     main.ts:167-186
       │    Preferences → showScreen('content') →
       │    playContent() immediately (BUG#1 fix) →
       │    connectToRealtime()
       └─ NO CREDS: startPairing()                          main.ts:374
            ├─ POST /devices/pairing/request (CapacitorHttp, 10s/15s timeouts)
            ├─ show code + QR + countdown (5 min default)
            ├─ poll GET /pairing/status/{code} every 2s     main.ts:537-581
            └─ on 'paired' + deviceToken → SecureStorage → connectToRealtime()

connectToRealtime (main.ts:655): socket.io, auth.token = JWT,
  reconnection ∞, backoff 1s→60s ±50%.
  on connect    → status online, showScreen('content'), heartbeat 15s,
                  playContent() if restored playlist        main.ts:699-715
  on disconnect → stop heartbeat, offline overlay after 60s main.ts:717-730
  on connect_error containing 'unauthorized'/'invalid token'
                → WIPE credentials → startPairing()         main.ts:732-744  [F3]
  on playlist:update → updatePlaylist(data.playlist)  (NO validation) [F6]
  on command / config / qr-overlay:update → handlers

updatePlaylist (main.ts:771): overwrite playlist, index=0 [F15], persist to
  plain Preferences, clear container [F5], playContent(), preload first 5.

playContent (main.ts:803): clear container → await cache/download → append
  [black gap, F9]; layout items return with NO advance timer [F8]; null-content
  items recurse into nextContent unboundedly [F7]; non-video advance by
  setTimeout(duration); video advance by onended only [F17].
```

### 1.3 As-is "state machine" (implicit, ungoverned)

There is **no explicit playback state machine**. Screen state is the union of four DOM screens toggled by `showScreen()` (`main.ts:1357-1365`) plus a mutable soup of: `currentPlaylist`, `currentIndex`, `playbackTimer`, `temporaryContent`, `savedPlaylistState`, `zoneTimers`, socket state, and `pairingRetryCount`. Transitions are triggered from at least 9 entry points (init, connect, disconnect, connect_error, playlist:update, command, network listener, appStateChange, pairing poll) with no arbitration. Several S1 findings below are direct consequences: states exist that no code path can leave (layout item, empty playlist, dead init), and states can be entered that violate the invariant (pairing screen while cached content exists).

### 1.4 Offline & cache

- Cache: `content-cache/` under `Directory.Data`, JSON manifest, LRU eviction at 500MB default (`cache-manager.ts:18-30,182-208`). Images/videos only; templates survive offline because `metadata.renderedHtml` rides inside the persisted `last_playlist` JSON. `webpage`/`url` content has no offline story (blank iframe).
- **No integrity checks**: download success = HTTP 200; no length/checksum verification; `getCachedUri` verifies existence only (`cache-manager.ts:160-179`). A corrupt file is served forever [F16].
- Eviction is manifest-driven; files orphaned by a crash between `writeFile` and manifest save are invisible to eviction forever (`cache-manager.ts:113-134`) [F34].
- Max survivable offline duration: indefinite for cached image/video/template loops (playback and boot-restore are fully local), **provided the device never loses power** (boot auto-start broken, F1) and the token is never judged invalid (F3).

### 1.5 Pairing & identity

- Code displayed ~6 alphanumeric chars (per E2E evidence: `RQPNKF`), 5-min expiry, entropy/single-use/rate-limiting are **server-side and unverifiable from this repo** — flagged for backend audit.
- Device stores: JWT + deviceId in `EncryptedSharedPreferences` (AES256-GCM, Keystore-backed master key, `SecureStoragePlugin.java:33-41`); one-time migration from plaintext prefs (`main.ts:344-366`). Good.
- **No token refresh/rotation exists.** If backend JWTs expire, the only path is `connect_error` string-match → full credential wipe → pairing screen (F3).
- Unpair (remote command) removes token/deviceId but **not** `last_playlist` or cache (`main.ts:944-948`) [F4].
- Device identifier is regenerated per pairing attempt (`android-{WxH}-{timestamp36}`, `main.ts:394`) — factory-reset-then-repair creates a brand-new backend identity; old device rows orphan [F30].

### 1.6 Device-management surface

- Commands (via authenticated socket `command` event + heartbeat ack): `reload`, `clear_cache`, `unpair`, `update_config`, `push_content`, `qr-overlay-update` (`main.ts:933-980`). Channel auth = socket JWT handshake; no per-command signing (acceptable given TLS + handshake auth).
- Telemetry home: heartbeat every 15s **only while socket connected** (`main.ts:616-619`) with uptime, appVersion, memory %, `currentContent.contentId`; `content:impression` events (dropped silently when offline, `main.ts:826,863,886`) [F25].
- **What the backend can infer about a dark screen: nothing.** `currentContentId` is set on play and never cleared (`main.ts:822`), so a device whose playback died reports the last content forever [F13]. No `isPlaying`, no screen state, no cache stats, no error events.

### 1.7 Survivability inventory

- Crash handling: `CrashRecoveryHandler` schedules an exact alarm +3s with `PendingIntent.getActivity` (`CrashRecoveryHandler.java:31-63`). **Empirically failed** the only test ever run against it (E2E S-19, native crash — `docs/e2e-test-results-2026-03-27.md`), was never retested, and is architecturally suspect on Android 10+ (background activity-launch restrictions apply to alarm PendingIntents from a dead process) [F2]. No crash counter / loop back-off — a crash-on-startup bug means a 3-second restart loop forever (if restart works at all).
- Watchdog: **none.** If the WebView JS context dies or playback halts (F7/F17), nothing notices. (Renderer-process death terminates the hosting app process by framework default, but WITHOUT raising a catchable Java exception — so it bypasses `CrashRecoveryHandler` (F2's handler) entirely, and post-kill auto-restart is unproven, not guaranteed. There is no `onRenderProcessGone` override to recover in-process. **Corrected 2026-07-06 — see F36.**)
- ANR exposure: low (network on native threads via CapacitorHttp).
- Memory: 88–106MB measured over 15 min (prior report) — but zone-timer leak on layout→other transitions is unmeasured [F12]; no multi-day soak has ever been run.
- Wake/screen-on: `android:keepScreenOn="true"` (`AndroidManifest.xml:34`) + immersive flags; prior test confirmed `mWakefulness=Awake`. HOME button on a remote exits to launcher with **no recovery mechanism** (app is not the HOME app, no kiosk/device-owner mode) — anyone with the remote can take the screen down until human relaunch.
- Clock/timezone: no client-side scheduling exists at all; all schedule/expiry semantics are server-push. Consequence: an offline device can never expire anything [F22].
- Burn-in: no mitigation; worse, a static status pill is permanently overlaid on content (`index.html:417-420`) [F21].

### 1.8 Update story

- Play Store auto-update only; no self-update, no remote config flags.
- **Two holes:** (a) an always-foreground kiosk app frequently never satisfies Play's "app not in use" auto-update condition → fleet silently pins to old versions; (b) if an update does apply, the process is killed and there is **no `MY_PACKAGE_REPLACED` receiver** to relaunch — combined with F1, the screen stays dark until power cycle [F18]. No rollback runbook exists anywhere in the repo.

### 1.9 Play readiness

- `targetSdkVersion 34` (`android/variables.gradle:4`). **Google Play has required target API 35 for new-app submissions since 2025-08-31.** This alone blocks submission today [F10].
- `USE_EXACT_ALARM` declared (`AndroidManifest.xml:10`) — Play policy restricts this permission to alarm/clock/calendar apps; a signage app declaring it is a rejection risk [F10b].
- TV banner points at the square launcher mipmap (`AndroidManifest.xml:23`), not a 320×180 banner asset; `store-listing/icons/tv-banner.svg` exists but is not wired in [F29].
- Leanback intent ✓, touchscreen not required ✓, landscape ✓, cleartext blocked in release ✓ (`android/app/src/release/res/xml/network_security_config.xml`), signing external to VCS ✓ (though `android/vizora-release.jks` sits *inside* the repo working tree, gitignored — contrary to the project's own publishing guide) [F33].
- Crash reporting: **absent entirely** (no Crashlytics/Sentry/Bugsnag anywhere) — combined with R8 minification and no mapping-retention process, field crashes are invisible and unsymbolizable [F14].
- Data-safety form accuracy: app transmits userAgent, screen metrics, network type, uptime, memory, content IDs; `PLAY_STORE_LISTING.md:49` claims "No personal data collection" — defensible but the form must still declare device/diagnostic data collection.

### 1.10 Verification of previously-claimed items

| Claim | Verdict | Evidence |
|---|---|---|
| a. "Play approval is the only blocker" (`vizora-tv-report.md`: READY FOR SUBMISSION) | **REJECTED** | Target SDK 34 < required 35 (stale requirement in report); USE_EXACT_ALARM policy risk; banner asset; plus the S1 field-readiness set below which makes shipping to paying storefronts reckless regardless of Play. |
| b. Offline playback is last-known-good | **PARTIAL** | Genuine for cached image/video/template loops incl. cold boot (`main.ts:167-186`). But: `unauthorized` connect_error wipes creds and replaces content with pairing screen (F3); empty/malformed playlist pushes black-screen (F5/F6); webpage content has no offline path. |
| c. Backend contract matches server audit | **UNVERIFIABLE HERE** | This repo is standalone; the server audit is not in-tree. Client-side facts documented in §1.2 for cross-checking; open questions flagged: JWT expiry policy, pairing-code entropy/single-use, whether `playlist:update` is re-sent on every reconnect (drives F15 severity), entitlement-lapse push semantics. |
| d. Known device bugs root-caused & regression-tested | **PARTIAL** | BUG-1 (black on restart) fixed at `main.ts:177-186` with unit coverage. BUG-2 (crash recovery FAIL, E2E S-19) was deferred to "retest on physical device" and then **silently dropped** — the 2026-03-31 report's Suite 7 "PASS" tested token persistence, not crash restart or boot restart (P-08 was skipped). Explicit disagreement: the READY verdict rests on two never-verified survivability mechanisms. |

**Backend open questions — gate store submission (owner: this section; the Play checklist points here, does not restate).** The 2026-07-06 T2 delivery-layer audit adds four server-contract questions to the JWT-expiry item in row (c) above. Each is answerable only against the backend repo, not this standalone tree.

> **ROUTED 2026-07-10** per operator ruling: handed off to the backend session as `vizora/tasks/tv-contract-questions-2026-07-10.md`, which also carries the F40 binding step (shared ack-contract type + integration round-trip). Answers land back in this section; F40 closes here when the binding ships.

1. **Do device JWTs carry an `exp` claim (and is there refresh/re-issue)?** If yes, an expired-but-not-revoked token leaves a device playing cached content forever but never reconnecting — the F3 fail-open is CORRECT and there is no client recovery path (see the F38 disposition, §5.1). Ties to F22. Server must state token lifetime + refresh policy.
2. **Does the server bump effective-content `version` on an in-place content edit?** PD-7 (`9fec12f`) added `content.updatedAt` to the client signature so edits re-render, but `applyPulledContent` gates on the version-only `shouldApplyContent` BEFORE the `updatedAt`-aware signature check (`main.ts:835`). If `version` does NOT change on an in-place edit, versioned pushes/pulls of an edited playlist no-op and the edit never reaches the screen.
3. **Does the server ever deliver a `command`/`revoked` ONLY via the heartbeat-ack `.data` envelope (no separate event)?** The client reads `reconcileContent` from the unwrapped `ack` (`main.ts:783`) but `revoked`/`commands` from top-level `response` (`main.ts:775,778`); the code's own comment says the server wraps in `.data` (`main.ts:768-771`). If so, ack-piggybacked commands are silently dropped TODAY — a live client bug. Client fix (read `ack.` for all three) is do-now (§5.1, P1-1); revocation has a redundant `device:revoked` path so only commands are at risk.
4. **Is any production `playlist:update` still emitted without a `version`?** If not, the legacy versionless branch (`main.ts:994-996`) is dead code and can be deleted. This is cleanup gated on a server fact, NOT a live hazard — the branch already handles versionless safely via the PD-1 signature no-op.

---

## 2. Findings Register

Severity: **S1** = violates north-star invariant or blocks ship; **S2** = degrades unattended operation/fleet ops; **S3** = hygiene. Blast: per-device (PD) vs fleet-wide (FW); remote-recoverable (RR) vs truck-roll (TR).

### S1 — invariant violations & ship blockers

| ID | Finding | Evidence | Blast | Proposed fix | Effort |
|---|---|---|---|---|---|
| **F1** | Boot auto-start broken on Android 10+: `startActivity()` from a BOOT_COMPLETED receiver is a background activity launch, blocked since API 29. Power loss → dark screen until human. Never actually tested (E2E P-08 skipped). | `BootReceiver.java:22-24` | FW, TR | Physical-device verification protocol (§6); pursue kiosk posture: document/require "Display over other apps" grant or device-owner provisioning; add full-screen-intent/overlay fallback. Honest failure mode surfaced in docs. | M |
| **F2** | Crash restart unproven and empirically failed (E2E S-19); alarm-PendingIntent activity launch from dead process is BAL-restricted on 29+; **no crash-loop back-off or counter** — best case is an infinite 3s restart loop on a persistent crash. | `CrashRecoveryHandler.java:31-63`; `docs/e2e-test-results-2026-03-27.md` BUG-2 | FW, TR | Persist crash timestamps (SharedPreferences), exponential back-off, cap-then-hold; verify restart path on hardware; pair with F14 so crashes are at least visible. | M |
| **F3** | Any `connect_error` whose message contains "unauthorized"/"invalid token" **wipes credentials and replaces playing cached content with the pairing screen**. A backend JWT-secret rotation, expiry policy change, or transient auth bug de-pairs the entire fleet simultaneously (every screen shows a pairing code; every storefront needs manual re-pair). Violates direction-aware fail-safe: expired token must fail *open* for playback; only confirmed revocation fails closed. String-matching also means differently-worded revocations are never honored. | `main.ts:732-744` | **FW, TR** | Distinguish explicit revocation (structured server event/code) from auth failure. On auth failure: keep cached loop playing, retry auth in background with back-off, surface state via overlay + telemetry. Wipe only on confirmed revocation. Negative test: "did not stop rendering cached content on transient 401". | M |
| **F4** | Cross-tenant stale content: `unpair` clears token/deviceId but not `last_playlist` or the asset cache. Re-pair to a different tenant → next app start restores and **plays the previous tenant's playlist** until the first `playlist:update` arrives. Direct north-star violation (wrong-tenant content on glass). | `main.ts:944-948` (unpair), `main.ts:167-186` (restore) | PD, RR | On unpair/credential wipe: purge `last_playlist`, cache, and QR overlay config atomically. Bind persisted playlist to deviceId/tenant and discard on mismatch. Negative test: "did not render tenant-A content after re-pair to tenant-B". | S |
| **F5** | Empty `playlist:update` → container is cleared, then the empty case only logs → **permanent black screen** while screen state is 'content'. Publishing an empty playlist from the dashboard blacks out every assigned screen. | `main.ts:787-800` | FW, RR | Part of state machine: empty playlist → branded holding screen state, never bare black. Negative test asserts holding screen visible. | S |
| **F6** | No validation on `playlist:update` payload: `data.playlist` undefined/malformed → container cleared at `main.ts:787-791`, then `playlist.items` throws → playback dead, black screen until next valid push. One malformed push blacks a fleet. | `main.ts:753-756`, `771-800` | FW, RR | Schema-validate payload; on invalid, keep current playback and emit telemetry error event. Negative test with garbage payloads. | S |
| **F7** | Playlist whose items all have `content: null` → `playContent()` ↔ `nextContent()` unbounded synchronous recursion (no await before the recursive call, loop wraps index) → stack overflow → playback engine halts silently. | `main.ts:814-817`, `899-910` | FW, RR | Guard: track items attempted per cycle; if a full pass renders nothing → holding screen state. | S |
| **F8** | Layout content is a terminal state: the `layout` branch returns **without scheduling any advance timer**, so a playlist `[image, layout, image]` never advances past the layout. Worse: `renderLayout` early-returns on missing metadata **after** the container was cleared → permanent black. | `main.ts:842-845` (no timer), `main.ts:1148-1149` (early return), `main.ts:834-835` (pre-clear) | PD/FW, RR | Schedule duration timer for layout items like any other; on invalid metadata, skip item (never clear-then-return). | S |
| **F9** | Black gap on every transition: container is emptied, *then* the next asset is awaited (cache stat, or full download for uncached items — items 6+ are never preloaded, `main.ts:797`). On slow networks an uncached video = black screen for the whole download. Even cached = visible flash every rotation. | `main.ts:834-835` → `848-857`, `1267-1285` | FW, RR | Double-buffer: build next element off-DOM, swap on ready; old frame persists until replacement is renderable. Negative test: "no frame where container is empty during swap". | M |
| **F10** | Play submission blockers: `targetSdkVersion 34` (API 35 required for new apps since 2025-08-31); **F10b** `USE_EXACT_ALARM` is policy-restricted to alarm/clock/calendar apps — rejection risk; release artifact plan says APK (`capacitor.config.ts:36`) where Play requires AAB. | `android/variables.gradle:4`; `AndroidManifest.xml:9-10` | n/a (submission) | Bump target/compile SDK to 35 (includes migrating deprecated `setSystemUiVisibility` → `WindowInsetsController`, flagged in the project's own report); drop `USE_EXACT_ALARM` (crash restart shouldn't depend on exact alarms anyway — see F2 redesign); submit AAB. | M |
| **F36** | Renderer-process death is not recovered in-process: no `WebViewClient.onRenderProcessGone` override exists, so a WebView renderer OOM/SIGSEGV terminates the app process WITHOUT a catchable Java exception → `CrashRecoveryHandler` (F2) never fires, and restart falls to the BAL-gated boot/alarm paths (unproven on API 29+). Corrects the §1.7 assumption at line 86. Common on 24/7 boxes decoding large media. (Recovery is API 26+; inert on API 23-25 — the target fleet is API 31+.) | `MainActivity.java:12-53` (no override); refutes `:86` | FW, TR | Override `onRenderProcessGone` → recreate/reload the WebView in-process (needs NO SAW/BAL → the FIX lands independently of the P0-3 posture gate); VERIFY on hardware via new P0-3 test **S-19d**. | S fix / hw verify |
| **F37** | Keystore read-rejection wedges init in an infinite RECOVERING loop, never reaching the pairing fallback: `SecureStorage.get` REJECTS (not null) on EncryptedSharedPreferences keystore corruption (documented post-OS-update key invalidation); `init()` credential reads are unguarded → throw → `startInit` catch → RECOVERING → retry `init()` forever (5-min cap). Rides the F19 retry loop; brick until adb/clear-data. | `main.ts:221-222`, `199-208`; `SecureStoragePlugin.java:81-89` | PD, TR (brick) | Guard credential reads; on read failure after a bounded retry, route to `startPairing()` instead of the generic init-retry. vitest-testable (mock reject: persistent→pairing, transient→recovers). | S |

**2026-07-06 audit note:** the T2/delivery-layer audit confirmed **F2** (crash-restart still fixed-3s, pre-P0-3) and **F34** (manifest-orphan) unchanged; its manifest and never-black findings map to existing F-numbers, not new ones. F36/F37 are the only net-new S1s. **F38** (401→"limbo") was investigated and **REJECTED** as a finding — the 401 fail-open is correct by design (P0-2/F3); a 401→re-pair "fix" would reopen the fleet de-pair bomb. See §5.1 for the clear-path disposition. Adversarial review of the implemented fixes (2026-07-06) additionally surfaced **F39** (plaintext-fallback credential downgrade, S2 above), dispositioned as a follow-up needing a fail-closed-vs-flag decision.

### S2 — unattended operation & fleet ops

| ID | Finding | Evidence | Blast | Proposed fix | Effort |
|---|---|---|---|---|---|
| F11 | Paired device with no playlist assigned: `connect` handler shows the content screen unconditionally → black until first push. First-boot impression in a storefront is a black screen. | `main.ts:707-714` | PD, RR | Branded holding screen state ("Vizora — waiting for content"). | S |
| F12 | Zone timer leak: `cleanupLayout()` is only called from `renderLayout` itself. Any transition layout→non-layout (`updatePlaylist`, `playContent`, push content) leaves zone loops running forever against detached DOM — CPU, memory, ghost cache downloads. | `main.ts:1222-1226` vs `771-800`, `834-835` | PD, RR (reload) | Call cleanupLayout in every container-clearing path (state-machine exit hook). | S |
| F13 | Heartbeat lies: `currentContentId` set on play, never cleared on stop/black/halt → backend sees a healthy "playing" device while glass is dark. This is the single biggest observability gap. | `main.ts:822`, `638-640` | FW (ops blindness) | Heartbeat enrichment: playback state enum (LIVE/CACHED/HOLDING/BLACK), last-render timestamp, playlistId+version, cache stats, storage free, error counters. Clear contentId on halt. | M |
| F14 | Zero crash reporting (no SDK), R8-minified stack traces, no mapping retention process → field failures invisible and unsymbolizable. | `package.json`, `android/app/build.gradle`, grep: no crashlytics/sentry | FW (ops blindness) | Add Sentry (or Crashlytics) keyed by deviceId; upload mapping in release pipeline; JS error boundary reporting via the same channel. | M |
| F15 | `playlist:update` is not idempotent: unconditional index reset to 0. If the server re-sends the playlist on every reconnect (typical), a flappy network keeps the screen stuck replaying item 1. | `main.ts:771-773` | FW, RR | Compare playlist id/hash; identical → no-op (keep position). Ordering/duplicate tests. | S |
| F16 | Corrupt cached asset is permanent: no download integrity check, `getCachedUri` checks existence only, and render `onerror` shows "Unable to load: …" for 5s **every loop iteration** without ever evicting the bad entry. | `cache-manager.ts:103-134`, `160-179`; `main.ts:851-854`, `1052-1058` | PD, RR (clear_cache) | Verify content-length (checksum if backend provides one); on render error, evict cache entry and re-download once before error state; skip item rather than showing error card in loop. | S |
| F17 | Video advancement relies solely on `onended`; a stalled decode/stream = frozen frame forever, no watchdog. | `main.ts:859` (video excluded from timer), `1310` | PD, RR | Watchdog timer = expected duration × margin; fires → skip item + telemetry event. | S |
| F18 | Update lifecycle: no `MY_PACKAGE_REPLACED` receiver (post-update the app stays dead); always-foreground likely blocks Play auto-update entirely; no bad-build runbook. | manifest (absent receiver); §1.8 | FW, TR | Add MY_PACKAGE_REPLACED receiver (same BAL caveat as F1 — verify on hardware); document staged-rollout + halt + rollback runbook; heartbeat appVersion (exists) becomes the fleet version monitor. | M |
| F19 | Fatal init error → dead-end error screen with no retry (`init().catch` → `showError`). Transient plugin failure at boot = permanent error surface. Offline pairing start also shows the error screen rather than pairing screen with status. | `main.ts:140-143`, `379-386`, `1367-1373` | PD, TR | Retry init with back-off; error screen becomes a state with self-recovery, not a terminus. | S |
| F21 | Status pill permanently overlaid on content (top-right, z-1000): burn-in vector + "Disconnected" text visible to storefront customers. | `index.html:417-420` | FW (product) | Hide on content screen (or show transiently on state change only). | S |
| F22 | Revocation/expiry latency is unbounded: a disconnected device plays revoked/expired content forever; client has no validity-window model and no max-stale-age policy. Backend contract needed. | §1.5, §1.7; `main.ts` (no schedule/expiry logic) | FW (trust) | Define with backend: max offline age before degrade-to-holding; optional per-item validity windows; document decision. | M (needs backend) |
| F23 | Pairing loop can stack: `startPairing` re-entered via bare `setTimeout` from two retry paths + the 404 poll path with no generation guard → overlapping request loops after network flaps. Countdown expiry itself never requests a new code (relies entirely on the poll 404 contract). | `main.ts:384`, `456`, `549-552`, `482-485` | PD, RR | Single owner-token/generation counter for the pairing loop; expiry triggers explicit re-request. | S |
| F24 | Device JWT rides as `?token=` query param on same-origin media URLs → JWT lands in access/CDN logs. Mitigated (same-origin only) but header-auth or short-lived signed URLs are the fleet-grade pattern. | `utils.ts:46-55` | FW (cred hygiene) | Backend work: signed asset URLs; client change trivial after. | M (backend) |
| F25 | Impressions dropped while offline (proof-of-play gap exactly when the loop runs from cache). | `main.ts:826-832`, `863-873`, `886-897` | FW (billing/analytics) | Queue impressions to disk, flush on reconnect with batch emit. | M |
| **F39** | Encrypted credential storage silently degrades to a PLAINTEXT store on any keystore-init failure: `load()` catches `MasterKeys.getOrCreate` / `EncryptedSharedPreferences.create` exceptions and falls back to a regular unencrypted SharedPreferences file. A subsequent re-pair then persists the device JWT in plaintext — a silent credential-at-rest confidentiality downgrade. Conditional (only on devices where keystore init fails). Surfaced during the F37 fix review (2026-07-06). | `SecureStoragePlugin.java:47-50` (fallback), `:64` (set writes to it) | PD, RR | **IMPLEMENTED (fail-closed, retry-then-surface — operator ruling):** native retries keystore init ×3, then fails closed — `securePrefs` stays null and every op rejects `SECURE_STORAGE_UNAVAILABLE`; the web layer surfaces a loud holding-screen error + `secure_storage_unavailable` telemetry, never plaintext. **Documented decision point:** if flaky-keystore on good target hardware proves common enough that loud-fail-on-pair is a real support burden, revisit toward flag-and-degrade-with-loud-telemetry as a documented interim — gated on hardware/field failure-rate data (no data today → fail-closed is the default). | S (done) |
| **F40** (testing) | The heartbeat-ack `.data` envelope is an UNTYPED cross-process contract — the socket ack is typed loosely (`any`-shaped) across the client/server boundary, so an envelope-shape mismatch is INVISIBLE to `tsc`. This is the SECOND such bug: `reconcileContent`-always-undefined (fixed `51efb4e`) and `revoked`/`commands`-always-dropped (this branch, LIVE — the fleet build could not receive revocation or remote commands via the ack). A CI typecheck gate would NOT have caught either. | `main.ts:787-798` (ack read); sibling `51efb4e` | FW (silent control-plane drop) | Rank a **shared contract TYPE** for the ack envelope (one definition imported by both client and server) and/or an **integration round-trip test** (real heartbeat emit → ack shaped like the server → assert the effect) **ABOVE a CI typecheck gate** — typecheck cannot see an `any`-shaped cross-process payload, so the round-trip is what actually binds the contract. | M |

### S3 — hygiene

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| F26 | `webpage`/`url` iframes have no `sandbox` attribute (cross-origin policy is the only isolation). | `main.ts:1314-1322` | Add sandbox with required allowances. |
| F27 | Template CSP permits `img-src https:` (any host) + inline script → data-exfil beacon channel from tenant templates. | `utils.ts:13` | Acceptable for controlled signage; tighten if templates become third-party. |
| F28 | FileProvider declared but unused. | `AndroidManifest.xml:55-63` | Remove. |
| F29 | TV banner = square launcher icon; Play TV quality wants 320×180. `store-listing/icons/tv-banner.svg` exists unwired. | `AndroidManifest.xml:23` | Render banner PNG, reference it. |
| F30 | Device identifier regenerated per pairing attempt → identity churn, orphan device rows after factory reset. | `main.ts:394` | Persist a stable install UUID. |
| F31 | Vestigial `jest.config.js` (tests run on vitest); project CLAUDE.md still says Jest. | `jest.config.js`, `package.json:26` | Delete + doc fix. |
| F32 | Heartbeat `appVersion` comes from `package.json` 1.0.0 while Android `versionName` is 1.0.1 → fleet version monitoring reports the wrong number. | `vite.config.ts:40`, `build.gradle:14` | Single version source. |
| F33 | Release keystore lives inside the repo working tree (gitignored via `android/.gitignore:56`, never committed — verified) contrary to the project's own publishing guide. | `android/vizora-release.jks` | Move outside repo; document backup location. |
| F34 | Cache files orphaned on crash-between-write-and-manifest are invisible to eviction forever. | `cache-manager.ts:113-134` | Directory sweep on init reconciling manifest ↔ files. |
| F35 | Non-looping playlist end freezes the last item forever with the engine stopped (deliberate? undocumented). | `main.ts:901-907` | Define behavior in state machine (hold last item is fine — make it explicit). |

---

## 3. Scorecard (1–5; 5 = structurally enforced)

| # | Dimension | Score | Basis |
|---|---|---|---|
| 1 | Screen integrity & content trust | **2** | Good: encrypted creds, template sandbox+CSP, same-origin token rule. Bad: cross-tenant stale playback (F4), unbounded revocation latency (F22), revocation-by-string-match (F3), no client tenant binding at all. |
| 2 | Never-black guarantee | **1** | Six reachable black/frozen branches (F5–F9, F11), no fallback hierarchy, no holding screen exists in the codebase. Nothing structural — the invariant isn't represented in code. |
| 3 | Survivability 24/7 | **2** | keepScreenOn + immersive solid; crash restart empirically failed + no loop back-off (F2), boot restart architecturally broken on 29+ (F1), no watchdog (F17), zone leak (F12), HOME-button exposure, no soak evidence beyond 15 min. |
| 4 | Pairing & device security | **3** | Keystore-backed storage, TLS clean (no trustAllCerts anywhere, release cleartext off), sandboxed srcdoc, timeouts everywhere. Deductions: query-param JWT (F24), pairing-loop stacking (F23), code entropy/single-use unverified server-side, no token rotation. |
| 5 | Sync & consistency | **2** | Push works and persists; but zero payload validation (F6), non-idempotent updates (F15), no playlist versioning, manifest/cache can serve corrupt assets (F16), no clock-skew concerns only because no client scheduling exists. |
| 6 | Observability from the server's chair | **1.5** | Heartbeat exists but cannot distinguish offline/dark/stale (F13), no crash reporting (F14), impressions dropped offline (F25), no error events, logs unbounded console only. |
| 7 | Performance & hardware envelope | **3** | WebView + native HTTP is adequate; 88–106MB measured; min-spec floor undefined, 4K-asset-on-1080p and thermal behavior untested (hardware-only, §6). |
| 8 | Testing | **3** | 181 unit tests incl. genuine negative cases (sandbox flags, token non-leak); but every S1 branch above is untested, no instrumentation tests (stubs only), no automated E2E, offline loop verified only manually/inconclusively. |
| 9 | Release & ops quality | **2** | Signing hygiene mostly right; target SDK stale (F10), APK-vs-AAB, no symbolication or crash pipeline (F14), version drift (F32), no staged-rollout/rollback runbook (F18). |

---

## 4. Verdict on "Play approval is the only blocker"

**REJECTED.** Two independent blocker classes exist:

1. **Store submission blocks today:** target API 35 (F10), USE_EXACT_ALARM policy risk (F10b), AAB packaging, TV banner asset (F29), data-safety form completion. The 2026-03-31 "READY FOR SUBMISSION" verdict was correct against the requirements of its date and is stale now.
2. **Unattended 24/7 operation blocks today (worse):** F1/F2 mean any power event or crash can permanently dark a screen (truck roll); F3 means one backend auth hiccup de-pairs the fleet; F4–F9 are reachable black-screen/wrong-content branches from ordinary dashboard actions (publish empty playlist, publish layout, malformed push). The two survivability mechanisms the product's pitch rests on (boot auto-start, crash recovery) have **never been observed working** — one was observed failing.

---

## 5. Roadmap

### P0 — blocks shipping to any paying customer's TV
| Slice | Contents | Findings | Effort |
|---|---|---|---|
| **P0-1: Playback state machine + never-black** | Explicit states (PAIRING / LIVE / CACHED / HOLDING / ERROR-RECOVERING) with single-owner transitions; branded holding screen; payload validation; null-content & layout advance guards; double-buffered transitions; empty-playlist → holding. Negative tests: no empty-container frame during swap; holding on empty/garbage push; no recursion crash. | F5,F6,F7,F8,F9,F11,F35 (+F12,F19 fall out naturally) | L (biggest slice, highest value) |
| **P0-2: Auth/trust correctness** | Structured revocation vs transient auth failure; cached loop survives 401; purge playlist+cache on unpair/re-pair; tenant-bind persisted playlist. Negative tests: no render after revocation; no pairing screen during transient 401 with cache; no tenant-A content after re-pair. | F3, F4 | M — **pairing/security change, needs approval** |
| **P0-3: Boot & crash survivability** | Hardware verification protocol (§6) first — facts before fixes; crash-loop back-off + persisted crash counter; MY_PACKAGE_REPLACED receiver; kiosk-posture decision (overlay permission / device-owner guidance). | F1, F2, F18(part) | M — **update/survivability mechanism, needs approval** |
| **P0-4: Play submission closure** | SDK 35 (+WindowInsetsController migration), drop USE_EXACT_ALARM, AAB, banner, data-safety, listing checklist with evidence. | F10, F10b, F29 | M |

### P1 — blocks confident fleet operation
- **P1-1 Observability:** heartbeat enrichment (state enum, last-render ts, playlist version, storage), clear stale contentId, Sentry + mapping upload, offline impression queue. (F13, F14, F25)
- **P1-2 Content robustness:** cache integrity + evict-on-render-error (F16), video watchdog (F17), idempotent playlist updates (F15), pairing-loop generation guard (F23).
- **P1-3 Ops:** bad-build runbook + staged rollout plan (F18), status-pill removal from content screen (F21), init retry (F19 if not covered in P0-1), revocation max-stale-age policy with backend (F22).
- **P1-4 Soak:** scripted multi-hour emulator soak (memory sampling via adb, playlist with layout↔image↔video churn to catch F12-class leaks); define min-spec floor.

### P2 — hygiene
F24 (signed URLs, backend), F26–F34, stable device identity (F30), version unification (F32), cache orphan sweep (F34).

### Minimal slice set to fleet grade
P0-1 → P0-2 → P0-3 → P1-1 → P1-2. P0-4 runs in parallel (independent of the code slices except SDK bump touching MainActivity).

### 5.1 Disposition of the 2026-07-06 audit (clear-path split)

Actionable findings split by **who can clear them** — this ordering IS the priority:

**Keyboard-clearable now (client code + vitest; no hardware, no backend):**
- **F37** — guard init credential reads → bounded retry → pairing fallback. Home: P0-1 (the F19 init-retry logic) + P0-2 cross-ref for the credential-read guard.
- **Ack-unwrap client fix** (backend Q#3) — read `ack.` for `reconcileContent`/`revoked`/`commands` alike (`main.ts:775,778`). Home: P1-1 observability.
- **F38 safe half** — add an explicit `status===401` branch to `scheduleAuthProbe` that KEEPS fail-open (stay degraded, keep cached playback, keep probing) and only promotes the 24h operator badge (`main.ts:1130-1131`) to "needs re-pairing — contact admin" on sustained 401. NO purge, NO auto-re-pair.
- **Socket Manager construct-once** (soak item) — construct the socket once, use `.connect()`/`.disconnect()` instead of a fresh `io()` per reconnect (`main.ts:876`); node-harness regression with the REAL client (current tests mock socket.io-client at `vizora-app.spec.ts:358` → prove nothing about Manager teardown). Home: P1-4.

**REJECTED — do not implement (recorded so it is not re-proposed):**
- **F38 "401 → re-pair/purge".** Reverses the P0-2/F3 fail-open and reintroduces the fleet de-pair bomb — a transient/rotation 401 (any gateway/proxy/validator hiccup) drops every probing device to a pairing code. Only 410 purges by contract (`main.ts:1013-1014,1056,1114`); a locked regression test forbids credential-wipe on unauthorized (`vizora-app.spec.ts:1174-1185`). Real token recovery is server-gated (backend Q#1), not a client fix.

**Hardware-gated by nature (fix may be writable now; acceptance is silicon-only → P0-3 sitting):**
- **F36** — write the `onRenderProcessGone` override now (no SAW → lands independently of the posture gate), PROVE recovery on hardware via new test **S-19d**. The §86-vs-F36 dispute (does the framework auto-restart after a renderer kill?) is itself an empirical silicon question.
- **F2** — crash-loop backoff + safe-mode is the P0-3 implementation slice, gated by **S-19c**; add clearing/skipping poison persisted state to the design (boot-survivability §4 bullet 2).

**Server-answerable (no code here):** the four backend open questions in §1.10 — they gate store submission.

---

## 6. Hardware-only verification protocols (cannot be proven on emulator)

1. **Boot auto-start (F1):** physical Android TV device (one API 28-era box, one API 31+ Google TV), paired to staging. Pull power, restore, assert app foreground within 3 min without touching the remote. Repeat ×5. Also test with "Display over other apps" granted vs not.
2. **Crash restart (F2):** `adb shell am crash com.vizora.display` (Java path) and a forced native crash; assert relaunch; then induce crash-on-start to observe loop behavior (currently expected: 3s tight loop).
3. **Play auto-update while foreground (F18):** internal-track update push to an always-foreground device; measure whether/when the update applies.
4. **Thermal/decode envelope:** 24h mixed 4K-asset loop on min-spec box; watch for decoder failures (feeds F17 watchdog design).
5. **Remote-control interference:** HOME/BACK/standby button presses; document recovery gaps (currently: HOME = dead screen until human).

---

## CHECKPOINT

*(Historical — 2026-07-02.)* No code had been changed at the time of this checkpoint. **As of 2026-07-07, P0-1 / P0-2 / P0-4 + the T2 delivery layer are merged; P0-3 remains open** — see the STATUS UPDATE at the top and the §5.1 disposition of the 2026-07-06 audit. Per the original ground rules, P0-1/P0-2/P0-3 all fell under approval-required categories.

---

## 7. Whole-tree seam review (2026-07-11) — F41–F56

Pre-external-handoff review of master `f422533` by three orthogonal lenses (integration seams / Android-native / security). Every prior hardening round was reviewed per-PR in isolation; these findings are all at the **seams between separately-merged features**. F41/F42/F43 self-verified against code by the lead. Branch: `review-fixes` (worktree). Fixing all 16; not merged.

### BLOCKERS (fix before handoff)

- **F41 — `tenantSuspended` latch never cleared on reconnect or 200 auth-check.** Set at `main.ts:1222`, cleared ONLY at `:1016` (tenant:resumed event) and `:1246` (purge). The connect handler (`:939`) and the 200-auth-check branch (`:1160`) both call `exitAuthDegraded()` but leave the latch true; `advance()` gates on it at `:1383`. A tenant suspended via the auth-probe 403 path (`:1170`, no `return` → falls through to reschedule) then resumed → next 200 → reconnect → **stuck on holding forever with valid cached content; whole-tenant blast on a suspend/resume cycle.** FIX: add `exitTenantSuspended()` helper (clear latch + resume playback if holding-for-suspension); call from the 200-auth-check branch and the successful-connect handler (successful handshake ⇒ tenant active); dedupe the tenant:resumed event through it. Regression test the reconnect + auth-check-200 recovery (existing test at `vizora-app.spec.ts:3218` covers only the event).
- **F42 — unguarded `tenant_id` keystore read reopens the F37 brick.** `main.ts:280` sits OUTSIDE the F37 bounded-retry guard (closes `:271`) and before the `last_playlist` try (`:287`). Per-value AEAD corruption of `tenant_id` alone (token/deviceId decrypt fine) throws out of `init()` → `recovering` → retry → same throw → **infinite RECOVERING**, the exact brick F37 killed, via the sibling read P0-2 added. FIX: make the tenant read non-fatal — wrap in try/catch, on failure log + `reportEvent` + degrade to grace mode (`tenantId = null`, which the load-time tenant check already supports) and continue booting cached content. **HARDENED (adversarial verification, 2026-07-11):** the naive grace-mode fix reopened F4 cross-tenant isolation — both the `last_playlist` purge guard (`:305`) and the cache-asset guard (`cache-manager.ts:60`) key on a nullable tenantId, so `tenantId=null` fails OPEN → a stale tenant-A cached playlist would render on a tenant-B device offline (wrong-content-on-glass). Final fix distinguishes null-because-legacy (render = grace) from null-because-read-FAILED (`tenantReadFailed` flag): a tenant-BOUND cache whose tenant is unverifiable now FAILS CLOSED — holds (never black) without rendering or destructively purging, and the online pull delivers authoritative content. Legacy no-tenant devices untouched.
- **F43 — `update_config` redirects the device JWT to any host, no allowlist.** `main.ts:1638` writes `apiUrl/realtimeUrl/dashboardUrl` to Preferences with zero validation → reload → `loadConfig` promotes them (`:344`). Attacker at the control-plane sets `apiUrl=evil.tld`; a follow-up `playlist:update` with media there is now "same-origin," so `utils.ts:106` appends `?token=<JWT>` → **JWT exfil + durable device hijack, defeating F24's same-origin mitigation.** FIX: validate each update_config URL — require https/wss AND host within the same registrable domain (last two labels) as the COMPILED-IN default (`DEFAULT_CONFIG`, anchored to `import.meta.env.VITE_*`, not the mutable runtime config); reject + `reportEvent('config_rejected')` on mismatch. Self-maintaining allowlist, no hardcoded domain list.

### HIGH (Android team flags first)

- **F44 — main-thread Keystore crypto in `SecureStoragePlugin.load()`, tripled by the F39 retry loop → startup ANR.** Capacitor calls `load()` on the main thread; F39's 3× no-backoff `EncryptedSharedPreferences.create` (Keystore RPC + disk I/O + AEAD self-test) can stall >5s on a wedged keystore — exactly the devices F39 targets. FIX: make init lazy — an idempotent, `synchronized` `ensureSecurePrefs()` invoked from each `@PluginMethod` handler (which run on the background HandlerThread), NOT from `load()`; add bounded backoff between retries now that it's off-main; fields `volatile` (folds in F53). F39 fail-closed semantics preserved (compute `secureStorageAvailable` lazily; `rejectIfUnavailable` unchanged).

### MEDIUM (fix-before-fleet)

- **F45 — host document has no CSP + QR fallback uses `innerHTML`.** `index.html` head has no CSP (the parent doc owns the Capacitor/SecureStorage bridge); `main.ts:675` injects `pairUrl` (contains server `code`) via `innerHTML`. FIX (as shipped): render the QR fallback with `textContent`, not `innerHTML` — the identified injection sink, closed. **Host-document CSP DEFERRED (adversarial verification, 2026-07-11):** a strict host `script-src 'self'` meta is inherited by the `srcdoc` template iframes (`utils.ts:66`), and CSP enforcement is the INTERSECTION of parent + child — so it would block the inline JS + web fonts that shipping `html`/`template` content relies on, regressing that content type to effectively-black. The parent-doc XSS class is already substantially closed by the `textContent` fix + F43 (origin can't be redirected). Revisit host-CSP only alongside a template-rendering change (real cross-origin iframe / blob URL instead of `srcdoc`, so templates don't inherit it), validated on-device. Deferral note left in `index.html`.
- **F46 — operator `unpair` dropped by the revocation-confirmation 5-min rate-limiter.** `unpair` routes through `confirmRevocation('unpair_command')` gated for ALL sources at `main.ts:1098`; unrelated revocation-signal noise within 5 min silently no-ops a deliberate operator unpair. FIX: exempt `unpair_command` from the confirmation rate limit.
- **F47 — reconnect / pull-on-connect / heartbeat-reconcile clobbers active temporary push.** `handleContentPush` leaves `currentPlaylist` intact; the T2 resume paths (`:956` ensurePlaying, `:954`/`:835` pull→updatePlaylist→advance) are unaware of `temporaryContent` → an emergency push is cut short by an unrelated transport event. FIX: guard connect-resume/ensurePlaying and the pull-apply path on `!this.temporaryContent` (or route pulled updates into `savedPlaylistState` while a push is active).
- **F48 — unbounded `UncaughtExceptionHandler` chain across renderer-recovery relaunches.** `MainActivity.java:38` sets a NEW `CrashRecoveryHandler` each `onCreate`, capturing the prior default as delegate; in-process renderer recovery grows the chain per relaunch → slow leak + ever-deeper crash-path recursion. FIX: register once (Application.onCreate) or guard against re-chaining on relaunch.
- **F49 — credential write uses `apply()` not `commit()`.** `SecureStoragePlugin.java:96` async-flushes; a crash/SIGKILL/renderer-recovery `finish()` in the pairing→first-render window loses the just-written JWT → silent revert to unpaired. FIX: `commit()` for the credential write (already off-main, blocking is fine). **Extended (verification, 2026-07-11):** `remove()` also switched `apply()`→`commit()` so a credential PURGE (revocation/unpair) is as durable as a write — a non-durable purge could otherwise leave a revoked token on disk across an immediate SIGKILL.

### NOTES (hygiene / defense-in-depth)

- **F50 — tenant-suspend fail-closed bypassed by `push_content`.** `advance()` enforces the suspend gate (`:1383`) but the temp-push path (`handleContentPush`/`renderTemporaryContent`) does not, and `canPlay()` returns true when `temporaryContent != null`. FIX: check `tenantSuspended` in the push path.
- **F51 — Sentry initialized with no `beforeSend`/`beforeBreadcrumb` scrubbing** (`crash-reporting.ts:25`). No live leak today (JWT never console-logged; asset GETs bypass Sentry's fetch wrapper), but `cache-manager.ts:171` can embed a `?token=` URL in a breadcrumb. FIX: `beforeBreadcrumb`/`beforeSend` strip `token` query params + `Authorization` before the external team wires a real DSN.
- **F52 — credential migration is non-atomic** (`main.ts:483`). Crash between SecureStorage write and plaintext removal → next boot's "already migrated" early-return never cleans up → plaintext JWT lingers. Mitigated by `allowBackup=false`. FIX: always attempt plaintext cleanup, or remove-plaintext-only-after-verified-secure-read.
- **F53 — `securePrefs`/`secureStorageAvailable` non-volatile** (written on main in load, read on HandlerThread). FIX: `volatile` (folded into F44).
- **F54 — `WAKE_LOCK` permission declared but unused** (`AndroidManifest.xml:8`; screen-on uses `keepScreenOn` window flag, no permission needed). FIX: drop it (Play permission-justification hygiene).
- **F55 — `BootReceiver` not `directBootAware` and lacks `QUICKBOOT_POWERON`** intent-filter. Largely moot on API 31+ (F1 BAL blocks the launch regardless) but a TV reviewer will mention it. FIX: add the OEM quick-boot action + HTC variant to the filter **AND** (verification, 2026-07-11) the receiver's `onReceive` action guard — registering the actions in the manifest without handling them in `onReceive` (which only checked `ACTION_BOOT_COMPLETED`) was a silent no-op. Now handles all three actions; F1 BAL still gates the foreground launch on modern boxes (helps pre-BAL devices).
- **F56 — native SecureStorage has no self-heal on keyset decrypt corruption.** `get()` catches `AEADBadTagException` and rejects with a GENERIC code (`SecureStoragePlugin.java:116`), never clearing/re-initializing the corrupt prefs. FIX: on decrypt corruption of an entry, clear it and reject with the GENERIC code (→ web F37 re-pair path, NOT F39). **CORRECTED (adversarial verification, 2026-07-11):** the first cut used `.clear()` (whole store), which — because F42 calls `get('tenant_id')` expecting a non-fatal failure — would wipe `device_token`/`device_id` on a single-key corruption and silently DE-PAIR the device on next boot, defeating F42. Final: `.remove(key).commit()` heals only the corrupt entry; `device_token`/`device_id` survive a single-key (e.g. `tenant_id`) corruption, so F42's grace-mode + hold-on-unverifiable works as designed.
