/**
 * Vizora TV Display Client
 *
 * One codebase, three TV families:
 * - Android TV — Capacitor native runtime (native HTTP, Filesystem cache,
 *   Keystore-backed SecureStorage, boot auto-start)
 * - Samsung Smart TV (Tizen) and LG Smart TV (webOS) — packaged web app; the
 *   Capacitor plugin calls below fall through to their web implementations
 *   (Preferences→localStorage, CapacitorHttp→fetch, Network→navigator.onLine,
 *   App→visibilitychange, SplashScreen→no-op) and src/platform.ts owns the
 *   genuinely platform-specific pieces (detection, keep-awake, remote keys).
 *
 * Features:
 * - D-pad / remote-control navigation support
 * - Hardware acceleration for video
 * - Auto-start on boot (Android; TV runtimes configure this per-platform)
 * - Persistent storage via Capacitor Preferences
 */

import { App } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { Preferences } from '@capacitor/preferences';
import { SplashScreen } from '@capacitor/splash-screen';
import { CapacitorHttp, HttpResponse } from '@capacitor/core';
import { io, Socket } from 'socket.io-client';
import { AndroidCacheManager } from './cache-manager';
import { TvCacheManager } from './tv-cache-manager';
import {
  detectPlatform,
  initTvPlatform,
  isNativeCapacitor,
  isTvBackKey,
  platformDeviceType,
  platformIdentifierPrefix,
} from './platform';
import { SecureStorage } from './secure-storage';
import { transformContentUrl, injectContentSecurityPolicy, computePlaylistSignature, shouldApplyContent, parseCrashLoopMarker, CRASH_LOOP_MARKER_KEY } from './utils';
import { ScreenStateMachine } from './screen-state';
import { initCrashReporting, setCrashReportingDevice, reportEvent, isCrashReportingEnabled } from './crash-reporting';

initCrashReporting();

declare const __APP_VERSION__: string;

/**
 * The DEFAULT backend origins this bundle was COMPILED with, as a JSON string,
 * stamped in at build time from release-origins.json (see vite.config.ts).
 *
 * These are the seeds for DEFAULT_CONFIG, not the effective runtime destination:
 * loadConfig() applies URL parameters and stored Preferences over them, and the
 * guarded update_config path can move a paired device to another host in the same
 * registrable domain. This value records what the BUILD was pointed at.
 *
 * Published as a global so the shipped artifact describes itself. Two consumers:
 *
 *  - The publish-side release gate unpacks the APK and reads this back out, so
 *    "which origins was this binary compiled with" is verified from the bytes we
 *    are about to hand customers rather than from the config we think we built
 *    with. Scanning the bundle for bare URLs cannot do that job: `api` and
 *    `dashboard` are both https://vizora.cloud today, so the strings alone cannot
 *    say which value landed in which slot.
 *  - Support: read `__VIZORA_RELEASE_ORIGINS__` off a device console to see what a
 *    screen's build shipped with — then compare against its live config, since the
 *    two can legitimately differ.
 *
 * A plain string rather than an object literal on purpose — it survives
 * minification as one quoted token the verifier can extract with a regex, instead
 * of an object whose keys a minifier is free to reshape.
 */
declare const __RELEASE_ORIGINS_JSON__: string;

// Assigned unconditionally at module scope: a side effect, so it is never
// tree-shaken out of the release bundle the gate has to read.
(globalThis as Record<string, unknown>).__VIZORA_RELEASE_ORIGINS__ =
  typeof __RELEASE_ORIGINS_JSON__ !== 'undefined' ? __RELEASE_ORIGINS_JSON__ : '';

/**
 * Whether this bundle was COMPILED with a crash-reporting DSN (see vite.config.ts).
 *
 * `VITE_SENTRY_DSN` is env-driven with a silent empty default, so a release built on
 * a machine without one ships with reportEvent() as a total no-op — and every safety
 * argument that rests on telemetry (command_dedupe_*, device_purge_incomplete,
 * crash_loop_capped, secure_storage_unavailable, …) is void with nothing anywhere
 * saying so. That is the same provenance failure release-origins.json exists to
 * prevent, on the one field it deliberately left out of scope.
 *
 * The build does NOT fail closed on it — a DSN is a credential and blocking a
 * release on one we may not have is worse than shipping without telemetry
 * KNOWINGLY. So the artifact describes itself instead, exactly like the origins
 * above, and the build warns loudly in release modes.
 *
 * Read back by:
 *  - the publish-side gate, which unpacks the APK / TV package and greps the bundle
 *    for `__VIZORA_SENTRY_CONFIGURED__` (terser keeps the property name; the value
 *    minifies to `!0` / `!1`), so "does this binary report crashes" is answered from
 *    the bytes we are about to hand customers rather than from build-machine state;
 *  - support, off a device console.
 */
declare const __RELEASE_SENTRY_CONFIGURED__: boolean;

(globalThis as Record<string, unknown>).__VIZORA_SENTRY_CONFIGURED__ =
  typeof __RELEASE_SENTRY_CONFIGURED__ !== 'undefined' ? __RELEASE_SENTRY_CONFIGURED__ : false;

// Configuration - can be overridden via URL params or stored preferences.
//
// FROZEN on purpose. This object is the ANCHOR isAllowedConfigUrl() measures every
// update_config candidate against, so it has to keep describing what the bundle was
// COMPILED with, not where the device has since been pointed. Freezing makes a
// regression that writes through to it fail loudly (module scope is strict mode, so
// the assignment throws) instead of silently widening the allowlist. Nothing writes
// here today — the runtime config is a COPY (see `private config` below).
const DEFAULT_CONFIG = Object.freeze({
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  realtimeUrl: import.meta.env.VITE_REALTIME_URL || 'http://localhost:3002',
  dashboardUrl: import.meta.env.VITE_DASHBOARD_URL || 'http://localhost:3001',
});

interface Config {
  apiUrl: string;
  realtimeUrl: string;
  dashboardUrl: string;
}

interface Playlist {
  id: string;
  name: string;
  items: PlaylistItem[];
  loopPlaylist?: boolean;
}

interface PlaylistItem {
  id: string;
  contentId: string;
  duration: number;
  order: number;
  content: {
    id: string;
    name: string;
    type: string;
    url: string;
    thumbnail?: string;
    mimeType?: string;
    duration?: number;
    updatedAt?: string; // PD-7: content-mutation discriminator for the playback signature
  } | null;
}

interface PushContent {
  id: string;
  name: string;
  type: string;
  url: string;
  thumbnailUrl?: string;
  mimeType?: string;
  duration?: number;
}

interface QrOverlayConfig {
  enabled: boolean;
  url: string;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  size?: number;
  margin?: number;
  backgroundColor?: string;
  opacity?: number;
  label?: string;
}

interface LayoutMetadata {
  gridTemplate?: { columns?: string; rows?: string };
  gap?: number;
  backgroundColor?: string;
  zones: LayoutZone[];
}

interface LayoutZone {
  id: string;
  gridArea: string;
  resolvedPlaylist?: Playlist;
  resolvedContent?: PlaylistItem['content'];
}

interface HeartbeatResponse {
  commands?: Array<{ type: string; payload?: Record<string, unknown>; [key: string]: unknown }>;
  revoked?: boolean;
  // T2: server sets this when the device's reported contentVersion has drifted from the
  // authoritative resolveEffectiveContent version → the device re-pulls (self-heal).
  reconcileContent?: boolean;
}

/**
 * Capabilities advertised to the realtime gateway in the Socket.IO handshake.
 *
 * `deliveryAck` is the switch that takes the server OFF its legacy delivery path.
 * Without it the gateway does a bare `socket.emit()` and reports back
 * `{ delivered: true, legacy: true }` — so a payload written into a half-open
 * socket (TCP dead, the server has not noticed yet, up to ~45s) is lost while the
 * operator's dashboard says it was delivered and writes an audit row saying so.
 *
 * For `command` that loss is permanent: commands are not re-derivable from DB state
 * the way content is. For `playlist:update` the server additionally DELETES the
 * pending-replay entry on the strength of that false receipt.
 *
 * Advertised ALWAYS — see handshakeAuth() for why "sometimes" is worse than never.
 */
const CLIENT_CAPABILITIES: readonly string[] = ['deliveryAck'];

/** The callback the server attaches to a delivery-guaranteed emit. May be absent. */
type DeliveryAck = ((response: { ok: boolean }) => void) | undefined;

interface PerformanceMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

class VizoraAndroidTV {
  private socket: Socket | null = null;
  private deviceId: string | null = null;
  private deviceToken: string | null = null;
  private pairingCode: string | null = null;
  private pairingCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private pairingExpiresAt: number = 0;
  private pairingCheckInterval: ReturnType<typeof setInterval> | null = null;
  /** Held across the pairing credential persist — see startPairingCheck. */
  private pairingCommitInFlight = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private offlineTimeout: ReturnType<typeof setTimeout> | null = null;
  // A COPY, never a reference: loadConfig() mutates this from URL params and stored
  // Preferences, and aliasing DEFAULT_CONFIG meant one stored off-domain origin
  // rewrote the compiled-in anchor isAllowedConfigUrl() reads — so a single poisoned
  // origin bootstrapped a wider allowlist for every later update_config.
  private config: Config = { ...DEFAULT_CONFIG };
  private startTime: number = Date.now();
  private currentContentId: string | null = null;
  private contentStartTime: number = 0;

  private currentPlaylist: Playlist | null = null;
  private currentIndex = 0;
  // T2 version-wins: the authoritative content version currently rendered, so pull and
  // push are reconciled by shouldApplyContent (a same-or-older re-delivery is a no-op).
  private currentContentVersion = '';
  private currentContentPlaylistId: string | null = null;
  private playbackTimer: ReturnType<typeof setTimeout> | null = null;
  private isOnline = true;
  // Filesystem-backed cache under Capacitor (native URIs via convertFileSrc);
  // IndexedDB blob cache on the TV web runtimes, where Filesystem URIs don't
  // resolve. Both honor the same tenant-binding + LRU contract.
  private cacheManager: AndroidCacheManager | TvCacheManager =
    isNativeCapacitor() ? new AndroidCacheManager() : new TvCacheManager();

  // Screen ownership state machine (P0-1) — the only screen-visibility authority
  private machine: ScreenStateMachine;
  // Playback engine state. `playbackGeneration` invalidates in-flight prepares
  // when the playlist changes; `advanceInFlight`/`pendingRestart` serialize the
  // advance loop so it can never run concurrently or recurse.
  private playbackGeneration = 0;
  private advanceInFlight = false;
  private pendingRestart = false;
  private currentItemCleanup: (() => void) | null = null;
  private holdingRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private playbackSource: 'live' | 'cached' | 'hold-last' = 'cached';
  private initRetryCount = 0;
  private capacitorSetupDone = false;

  // Trust / revocation state (P0-2 — docs/design/revocation-contract.md)
  private tenantId: string | null = null;
  private tenantSuspended = false;
  private authProbeTimer: ReturnType<typeof setTimeout> | null = null;
  private authProbeRetry = 0;
  private lastConfirmProbeAt = 0;
  private authDegradedSince = 0;

  // Temporary content push state
  private temporaryContent: PushContent | null = null;
  private temporaryContentTimer: ReturnType<typeof setTimeout> | null = null;
  private savedPlaylistState: { playlist: Playlist; index: number } | null = null;

  // Pairing retry state
  private pairingRetryCount = 0;

  // Delivery-ack duplicate suppression for `command` (see commandDedupeKey /
  // handleCommand). PERSISTED — the whole point is surviving a reload.
  private static readonly COMMAND_DEDUPE_PREF_KEY = 'seen_command_keys';
  /**
   * SECOND, SYNCHRONOUS home for the same ring, written before the Preferences copy.
   *
   * The Preferences write is the durable cross-webview-clear copy, but it is
   * asynchronous and goes through the Capacitor bridge, which leaves three ways for
   * a context-destroying command to be dispatched with NOTHING recorded: the 2s
   * persist bound elapsing, the write REJECTING (rememberCommand resolves normally
   * either way, so the caller cannot tell), and an unkeyable command. Any one of
   * them leaves the requeue → replay → reload loop with no terminator at all, and
   * nothing else bounds it — the native crash ladder counts Java uncaught
   * exceptions, and window.location.reload() is not a crash.
   *
   * localStorage closes all three: it is synchronous (so it lands before reload()
   * can tear the context down), needs no bridge (so a wedged bridge cannot stop it)
   * and survives window.location.reload(). Both sources are unioned on load.
   *
   * A distinct key, not COMMAND_DEDUPE_PREF_KEY: on the TV runtimes the Preferences
   * plugin ALSO lands in localStorage, under its own `CapacitorStorage.` prefix.
   * Sharing the bare name would work today and collide the moment that prefix
   * changes.
   */
  private static readonly COMMAND_DEDUPE_LOCAL_KEY = 'vizora_seen_command_keys';
  private static readonly COMMAND_DEDUPE_MAX = 20;
  /**
   * Ceiling on a dedupe key. `type` and `timestamp` both arrive from the server
   * unvalidated and the ring is JSON-stringified into two stores, so an oversized
   * key is a way to blow the storage quota — on the TV runtimes a
   * QuotaExceededError takes out every subsequent write identically, which disarms
   * the terminator above for every LATER command. Over the bound we return null,
   * which already means "execute, don't suppress".
   */
  private static readonly COMMAND_DEDUPE_KEY_MAX_LEN = 128;
  /**
   * Ceiling on the ring write that gates a context-destroying dispatch. A wedged
   * Capacitor bridge leaves Preferences.set pending forever — without a bound, the
   * operator's `reload` simply never runs while the server (and the dashboard) hold
   * an `{ ok: true }` receipt saying it did. Long enough that a healthy native
   * round-trip is never cut short; short enough that a wedge does not become a
   * silent no-op.
   */
  private static readonly COMMAND_DEDUPE_PERSIST_TIMEOUT_MS = 2000;
  /**
   * Ceiling on a Capacitor Preferences READ taken on the boot path. Same reasoning
   * as the write bound above, applied to the reads that gate init() — see
   * boundedPrefsGet().
   */
  private static readonly BRIDGE_READ_TIMEOUT_MS = 2000;
  /** Durable half of the tenant-suspension latch — see enterTenantSuspended(). */
  private static readonly TENANT_SUSPENDED_PREF_KEY = 'tenant_suspended';
  /**
   * The commands that tear down the JS context (window.location.reload). These are
   * the only ones a replay loop can be built from — a replayed `reboot` or
   * `clear_override` costs one wasted execution, a replayed `reload` costs the
   * device. Anything added here must be a command whose own dispatch can destroy
   * the ring's chance to be read back.
   */
  private static readonly CONTEXT_DESTROYING_COMMANDS = new Set(['reload', 'restart', 'clear_cache']);
  /**
   * Marker separating a SYNTHETIC dedupe record from a real `type@timestamp` one.
   *
   * A synthetic record is keyed on the command TYPE alone plus the local time it was
   * dispatched, because the wire gave us nothing else to key on. `~` cannot appear at
   * the start of a server timestamp we would ever produce (they are ISO strings or
   * epoch numbers), so the two families cannot be confused in a ring that holds both.
   */
  private static readonly COMMAND_UNKEYED_MARK = '@~unkeyed:';
  /**
   * How long a synthetic record suppresses an IDENTICAL unkeyable context-destroying
   * command. 60s, and the two bounds it sits between are both hard:
   *
   *  - LOWER bound — it must outlast one replay round, or it terminates nothing. The
   *    server's ack timeout is 10s and the requeue is delivered on the next connect;
   *    a reload plus reconnect is the ~3-5s the observed loop period is made of. 60s
   *    covers that with an order of magnitude to spare, including a slow TV boot.
   *  - UPPER bound — it must not eat a DELIBERATE re-issue. An operator who watches a
   *    reload not take and presses the button again does so in tens of seconds, but
   *    they are the kind of user who will try twice; a window measured in minutes
   *    would silently swallow the second press with `{ ok: true }` on the dashboard.
   *
   * The record only ever exists for a command that arrived with NO usable dedupe key.
   * A keyed command is matched EXACTLY and is unaffected by this window, and a
   * non-context-destroying command is never recorded at all — a replayed
   * `clear_override` costs one wasted execution, a replayed `reload` costs the device.
   *
   * CLOCK. The only time source that survives window.location.reload() is Date.now(),
   * so that is what is used, read once per delivery and used for both the scan and the
   * record. It can jump: TVs boot with a bogus RTC and correct it from NTP seconds
   * later. Both directions therefore fail towards EXECUTING, never towards
   * suppressing — a record stamped in the future (clock moved backwards) and a record
   * that appears ancient (clock moved forwards) are both simply not "recent", so the
   * command runs. A suppressed reload the operator wanted is recoverable by pressing
   * it again; a permanently suppressed one is a device that has stopped taking
   * commands, which is not.
   */
  private static readonly COMMAND_UNKEYED_WINDOW_MS = 60_000;
  private seenCommandKeys: string[] = [];

  /**
   * Bumped by purgeDeviceState(). Any asynchronous path that can WRITE credentials or
   * commit content has to revalidate it after every await, or it resurrects state on a
   * de-paired device. Same supersede primitive as `playbackGeneration`, one level up:
   * that one invalidates frames, this one invalidates the pairing itself.
   */
  private purgeGeneration = 0;

  /**
   * True when tenant_id could not be READ at boot (a per-value decrypt failure), as
   * opposed to a legacy device that never had one. Both leave `tenantId` null, but
   * they are not the same: a legacy null means "no binding, grace is correct", while
   * an unverifiable null means our own tenant identity is unknown and anything we
   * stamp with it is a downgrade. See updatePlaylist's last_playlist persist.
   */
  private tenantReadFailed = false;

  /** Serializes applyPulledContent — see the comment there. */
  private applyContentQueue: Promise<void> = Promise.resolve();

  private dpadHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor() {
    this.machine = new ScreenStateMachine(
      {
        // Usable credentials = token AND deviceId (init connects only with
        // both). A dangling token without an id must still be able to pair.
        canPair: () => !(this.deviceToken && this.deviceId),
        canPlay: () =>
          !!(this.currentPlaylist?.items?.length) || this.temporaryContent != null,
      },
      (rec) => {
        // Leaving PLAYING: heartbeat must stop claiming content is on glass.
        if (rec.from === 'playing' && rec.to !== 'playing') {
          this.currentContentId = null;
        }
        if (rec.from === 'holding' && this.holdingRetryTimer) {
          clearTimeout(this.holdingRetryTimer);
          this.holdingRetryTimer = null;
        }
      },
    );
    this.startInit();
  }

  /**
   * Init with retry — a transient failure at boot must never dead-end on an
   * error screen (F19). Backoff 5s -> 5min cap.
   */
  private startInit() {
    this.init().catch(err => {
      console.error('[Vizora] Initialization error, will retry:', err);
      this.machine.transition('recovering', 'init_failure');
      this.setHoldingMessage('Starting up — retrying…');
      const delay = Math.min(5000 * Math.pow(2, this.initRetryCount), 300000);
      this.initRetryCount = Math.min(this.initRetryCount + 1, 6);
      setTimeout(() => this.startInit(), delay);
    });
  }

  private async init() {
    console.log('[Vizora] Initializing Android TV display client...');

    // Load configuration
    await this.loadConfig();

    // Restore the command dedupe ring BEFORE anything can deliver a command. This
    // is the guard against the reload→replay→reload loop described on
    // loadSeenCommands(); loading it late would leave a window in which the very
    // replay it exists to absorb arrives against an empty ring.
    await this.loadSeenCommands();

    // Setup Capacitor plugins
    await this.setupCapacitor();

    // Report (once) that the native crash handler degraded this device to its slow retry
    // rung. Deliberately before the credential work: this is the one boot that got far
    // enough to tell anyone, and a later step failing must not swallow the report.
    await this.reportCrashLoopMarker();

    // Check for existing device token (from encrypted storage)
    await this.migrateCredentialsToSecureStorage();
    // Read credentials from encrypted storage. A REJECTION here (not a null
    // value) means securePrefs.getString() itself threw — a VALUE-level
    // decrypt failure reading an existing encrypted entry (per-value AEAD
    // validation failing against a corrupted keyset). Unguarded, that
    // rejection propagates into the startInit RECOVERING loop and retries
    // FOREVER, never reaching the pairing fallback (F37) — a permanent brick.
    // Route to pairing so an operator can recover the device.
    //   NOTE: the other keystore failure mode — create()/master-key
    //   invalidation at plugin load() — is NOT a reject. SecureStoragePlugin
    //   .load() catches it and falls back to an empty (plaintext) store, so
    //   get() returns {value:null} and the device already drops to pairing via
    //   the no-credentials path below. This catch specifically covers the
    //   value-level getString() throw. (See F39: the plaintext fallback is a
    //   separate silent security-downgrade concern.)
    // The bounded re-throw gives a transient blip a few retries via the
    // startInit backoff first; pairing is non-destructive — canPair() gates on
    // the in-memory creds (both null here) and stored credentials are untouched.
    const CRED_READ_MAX_RETRIES = 3;
    let storedToken: { value: string | null };
    let storedDeviceId: { value: string | null };
    try {
      storedToken = await SecureStorage.get({ key: 'device_token' });
      storedDeviceId = await SecureStorage.get({ key: 'device_id' });
    } catch (err) {
      const errCode = (err as { code?: string } | null)?.code;
      const errText = String((err as { message?: string } | null)?.message ?? err ?? '');
      if (errCode === 'SECURE_STORAGE_UNAVAILABLE' || errText.includes('SECURE_STORAGE_UNAVAILABLE')) {
        // F39: the keystore-backed store failed to initialize and the plugin fails
        // CLOSED (no plaintext fallback). The device can neither read nor store
        // credentials, so it cannot resume OR pair safely — surface a loud, visible
        // state + telemetry instead of a silent plaintext downgrade or a pairing
        // screen that would just fail on write. NOT retried here (the native side
        // already retried keystore init); recovery is device service / re-launch.
        console.error('[Vizora] Secure storage unavailable — failing closed (F39):', err);
        reportEvent('secure_storage_unavailable', {});
        await SplashScreen.hide();
        this.initRetryCount = 0;
        this.machine.transition('holding', 'secure_storage_unavailable');
        this.setHoldingMessage('Device error: secure storage unavailable. Please contact support.');
        return;
      }
      if (this.initRetryCount < CRED_READ_MAX_RETRIES) {
        throw err; // transient — let startInit retry init()
      }
      console.error('[Vizora] SecureStorage credential read failing persistently — routing to pairing (F37):', err);
      reportEvent('secure_storage_read_failed', { retries: this.initRetryCount });
      await SplashScreen.hide();
      this.initRetryCount = 0;
      this.startPairing();
      return;
    }

    this.deviceToken = storedToken.value;
    this.deviceId = storedDeviceId.value;
    setCrashReportingDevice(this.deviceId);

    if (this.deviceToken && this.deviceId) {
      console.log('[Vizora] Found existing device credentials, connecting...');

      // A per-value AEAD decrypt failure on tenant_id alone (token/deviceId read
      // fine) must NOT be fatal — an unguarded throw here re-opens the F37 brick
      // via the sibling read P0-2 added (infinite RECOVERING). Degrade to grace
      // mode (tenantId=null, which the load-time tenant check already supports)
      // and keep booting cached content (F42). But track WHY tenantId is null:
      // a READ FAILURE means our tenant is unverifiable, so a tenant-bound cache
      // must fail closed (F4) — distinct from a legacy device that never had a
      // tenant, where rendering is correct grace.
      try {
        const storedTenant = await SecureStorage.get({ key: 'tenant_id' });
        this.tenantId = storedTenant.value;
        this.tenantReadFailed = false;
      } catch (err) {
        console.warn('[Vizora] tenant_id read failed — booting in grace mode (F42):', err);
        reportEvent('tenant_read_failed', {});
        this.tenantId = null;
        this.tenantReadFailed = true;
      }
      const tenantReadFailed = this.tenantReadFailed;
      this.cacheManager.setExpectedTenant(this.tenantId);

      // Restore last playlist for offline resilience — tenant-bound (F4):
      // refuse to render a playlist issued under a different tenant, no
      // matter how it got here (re-pair, restored backup, cloned image).
      try {
        const lastPlaylist = await Preferences.get({ key: 'last_playlist' });
        if (lastPlaylist.value) {
          const parsed = JSON.parse(lastPlaylist.value);
          const envelope = parsed && typeof parsed === 'object' && 'playlist' in parsed
            ? (parsed as { tenantId?: string; playlist: unknown })
            : { tenantId: undefined, playlist: parsed }; // pre-envelope format: migration grace (§2)
          if (envelope.tenantId && this.tenantId && envelope.tenantId !== this.tenantId) {
            console.warn('[Vizora] Cached playlist belongs to a different tenant — purging (F4)');
            reportEvent('tenant_mismatch_purge', { cachedTenant: envelope.tenantId });
            // Independent removals, same treatment as purgeDeviceState. As a
            // sequential await chain a failing Preferences.remove skipped the cache
            // clear entirely, and either failure landed in the outer catch below —
            // which logs "Failed to restore last playlist", a message that says
            // nothing about a HALF-PURGED foreign tenant. The device correctly does
            // not render the foreign playlist either way; what was missing is the
            // operator ever learning the purge did not complete.
            const purge = await Promise.allSettled([
              Preferences.remove({ key: 'last_playlist' }),
              this.cacheManager.clearCache(),
            ]);
            const purgeFailures = purge.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
            if (purgeFailures.length > 0) {
              console.error('[Vizora] Tenant-mismatch purge incomplete:', purgeFailures.map(f => f.reason));
              reportEvent('tenant_mismatch_purge_incomplete', { failed: purgeFailures.length });
            }
          } else if (envelope.tenantId && tenantReadFailed) {
            // The cache is tenant-BOUND but our tenant is UNVERIFIABLE (read
            // failed) — fail closed (F4): do NOT render it. Leave currentPlaylist
            // unset so boot enters holding and connectToRealtime()'s pull delivers
            // authoritative content. Do NOT purge — the read failure may be
            // transient and the content may legitimately be ours; preserve it for
            // a future verified boot. Never-black (holds) AND never-wrong-tenant.
            console.warn('[Vizora] tenant unverifiable + tenant-bound cache — holding, not rendering (F4/F42)');
            reportEvent('tenant_unverifiable_hold', { cachedTenant: envelope.tenantId });
          } else {
            // Verified match OR legacy no-tenant-binding (envelope.tenantId absent) — grace.
            this.currentPlaylist = this.validatePlaylist(envelope.playlist);
            this.playbackSource = 'cached';
            console.log('[Vizora] Restored last playlist from storage');
          }
        }
      } catch (err) {
        console.warn('[Vizora] Failed to restore last playlist:', err);
      }

      // Re-enter suspension BEFORE any playback decision. The latch is durable
      // precisely so a power cycle cannot be used to resume a suspended tenant's
      // content: last_playlist is still on disk and would otherwise render straight
      // away. Only a 200 from auth/check clears it — on connect (see the `connect`
      // handler) or via the probe loop — so this is a hold, not a dead end.
      const suspendedLatch = await this.boundedPrefsGet(VizoraAndroidTV.TENANT_SUSPENDED_PREF_KEY);
      if (suspendedLatch !== 'timeout' && suspendedLatch.value === '1') {
        this.enterTenantSuspended('restored_latch');
      }

      // Start playback immediately from the restored playlist (don't wait for
      // the WebSocket — BUG #7). The loading screen stays up until the first
      // frame commits; the machine enters PLAYING at commit time, so there is
      // no window where the content screen shows an empty container.
      if (this.tenantSuspended) {
        // enterTenantSuspended already owns the screen (branded holding + message).
      } else if (this.currentPlaylist && this.currentPlaylist.items?.length > 0) {
        void this.advance();
      } else {
        this.machine.transition('holding', 'boot_no_cached_playlist');
        this.setHoldingMessage('Connecting…');
      }

      this.connectToRealtime();
    } else {
      console.log('[Vizora] No credentials found, starting pairing flow...');
      this.startPairing();
    }

    // Hide splash screen
    await SplashScreen.hide();
    this.initRetryCount = 0;
  }

  private async loadConfig() {
    // Try to load config from URL params first
    const urlParams = new URLSearchParams(window.location.search);

    const apiUrl = urlParams.get('api_url');
    const realtimeUrl = urlParams.get('realtime_url');
    const dashboardUrl = urlParams.get('dashboard_url');

    if (apiUrl) this.config.apiUrl = apiUrl;
    if (realtimeUrl) this.config.realtimeUrl = realtimeUrl;
    if (dashboardUrl) this.config.dashboardUrl = dashboardUrl;

    // Try to load from stored preferences
    const storedApiUrl = await Preferences.get({ key: 'config_api_url' });
    const storedRealtimeUrl = await Preferences.get({ key: 'config_realtime_url' });
    const storedDashboardUrl = await Preferences.get({ key: 'config_dashboard_url' });

    if (storedApiUrl.value && !apiUrl) this.config.apiUrl = storedApiUrl.value;
    if (storedRealtimeUrl.value && !realtimeUrl) this.config.realtimeUrl = storedRealtimeUrl.value;
    if (storedDashboardUrl.value && !dashboardUrl) this.config.dashboardUrl = storedDashboardUrl.value;

    console.log('[Vizora] Config loaded:', this.config);
  }

  /**
   * Allowlist gate for update_config URLs (F43). Anchored to the COMPILED-IN
   * DEFAULT_CONFIG (import.meta.env.VITE_* resolved at build), NEVER the mutable
   * runtime config, so a hostile config push cannot bootstrap a wider allowlist.
   * Accepts: an exact match to a compiled-in default origin (covers localhost/IP
   * dev + smoke, where the shipped scheme may be http), OR — for public hosts —
   * a candidate whose registrable domain matches one of the defaults', over
   * https (api/dashboard) or wss/https (realtime). A literal host (localhost/IP)
   * that is not an exact default-origin match is refused. This keeps the device
   * JWT from ever being redirected to an attacker origin (defeats F24 bypass).
   */
  private isAllowedConfigUrl(candidate: string, kind: 'api' | 'realtime' | 'dashboard'): boolean {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return false;
    }

    const defaultRaw: Record<'api' | 'realtime' | 'dashboard', string> = {
      api: DEFAULT_CONFIG.apiUrl,
      realtime: DEFAULT_CONFIG.realtimeUrl,
      dashboard: DEFAULT_CONFIG.dashboardUrl,
    };
    const defaultOrigins = new Set<string>();
    const defaultDomains = new Set<string>();
    for (const raw of Object.values(defaultRaw)) {
      try {
        const u = new URL(raw);
        defaultOrigins.add(u.origin);
        defaultDomains.add(VizoraAndroidTV.registrableDomain(u.hostname));
      } catch { /* skip a malformed default */ }
    }

    // Exact match to a compiled-in default origin is inherently trusted.
    if (defaultOrigins.has(url.origin)) return true;

    // Public-host path: enforce a safe scheme (no wss→ws / https→http downgrade).
    const schemeOk = kind === 'realtime'
      ? url.protocol === 'wss:' || url.protocol === 'https:'
      : url.protocol === 'https:';
    if (!schemeOk) return false;

    let defaultHost: string;
    try {
      defaultHost = new URL(defaultRaw[kind]).hostname;
    } catch {
      return false;
    }
    const isLiteral = (host: string) =>
      host === 'localhost' || host.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (isLiteral(defaultHost) || isLiteral(url.hostname)) {
      // A literal is involved but the origin didn't exactly match a default — refuse.
      return false;
    }
    return defaultDomains.has(VizoraAndroidTV.registrableDomain(url.hostname));
  }

  /** Coarse registrable-domain heuristic: the last two dot-labels, lowercased. */
  private static registrableDomain(hostname: string): string {
    return hostname.toLowerCase().split('.').slice(-2).join('.');
  }

  /**
   * `window.localStorage`, or null where it is absent or throws.
   *
   * Every access is guarded, not just the first: reading the PROPERTY throws on some
   * engines (disabled storage, privacy modes), and a store that hands out a handle
   * can still throw from getItem/setItem. This is the durable copy of the
   * command-replay terminator, so it must never be able to take a boot down with it.
   */
  private static localStore(): Storage | null {
    try {
      const store = (window as unknown as { localStorage?: Storage }).localStorage;
      return store ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Bound a Capacitor Preferences READ in wall-clock time.
   *
   * The dedupe-ring WRITE is bounded because a wedged bridge would otherwise swallow
   * the operator's command. The boot READS need the same treatment for a worse
   * reason: they run inside init(), before credentials, so a bridge that never
   * settles means init() never settles — which means it never REJECTS, which means
   * the startInit() retry loop never fires and the device sits on the splash screen
   * indefinitely with no error and no telemetry.
   *
   * Returns 'timeout' rather than throwing; every caller treats a missing value as
   * "carry on without it", which is what they already do for an absent key.
   */
  private async boundedPrefsGet(key: string): Promise<{ value: string | null } | 'timeout'> {
    const result = await Promise.race([
      Preferences.get({ key }),
      this.timeoutAfter(VizoraAndroidTV.BRIDGE_READ_TIMEOUT_MS),
    ]);
    if (result === 'timeout') {
      console.warn(
        `[Vizora] Preferences.get(${key}) did not settle in ${VizoraAndroidTV.BRIDGE_READ_TIMEOUT_MS}ms — continuing without it`,
      );
      reportEvent('preferences_read_timeout', { key });
    }
    return result;
  }

  private async setupCapacitor() {
    // Init retries must not double-register listeners (F19 retry path)
    if (this.capacitorSetupDone) return;

    // TV runtime bootstrap (Tizen/webOS keep-awake etc.) — no-op on Android,
    // best-effort everywhere: a missing TV API must never fail init.
    initTvPlatform();

    // Setup network status monitoring
    Network.addListener('networkStatusChange', (status) => {
      console.log('[Vizora] Network status changed:', status);
      this.isOnline = status.connected;

      if (status.connected && this.deviceToken && !this.socket?.connected) {
        console.log('[Vizora] Network restored, reconnecting...');
        this.connectToRealtime();
      }
    });

    // Check initial network status
    const status = await Network.getStatus();
    this.isOnline = status.connected;
    console.log('[Vizora] Initial network status:', status);

    // Handle app state changes
    App.addListener('appStateChange', ({ isActive }) => {
      console.log('[Vizora] App state changed, active:', isActive);
      if (isActive && this.deviceToken && !this.socket?.connected) {
        this.connectToRealtime();
      }
      if (!isActive && this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
        this.offlineTimeout = null;
      }
    });

    // Handle back button (Android TV)
    App.addListener('backButton', () => {
      // Don't exit the app on back button
      console.log('[Vizora] Back button pressed, ignoring...');
    });

    this.capacitorSetupDone = true;

    // Setup D-pad navigation
    this.setupDpadNavigation();
  }

  private setupDpadNavigation() {
    // Android TV D-pad key codes
    const KEY_UP = 'ArrowUp';
    const KEY_DOWN = 'ArrowDown';
    const KEY_LEFT = 'ArrowLeft';
    const KEY_RIGHT = 'ArrowRight';
    const KEY_ENTER = 'Enter';
    const KEY_BACK = 'Escape';

    // Remove previous handler if re-initialized
    if (this.dpadHandler) {
      document.removeEventListener('keydown', this.dpadHandler);
    }

    this.dpadHandler = (event: KeyboardEvent) => {
      // Samsung/LG remote "back" keys arrive as raw keyCodes (10009 / 461)
      // with firmware-dependent `key` values — swallow them so back never
      // exits the signage loop to the TV home screen.
      if (isTvBackKey(event)) {
        event.preventDefault();
        return;
      }

      const focusableElements = document.querySelectorAll('.focusable');
      const currentFocus = document.activeElement;

      switch (event.key) {
        case KEY_UP:
        case KEY_DOWN:
        case KEY_LEFT:
        case KEY_RIGHT:
          // Navigate between focusable elements
          this.handleDpadNavigation(event.key, focusableElements, currentFocus);
          event.preventDefault();
          break;

        case KEY_ENTER:
          // Activate current element
          if (currentFocus && currentFocus instanceof HTMLElement) {
            currentFocus.click();
          }
          event.preventDefault();
          break;

        case KEY_BACK:
          // Don't exit app
          event.preventDefault();
          break;
      }
    };

    document.addEventListener('keydown', this.dpadHandler);
  }

  // Linear D-pad navigation — treats all focusable elements as a flat list.
  // Sufficient for current single-column UI. If the UI gains grid layouts,
  // switch to spatial navigation (nearest element by bounding rect in direction).
  private handleDpadNavigation(
    direction: string,
    elements: NodeListOf<Element>,
    currentFocus: Element | null
  ) {
    if (elements.length === 0) return;

    const elementsArray = Array.from(elements);
    let currentIndex = currentFocus ? elementsArray.indexOf(currentFocus) : -1;

    switch (direction) {
      case 'ArrowUp':
      case 'ArrowLeft':
        currentIndex = currentIndex <= 0 ? elementsArray.length - 1 : currentIndex - 1;
        break;
      case 'ArrowDown':
      case 'ArrowRight':
        currentIndex = currentIndex >= elementsArray.length - 1 ? 0 : currentIndex + 1;
        break;
    }

    const nextElement = elementsArray[currentIndex];
    if (nextElement instanceof HTMLElement) {
      nextElement.focus();
    }
  }

  /**
   * Surface the native crash-loop degradation marker, then clear it.
   *
   * The Android uncaught-exception handler escalates restarts 3s -> 30s -> 5min and then caps
   * at one attempt per hour. Reaching that cap means the device has been crash-looping for
   * minutes and is now barely restarting — an automated degradation the operator would
   * otherwise never hear about, because the process that made the decision was dying and
   * could not report anything itself (CLAUDE.md 12b). It writes a marker instead; this reads
   * it on the next boot that works well enough to talk to the backend.
   *
   * Reported ONCE then removed: the marker describes a past episode, and re-reporting it on
   * every boot forever would turn a real signal into noise. Non-Android runtimes never have
   * it (nothing writes the key), so this is a single no-op read there.
   *
   * Never throws. Telemetry must not be able to break boot.
   */
  private async reportCrashLoopMarker() {
    try {
      const stored = await this.boundedPrefsGet(CRASH_LOOP_MARKER_KEY);
      if (stored === 'timeout') return;
      const marker = parseCrashLoopMarker(stored.value);
      if (!marker) {
        return;
      }
      console.warn(
        `[Vizora] Recovered from a native crash loop — ${VizoraAndroidTV.crashLoopDegradation(marker.reason)}:`,
        stored.value,
      );
      reportEvent('crash_loop_capped', {
        at: marker.at,
        crashes: marker.crashes,
        reason: marker.reason,
      });
      // Removed ONLY once it has actually been reported somewhere. reportEvent is a
      // total no-op in a build with no VITE_SENTRY_DSN, and this is a once-ever
      // breadcrumb: deleting it on the strength of a call that sent nothing destroys
      // the only record that the device crash-looped. Keeping it costs one repeated
      // console line per boot; the build-time warning and __VIZORA_SENTRY_CONFIGURED__
      // are what make the underlying "no telemetry" state visible.
      if (!isCrashReportingEnabled()) {
        console.warn('[Vizora] Keeping the crash-loop marker — crash reporting is disabled, so nothing was reported');
        return;
      }
      await Preferences.remove({ key: CRASH_LOOP_MARKER_KEY });
    } catch (err) {
      console.warn('[Vizora] Failed to read/clear the crash-loop marker:', err);
    }
  }

  /**
   * How the native side degraded this device, phrased to match the reason it wrote.
   *
   * The restart ladder is only ONE of the things the native handler caps. A
   * `renderer_recovery_storm` means the WebView renderer kept dying and kept being
   * recovered — no restart delay changed and the device never dropped to the slow
   * rung — so describing every marker as "degraded to the slow restart rung" tells
   * an operator something that did not happen.
   */
  private static crashLoopDegradation(reason: string | null): string {
    switch (reason) {
      case 'renderer_recovery_storm':
        return 'the WebView renderer was dying and being recovered repeatedly';
      case 'uncaught_exception':
        return 'the device had degraded to the slow restart rung';
      default:
        return `the native handler capped it (reason: ${reason ?? 'unrecorded'})`;
    }
  }

  // ==================== CREDENTIAL MIGRATION ====================

  /**
   * Migrate device credentials from plain Preferences to SecureStorage.
   * Runs once: if credentials exist in Preferences but not in SecureStorage,
   * copies them over and removes the plaintext versions.
   */
  private async migrateCredentialsToSecureStorage() {
    try {
      const secureToken = await SecureStorage.get({ key: 'device_token' });
      if (secureToken.value) {
        // F52: a prior crash between the secure write and the plaintext removal
        // can strand plaintext credentials forever. Idempotently clean up any
        // lingering plaintext keys on every boot, even when already migrated
        // (Preferences.remove is a no-op when the key is absent).
        await Preferences.remove({ key: 'device_token' });
        await Preferences.remove({ key: 'device_id' });
        return;
      }

      const plainToken = await Preferences.get({ key: 'device_token' });
      const plainDeviceId = await Preferences.get({ key: 'device_id' });

      if (plainToken.value) {
        console.log('[Vizora] Migrating credentials to secure storage...');
        // Per-key and INDEPENDENT. As one sequential chain, a SecureStorage.set
        // rejection on EITHER key skipped BOTH Preferences.remove calls — so a
        // device_id write failure stranded the plaintext device_token on disk,
        // defeating the exact thing this migration exists to accomplish.
        const results = await Promise.allSettled([
          this.migrateOneCredential('device_token', plainToken.value),
          ...(plainDeviceId.value
            ? [this.migrateOneCredential('device_id', plainDeviceId.value)]
            : []),
        ]);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failures.length > 0) {
          // Surface, never swallow: the plaintext copy of whatever failed is still
          // on disk, and the next boot retries it.
          console.error('[Vizora] Credential migration incomplete:', failures.map(f => f.reason));
          reportEvent('credential_migration_incomplete', { failed: failures.length });
        } else {
          console.log('[Vizora] Credential migration complete');
        }
      }
    } catch (error) {
      console.error('[Vizora] Credential migration failed:', error);
    }
  }

  /**
   * Migrate ONE credential. Ordering rule: the encrypted copy is written FIRST and
   * the plaintext copy is removed only after that write resolves — losing both
   * copies is worse than stranding one, and a stranded plaintext key is retried by
   * the idempotent cleanup at the top of the next boot. Each credential is its own
   * unit so one key's failure can never strand another key's plaintext.
   */
  private async migrateOneCredential(key: string, value: string): Promise<void> {
    await SecureStorage.set({ key, value });
    await Preferences.remove({ key });
  }

  // ==================== HTTP ====================

  /**
   * Bound an HTTP promise in wall-clock time. CapacitorHttp's native layer
   * honors connectTimeout/readTimeout, but its WEB implementation (the TV
   * runtimes) is a bare fetch that ignores both — a black-holed connection
   * would hang the awaiting flow forever. Pairing retries and the auth-probe
   * loop reschedule only after the promise settles, so an unbounded hang
   * permanently stalls them. The underlying fetch may keep running (no
   * AbortController on Chromium 53); only the app logic is unblocked.
   */
  private static httpWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  // ==================== PAIRING ====================

  private getPairingRetryDelay(): number {
    return Math.min(5000 * Math.pow(2, this.pairingRetryCount), 300000);
  }

  private async startPairing() {
    // Guarded: a credentialed device can never land on the pairing screen.
    if (!this.machine.transition('pairing', 'pairing_requested')) {
      return;
    }
    this.stopPairingCountdown();
    this.updateStatus('connecting', 'Requesting pairing code...');

    if (!this.isOnline) {
      // Stay on the pairing screen (deliberate branded surface) — no error screen.
      this.updateStatus('offline', 'No network connection — retrying…');
      const countdownEl = document.getElementById('pairing-countdown');
      if (countdownEl) countdownEl.textContent = 'Waiting for network…';
      const delay = this.getPairingRetryDelay();
      this.pairingRetryCount = Math.min(this.pairingRetryCount + 1, 6);
      console.log(`[Vizora] Pairing retry in ${delay}ms (attempt ${this.pairingRetryCount})`);
      setTimeout(() => this.startPairing(), delay);
      return;
    }

    // Reset retry count on fresh online attempt
    this.pairingRetryCount = 0;

    try {
      // Generate a unique device identifier
      const deviceInfo = await this.getDeviceInfo();
      const deviceIdentifier = `${platformIdentifierPrefix()}-${deviceInfo.screenWidth}x${deviceInfo.screenHeight}-${Date.now().toString(36)}`;

      console.log('[Vizora] Making pairing request to:', `${this.config.apiUrl}/api/v1/devices/pairing/request`);

      // Native HTTP on Android; fetch on the TV web runtimes
      const response: HttpResponse = await VizoraAndroidTV.httpWithTimeout(
        CapacitorHttp.post({
          url: `${this.config.apiUrl}/api/v1/devices/pairing/request`,
          headers: { 'Content-Type': 'application/json' },
          data: {
            deviceIdentifier,
            metadata: deviceInfo,
          },
          connectTimeout: 10000,
          readTimeout: 15000,
        }),
        30_000,
        'pairing request',
      );

      console.log('[Vizora] Pairing response status:', response.status);

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Failed to request pairing code: ${response.status}`);
      }

      // Unwrap response envelope: { success, data: { code, qrCode, ... } }
      const responseBody = response.data;
      const data = responseBody?.data ?? responseBody;

      if (typeof data?.code !== 'string' || !data.code) {
        throw new Error('Invalid pairing response: missing code');
      }
      if (data.deviceId != null && typeof data.deviceId !== 'string') {
        throw new Error('Invalid pairing response: invalid deviceId');
      }

      console.log('[Vizora] Pairing code received, length:', data.code.length);
      this.pairingCode = data.code;
      this.deviceId = data.deviceId;

      // Track expiry for countdown timer (default 5 minutes if not provided)
      const expiresInSeconds = data.expiresInSeconds || 300;
      this.pairingExpiresAt = Date.now() + expiresInSeconds * 1000;

      // Display the code with countdown
      this.displayPairingCode(data.code);
      this.startPairingCountdown();

      // Start polling for pairing completion BEFORE the QR render, and never after it.
      //
      // The QR is COSMETIC — an operator can always type the code that is already on
      // the glass — while the poll is the only functional path off this screen. Ordered
      // the other way, the functional path sat downstream of the decorative one behind
      // `await this.generateQRCode()`, which awaits a dynamic import('qrcode'). A
      // REJECTING import is handled (generateQRCode catches and renders a text
      // fallback), but an import that never SETTLES never returns, so the poll was
      // never armed at all. That is unrecoverable rather than merely degraded: the only
      // thing that replaces an expired code is the poll's own 404 branch, so the device
      // sits on a pairing screen showing a dead code until someone visits it.
      //
      // A timeout bound on the render would only shorten that stall; it leaves the
      // dependency in place. Ordering removes it. Safe in both directions: `pairingCode`
      // is assigned above, so the callback's `!this.pairingCode` guard cannot fire, and
      // startPairingCheck() clears any existing interval first, so arming earlier cannot
      // double-arm on a re-request.
      this.startPairingCheck();
      this.updateStatus('connecting', 'Waiting for pairing...');

      // Generate/display QR code — decorative, and deliberately last.
      if (data.qrCode) {
        this.displayQRCode(data.qrCode);
      } else {
        await this.generateQRCode(data.code);
      }
    } catch (error) {
      console.error('[Vizora] Pairing request failed:', error);
      // Stay on the pairing screen — status line reports the retry.
      this.updateStatus('offline', 'Pairing request failed — retrying…');
      const countdownEl = document.getElementById('pairing-countdown');
      if (countdownEl) countdownEl.textContent = 'Retrying…';
      const delay = this.getPairingRetryDelay();
      this.pairingRetryCount = Math.min(this.pairingRetryCount + 1, 6);
      console.log(`[Vizora] Pairing retry in ${delay}ms (attempt ${this.pairingRetryCount})`);
      setTimeout(() => this.startPairing(), delay);
    }
  }

  private displayPairingCode(code: string) {
    const codeElement = document.getElementById('pairing-code');
    if (codeElement) {
      codeElement.textContent = code;
    }
  }

  private startPairingCountdown() {
    if (this.pairingCountdownInterval) {
      clearInterval(this.pairingCountdownInterval);
    }

    const countdownEl = document.getElementById('pairing-countdown');
    if (!countdownEl) return;

    const updateCountdown = () => {
      const remaining = Math.max(0, this.pairingExpiresAt - Date.now());
      const seconds = Math.ceil(remaining / 1000);
      const min = Math.floor(seconds / 60);
      const sec = seconds % 60;
      countdownEl.textContent = `Code expires in ${min}:${sec.toString().padStart(2, '0')}`;

      if (remaining <= 0) {
        countdownEl.textContent = 'Code expired — requesting new code...';
        this.stopPairingCountdown();
      }
    };

    updateCountdown();
    this.pairingCountdownInterval = setInterval(updateCountdown, 1000);
  }

  private stopPairingCountdown() {
    if (this.pairingCountdownInterval) {
      clearInterval(this.pairingCountdownInterval);
      this.pairingCountdownInterval = null;
    }
  }

  private displayQRCode(qrDataUrl: string) {
    const container = document.getElementById('qr-code');
    if (container) {
      const img = document.createElement('img');
      img.src = qrDataUrl;
      img.alt = 'QR Code';
      container.innerHTML = '';
      container.appendChild(img);
    }
  }

  private async generateQRCode(code: string) {
    const container = document.getElementById('qr-code');
    if (!container) return;

    const pairUrl = `${this.config.dashboardUrl}/pair?code=${code}`;

    try {
      const QRCode = await import('qrcode');
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, pairUrl, {
        width: 200,
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' },
      });
      container.innerHTML = '';
      container.appendChild(canvas);
    } catch (error) {
      console.error('[Vizora] Failed to generate QR code:', error);
      // Render as text, never interpolated HTML — pairUrl carries a server-issued
      // code and must not be injected as markup (F45).
      container.innerHTML = '';
      const fallback = document.createElement('div');
      fallback.style.cssText = 'color: #888; font-size: 0.8rem; padding: 2rem; word-break: break-all;';
      fallback.textContent = `QR unavailable — ${pairUrl}`;
      container.appendChild(fallback);
    }
  }

  private startPairingCheck() {
    if (this.pairingCheckInterval) {
      clearInterval(this.pairingCheckInterval);
    }

    this.pairingCheckInterval = setInterval(async () => {
      if (!this.pairingCode || !this.isOnline) return;

      try {
        // Native HTTP on Android; fetch on the TV web runtimes
        const response: HttpResponse = await VizoraAndroidTV.httpWithTimeout(
          CapacitorHttp.get({
            url: `${this.config.apiUrl}/api/v1/devices/pairing/status/${this.pairingCode}`,
            connectTimeout: 10000,
            readTimeout: 10000,
          }),
          15_000,
          'pairing status poll',
        );

        if (response.status < 200 || response.status >= 300) {
          if (response.status === 404) {
            console.log('[Vizora] Pairing code expired, requesting new one...');
            this.startPairing();
            return;
          }
          throw new Error('Failed to check pairing status');
        }

        // Unwrap response envelope: { success, data: { status, deviceToken, ... } }
        const responseBody = response.data;
        const data = responseBody?.data ?? responseBody;

        // Overlapping poll continuations can resume after pairing already
        // succeeded (async interval callbacks are not serialized) — only the
        // first wins, otherwise the success path runs twice and churns the
        // socket connection. `pairingCode` alone stopped covering this once the
        // credential persist moved AHEAD of clearing it (persist-then-commit): the
        // success path now awaits three keystore writes before `pairingCode` goes
        // null, and a second poll could enter that window. The latch closes it
        // without re-introducing the brick — it is released on failure, so the next
        // poll still retries.
        if (!this.pairingCode || this.pairingCommitInFlight) return;

        if (data.status === 'paired' && typeof data.deviceToken === 'string' && data.deviceToken) {
          console.log('[Vizora] Device paired successfully!');

          const deviceId = typeof data.deviceId === 'string' ? data.deviceId : this.deviceId;
          // Tenant identity binds the cache/playlist (contract §2). Absent on
          // the legacy backend — the load-time check degrades to grace mode.
          const tenantId = typeof data.tenantId === 'string' && data.tenantId ? data.tenantId : null;

          // PERSIST FIRST, COMMIT SECOND — the rule handleTokenRefresh documents and
          // follows. Committing in memory first meant a keystore failure left the
          // poller stopped, a now-dead pairing code on the glass, connectToRealtime()
          // skipped and the token never written: bricked until a human power-cycles
          // the screen. All THREE writes gate the commit — persisting the token but
          // not tenant_id would silently boot the device in grace mode forever after,
          // downgrading cross-tenant cache isolation.
          this.pairingCommitInFlight = true;
          try {
            await SecureStorage.set({ key: 'device_token', value: data.deviceToken });
            await SecureStorage.set({ key: 'device_id', value: deviceId || '' });
            if (tenantId) {
              await SecureStorage.set({ key: 'tenant_id', value: tenantId });
            }
          } catch (error) {
            // Fail RECOVERABLE: nothing is committed and the poller is untouched, so
            // the very next poll retries this same still-valid code, and if it does
            // expire the 404 branch requests a fresh one. The device stays pairable.
            console.error('[Vizora] Failed to persist pairing credentials — will retry on the next poll:', error);
            reportEvent('pairing_persist_failed', {});
            return;
          } finally {
            this.pairingCommitInFlight = false;
          }

          this.pairingCode = null;
          this.stopPairingCheck();
          this.stopPairingCountdown();
          this.pairingRetryCount = 0;

          this.deviceToken = data.deviceToken;
          this.deviceId = deviceId;
          if (tenantId) {
            this.tenantId = tenantId;
          }
          // A fresh pairing establishes tenant identity from the wire, so whatever
          // the boot-time keystore read did is no longer what we know.
          this.tenantReadFailed = false;
          this.cacheManager.setExpectedTenant(this.tenantId);
          setCrashReportingDevice(this.deviceId);

          this.connectToRealtime();
        }
      } catch (error) {
        console.error('[Vizora] Pairing check error:', error);
      }
    }, 2000);
  }

  private stopPairingCheck() {
    if (this.pairingCheckInterval) {
      clearInterval(this.pairingCheckInterval);
      this.pairingCheckInterval = null;
    }
  }

  // ==================== HEARTBEAT ====================

  private startHeartbeat() {
    if (this.heartbeatInterval) {
      return;
    }

    console.log('[Vizora] Starting heartbeat (every 15s)');

    // Send first heartbeat immediately
    this.sendHeartbeat();

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, 15000);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      console.log('[Vizora] Stopping heartbeat');
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat() {
    if (!this.socket || !this.socket.connected) {
      return;
    }

    try {
      const uptimeSeconds = Math.floor((Date.now() - this.startTime) / 1000);

      // Use browser performance API for memory if available, otherwise defaults
      let memoryUsage = 50; // reasonable default
      const perfMemory = (performance as unknown as { memory?: PerformanceMemory }).memory;
      if (perfMemory && perfMemory.jsHeapSizeLimit) {
        memoryUsage = Math.round((perfMemory.usedJSHeapSize / perfMemory.jsHeapSizeLimit) * 100 * 100) / 100;
      }

      const heartbeatData = {
        uptime: uptimeSeconds,
        appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0',
        // T2 heartbeat-reconcile: report the content version currently rendered so the
        // server can compare against resolveEffectiveContent and, on drift, tell this
        // device to re-pull — the self-heal for a connected-but-flaky device that never
        // dropped its socket (Finding-2 residual 1). Server side wires the compare.
        contentVersion: this.currentContentVersion,
        metrics: {
          cpuUsage: 0, // not available in browser/WebView context
          memoryUsage,
        },
        // Screen truth for the backend: which state owns the glass and where
        // the playing content came from. currentContent is cleared whenever
        // the machine leaves PLAYING, so a dark engine can no longer report
        // stale "now playing" data (F13 partial; full enrichment is P1-1).
        screenState: this.machine.state,
        playbackSource: this.playbackSource,
        currentContent: this.currentContentId
          ? { contentId: this.currentContentId }
          : undefined,
      };

      this.socket.emit('heartbeat', heartbeatData, (response: HeartbeatResponse) => {
        // An ERROR ack (createErrorResponse: { success:false, error, timestamp } — no
        // `data`) used to fall through the unwrap below to the top level, where every
        // field it reads is undefined. The result was indistinguishable from a clean
        // beat: a rate-limited or failed heartbeat produced no signal at all, so a
        // device could beat into a wall indefinitely with nobody the wiser. Surface it.
        //
        // Deliberately no retry and no backoff here — the 15s cadence is unchanged and
        // the next beat is the retry. The defect being fixed is the SILENCE.
        const failed = response as unknown as { success?: unknown; error?: unknown } | undefined;
        if (failed?.success === false) {
          console.warn('[Vizora] Heartbeat rejected by server:', failed.error);
          reportEvent('heartbeat_ack_error', { error: String(failed.error ?? 'unspecified') });
          return; // a failure envelope carries no data to act on
        }
        // The server wraps the ack payload in `.data` (createSuccessResponse), so read
        // from there; fall back to the top level so this is robust either way (a legacy
        // unwrapped ack still works). Read revoked/commands/reconcileContent all from the
        // SAME unwrapped envelope — reading revoked/commands from the raw top level
        // silently dropped ack-piggybacked commands whenever the server wrapped them
        // (audit 2026-07-06, backend Q#3).
        const ack = ((response as unknown as { data?: HeartbeatResponse })?.data ?? response) as
          | HeartbeatResponse
          | undefined;
        if (ack && ack.revoked) {
          void this.confirmRevocation('heartbeat_ack');
        }
        if (ack && ack.commands) {
          // Same rejection handling as the `command` socket handler. Bare, this was a
          // floating promise: handleCommand is async and can reject (a throwing
          // update_config persist, a push that blows up), and the two delivery doors
          // must not differ on what happens then — one surfaced it, the other made it
          // an unhandled rejection with no telemetry.
          ack.commands.forEach((cmd) => {
            void this.handleCommand(cmd).catch((error) => {
              console.error('[Vizora] Command handler failed:', error);
              reportEvent('command_handler_failed', { type: (cmd as { type?: unknown })?.type ?? null });
            });
          });
        }
        // T2 heartbeat-reconcile: the server saw our contentVersion drift from the
        // authoritative version → re-pull (self-heal without a disconnect). Fails safe.
        if (ack && ack.reconcileContent) {
          void this.pullContent();
        }
      });
    } catch (error) {
      console.error('[Vizora] Error sending heartbeat:', error);
    }
  }

  /**
   * T2 pull: fetch the device's AUTHORITATIVE effective content (the same resolver
   * realtime pushes) and apply it via version-wins. Called on connect, on a heartbeat
   * reconcile signal (the server detected the rendered version drifted from truth — the
   * connected-but-flaky-never-drops self-heal), and it is the backstop the whole
   * delivery model rests on. FAILS SAFE: on any error the device keeps playing
   * last-known-good — it NEVER blanks (never-black on the reconcile path).
   */
  /**
   * Persist a server-rotated device token and adopt it for future connects.
   *
   * Order matters: SecureStorage first, in-memory second. If the write throws we
   * keep the OLD token in memory, so a storage failure leaves a device that still
   * works on its current credential rather than one holding a token it cannot
   * survive a reboot with.
   *
   * `socket.auth` is updated in place so the next reconnect presents the new token
   * without tearing down the working socket — Socket.IO re-reads auth on each
   * reconnection attempt.
   */
  private async handleTokenRefresh(payload: unknown): Promise<void> {
    const token = (payload as { token?: unknown } | null | undefined)?.token;
    if (typeof token !== 'string' || token.length === 0) {
      console.warn('[Vizora] Ignoring malformed token:refresh payload — keeping current credential');
      return;
    }
    if (token === this.deviceToken) return; // idempotent re-delivery

    // Snapshot BEFORE the keystore write — see the re-check below.
    const gen = this.purgeGeneration;

    try {
      await SecureStorage.set({ key: 'device_token', value: token });
    } catch (error) {
      // Keep the old token: it is still valid for now, and re-issue is retried on
      // the next connect. Adopting a token we failed to persist would lose it.
      console.error('[Vizora] Failed to persist rotated device token — keeping current credential:', error);
      return;
    }

    // A purge that landed during that write has already run its own
    // SecureStorage.remove, so OUR write is the one left on disk: the de-paired
    // device would come back up holding a live credential. In memory it is worse —
    // the assignment below resurrects `deviceToken` on a device sitting on the
    // pairing screen, and the network / appState listeners then call
    // connectToRealtime() with it. Same supersede primitive purgeDeviceState uses
    // for playback; this one guards the pairing itself.
    if (gen !== this.purgeGeneration) {
      console.warn('[Vizora] Device was purged during a token rotation — discarding the rotated token');
      reportEvent('token_refresh_discarded_after_purge', {});
      await SecureStorage.remove({ key: 'device_token' }).catch((err) => {
        console.error('[Vizora] Could not remove a token written across a purge:', err);
        reportEvent('token_refresh_purge_cleanup_failed', {});
      });
      return;
    }

    this.deviceToken = token;
    if (this.socket) {
      // MERGE, never replace. A wholesale `= { token }` silently drops
      // `capabilities`, so the device would revert to the server's legacy delivery
      // path on its next reconnect — with no signal anywhere that it had — and a
      // command lost on a half-open socket would be gone permanently while the
      // dashboard reported it delivered. The spread keeps anything else Socket.IO
      // or a future field put there; handshakeAuth() re-asserts what must be true.
      (this.socket.auth as Record<string, unknown>) = {
        ...(this.socket.auth as Record<string, unknown> | undefined),
        ...VizoraAndroidTV.handshakeAuth(token),
      };
    }
    console.log('[Vizora] Device token rotated by server and persisted');
    reportEvent('device_token_rotated', { hasSocket: Boolean(this.socket) });
  }

  private async pullContent(): Promise<void> {
    if (!this.deviceToken || !this.isOnline) return;
    // The pairing this content is being fetched FOR. A de-pair cannot reach into an
    // in-flight request (the bound is 20s), so without this the response of the OLD
    // pairing lands on a purged device and is applied as if it were current.
    const gen = this.purgeGeneration;
    try {
      const response: HttpResponse = await VizoraAndroidTV.httpWithTimeout(
        CapacitorHttp.get({
          url: `${this.config.apiUrl}/api/v1/devices/me/content`,
          headers: { Authorization: `Bearer ${this.deviceToken}` },
          connectTimeout: 10000,
          readTimeout: 10000,
        }),
        20_000,
        'content pull',
      );
      if (response.status < 200 || response.status >= 300) {
        console.warn(`[Vizora] pullContent non-2xx (${response.status}) — keeping last-known-good`);
        return; // fail safe
      }
      const body = response.data;
      const payload = body?.data ?? body; // unwrap { success, data } envelope
      await this.applyPulledContent(payload, gen);
    } catch (error) {
      // Fail safe: a reconcile/pull failure NEVER blanks the screen — keep last-known-good.
      console.warn('[Vizora] pullContent failed — keeping last-known-good:', error);
    }
  }

  /**
   * Apply an effective-content payload (pull, or a versioned push) via version-wins
   * (shouldApplyContent). A same-or-older re-delivery of the same playlist is a NO-OP
   * (no re-flash, no duplicate content:impression — the PD-1/PD-7 close, now honored on
   * the CLIENT so the whole coherence model is closed end-to-end). A different playlist
   * (schedule boundary / reassignment) or a newer version applies.
   */
  private applyPulledContent(
    payload: { version?: string; playlist?: Playlist | null } | null | undefined,
    gen: number,
  ): Promise<void> {
    // SERIALIZED. There are four entry points into this one critical section —
    // pull-on-connect, the heartbeat reconcile pull, a versioned playlist:update and
    // the T2 pull itself — and overlap is guaranteed by construction rather than
    // merely possible: pullContent's bound is 20s while the heartbeat cadence is 15s,
    // so two pulls can be in flight before the first can time out. Interleaved, the
    // read of `current`, the await inside updatePlaylist and the version commit are
    // three separate steps on shared state, and the LAST commit to land wins — which
    // is not the newest version. The device then reports a version it is not
    // rendering, the server sees agreement and the reconcile self-heal never fires.
    //
    // `gen` is the purge generation of the pairing this payload BELONGS TO, and every
    // caller captures it where the payload was asked for or delivered — NOT here and
    // not inside the critical section, both of which run arbitrarily late. A de-pair
    // cannot reach into an in-flight pull (a 20s bound) or empty a queue that already
    // holds a push, so a payload of the OLD pairing can enter this section entirely
    // after the purge; a generation read at that point agrees with itself and commits
    // the purged tenant's content onto a device sitting on the pairing screen — which
    // pairing -> playing does NOT refuse, because canPlay() only asks whether a
    // playlist has items.
    const next = this.applyContentQueue.then(() => this.applyContentExclusive(payload, gen));
    // The queue must never hold a rejection, or every later apply short-circuits.
    this.applyContentQueue = next.catch(() => {});
    return next;
  }

  private async applyContentExclusive(
    payload: { version?: string; playlist?: Playlist | null } | null | undefined,
    gen: number,
  ): Promise<void> {
    if (!payload) return;
    if (gen !== this.purgeGeneration) {
      // De-paired between this payload arriving and the queue reaching it.
      console.warn('[Vizora] Content arrived for a pairing that has been purged — discarding it');
      reportEvent('content_discarded_after_purge', { playlistId: payload.playlist?.id ?? null });
      return;
    }
    const incoming = { playlistId: payload.playlist?.id ?? null, version: payload.version ?? '' };
    const current = { playlistId: this.currentContentPlaylistId, version: this.currentContentVersion };
    if (!shouldApplyContent(incoming, current)) return; // stale/duplicate → no-op, no re-flash
    if (payload.playlist) {
      try {
        await this.updatePlaylist(payload.playlist);
      } catch (error) {
        // validatePlaylist only checks that `items` is an array, so a malformed item
        // (e.g. a null entry) makes computePlaylistSignature throw inside updatePlaylist.
        // The version is committed AFTER the apply for exactly this case: committing
        // first left the device REPORTING a contentVersion it was not rendering, and
        // the server's heartbeat-reconcile then saw agreement and never self-healed —
        // permanent silent drift. Fail safe: keep last-known-good AND keep the old
        // version, so the next reconcile still sees the drift and re-delivers.
        console.warn('[Vizora] Failed to apply content — keeping last-known-good:', error);
        reportEvent('content_apply_failed', { playlistId: incoming.playlistId });
        return;
      }

      // updatePlaylist awaits a Preferences write, so the world can have moved on.
      // Re-validate before committing — the version is what the server reconciles
      // against, and a wrong one here is silent, permanent drift.
      if (gen !== this.purgeGeneration) {
        // De-paired mid-apply. purgeDeviceState reset these coordinates on purpose
        // (a re-pair to the same playlist yields the identical version); writing
        // them back would re-create the hold-forever state it just cleared.
        console.warn('[Vizora] Device was purged while applying content — not committing the version');
        return;
      }
      // DEFENCE IN DEPTH, and deliberately not independently testable: while the
      // queue above holds, this is the only writer of these two fields apart from
      // purgeDeviceState (guarded just above), so nothing can currently make it fire
      // — a mutation that removes it does not turn any test red. It is kept because
      // it is the check that stays correct if a future caller ever reaches
      // applyContentExclusive without going through the queue; rolling the version
      // back to ours would make the device under-report and re-apply stale content.
      if (!shouldApplyContent(incoming, {
        playlistId: this.currentContentPlaylistId,
        version: this.currentContentVersion,
      })) {
        return;
      }
    }
    this.currentContentVersion = incoming.version;
    this.currentContentPlaylistId = incoming.playlistId;
  }

  // ==================== REALTIME CONNECTION ====================

  /**
   * The Socket.IO handshake `auth` payload — the ONE place it is constructed, so a
   * connect and a token rotation cannot drift apart on what this device claims to
   * support.
   *
   * `capabilities` is read by the gateway off the handshake. Advertise it ALWAYS or
   * never, never conditionally between reconnects: a device that goes legacy for a
   * single reconnect has a window in which a command pushed into a half-open socket
   * is lost permanently while the dashboard reports it delivered — and nothing on
   * either side records that the window existed. The array form is used because the
   * server accepts either an array containing the string or an object with
   * `deliveryAck === true`, and the array is the one it treats as canonical.
   */
  private static handshakeAuth(token: string | null): Record<string, unknown> {
    // Fresh array per call: the handshake object is handed to a third-party client
    // that may hold it, and a shared module-level array is a mutation hazard.
    return { token, capabilities: [...CLIENT_CAPABILITIES] };
  }

  private connectToRealtime() {
    if (!this.deviceToken) {
      console.error('[Vizora] No device token available');
      this.startPairing();
      return;
    }

    if (!this.isOnline) {
      console.log('[Vizora] Offline, will retry when network is available');
      this.updateStatus('offline', 'No network connection');
      // Start playback from restored playlist if available
      if (this.currentPlaylist && this.currentPlaylist.items?.length > 0) {
        console.log('[Vizora] Starting offline playback from restored playlist');
        this.ensurePlaying();
      }
      return;
    }

    this.updateStatus('connecting', 'Connecting to server...');

    // Close existing socket if any
    if (this.socket) {
      this.stopHeartbeat();
      if (this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
        this.offlineTimeout = null;
      }
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }

    this.socket = io(this.config.realtimeUrl, {
      auth: VizoraAndroidTV.handshakeAuth(this.deviceToken),
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 60000,
      randomizationFactor: 0.5,
    });

    // Server-initiated credential rotation. The gateway re-issues a 90-day token
    // when a device connects within 14 days of expiry and pushes it here; the
    // stored hash is rotated at the same moment, so a device that ignores this
    // event is holding a credential the server has already replaced.
    //
    // Until now nothing listened. The refresh was built for the Electron client
    // and the TV was never wired up, which strands a screen two ways:
    //   - the socket survives on a short-lived Redis grace record, but auth/check
    //     compares against the CURRENT hash and answers 410 DEVICE_REVOKED, so a
    //     single transient connect_error makes the device wipe its own credentials
    //     and put a pairing code on customer glass
    //   - once the old token hard-expires the handshake returns AUTH_EXPIRED, which
    //     is fail-open by contract, so the device retries forever showing
    //     "Connection failed" over a stale cached playlist
    //
    // Not hypothetical: 14 of 24 production devices are already past the 90-day
    // expiry, across five organisations.
    //
    // Deliberately conservative — a bad payload must never clear a WORKING
    // credential. Anything non-string or empty is ignored and the current token
    // keeps running; a refresh we cannot use is strictly better than none.
    this.socket.on('token:refresh', (payload: unknown) => {
      void this.handleTokenRefresh(payload);
    });

    this.socket.on('connect', () => {
      console.log('[Vizora] Connected to realtime gateway');
      this.updateStatus('online', 'Connected');
      if (this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
        this.offlineTimeout = null;
      }
      this.hideOfflineOverlay();
      this.exitAuthDegraded();
      this.startHeartbeat();

      // T2 pull-on-connect: fetch the authoritative effective content on every
      // (re)connect and apply it via version-wins. This makes delivery resilient to any
      // single push's fate (closes Finding-2's reconnect strand + C-7 on the pull side);
      // push remains the low-latency fast-path. Fails safe — keeps last-known-good.
      void this.pullContent();

      // A successful handshake does NOT mean the tenant is active. Verified against
      // the deployed gateway (d323434e): its handshake checks token revocation,
      // device existence, org match, isDisabled and token currency — there is no
      // tenant-suspension check anywhere in it; the only suspension code there is the
      // outbound `tenant:suspended` emitter. TENANT_SUSPENDED comes solely from the
      // REST auth/check. So clearing the latch here fails OPEN on every reconnect,
      // and a 24/7 screen reconnects: a suspended tenant's content silently resumes,
      // permanently, with no probe loop left running to catch it.
      //
      // Re-check instead, and clear only on a 200. The probe stays scheduled while
      // the answer is anything else, so the device can still LEAVE suspension the
      // moment the tenant is genuinely resumed (that, and the `tenant:resumed`
      // event, are the two exits — neither is removed here).
      if (this.tenantSuspended) {
        void this.revalidateTenantSuspension('reconnect');
      }

      // An active temporary push owns the screen — a reconnect must never cut it
      // short (F47). Only touch playback when no push is showing.
      if (!this.temporaryContent) {
        if (this.currentPlaylist && this.currentPlaylist.items?.length > 0) {
          // Restored/ongoing playlist — keep or start playing while waiting for
          // a server update. The machine enters PLAYING when a frame commits.
          this.ensurePlaying();
        } else {
          // Paired but nothing assigned: branded holding, never a bare black
          // content screen (F11).
          this.enterHolding('paired_no_playlist');
        }
      }
    });

    this.socket.on('disconnect', (reason) => {
      console.log('[Vizora] Disconnected:', reason);
      this.updateStatus('offline', 'Disconnected');
      this.stopHeartbeat();
      // Show offline overlay after 60s of sustained disconnect
      if (this.offlineTimeout) {
        clearTimeout(this.offlineTimeout);
      }
      this.offlineTimeout = setTimeout(() => {
        if (!this.socket?.connected) {
          this.showOfflineOverlay();
        }
      }, 60_000);
    });

    this.socket.on('connect_error', (error) => {
      console.error('[Vizora] Connection error:', error);
      this.updateStatus('offline', 'Connection failed');

      const code = (error as { data?: { code?: string } }).data?.code;

      if (code === 'DEVICE_REVOKED') {
        void this.confirmRevocation('connect_error');
        return;
      }
      if (code === 'TENANT_SUSPENDED') {
        this.enterTenantSuspended('connect_error');
        return;
      }
      // AUTH_EXPIRED / AUTH_INVALID / unknown codes / legacy message strings:
      // transport-layer by default (contract §1.5a). Credentials untouched,
      // the cached loop keeps playing (F3 fix), and the REST probe
      // disambiguates in the background.
      if (code) reportEvent('auth_degraded_signal', { code });
      this.scheduleAuthProbe();
    });

    this.socket.on('device:revoked', (payload) => {
      console.warn('[Vizora] device:revoked received:', payload);
      void this.confirmRevocation('device_revoked_event');
    });

    this.socket.on('tenant:suspended', () => {
      this.enterTenantSuspended('tenant_suspended_event');
    });

    this.socket.on('tenant:resumed', () => {
      console.log('[Vizora] Tenant resumed');
      // Dedupe the latch-clear through the shared helper (F41).
      this.exitTenantSuspended('tenant_resumed_event');
      if (this.currentPlaylist?.items?.length) {
        void this.advance();
      } else {
        this.enterHolding('paired_no_playlist');
      }
    });

    this.socket.on('config', (config) => {
      console.log('[Vizora] Received config:', config);
      if (config.qrOverlay) {
        this.renderQrOverlay(config.qrOverlay);
      }
    });

    this.socket.on('playlist:update', (data, ack?: DeliveryAck) => {
      // DELIVERY receipt, sent FIRST and unconditionally — see the ACK SEMANTICS
      // block above handleCommand. Never a nack, specifically including the
      // malformed and apply-failure paths below: content is re-derivable (the
      // connect-time resolver push and the T2 heartbeat reconcile both re-deliver
      // it), so a nack buys nothing — it can only replay the SAME payload that just
      // failed, while consuming the backoff counter that this device's command
      // delivery shares. `ack` is absent for the connect-time sendInitialState emit.
      VizoraAndroidTV.ackDelivery(ack);
      console.log('[Vizora] Received playlist update:', data);
      const playlist = this.validatePlaylist(data?.playlist);
      if (!playlist) {
        // A malformed push must be inert — current playback continues (F6).
        console.warn('[Vizora] Ignoring malformed playlist:update payload');
        return;
      }
      // A VERSIONED push (T2 sendInitialState / future push paths) goes through the same
      // version-wins as the pull, so a same-version push arriving after a pull does NOT
      // re-apply (no re-flash). A legacy push without a version falls back to
      // updatePlaylist, whose signature no-op still absorbs an identical re-send (PD-1).
      if (typeof data?.version === 'string' && data.version) {
        // The generation at DELIVERY: this handler runs synchronously on the socket
        // event, but the queue can hold the payload across a de-pair before it applies.
        void this.applyPulledContent({ version: data.version, playlist }, this.purgeGeneration);
      } else {
        // Same failure handling as the versioned path above (which gets it via
        // applyPulledContent's try). validatePlaylist only checks that `items` is an
        // array, so a malformed item makes computePlaylistSignature throw inside
        // updatePlaylist — bare, that was an unhandled rejection. Fail safe: keep
        // last-known-good on the glass and report it.
        void this.updatePlaylist(playlist).catch((error) => {
          console.warn('[Vizora] Failed to apply content — keeping last-known-good:', error);
          reportEvent('content_apply_failed', { playlistId: playlist.id ?? null });
        });
      }
    });

    this.socket.on('command', (command, ack?: DeliveryAck) => {
      // ACK BEFORE DISPATCH — not a style choice. `reload`, `restart` and
      // `clear_cache` call window.location.reload() synchronously inside
      // handleCommand; an ack emitted after that call has no chance of leaving the
      // device at all. Acking first is BEST-EFFORT, not a delivery guarantee: the
      // frame can still be stranded in engine.io's writeBuffer (flush() bails while
      // the transport is unwritable or upgrading) or aborted mid-XHR on the polling
      // fallback, and the reload discards it either way. What terminates the
      // resulting requeue → replay is the PERSISTED dedupe ring inside
      // handleCommand — see rule 3 of the ACK SEMANTICS block above it before
      // touching either half. Duplicate suppression lives inside handleCommand,
      // AFTER this line, so a suppressed replay is still acked — otherwise the
      // server just requeues the thing we deliberately ignored.
      VizoraAndroidTV.ackDelivery(ack);
      console.log('[Vizora] Received command:', command);
      void this.handleCommand(command).catch((error) => {
        // The receipt is already sent and stays sent: it reports delivery, not
        // outcome. A failed command surfaces here, never through the ack.
        console.error('[Vizora] Command handler failed:', error);
        reportEvent('command_handler_failed', { type: (command as { type?: unknown })?.type ?? null });
      });
    });

    this.socket.on('qr-overlay:update', (data) => {
      console.log('[Vizora] Received QR overlay update:', data);
      this.renderQrOverlay(data.qrOverlay);
    });
  }

  // ==================== TRUST / REVOCATION (P0-2) ====================
  //
  // Contract: docs/design/revocation-contract.md. The invariants enforced
  // here: no credential wipe without a 410 confirmation from auth-check
  // (§1.5/§3.4); anything unclassified is transport-layer (§1.5a); tenant
  // binding is verified at load time (§1.4/§2).

  /** GET /devices/auth/check — returns HTTP status, or null if unreachable. */
  private async runAuthCheck(): Promise<number | null> {
    if (!this.deviceToken) return null;
    try {
      const response: HttpResponse = await VizoraAndroidTV.httpWithTimeout(
        CapacitorHttp.get({
          url: `${this.config.apiUrl}/api/v1/devices/auth/check`,
          headers: { Authorization: `Bearer ${this.deviceToken}` },
          connectTimeout: 10000,
          readTimeout: 10000,
        }),
        20_000,
        'auth check',
      );
      // Mechanical gate for the §7.1a carve-out: once this device has ever
      // seen the auth-check endpoint respond (backend item §6.4 deployed),
      // remember it — a later 404 can then only mean an anomaly, never
      // "legacy backend", and the carve-out refuses to fire.
      if (response.status === 200 || response.status === 401 || response.status === 403 || response.status === 410) {
        Preferences.set({ key: 'auth_check_seen', value: '1' }).catch(() => {});
      }
      return response.status;
    } catch (err) {
      console.warn('[Vizora] Auth check unreachable:', err);
      return null;
    }
  }

  /**
   * Confirm-then-purge (§3.4). Every revocation signal funnels through here;
   * only a 410 destroys device state. Rate-limited to one confirmation probe
   * per 5 minutes regardless of signal volume (§3.3).
   */
  private async confirmRevocation(source: string): Promise<void> {
    const now = Date.now();
    // Operator unpair is a deliberate, human-initiated action — it must never be
    // swallowed by revocation-signal noise inside the 5-min window (F46).
    if (source !== 'unpair_command' && now - this.lastConfirmProbeAt < 5 * 60_000) {
      console.warn(`[Vizora] Revocation signal (${source}) dropped — confirmation rate limit`);
      return;
    }
    this.lastConfirmProbeAt = now;

    const status = await this.runAuthCheck();

    if (status === 410) {
      // The de-pair transition is UNCONDITIONAL. Revocation is confirmed at this point;
      // whether the storage wipe fully succeeded or not, the one thing that must not
      // happen is the device sitting on the revoked tenant's last frame forever.
      try {
        await this.purgeDeviceState(`revocation_confirmed:${source}`);
      } finally {
        if (source === 'unpair_command') {
          window.location.reload();
        } else {
          this.startPairing();
        }
      }
      return;
    }

    // §7.1a migration carve-out: operator-initiated unpair on the
    // authenticated socket is honored against a legacy backend that has no
    // auth-check endpoint (404). Self-disabling: once `auth_check_seen` is
    // set (the endpoint responded at least once — backend §6.4 is live), a
    // 404 is an anomaly and the carve-out refuses.
    // TODO(remove with backend item §6.4 fleet-wide): delete this branch and
    // the `auth_check_seen` flag once no legacy backends remain.
    if (status === 404 && source === 'unpair_command') {
      const seen = await Preferences.get({ key: 'auth_check_seen' }).catch(() => ({ value: null }));
      if (seen.value === '1') {
        console.warn('[Vizora] unpair carve-out REFUSED — auth-check endpoint was previously available');
        reportEvent('legacy_carveout_refused', { source });
        return;
      }
      await this.purgeDeviceState('unpair_legacy_backend');
      window.location.reload();
      return;
    }

    console.warn(`[Vizora] Revocation signal (${source}) NOT confirmed (auth-check=${status}) — keeping state`);
    reportEvent('revocation_unconfirmed', { source, authCheckStatus: status });
  }

  /**
   * Background disambiguation loop for auth-degraded mode (§5): backoff
   * 30s -> 15min with ±25% jitter. Playback continues from cache throughout.
   */
  private scheduleAuthProbe() {
    if (this.authProbeTimer || !this.deviceToken) return;
    if (!this.authDegradedSince) {
      this.authDegradedSince = Date.now();
      reportEvent('auth_degraded_enter', {});
    }
    const base = Math.min(30_000 * Math.pow(2, this.authProbeRetry), 900_000);
    const jitter = base * 0.25 * (Math.random() * 2 - 1);
    const delay = Math.round(base + jitter);
    this.authProbeRetry = Math.min(this.authProbeRetry + 1, 5);
    console.log(`[Vizora] Auth probe scheduled in ${delay}ms`);

    this.authProbeTimer = setTimeout(async () => {
      this.authProbeTimer = null;
      const status = await this.runAuthCheck();

      if (status === 200) {
        this.exitAuthDegraded();
        // A 200 means the tenant is active again — clear the suspension latch
        // (F41) so playback resumes instead of stranding forever on holding.
        this.exitTenantSuspended('auth_check_active');
        if (!this.socket?.connected) {
          this.connectToRealtime();
        } else if (!this.temporaryContent) {
          if (this.currentPlaylist?.items?.length) {
            this.ensurePlaying();
          } else {
            this.enterHolding('paired_no_playlist');
          }
        }
        return;
      }
      if (status === 410) {
        await this.purgeDeviceState('auth_check_revoked');
        this.startPairing();
        return;
      }
      if (status === 403) {
        this.enterTenantSuspended('auth_check');
      }
      if (status === 404) {
        // Legacy backend — the endpoint teaches us nothing; stop probing and
        // let the socket reconnection loop carry recovery.
        console.log('[Vizora] Auth-check endpoint absent (legacy backend) — probe loop stopped');
        return;
      }
      if (status === 401) {
        // Fail-open by contract (§1.5a / F3): a 401 is the generic auth-hiccup
        // status any gateway/proxy/token-validator emits — treating it as
        // revocation would de-pair the whole fleet on a transient blip. ONLY a
        // 410 (confirmed revocation) purges. NEVER purge or re-pair here. The
        // one thing we add is observability: distinct telemetry so an operator
        // can tell a rejected token from a transport blip; recovery is a human
        // re-pair or a server-side re-issue, not an auto-wipe. Fall through to
        // the shared degraded tail (24h badge + reschedule).
        reportEvent('auth_check_401', {
          degradedForSeconds: this.authDegradedSince
            ? Math.round((Date.now() - this.authDegradedSince) / 1000)
            : 0,
        });
      }

      // 24h continuously degraded: unobtrusive badge, cached loop continues (§5)
      if (this.authDegradedSince && Date.now() - this.authDegradedSince > 24 * 3600_000) {
        this.showAuthDegradedBadge();
      }
      this.scheduleAuthProbe();
    }, delay);
  }

  private exitAuthDegraded() {
    if (this.authProbeTimer) {
      clearTimeout(this.authProbeTimer);
      this.authProbeTimer = null;
    }
    this.authProbeRetry = 0;
    if (this.authDegradedSince) {
      reportEvent('auth_degraded_exit', {
        degradedForSeconds: Math.round((Date.now() - this.authDegradedSince) / 1000),
      });
      this.authDegradedSince = 0;
    }
    this.hideAuthDegradedBadge();
  }

  /**
   * Re-check a live suspension against the ONLY endpoint that knows about it.
   *
   * The realtime handshake does not verify tenant suspension (see the `connect`
   * handler), so a successful reconnect is not evidence of anything. `auth/check` is,
   * and only a 200 clears the latch. Anything else — 403, an error, an unreachable
   * endpoint — leaves the device held and (re)starts the probe loop, so the device
   * can still leave suspension without another reconnect when the tenant is resumed.
   */
  private async revalidateTenantSuspension(source: string): Promise<void> {
    const status = await this.runAuthCheck();

    if (status === 200) {
      this.exitTenantSuspended(`${source}_auth_check_200`);
      // This path owns the resume, the same way the tenant:resumed handler does —
      // the `connect` handler's playback block already ran (and held) before this
      // async probe settled.
      if (!this.temporaryContent) {
        if (this.currentPlaylist?.items?.length) {
          this.ensurePlaying();
        } else {
          this.enterHolding('paired_no_playlist');
        }
      }
      return;
    }

    console.warn(`[Vizora] Tenant still suspended after ${source} (auth-check=${status}) — staying held`);
    reportEvent('tenant_suspension_confirmed', { source, authCheckStatus: status });
    // Keep the disambiguation loop alive so a later resume is noticed even if no
    // further reconnect ever happens. Idempotent — it no-ops if already scheduled.
    this.scheduleAuthProbe();
  }

  /** Tenant suspension: fail closed for rendering, keep credentials (§3.1). */
  private enterTenantSuspended(source: string) {
    console.warn('[Vizora] Tenant suspended:', source);
    reportEvent('tenant_suspended', { source });
    this.tenantSuspended = true;
    // DURABLE. In memory only, the latch died with the process: a power cycle booted
    // straight back into the cached playlist (last_playlist is still written while
    // suspended) and the suspended tenant's content was on customer glass again with
    // no probe running. Fire-and-forget — a failed write must never block the
    // fail-closed transition below, which is the part that takes content off screen.
    void Preferences.set({ key: VizoraAndroidTV.TENANT_SUSPENDED_PREF_KEY, value: '1' }).catch((err) => {
      console.warn('[Vizora] Could not persist the tenant-suspension latch:', err);
      reportEvent('tenant_suspension_persist_failed', {});
    });
    // Invalidate any prepare() already in flight. advance() checks the suspend gate
    // once at entry (:1696) and its ONLY post-await check is the playback generation
    // (:1715), so without this a frame prepared BEFORE this signal commits on top of
    // the holding screen we are about to enter — and the transition out of holding
    // then cancels the 30s self-heal retry (:236-239). Same supersede primitive
    // purgeDeviceState() already uses for the same reason (:1537).
    this.playbackGeneration++;
    this.enterHolding('tenant_suspended');
    this.setHoldingMessage('Display paused — contact your administrator');
  }

  /**
   * Clear the tenant-suspension latch (F41). Idempotent: only fires telemetry on
   * a real suspended→active transition. Callers own the actual playback resume,
   * so this never double-renders. Without this, a device suspended via the
   * auth-probe 403 path stays latched through a resume + reconnect and advance()'s
   * gate (:1383) strands it on holding forever with valid cached content.
   */
  private exitTenantSuspended(source: string) {
    if (!this.tenantSuspended) return;
    this.tenantSuspended = false;
    // Clear the durable copy too, or the next boot re-enters holding on a tenant that
    // is demonstrably active. Unconditional and fire-and-forget: a stranded latch
    // costs one extra auth-check on the next boot, which clears it.
    void Preferences.remove({ key: VizoraAndroidTV.TENANT_SUSPENDED_PREF_KEY }).catch(() => {});
    reportEvent('tenant_unsuspended', { source });
  }

  /**
   * Destroy all tenant-bound device state. Only reachable via a confirmed
   * revocation (§3.4) or the legacy unpair carve-out (§7.1a).
   */
  private async purgeDeviceState(reason: string) {
    console.warn('[Vizora] Purging device state:', reason);
    reportEvent('device_purged', { reason });

    // Halt playback first: no further frame of this tenant's content renders, and
    // invalidate every in-flight credential/content write (see purgeGeneration).
    this.playbackGeneration++;
    this.purgeGeneration++;
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.temporaryContentTimer) {
      clearTimeout(this.temporaryContentTimer);
      this.temporaryContentTimer = null;
    }
    this.exitAuthDegraded();
    this.exitTenantSuspended('device_purged'); // clears the durable latch too
    this.tenantSuspended = false;
    this.tenantReadFailed = false;
    this.currentPlaylist = null;
    // The content coordinates MUST be reset with the playlist. The server derives
    // `version` from content updatedAt stamps, so it is byte-identical across
    // unpair → re-pair to the same playlist: leaving these set meant the re-pair's
    // pullContent hit shouldApplyContent({P,V},{P,V}) === false, no-op'd, and left
    // currentPlaylist null — the device holds FOREVER while its heartbeat reports a
    // contentVersion that matches the server's truth, so the reconcile self-heal
    // never fires either.
    this.currentContentVersion = '';
    this.currentContentPlaylistId = null;
    this.savedPlaylistState = null;
    this.temporaryContent = null;
    this.deviceToken = null;
    this.deviceId = null;
    this.tenantId = null;
    // The dedupe ring is delivery state for THIS pairing. Left behind it outlives the
    // de-pair in memory as well as on disk, and rememberCommand would write the old
    // tenant's keys straight back out on the next command after re-pairing.
    this.seenCommandKeys = [];
    this.writeLocalRing(); // and its synchronous durable copy
    // Unbind the cache too. Nulling only `this.tenantId` left the cache manager still
    // expecting the purged tenant, so its tenant-mismatch purge could not fire for
    // whatever is paired next.
    this.cacheManager.setExpectedTenant(null);
    setCrashReportingDevice(null);

    if (this.socket) {
      this.stopHeartbeat();
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    // Every removal is INDEPENDENT. SecureStorage.remove genuinely rejects (the Java
    // plugin rejects on failure and on SECURE_STORAGE_UNAVAILABLE), and as a sequential
    // await chain the first rejection skipped every removal after it AND propagated out
    // of purgeDeviceState — where every caller is `void this.confirmRevocation(...)`, so
    // it became an unhandled rejection with no telemetry and no de-pair transition. A
    // revoked device kept its credentials and froze on the revoked tenant's last frame.
    const results = await Promise.allSettled([
      SecureStorage.remove({ key: 'device_token' }),
      SecureStorage.remove({ key: 'device_id' }),
      SecureStorage.remove({ key: 'tenant_id' }),
      Preferences.remove({ key: 'last_playlist' }),
      // Command-dedupe state is bound to the pairing that produced it. Surviving a
      // de-pair, it can suppress a genuinely new command for the NEXT tenant whose
      // (type, timestamp) key happens to collide, and it leaves the revoked tenant's
      // command history readable on the device.
      Preferences.remove({ key: VizoraAndroidTV.COMMAND_DEDUPE_PREF_KEY }),
      // Device-lifecycle state that was surviving a purge which claims to be
      // complete: the crash-loop breadcrumb describes an episode on the PREVIOUS
      // pairing, and the suspension latch would re-enter holding on whatever tenant
      // is paired next.
      Preferences.remove({ key: CRASH_LOOP_MARKER_KEY }),
      Preferences.remove({ key: VizoraAndroidTV.TENANT_SUSPENDED_PREF_KEY }),
      this.cacheManager.clearCache(),
    ]);

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      // Surface, never swallow: a partial purge is a device still holding some tenant
      // state, and the operator has to be able to see that it happened.
      console.error('[Vizora] Device purge incomplete:', failures.map(f => f.reason));
      reportEvent('device_purge_incomplete', { reason, failed: failures.length });
    }
  }

  private showAuthDegradedBadge() {
    if (document.getElementById('auth-degraded-badge')) return;
    const badge = document.createElement('div');
    badge.id = 'auth-degraded-badge';
    badge.style.cssText = 'position:fixed;bottom:16px;left:16px;background:rgba(0,0,0,0.7);color:#ccc;padding:8px 14px;border-radius:8px;font-size:14px;z-index:9999;';
    badge.textContent = 'Check display registration — see dashboard';
    document.body.appendChild(badge);
  }

  private hideAuthDegradedBadge() {
    const badge = document.getElementById('auth-degraded-badge');
    if (badge) badge.remove();
  }

  // ==================== PLAYBACK ENGINE ====================
  //
  // Structure (docs/design/playback-state-machine.md):
  //  - advance(): bounded scan for the next renderable item — recursion-free.
  //  - prepare(): builds the item's DOM off-screen; the previous frame stays
  //    visible for the whole cache/download/decode wait.
  //  - commitItem(): the ONLY place content leaves the container — appends the
  //    ready replacement first, then removes the old frame.
  //  - completeItem(): duration/onended handler, schedules the next advance.
  // A full scan with nothing renderable lands in branded HOLDING, never black.

  /** Wait budget for readiness before committing optimistically. */
  private static readonly READY_WAIT_MS: Record<string, number> = {
    image: 1500,
    video: 4000,
  };

  private validatePlaylist(raw: unknown): Playlist | null {
    if (!raw || typeof raw !== 'object') return null;
    const candidate = raw as Partial<Playlist>;
    if (!Array.isArray(candidate.items)) return null;
    return candidate as Playlist;
  }

  private async updatePlaylist(playlist: Playlist) {
    // Snapshot BEFORE the persist await below — see the re-check after it. Same
    // supersede primitive handleTokenRefresh uses for a credential; this one is for
    // the CONTENT commit, which was the half applyContentExclusive's guard did not
    // cover (it guards the version only).
    const gen = this.purgeGeneration;

    // PD-1 idempotency: a redundant delivery of the playlist ALREADY playing must
    // be a no-op — no rotation restart, no re-render flash, no duplicate
    // content:impression. The Finding-2 backend fix deliberately re-sends the
    // authoritative playlist on reconnect (best-effort pending + DB re-send); if
    // the device already has it, absorb it silently. This is the elegant half of
    // that fix: it distinguishes "already rendered" (signature matches → no-op)
    // from "stranded" (device holding → currentPlaylist empty → signature differs
    // → render). An EDITED playlist (same id, changed items) has a different
    // signature and still re-renders.
    const incomingSig = computePlaylistSignature(playlist);
    if (incomingSig && incomingSig === computePlaylistSignature(this.currentPlaylist)) {
      // Keep the running rotation; only nudge the engine if it somehow parked
      // (ensurePlaying resumes from the current index — it does NOT reset to 0).
      this.playbackSource = 'live';
      // An active temporary push owns the screen — don't nudge the engine over
      // it (F47); the push resumes into the running rotation on its own.
      if (!this.temporaryContent) this.ensurePlaying();
      return;
    }

    this.currentPlaylist = playlist;
    this.currentIndex = 0;
    this.playbackGeneration++; // invalidate any in-flight prepare
    this.playbackSource = 'live';

    // Persist playlist for offline resilience, tenant-bound (contract §2):
    // the envelope's tenantId is verified at load time before any render.
    //
    // SKIPPED while our own tenant identity is unverifiable. `tenantId ?? undefined`
    // writes the SAME envelope for "legacy device, never had a tenant" and "the
    // tenant_id read threw this boot" — and the loader treats an absent tenantId as
    // the legacy no-binding grace branch and renders it unconditionally. So one
    // transient decrypt failure permanently downgrades that record's tenant binding,
    // for every boot after. Keeping the PREVIOUS (correctly stamped) record is
    // strictly better: it is still tenant-bound, and live delivery is unaffected.
    let persisted = false;
    if (this.tenantReadFailed) {
      console.warn('[Vizora] Not persisting last_playlist — tenant identity is unverifiable this boot (F4/F42)');
      reportEvent('playlist_persist_skipped_tenant_unverified', { playlistId: playlist.id ?? null });
    } else {
      try {
        await Preferences.set({
          key: 'last_playlist',
          value: JSON.stringify({
            tenantId: this.tenantId ?? undefined,
            deviceId: this.deviceId ?? undefined,
            savedAt: Date.now(),
            playlist,
          }),
        });
        persisted = true;
      } catch (err) {
        console.warn('[Vizora] Failed to persist playlist:', err);
      }
    }

    // A purge that landed inside that write is the whole reason the snapshot exists.
    // purgeDeviceState removes last_playlist as part of its own purge, so a write
    // parked in the bridge lands AFTER that removal and OURS is the copy left on disk:
    // the de-paired device reboots straight back into the purged tenant's playlist.
    // And everything below this point runs off the `playlist` ARGUMENT rather than
    // this.currentPlaylist (which the purge nulled), so the preloader re-populates the
    // cache the purge had just cleared with that tenant's assets. Both are the exact
    // leak purgeDeviceState exists to prevent, so decline the whole commit.
    //
    // The sibling hazard — a payload that reaches updatePlaylist entirely AFTER a
    // purge, which this entry snapshot cannot see because it is taken too late — is
    // closed one level up, by the generation applyPulledContent's callers capture at
    // the point the payload was asked for. See the comment there.
    if (gen !== this.purgeGeneration) {
      console.warn('[Vizora] Device was purged while applying a playlist — discarding it');
      reportEvent('playlist_discarded_after_purge', { playlistId: playlist.id ?? null });
      // Only what WE put there, and only if it is still ours: a purge implies a
      // pairing screen, but a re-pair inside the same window is not impossible and
      // its content must not be collateral.
      if (this.currentPlaylist === playlist) {
        this.currentPlaylist = null;
        this.currentIndex = 0;
      }
      if (this.savedPlaylistState?.playlist === playlist) this.savedPlaylistState = null;
      if (persisted) {
        void Preferences.remove({ key: 'last_playlist' }).catch((err) => {
          console.error('[Vizora] Could not remove a playlist persisted across a purge:', err);
          reportEvent('playlist_purge_cleanup_failed', {});
        });
      }
      // No advance(), no preload, and no screen transition: the revocation path owns
      // the screen and is already heading for pairing. An enterHolding() from here is
      // refused while pairing owns it, but it would still fire before that transition
      // lands, and there is nothing to hold FOR on a de-paired device.
      return;
    }

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    // F47: an active temporary push owns the screen. The new playlist is already
    // stored + persisted above (so the latest content is ready); stage it for
    // resume and preload its assets, but do NOT render over the push —
    // resumePlaylist shows it when the push timer ends.
    if (this.temporaryContent) {
      this.savedPlaylistState = playlist.items?.length ? { playlist, index: 0 } : null;
      this.preloadContent(playlist.items?.slice(0, 5) ?? []);
      return;
    }

    if (playlist.items && playlist.items.length > 0) {
      // Old content stays on screen until the first new item commits (F9).
      void this.advance();
      // Preload upcoming content
      this.preloadContent(playlist.items.slice(0, 5));
    } else {
      console.log('[Vizora] Playlist is empty — holding');
      this.enterHolding('empty_playlist');
    }
  }

  /** Kick the engine if it is parked (no timer pending, no advance running). */
  private ensurePlaying() {
    if (!this.playbackTimer && !this.advanceInFlight) {
      void this.advance();
    }
  }

  /**
   * Find and commit the next renderable item. Scans at most items.length
   * entries (F7: no recursion, no unbounded loop); exhaustion => HOLDING (F5).
   */
  private async advance(): Promise<void> {
    if (this.advanceInFlight) {
      this.pendingRestart = true;
      return;
    }
    this.advanceInFlight = true;
    try {
      // Fail closed while the tenant is suspended: no rendering, branded
      // holding until an explicit resume signal (contract §3.1/§4).
      if (this.tenantSuspended) {
        this.machine.transition('holding', 'tenant_suspended');
        return;
      }
      const gen = this.playbackGeneration;
      const playlist = this.currentPlaylist;
      const container = document.getElementById('content-container');
      if (!playlist || !playlist.items || playlist.items.length === 0 || !container) {
        this.enterHolding('no_playlist');
        return;
      }
      const items = playlist.items;

      for (let step = 0; step < items.length; step++) {
        const idx = (this.currentIndex + step) % items.length;
        const item = items[idx];
        if (!item || !item.content) continue;

        const prepared = await this.prepare(item, gen);
        if (gen !== this.playbackGeneration) {
          prepared?.cleanup();
          return; // superseded by a newer playlist
        }
        if (!prepared) continue; // unrenderable — skip without touching the DOM

        this.currentIndex = idx;
        this.commitItem(container, item, prepared);
        return;
      }

      console.warn('[Vizora] No renderable content in playlist — holding');
      reportEvent('playback_holding', { reason: 'no_renderable_content', playlistId: playlist.id });
      this.enterHolding('no_renderable_content');
    } finally {
      this.advanceInFlight = false;
      if (this.pendingRestart) {
        this.pendingRestart = false;
        void this.advance();
      }
    }
  }

  /**
   * Build an item's DOM detached from the screen and wait (bounded) for it to
   * become renderable. Returns null to skip the item — the screen is never
   * touched on the skip path.
   */
  private async prepare(
    item: PlaylistItem,
    gen: number,
  ): Promise<{ el: HTMLElement; cleanup: () => void } | null> {
    const content = item.content!;

    if (content.type === 'layout') {
      return this.prepareLayout(item);
    }

    try {
      const contentDiv = document.createElement('div');
      contentDiv.className = 'content-item';

      const { ready } = await this.renderContentToDiv(content, contentDiv, {
        useCache: true,
        onVideoEnd: () => {
          if (gen !== this.playbackGeneration) return;
          if (this.playbackTimer) {
            clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
          }
          this.completeItem(item);
        },
        onError: () => this.handleContentError(gen, content.id),
      });

      const waitMs = VizoraAndroidTV.READY_WAIT_MS[content.type] ?? 0;
      const result = await Promise.race([ready, this.timeoutAfter(waitMs)]);

      if (result === 'error') return null;
      // 'ready' or 'timeout' — commit (timeout = optimistic commit; the asset
      // may still paint, and post-commit errors advance via onError).
      return {
        el: contentDiv,
        cleanup: () => this.cleanupMediaElements(contentDiv),
      };
    } catch (err) {
      console.warn(`[Vizora] Failed to prepare content ${content.id}:`, err);
      return null;
    }
  }

  private timeoutAfter(ms: number): Promise<'timeout'> {
    return new Promise(resolve => setTimeout(() => resolve('timeout'), ms));
  }

  /** Post-commit content failure (e.g. video stream dies mid-play): skip forward. */
  private handleContentError(gen: number, contentId: string) {
    if (gen !== this.playbackGeneration) return;
    if (this.currentContentId !== contentId) return; // pre-commit error — prepare() handles it
    console.warn(`[Vizora] Content ${contentId} failed after commit — advancing`);
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.completeItem(this.currentPlaylist?.items?.[this.currentIndex] ?? null);
  }

  /**
   * The only mutation site for the content container: append the ready
   * replacement, THEN remove the old frame (never-black by construction),
   * then run the previous item's cleanup (zone timers, media release — F12).
   */
  private commitItem(
    container: HTMLElement,
    item: PlaylistItem,
    prepared: { el: HTMLElement; cleanup: () => void },
  ) {
    const content = item.content!;
    const items = this.currentPlaylist?.items ?? [];
    console.log(`[Vizora] Playing content ${this.currentIndex + 1}/${items.length}: ${content.name}`);

    const oldChildren = Array.from(container.children) as HTMLElement[];
    container.appendChild(prepared.el);
    for (const child of oldChildren) {
      container.removeChild(child);
    }
    const oldCleanup = this.currentItemCleanup;
    this.currentItemCleanup = prepared.cleanup;
    oldCleanup?.();

    this.machine.transition('playing', 'content_committed');

    // Track current content for heartbeat reporting
    this.currentContentId = content.id;
    this.contentStartTime = Date.now();

    // Emit content impression for analytics
    if (this.socket?.connected) {
      this.socket.emit('content:impression', {
        contentId: content.id,
        playlistId: this.currentPlaylist?.id,
        timestamp: Date.now(),
      });
    }

    // Schedule advancement. Every type gets a timer (F8 — layout included).
    // Videos advance on `onended`; their timer is a stall watchdog sized so a
    // correctly-declared duration never truncates playback.
    const declaredSec = item.duration || content.duration || 10;
    const advanceMs =
      content.type === 'video'
        ? Math.max(declaredSec * 4, 600) * 1000
        : declaredSec * 1000;

    if (this.playbackTimer) clearTimeout(this.playbackTimer);
    this.playbackTimer = setTimeout(() => {
      this.playbackTimer = null;
      this.completeItem(item);
    }, advanceMs);
  }

  /** Item finished (timer, video end, or post-commit error): emit completion, move on. */
  private completeItem(item: PlaylistItem | null) {
    const playlist = this.currentPlaylist;

    if (item?.content && this.contentStartTime > 0 && this.socket?.connected) {
      const expectedDuration =
        (item.duration || item.content.duration || (item.content.type === 'video' ? 30 : 10)) * 1000;
      const actualDurationMs = Date.now() - this.contentStartTime;
      const completionPercentage = Math.min(100, Math.round((actualDurationMs / expectedDuration) * 100));
      this.socket.emit('content:impression', {
        contentId: item.content.id,
        playlistId: playlist?.id,
        duration: Math.round(actualDurationMs / 1000),
        completionPercentage,
        timestamp: Date.now(),
      });
    }

    if (!playlist || !playlist.items || playlist.items.length === 0) {
      this.enterHolding('playlist_removed');
      return;
    }

    if (this.currentIndex + 1 >= playlist.items.length && playlist.loopPlaylist === false) {
      // Explicit park (F35): the last frame stays on screen by design.
      console.log('[Vizora] Playlist ended — holding last frame (loopPlaylist=false)');
      this.playbackSource = 'hold-last';
      return;
    }

    this.currentIndex = (this.currentIndex + 1) % playlist.items.length;
    void this.advance();
  }

  /**
   * Branded fallback state — the never-black terminal. Self-heals: if a
   * playlist exists, retry the scan periodically (assets may finish caching).
   */
  private enterHolding(reason: string) {
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    const cleanup = this.currentItemCleanup;
    this.currentItemCleanup = null;
    cleanup?.();
    this.machine.transition('holding', reason);
    this.setHoldingMessage('Waiting for content…');

    if (this.holdingRetryTimer) clearTimeout(this.holdingRetryTimer);
    if (this.currentPlaylist?.items?.length) {
      this.holdingRetryTimer = setTimeout(() => {
        this.holdingRetryTimer = null;
        void this.advance();
      }, 30000);
    }
  }

  private async preloadContent(items: PlaylistItem[]) {
    const tasks = items
      .filter(item => item.content && (item.content.type === 'image' || item.content.type === 'video'))
      .map(async (item) => {
        const content = item.content!;
        const contentUrl = transformContentUrl(content.url, this.config.apiUrl, this.deviceToken, {
          rewriteLocalhostForEmulator: isNativeCapacitor(),
        });
        const cached = await this.cacheManager.getCachedUri(content.id);
        if (!cached) {
          await this.cacheManager.downloadContent(
            content.id,
            contentUrl,
            content.mimeType || (content.type === 'video' ? 'video/mp4' : 'image/jpeg'),
          );
        }
      });
    await Promise.allSettled(tasks);
  }

  // ==================== DELIVERY ACK (capability: deliveryAck) ====================
  //
  // ACK SEMANTICS — all four rules are derived from the realtime gateway's
  // behaviour, not from taste. Breaking any one of them produces a fleet-wide
  // storm the SERVER cannot stop, so they are stated once, here, and every ack
  // site defers to this comment.
  //
  //  1. ALWAYS `{ ok: true }`. NEVER a negative ack, for any reason. The server has
  //     no attempt counter, no dead-letter queue and no give-up for a nacked
  //     payload. Its only circuit breaker (5 failures) is per-device/per-process,
  //     is RESET by any clean replay round, and is BYPASSED entirely by the
  //     connect-time replay path — which also refreshes the Redis TTL. So a nack on
  //     a failure class that also restarts this client (a bad payload that crashes
  //     the renderer, an OOM reload) is a self-sustaining loop with no terminator.
  //     Worse, playlist and command replay share ONE backoff counter, so nacking
  //     playlists would throttle and eventually SUPPRESS this device's own command
  //     delivery. Apply failures go out through reportEvent / content:error — the
  //     channels that exist for them — never through the ack.
  //
  //  2. It is a DELIVERY receipt, not an APPLY receipt. Nothing server-side reads
  //     an "applied" status. Ack on receipt after cheap validation; never couple it
  //     to the outcome of the work.
  //
  //  3. Ack BEFORE any dispatch that can destroy the JS context. `reload`,
  //     `restart` and `clear_cache` call window.location.reload() synchronously; an
  //     ack emitted after that call has no chance at all of leaving the device.
  //
  //     Ordering is NECESSARY BUT NOT SUFFICIENT, and the difference matters — do
  //     not read this rule as closing the loop on its own. On an established
  //     WebSocket the emit does reach ws.send() synchronously, but engine.io-client's
  //     flush() bails when `!transport.writable` or `this.upgrading`
  //     (engine.io-client socket.js:342-346), leaving the frame sitting in
  //     writeBuffer — which window.location.reload() then discards. On the polling
  //     fallback the write is an XHR POST that the reload aborts. So acking first
  //     BUYS a chance to flush; it does not guarantee delivery.
  //
  //     The thing that actually terminates the loop is the PERSISTED dedupe ring
  //     (loadSeenCommands / rememberCommand): when the ack is lost, the server times
  //     out at 10s and requeues, the device reconnects and the identical
  //     (type, timestamp) arrives again — and the on-disk ring is what stops the
  //     second execution. Deleting the ring on the strength of this ordering rule
  //     would reintroduce reload → reconnect → replay → reload, forever.
  //
  //  4. EXACTLY ONCE on every path, including a throwing handler. A missed callback
  //     is a 10s server-side stall plus a requeue, and leaks an entry in the
  //     server's ack map for the socket's lifetime.
  //
  // The callback may also be ABSENT: the connect-time playlist:update
  // (sendInitialState) and the config / qr-overlay:update emits are not
  // ack-wrapped, so every call site goes through this helper rather than invoking
  // `ack` directly.

  /** Answer a delivery-guaranteed emit. Positive, once, and never throws. */
  private static ackDelivery(ack: unknown): void {
    if (typeof ack !== 'function') return; // legacy / unacked emit — rule above
    try {
      (ack as (response: { ok: boolean }) => void)({ ok: true });
    } catch (error) {
      // A throwing callback must not take the handler down with it, and must not
      // tempt a retry: from the server's side the ack either arrived or it did not.
      console.warn('[Vizora] delivery ack callback threw:', error);
    }
  }

  // ==================== COMMANDS ====================

  /**
   * Idempotency key for a delivered command: `(type, timestamp)`.
   *
   * NOT `commandId`. That exists only on fleet-originated commands — the
   * POST /api/push/content path constructs `{ type, payload }` with no id at all,
   * and the realtime DeviceCommand type does not declare one. `timestamp` is
   * stamped ONCE server-side and the identical object is requeued verbatim, so it
   * is stable across every replay and every reconnect, which is exactly the
   * property a dedupe key needs.
   *
   * Returns null when the command carries no timestamp: an unkeyable command is
   * EXECUTED (never suppressed on a guess) — and, as always, still acked. That is a
   * cross-repo invariant failing OPEN, so handleCommand reports it whenever the
   * command is one that destroys the context; see the `else if` there.
   */
  private static commandDedupeKey(command: { type?: unknown; timestamp?: unknown }): string | null {
    const type = command?.type;
    const timestamp = command?.timestamp;
    if (typeof type !== 'string' || !type) return null;
    if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return null;
    const key = `${type}@${timestamp}`;
    if (key.length > VizoraAndroidTV.COMMAND_DEDUPE_KEY_MAX_LEN) {
      // Unbounded, this is a way to blow the storage quota from the wire: the ring is
      // JSON-stringified into Preferences AND localStorage, and on the TV runtimes a
      // QuotaExceededError then fails every LATER write identically — disarming the
      // terminator for every subsequent command. Refusing the key costs at most one
      // duplicate execution of this one command.
      console.warn(`[Vizora] Dedupe key too long (${key.length} chars) — not recorded`);
      reportEvent('command_dedupe_key_oversize', {
        type: type.slice(0, 64),
        length: key.length,
      });
      return null;
    }
    return key;
  }

  /**
   * The key for a SYNTHETIC dedupe record: the command type plus the local time it is
   * being dispatched at. Null when it would not fit the same length bound a real key
   * has — `type` is unvalidated wire data, and this key goes into the same two stores.
   */
  private static syntheticUnkeyedKey(type: string, at: number): string | null {
    const key = `${type}${VizoraAndroidTV.COMMAND_UNKEYED_MARK}${at}`;
    if (key.length > VizoraAndroidTV.COMMAND_DEDUPE_KEY_MAX_LEN) {
      console.warn(`[Vizora] Synthetic dedupe key too long (${key.length} chars) — not recorded`);
      reportEvent('command_dedupe_key_oversize', { type: type.slice(0, 64), length: key.length });
      return null;
    }
    return key;
  }

  /**
   * When, if ever, an identical unkeyable command was dispatched inside the window —
   * see COMMAND_UNKEYED_WINDOW_MS for why the window exists and what the clock can do
   * to it. Newest match first; `elapsed >= 0` is the clock-went-backwards guard, and
   * dropping such a record means the command EXECUTES.
   */
  private recentUnkeyedDispatch(type: string, now: number): number | null {
    const mark = `${type}${VizoraAndroidTV.COMMAND_UNKEYED_MARK}`;
    for (let i = this.seenCommandKeys.length - 1; i >= 0; i--) {
      const key = this.seenCommandKeys[i];
      if (key.slice(0, mark.length) !== mark) continue;
      const at = Number(key.slice(mark.length));
      if (!Number.isFinite(at)) continue;
      const elapsed = now - at;
      if (elapsed >= 0 && elapsed < VizoraAndroidTV.COMMAND_UNKEYED_WINDOW_MS) return at;
    }
    return null;
  }

  /**
   * Restore the persisted dedupe ring.
   *
   * This is the infinite-reload guard, and it only works because it is on DISK.
   * The sequence it defends against: we ack a `reload`, the device reloads, the ack
   * is lost in flight because the socket died mid-reload, the server times out and
   * requeues, and on reconnect the IDENTICAL (reload, timestamp) arrives again.
   * In memory alone the ring is empty at that point and the device reloads forever.
   *
   * Fails OPEN: an unreadable ring suppresses nothing, which costs at most one
   * duplicate execution — strictly better than refusing to boot.
   *
   * But failing open here disarms the ONLY terminator a command-replay loop has, so
   * it is reported, not merely logged. On Tizen/webOS the Preferences plugin falls
   * through to its localStorage web implementation, where a storage fault takes out
   * every read and every write at once — the exact state in which the loop runs and
   * console output nobody is reading is the only trace.
   */
  private async loadSeenCommands(): Promise<void> {
    const merged: string[] = [];
    const absorb = (raw: string | null | undefined) => {
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const k of parsed) {
        if (typeof k === 'string' && merged.indexOf(k) === -1) merged.push(k);
      }
    };

    // UNION of both homes, and the synchronous one first. They can legitimately
    // disagree: the localStorage copy lands even when the Preferences write times
    // out or rejects, and the Preferences copy survives a webview storage clear that
    // takes localStorage with it. Whichever one has the key is enough to suppress
    // the replay — the ring only ever needs to answer "have I run this".
    try {
      absorb(VizoraAndroidTV.localStore()?.getItem(VizoraAndroidTV.COMMAND_DEDUPE_LOCAL_KEY));
    } catch (error) {
      console.warn('[Vizora] Could not restore the local command dedupe ring:', error);
      reportEvent('command_dedupe_ring_load_failed', { store: 'localStorage', error: String(error) });
    }

    try {
      const stored = await this.boundedPrefsGet(VizoraAndroidTV.COMMAND_DEDUPE_PREF_KEY);
      if (stored !== 'timeout') absorb(stored.value);
    } catch (error) {
      console.warn('[Vizora] Could not restore command dedupe ring — duplicates may re-execute:', error);
      // Distinct from the persist failure below: this one means the ring did not
      // survive the restart, which is precisely the replay window it guards.
      reportEvent('command_dedupe_ring_load_failed', { store: 'preferences', error: String(error) });
    }

    // Bounded on restore as well as on write: a ring that grew (an older build, a
    // hand-edited store, or the union of two copies that diverged) must not come
    // back unbounded and be written straight back out at full size.
    if (merged.length > 0) {
      this.seenCommandKeys = merged.slice(-VizoraAndroidTV.COMMAND_DEDUPE_MAX);
    }
  }

  /**
   * Record a key in the bounded ring and persist it, BEFORE the command is
   * dispatched. Awaited by the caller on purpose: a `reload` dispatched first would
   * race the write and could tear the context down before it landed — which is
   * precisely the state the ring exists to prevent. A failed write is not fatal (the
   * in-memory entry still covers a same-session replay) and never blocks the
   * operator's command.
   *
   * Never rejects — the caller races this against a timeout and must be able to
   * treat a settled promise as "the write is done trying".
   *
   * A failed write IS reported. It leaves the device with no on-disk terminator for
   * the very next replay, and the one plausible cause (a QuotaExceededError from the
   * localStorage web implementation on Tizen/webOS) fails EVERY subsequent write the
   * same way — so the loop, once started, has nothing left to stop it.
   */
  private rememberCommandLocally(key: string): boolean {
    this.seenCommandKeys.push(key);
    if (this.seenCommandKeys.length > VizoraAndroidTV.COMMAND_DEDUPE_MAX) {
      this.seenCommandKeys = this.seenCommandKeys.slice(-VizoraAndroidTV.COMMAND_DEDUPE_MAX);
    }

    // SYNCHRONOUS durable write FIRST, before anything asynchronous can be raced or
    // wedged. This is the write that actually terminates the replay loop: it has
    // landed by the time this function yields, so the 2s bound, a rejecting bridge and
    // a reload() firing on the next turn can none of them leave the dispatch
    // unrecorded. The Preferences write stays — it is the copy that survives a webview
    // storage clear — but it is no longer the only one.
    return this.writeLocalRing();
  }

  /** Persist the ring through the bridge. Never rejects; reports what it returns. */
  private async persistCommandRing(): Promise<boolean> {
    try {
      await Preferences.set({
        key: VizoraAndroidTV.COMMAND_DEDUPE_PREF_KEY,
        value: JSON.stringify(this.seenCommandKeys),
      });
      return true;
    } catch (error) {
      console.warn('[Vizora] Could not persist command dedupe ring:', error);
      reportEvent('command_dedupe_ring_persist_failed', { error: String(error) });
      return false;
    }
  }

  /**
   * Record `key` and answer the only question the dispatch decision needs: did a home
   * that SURVIVES window.location.reload() accept it?
   *
   * The in-memory entry is added unconditionally either way — it still suppresses a
   * same-process replay, which is the common case and does not depend on any disk.
   *
   * The two homes are independent on ANDROID (native SharedPreferences vs WebView
   * localStorage) and NOT independent on Tizen/webOS: @capacitor/preferences 6.0.4's
   * web implementation is literally `window.localStorage` under a `CapacitorStorage.`
   * prefix (dist/esm/web.js — `get impl() { return window.localStorage; }`). One quota
   * failure therefore takes BOTH out on exactly the platforms where the quota failure
   * was the motivating scenario. The sync write still closes the timing hole and the
   * wedged-bridge hole everywhere; what it cannot do there is be a SECOND store. So the
   * caller has to be told, rather than assuming two homes means two chances.
   */
  private async recordCommandDurably(key: string, type: string): Promise<boolean> {
    const localAccepted = this.rememberCommandLocally(key);
    // BOUNDED. A wedged Capacitor bridge leaves Preferences.set pending forever;
    // without the bound the operator's command would never run at all, with `{ ok: true }`
    // already sent and no rejection to report because the promise does not settle.
    const persist = await Promise.race([
      this.persistCommandRing().then((ok): 'persisted' | 'failed' => (ok ? 'persisted' : 'failed')),
      this.timeoutAfter(VizoraAndroidTV.COMMAND_DEDUPE_PERSIST_TIMEOUT_MS),
    ]);
    if (persist === 'timeout') {
      console.warn(
        `[Vizora] Dedupe ring persist did not settle in ${VizoraAndroidTV.COMMAND_DEDUPE_PERSIST_TIMEOUT_MS}ms — ${type} is guarded by the local copy alone`,
      );
      reportEvent('command_dedupe_persist_timeout', { type });
    }
    return localAccepted || persist === 'persisted';
  }

  /**
   * FAIL CLOSED, and only here: a context-destroying command whose dedupe record no
   * durable store would accept is REFUSED rather than dispatched.
   *
   * The asymmetry is the whole argument. Dispatching it risks the unterminated loop —
   * reload → ack lost → requeue → replay → reload at a ~3-5s period, a screen that
   * never reaches content and a truck roll to fix. Refusing it leaves the device doing
   * exactly what it was already doing, which is at worst stale, and puts the event in
   * telemetry where we can see it. The loop is strictly worse than the refusal, so when
   * we cannot prove we would be able to suppress the replay, we decline the command.
   *
   * Deliberately narrow: only when NEITHER home accepted (one is enough), and only for
   * the context-destroying set. Every other command still runs — a replayed
   * `clear_override` costs one wasted execution, not the device — and the normal path,
   * where at least one store works, is untouched.
   */
  private refuseUndurableCommand(type: string): void {
    console.error(`[Vizora] ${type} REFUSED — no durable store accepted its dedupe record, so a replay could not be stopped`);
    reportEvent('command_refused_no_durable_dedupe', { type });
  }

  /**
   * Write the ring to localStorage. Synchronous, bridge-free, survives
   * window.location.reload(). Returns whether the write actually landed — a missing
   * store (no localStorage at all) counts as a failure, not a success.
   *
   * Reported on failure for the same reason the Preferences write is: when BOTH homes
   * are unwritable the device has no terminator at all, and that state has to be
   * visible to us.
   */
  private writeLocalRing(): boolean {
    try {
      const store = VizoraAndroidTV.localStore();
      if (!store) return false;
      store.setItem(
        VizoraAndroidTV.COMMAND_DEDUPE_LOCAL_KEY,
        JSON.stringify(this.seenCommandKeys),
      );
      return true;
    } catch (error) {
      console.warn('[Vizora] Could not persist the local command dedupe ring:', error);
      reportEvent('command_dedupe_local_persist_failed', { error: String(error) });
      return false;
    }
  }

  private async handleCommand(command: { type: string; payload?: Record<string, unknown>; [key: string]: unknown }) {
    // Duplicate suppression sits here, at the single choke point both delivery
    // paths funnel through (the `command` socket event and the heartbeat ack's
    // commands array), so a replay cannot slip in via the other door. The ack is
    // already sent by the caller — a suppressed duplicate is still acked, or the
    // server would just requeue it (rule 1).
    const dedupeKey = VizoraAndroidTV.commandDedupeKey(command);
    if (dedupeKey !== null) {
      if (this.seenCommandKeys.includes(dedupeKey)) {
        console.log(`[Vizora] Duplicate command suppressed: ${dedupeKey}`);
        reportEvent('command_duplicate_suppressed', { type: command.type });
        return;
      }
      // The await is required (see recordCommandDurably) and is bounded there. A
      // timeout or a rejecting bridge is NOT by itself a reason to drop the operator's
      // command — the synchronous local copy still guards the replay, and losing the
      // command loses the operator's action outright. Only losing BOTH homes is.
      const durable = await this.recordCommandDurably(dedupeKey, command.type);
      if (!durable && VizoraAndroidTV.CONTEXT_DESTROYING_COMMANDS.has(command.type)) {
        this.refuseUndurableCommand(command.type);
        return; // still acked by the caller — a nack would only requeue it
      }
    } else if (VizoraAndroidTV.CONTEXT_DESTROYING_COMMANDS.has(command.type)) {
      // An unkeyable context-destroying command was the one shape this guard could not
      // cover: it executes (never suppressed on a guess) and, with no key to record,
      // recorded NOTHING — so a requeue after a lost ack replayed it with no
      // terminator at all, at the ~3-5s period of reload → reconnect → replay →
      // reload, forever. The scheme's safety otherwise rests on the gateway always
      // stamping `timestamp`: one line in another repo, with no compiler between us.
      //
      // So key it on what we DO have — the type, and our own clock. A TIME-WINDOWED
      // SYNTHETIC RECORD (COMMAND_UNKEYED_WINDOW_MS) terminates the loop after ONE
      // execution while leaving a deliberate re-issue a minute later working. It is
      // deliberately not a permanent record: the replay is a machine retrying inside
      // seconds, a second press is a human, and only the window tells them apart.
      //
      // It goes through rememberCommand — the SAME durable mechanism as a real key
      // (synchronous localStorage first, then Preferences) — because it has to survive
      // the very reload it exists to survive. An in-memory-only record is read back
      // empty by the reloaded context and terminates nothing.
      const now = Date.now();
      const recordedAt = this.recentUnkeyedDispatch(command.type, now);
      if (recordedAt !== null) {
        // Still acked by the caller, exactly like a keyed duplicate (rule 1): a nack
        // would just requeue the delivery we are deliberately declining to repeat.
        console.warn(`[Vizora] Unkeyable ${command.type} repeated after ${now - recordedAt}ms — suppressed as a replay`);
        reportEvent('command_unkeyed_replay_suppressed', { type: command.type, ageMs: now - recordedAt });
        return;
      }
      // Failing open is right; failing open SILENTLY is how a missing stamp would
      // first be discovered as a field loop. This fires on the FIRST delivery only.
      console.warn(`[Vizora] ${command.type} arrived with no dedupe key — guarding the replay on a synthetic record`);
      reportEvent('command_dedupe_key_missing', { type: command.type });

      const synthetic = VizoraAndroidTV.syntheticUnkeyedKey(command.type, now);
      // Same fail-closed rule as the keyed path above, for the same reason — and this
      // path needs it more, since an unkeyable command has no exact key to fall back
      // on. A key we could not even build counts as undurable.
      const durable = synthetic !== null && await this.recordCommandDurably(synthetic, command.type);
      if (!durable) {
        this.refuseUndurableCommand(command.type);
        return; // still acked by the caller
      }
      // Give the ack frame the same task boundary the keyed path gets from its
      // persist, so the tightest flush window does not land on exactly the case that
      // also has the weakest dedupe protection. Kept unconditional: the record above
      // is skipped entirely when the synthetic key does not fit.
      await this.timeoutAfter(0);
    }

    switch (command.type) {
      case 'reload':
      // An app restart for a WebView client IS a reload — there is no separate
      // process to bounce, so `restart` shares the path rather than getting a
      // parallel implementation or a fake one. Until now it fell to `default:`
      // and warned while the dashboard reported it delivered.
      case 'restart':
        window.location.reload();
        break;

      case 'clear_cache':
        // The reload is UNCONDITIONAL. clearCache now rejects on a failed disk purge
        // (so purgeDeviceState's telemetry is honest); here that rejection must not
        // escape — handleCommand is invoked bare from the socket handler and from the
        // heartbeat ack, so it would be an unhandled rejection AND would skip the
        // restart the operator asked for. The in-memory cache is empty either way.
        try {
          await this.cacheManager.clearCache();
        } catch (error) {
          console.error('[Vizora] clear_cache purge incomplete:', error);
          reportEvent('clear_cache_incomplete', {});
        }
        window.location.reload();
        break;

      case 'unpair':
        // Confirm-then-purge (contract §3.4); the legacy-backend carve-out
        // (§7.1a) lives inside confirmRevocation.
        await this.confirmRevocation('unpair_command');
        break;

      case 'update_config': {
        // Validate each URL against a self-maintaining allowlist anchored to the
        // COMPILED-IN defaults before persisting (F43). Without this, a malicious
        // control-plane could point apiUrl at an attacker host; a follow-up media
        // URL there would then be judged same-origin and receive the device JWT
        // (defeating F24). Only accepted-and-changed fields trigger a reload.
        const fields: Array<{ value: unknown; kind: 'api' | 'realtime' | 'dashboard'; prefKey: string; current: string }> = [
          { value: command.apiUrl, kind: 'api', prefKey: 'config_api_url', current: this.config.apiUrl },
          { value: command.realtimeUrl, kind: 'realtime', prefKey: 'config_realtime_url', current: this.config.realtimeUrl },
          { value: command.dashboardUrl, kind: 'dashboard', prefKey: 'config_dashboard_url', current: this.config.dashboardUrl },
        ];
        let changed = false;
        for (const field of fields) {
          if (typeof field.value !== 'string' || !field.value) continue;
          if (!this.isAllowedConfigUrl(field.value, field.kind)) {
            let host = 'unparseable';
            try { host = new URL(field.value).host; } catch { /* keep default */ }
            console.warn(`[Vizora] update_config rejected ${field.kind} → ${host} (outside allowlist)`);
            reportEvent('config_rejected', { kind: field.kind, host });
            continue;
          }
          await Preferences.set({ key: field.prefKey, value: field.value });
          if (field.value !== field.current) changed = true;
        }
        if (changed) {
          window.location.reload();
        }
        break;
      }

      case 'push_content':
        if (command.payload?.content != null) {
          const content = command.payload.content as PushContent;
          const duration = (command.payload.duration as number) || 5;
          this.handleContentPush(content, duration);
        } else {
          console.warn('[Vizora] push_content command missing content payload');
        }
        break;

      case 'qr-overlay-update':
        this.renderQrOverlay(command.payload?.config as QrOverlayConfig | undefined);
        break;

      case 'clear_override':
        // An operator cancelling an emergency push. Until now this fell to
        // `default:` and warned, so the pushed content stayed on the glass for the
        // rest of its timer — up to 240 minutes — while the dashboard reported the
        // cancel delivered. Reuses the push-expiry resume path rather than a
        // parallel one, so there is exactly one definition of "what comes back".
        if (this.temporaryContent) {
          console.log('[Vizora] clear_override — cancelling temporary content');
          this.resumePlaylist();
        } else {
          // Deliberately a no-op with nothing on the glass to clear. resumePlaylist()
          // with no push active would fall through to enterHolding() and BLANK a
          // perfectly good playlist — a clear_override arriving late must not do that.
          console.log('[Vizora] clear_override — no temporary content active, nothing to clear');
        }
        break;

      // Genuinely not implementable in this client: a device reboot needs
      // device-owner privileges, an app update is the store's job, and a screenshot
      // needs native frame capture. They are ACKED anyway — rule 1 forbids nacking
      // even a permanent failure, because the server would replay it forever — but
      // reported, so the gap is visible to us instead of being silently absorbed.
      // NOT stubbed with fake behaviour: pretending would be worse than the gap.
      case 'reboot':
      case 'update':
      case 'screenshot':
        console.warn(`[Vizora] Command not supported by this client: ${command.type}`);
        reportEvent('command_unsupported', { type: command.type });
        break;

      default:
        // A command type this build has never heard of. It is ACKED (rule 1 — the
        // caller already sent the receipt) and then dropped, so without telemetry a
        // NEW server-side command type rolled out ahead of the fleet is invisible:
        // every dashboard says delivered, every device does nothing, and nothing
        // anywhere records the version skew. `command_unsupported` is deliberately a
        // different event — that one is a KNOWN type this client cannot implement.
        console.warn('[Vizora] Unknown command:', command.type);
        reportEvent('command_unknown', { type: command.type ?? null });
    }
  }

  // ==================== TEMPORARY CONTENT PUSH ====================

  private handleContentPush(content: PushContent, duration: number = 5) {
    // Tenant suspension fails closed for ALL rendering paths, including pushes
    // (F50) — advance()'s suspend gate does not cover the temp-push path.
    if (this.tenantSuspended) {
      console.warn('[Vizora] push_content suppressed — tenant suspended (F50)');
      reportEvent('push_suppressed_tenant_suspended', {});
      return;
    }
    console.log(`[Vizora] Pushing content: ${content.name} for ${duration} min`);

    // Save current playlist state if playing
    if (this.currentPlaylist && !this.temporaryContent) {
      this.savedPlaylistState = {
        playlist: this.currentPlaylist,
        index: this.currentIndex,
      };
    }

    // Invalidate any in-flight prepare and clear the playback timer
    this.playbackGeneration++;
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }

    // Clear any existing temporary content timer
    if (this.temporaryContentTimer) {
      clearTimeout(this.temporaryContentTimer);
      this.temporaryContentTimer = null;
    }

    // Show temporary content
    this.temporaryContent = content;
    this.renderTemporaryContent(content).catch(err =>
      console.error('[Vizora] Error rendering temporary content:', err)
    );

    // Set timer to resume playlist after duration (convert minutes to ms)
    this.temporaryContentTimer = setTimeout(() => {
      this.resumePlaylist();
    }, duration * 60 * 1000);
  }

  private async renderTemporaryContent(content: PushContent) {
    const container = document.getElementById('content-container');
    if (!container) return;

    // Captured AFTER handleContentPush's own bump (:2030), so this is this push's
    // generation. Re-checked after the awaits below — the same contract advance()
    // already follows. playbackGeneration is the single supersession primitive in
    // this engine: purgeDeviceState, a new playlist, a newer push and tenant
    // suspension all bump it, and every asynchronous renderer must revalidate it
    // before putting anything on glass. This path was the one that did not.
    const gen = this.playbackGeneration;

    // Build off-DOM; the current frame stays visible until the push is ready.
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content-item';

    const { ready } = await this.renderContentToDiv(content, contentDiv, {
      useCache: true,
      onVideoEnd: () => {
        if (this.temporaryContent) this.resumePlaylist();
      },
    });

    const waitMs = VizoraAndroidTV.READY_WAIT_MS[content.type] ?? 0;
    const result = await Promise.race([ready, this.timeoutAfter(waitMs)]);
    if (gen !== this.playbackGeneration) return; // superseded mid-render (incl. suspension)
    if (this.temporaryContent !== content) return; // superseded / cancelled
    if (result === 'error') {
      console.warn(`[Vizora] Pushed content failed to load: ${content.name} — resuming playlist`);
      this.resumePlaylist();
      return;
    }

    // Commit-swap: append new, then remove old (never-black).
    const oldChildren = Array.from(container.children) as HTMLElement[];
    container.appendChild(contentDiv);
    for (const child of oldChildren) container.removeChild(child);
    const oldCleanup = this.currentItemCleanup;
    this.currentItemCleanup = () => this.cleanupMediaElements(contentDiv);
    oldCleanup?.();

    this.machine.transition('playing', 'content_pushed');

    // Track current content for heartbeat reporting
    this.currentContentId = content.id;

    // Emit content impression for analytics
    if (this.socket?.connected) {
      this.socket.emit('content:impression', {
        contentId: content.id,
        timestamp: Date.now(),
      });
    }
  }

  private resumePlaylist() {
    console.log('[Vizora] Resuming playlist after temporary content');

    // Clear temporary content state
    this.temporaryContent = null;
    if (this.temporaryContentTimer) {
      clearTimeout(this.temporaryContentTimer);
      this.temporaryContentTimer = null;
    }

    // Restore playlist state
    if (this.savedPlaylistState) {
      this.currentPlaylist = this.savedPlaylistState.playlist;
      this.currentIndex = this.savedPlaylistState.index;
      this.savedPlaylistState = null;
      void this.advance();
    } else {
      // No playlist was playing — branded holding, never a cleared screen.
      this.enterHolding('push_ended_no_playlist');
    }
  }

  // ==================== QR OVERLAY ====================

  /** The only class names the server is allowed to put on the overlay element. */
  private static readonly QR_POSITIONS: readonly string[] = [
    'top-left', 'top-right', 'bottom-left', 'bottom-right',
  ];

  private async renderQrOverlay(config: QrOverlayConfig | undefined) {
    const overlay = document.getElementById('qr-overlay');
    if (!overlay) return;

    if (!config || !config.enabled) {
      overlay.classList.add('hidden');
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      return;
    }
    overlay.innerHTML = '';
    // `position` is typed as a union but arrives from the server unvalidated, and this
    // is the overlay's ONLY className write — a push of `"hidden"` would apply the
    // app's hide rule and suppress the QR overlay entirely (and any other class name
    // in the stylesheet is equally assignable). Validate against the known values.
    const position = VizoraAndroidTV.QR_POSITIONS.includes(config.position as string)
      ? (config.position as 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right')
      : 'bottom-right';
    overlay.className = position;
    overlay.style.backgroundColor = config.backgroundColor || '#ffffff';
    overlay.style.opacity = String(config.opacity ?? 1);

    const margin = config.margin || 16;
    overlay.style.position = 'fixed';
    overlay.style.zIndex = '100';
    // Reset all positions first
    overlay.style.top = 'auto';
    overlay.style.bottom = 'auto';
    overlay.style.left = 'auto';
    overlay.style.right = 'auto';

    if (position === 'top-left') { overlay.style.top = margin + 'px'; overlay.style.left = margin + 'px'; }
    else if (position === 'top-right') { overlay.style.top = margin + 'px'; overlay.style.right = margin + 'px'; }
    else if (position === 'bottom-left') { overlay.style.bottom = margin + 'px'; overlay.style.left = margin + 'px'; }
    else { overlay.style.bottom = margin + 'px'; overlay.style.right = margin + 'px'; }

    // `size` is declared `number` but arrives from the server unvalidated, and it is
    // concatenated into the label's style.cssText below — a string like
    // "1px;background:url(https://x/)" would inject CSS declarations. Coerce to a
    // number and clamp: anything non-numeric or out of range falls back to the default.
    const rawSize = Number(config.size);
    const size = Number.isFinite(rawSize) && rawSize > 0
      ? Math.min(Math.max(Math.round(rawSize), 32), 512)
      : 120;
    try {
      const QRCode = await import('qrcode');
      const canvas = document.createElement('canvas');
      await QRCode.toCanvas(canvas, config.url, {
        width: size,
        margin: 1,
        color: { dark: '#000000', light: config.backgroundColor || '#ffffff' },
      });
      overlay.appendChild(canvas);

      if (config.label) {
        const label = document.createElement('div');
        label.style.cssText = 'font-size:10px;color:#333;text-align:center;max-width:' + size + 'px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        label.textContent = config.label;
        overlay.appendChild(label);
      }

      overlay.classList.remove('hidden');
    } catch (err) {
      console.error('[Vizora] QR code generation failed:', err);
    }
  }

  // ==================== MULTI-ZONE LAYOUT ====================

  /**
   * Build a layout item's grid off-DOM. Returns null when the metadata is
   * invalid — the caller skips the item without touching the screen (F8).
   * Zone timers are instance-local and torn down by the returned cleanup
   * closure, which commitItem runs on every departure from the item (F12).
   */
  private prepareLayout(content: PlaylistItem): { el: HTMLElement; cleanup: () => void } | null {
    const raw = content as unknown as Record<string, unknown>;
    const contentRecord = content.content as unknown as Record<string, unknown> | null;
    const metadata = (raw.metadata || contentRecord?.metadata) as LayoutMetadata | undefined;
    if (!metadata || !Array.isArray(metadata.zones)) return null;

    const zoneTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const grid = document.createElement('div');
    grid.className = 'layout-grid';
    if (metadata.gridTemplate) {
      grid.style.gridTemplateColumns = metadata.gridTemplate.columns || '1fr';
      grid.style.gridTemplateRows = metadata.gridTemplate.rows || '1fr';
    }
    if (metadata.gap) grid.style.gap = metadata.gap + 'px';
    if (metadata.backgroundColor) grid.style.backgroundColor = metadata.backgroundColor;

    for (const zone of metadata.zones) {
      const zoneDiv = document.createElement('div');
      zoneDiv.className = 'layout-zone';
      zoneDiv.style.gridArea = zone.gridArea;

      if (zone.resolvedPlaylist?.items && zone.resolvedPlaylist.items.length > 0) {
        this.createZonePlayer(zone.id, zone.resolvedPlaylist, zoneDiv, zoneTimers);
      } else if (zone.resolvedContent) {
        this.renderZoneContent(zone.resolvedContent, zoneDiv);
      }

      grid.appendChild(zoneDiv);
    }

    return {
      el: grid,
      cleanup: () => {
        for (const [, timer] of zoneTimers) clearTimeout(timer);
        zoneTimers.clear();
        this.cleanupMediaElements(grid);
      },
    };
  }

  private createZonePlayer(
    zoneId: string,
    playlist: Playlist,
    container: HTMLElement,
    zoneTimers: Map<string, ReturnType<typeof setTimeout>>,
  ) {
    let index = 0;

    const playZoneItem = () => {
      const items = playlist.items;
      if (!items || items.length === 0) return;
      const item = items[index % items.length];
      if (!item?.content) return;

      this.renderZoneContent(item.content, container);
      const duration = (item.duration || item.content.duration || 10) * 1000;
      const timer = setTimeout(() => {
        index = (index + 1) % items.length;
        playZoneItem();
      }, duration);
      zoneTimers.set(zoneId, timer);
    };

    playZoneItem();
  }

  private renderZoneContent(content: NonNullable<PlaylistItem['content']>, container: HTMLElement) {
    this.cleanupMediaElements(container);
    while (container.firstChild) container.removeChild(container.firstChild);
    const contentDiv = document.createElement('div');
    contentDiv.className = 'content-item';

    // Zone content uses cache and plays video muted+looping
    void this.renderContentToDiv(content, contentDiv, {
      useCache: true,
      muteVideo: true,
      loopVideo: true,
    });

    container.appendChild(contentDiv);
  }

  /**
   * May a content frame navigate to this URL?
   *
   * Two refusals, both anchored to the running document rather than to a list:
   *  - anything that is not http(s). `javascript:` executes in the frame's context,
   *    `data:`/`blob:` inherit nothing useful but bypass every network control, and
   *    `file:` reads the device's own storage.
   *  - anything on the APP's OWN origin. Under Capacitor the app document is served
   *    from `https://localhost` (androidScheme: 'https', no hostname), and the local
   *    server injects the Capacitor bridge into every frame it serves — so a frame at
   *    the app origin, granted allow-same-origin, can read the device JWT straight
   *    out of SecureStorage through `parent`.
   *
   * Relative URLs resolve against the app document, which is the same resolution the
   * iframe would do — so `/whatever` is correctly judged app-origin and refused.
   */
  private static isRenderableFrameUrl(candidate: string): boolean {
    const here = (window as unknown as { location?: { href?: string; origin?: string } }).location;
    let url: URL;
    try {
      url = here?.href ? new URL(candidate, here.href) : new URL(candidate);
    } catch {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (here?.origin && url.origin === here.origin) return false;
    return true;
  }

  // ==================== HTML CONTENT SECURITY ====================

  /**
   * Injects a Content-Security-Policy meta tag into HTML content.
   * Security model: iframe sandbox (allow-scripts only) + restrictive CSP.
   * This does NOT sanitize HTML — it relies on CSP to block network access
   * and sandbox to prevent parent DOM access.
   */
  private injectContentSecurityPolicy(html: string): string {
    return injectContentSecurityPolicy(html);
  }

  // ==================== SHARED CONTENT RENDERER ====================

  /**
   * Renders a content element into a container. Used by playlist playback,
   * temporary push content, and multi-zone layout to avoid triplicated logic.
   *
   * Returns a `ready` promise the playback engine races against a deadline:
   * 'ready' once the asset is renderable, 'error' if it failed. Types without
   * reliable readiness signals (webpage/html/template) resolve immediately.
   */
  private async renderContentToDiv(
    content: { id: string; name: string; type: string; url: string; mimeType?: string },
    contentDiv: HTMLElement,
    options?: {
      useCache?: boolean;
      onVideoEnd?: () => void;
      onError?: (contentName: string) => void;
      muteVideo?: boolean;
      loopVideo?: boolean;
    },
  ): Promise<{ ready: Promise<'ready' | 'error'> }> {
    const contentType = content.type;
    const useCache = options?.useCache ?? true;
    let ready: Promise<'ready' | 'error'> = Promise.resolve('ready');

    // Transform URL (skip for HTML/template which contain raw markup).
    //
    // The device JWT is withheld for `webpage`/`url` (S3). transformContentUrl's
    // rationale for appending it — "img/video tags can't send headers" — does not
    // apply to a FRAME NAVIGATION: the token lands in the frame's own document URL,
    // where any script in that document can read it off `location`, and the TV
    // engines put it in the `Referer` of every sub-resource the page fetches. Same
    // origin or not, a signage page never needs to be handed the device credential.
    const isFrameNavigation = contentType === 'webpage' || contentType === 'url';
    const contentUrl = (contentType === 'html' || contentType === 'template')
      ? content.url
      : transformContentUrl(
          content.url,
          this.config.apiUrl,
          isFrameNavigation ? null : this.deviceToken,
          { rewriteLocalhostForEmulator: isNativeCapacitor() },
        );

    // Resolve through cache for media content
    let resolvedUrl = contentUrl;
    if (useCache && (contentType === 'image' || contentType === 'video')) {
      try {
        const cachedUri = await this.cacheManager.getCachedUri(content.id);
        if (cachedUri) {
          resolvedUrl = cachedUri;
        } else {
          const downloaded = await this.cacheManager.downloadContent(
            content.id,
            contentUrl,
            content.mimeType || (contentType === 'video' ? 'video/mp4' : 'image/jpeg'),
          );
          if (downloaded) {
            resolvedUrl = downloaded;
          }
        }
      } catch {
        // Fall through to use direct URL
      }
    }

    const handleError = () => {
      if (options?.onError) options.onError(content.name);
    };

    switch (contentType) {
      case 'image': {
        const img = document.createElement('img');
        ready = new Promise(resolve => {
          img.onload = () => resolve('ready');
          img.onerror = () => {
            handleError();
            resolve('error');
          };
        });
        img.src = resolvedUrl;
        img.alt = content.name;
        contentDiv.appendChild(img);
        break;
      }
      case 'video': {
        const video = document.createElement('video');
        ready = new Promise(resolve => {
          video.onloadeddata = () => resolve('ready');
          video.onerror = () => {
            handleError();
            resolve('error');
          };
        });
        video.src = resolvedUrl;
        video.autoplay = true;
        video.muted = options?.muteVideo ?? false;
        video.playsInline = true;
        if (options?.loopVideo) video.loop = true;
        video.setAttribute('x5-video-player-type', 'h5');
        video.setAttribute('x5-video-player-fullscreen', 'true');
        if (options?.onVideoEnd) video.onended = options.onVideoEnd;
        contentDiv.appendChild(video);
        break;
      }
      case 'webpage':
      case 'url': {
        // REFUSE the navigation before an element exists, not after (B2).
        //
        // Two unguarded things met here. First, `content.url` reached iframe.src with
        // no scheme validation at all, so `javascript:` / `data:` / `file:` were
        // client-side unchecked. Second — and the reason the origin check is not
        // optional — the app document is NOT served from an unmatchable app scheme.
        // capacitor.config.ts sets `androidScheme: 'https'` with no `hostname`, so
        // the Android app origin is exactly `https://localhost`, which a content item
        // can name. Granted allow-same-origin below, such a frame is same-origin with
        // the app document; Capacitor's WebViewLocalServer serves dist/index.html
        // WITH the bridge injected for every frame, so the frame can call
        // `parent.Capacitor.Plugins.SecureStorage.get({key:'device_token'})` and hand
        // the device JWT to an attacker socket — reachable today, because the
        // backend's PATCH /content/:id does not run the validateUrl that POST does.
        //
        // Anchored to location.origin rather than a scheme allowlist so this stays
        // correct if androidScheme/hostname ever change.
        if (!VizoraAndroidTV.isRenderableFrameUrl(contentUrl)) {
          console.warn(`[Vizora] Refusing to frame ${content.id}: unsafe scheme or app-origin URL`);
          reportEvent('frame_url_refused', { contentId: content.id, type: contentType });
          // Treated as an ordinary content error so the engine SKIPS to the next item
          // (prepare() returns null on 'error') instead of dead-airing on a blocked
          // frame. handleError also drives the post-commit advance path.
          handleError();
          ready = Promise.resolve('error');
          break;
        }

        const iframe = document.createElement('iframe');
        // `allow-top-navigation` is DELIBERATELY excluded. This build targets old
        // Chromium (Tizen 4 ≈ 56, webOS 4 ≈ 53), where an un-sandboxed frame can run
        // `top.location = '…'` with no user gesture and replace the app document —
        // socket, heartbeat, state machine and the `reload` command all gone, with no
        // onRenderProcessGone and nothing for the Java crash handler to see. Recovery
        // would be a manual power cycle. allow-scripts + allow-same-origin keeps
        // ordinary signage pages (dashboards, widgets) working — most real pages
        // break outright under an opaque origin, so dropping it is not an option on
        // the TV platforms.
        iframe.sandbox.add('allow-scripts');
        // …but NOT on the plain-web platform, where the app document is served over
        // http(s) from a host a `webpage` item can also point at. The origin guard
        // above now refuses that URL on EVERY platform, so this is defence in depth
        // rather than the only line: a same-origin frame with allow-same-origin can
        // reach `parent`, strip this very sandbox attribute and reload itself
        // unsandboxed, giving back everything the sandbox took away.
        if (detectPlatform() !== 'web') {
          iframe.sandbox.add('allow-same-origin');
        }
        iframe.src = contentUrl;
        iframe.allow = 'autoplay; fullscreen';
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        iframe.onerror = handleError;
        contentDiv.appendChild(iframe);
        break;
      }
      case 'html':
      case 'template': {
        const iframe = document.createElement('iframe');
        iframe.sandbox.add('allow-scripts');
        const rawContent = content as unknown as Record<string, unknown>;
        const meta = rawContent.metadata as Record<string, unknown> | undefined;
        const htmlSource = (meta?.renderedHtml as string) || content.url;
        iframe.srcdoc = this.injectContentSecurityPolicy(htmlSource);
        iframe.style.cssText = 'width:100%;height:100%;border:none;';
        // onerror doesn't fire for srcdoc iframes; use load timeout as fallback
        const loadTimer = setTimeout(() => handleError(), 10_000);
        iframe.onload = () => clearTimeout(loadTimer);
        contentDiv.appendChild(iframe);
        break;
      }
      default:
        console.warn('[Vizora] Unknown content type:', contentType);
        ready = Promise.resolve('error');
    }

    return { ready };
  }

  // ==================== MEDIA CLEANUP ====================

  private cleanupMediaElements(container: HTMLElement) {
    const videos = container.querySelectorAll('video');
    videos.forEach(video => {
      video.pause();
      video.removeAttribute('src');
      video.load(); // forces release of media resources
    });
  }

  // ==================== UI HELPERS ====================
  //
  // Screen visibility is owned exclusively by the ScreenStateMachine
  // (src/screen-state.ts). There is deliberately no showScreen/showError
  // helper here — an arbitrary code path must not be able to blank the
  // display or surface a raw error while renderable content exists.

  private setHoldingMessage(message: string) {
    const el = document.getElementById('holding-message');
    if (el) el.textContent = message;
  }

  private showOfflineOverlay() {
    const existing = document.getElementById('offline-overlay');
    if (existing) return;
    const overlay = document.createElement('div');
    overlay.id = 'offline-overlay';
    overlay.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:rgba(0,0,0,0.8);color:#fff;text-align:center;padding:16px;z-index:9999;font-size:18px;';
    overlay.textContent = 'Device is offline — reconnecting...';
    document.body.appendChild(overlay);
  }

  private hideOfflineOverlay() {
    const overlay = document.getElementById('offline-overlay');
    if (overlay) overlay.remove();
  }

  private updateStatus(status: 'online' | 'offline' | 'connecting', text: string) {
    const dot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    if (dot) {
      dot.className = 'status-dot ' + status;
    }
    if (statusText) {
      statusText.textContent = text;
    }

    // Signage runs unattended for months, so a permanent "Connected" badge is
    // just burn-in risk and a distraction on customer-facing glass. Show the bar
    // only when there is something worth telling someone about: `connecting` and
    // `offline` stay visible, `online` hides.
    //
    // Hidden by class, not removed from the DOM, so the next non-online status
    // brings it straight back without re-creating any nodes. `.hidden` is the
    // primitive already used for the overlay elsewhere in this file, and its
    // `display: none !important` is what overrides `.status-bar`'s `display: flex`.
    const statusBar = document.getElementById('status-bar');
    if (statusBar) {
      statusBar.classList.toggle('hidden', status === 'online');
    }
  }

  private async getDeviceInfo() {
    // Get network info
    const networkStatus = await Network.getStatus();

    return {
      platform: platformDeviceType(),
      userAgent: navigator.userAgent,
      language: navigator.language,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      colorDepth: window.screen.colorDepth,
      pixelRatio: window.devicePixelRatio,
      networkType: networkStatus.connectionType,
      timestamp: new Date().toISOString(),
    };
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new VizoraAndroidTV());
} else {
  new VizoraAndroidTV();
}
