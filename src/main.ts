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
  initTvPlatform,
  isNativeCapacitor,
  isTvBackKey,
  platformDeviceType,
  platformIdentifierPrefix,
} from './platform';
import { SecureStorage } from './secure-storage';
import { transformContentUrl, injectContentSecurityPolicy, computePlaylistSignature, shouldApplyContent } from './utils';
import { ScreenStateMachine } from './screen-state';
import { initCrashReporting, setCrashReportingDevice, reportEvent } from './crash-reporting';

initCrashReporting();

declare const __APP_VERSION__: string;

// Configuration - can be overridden via URL params or stored preferences
const DEFAULT_CONFIG = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  realtimeUrl: import.meta.env.VITE_REALTIME_URL || 'http://localhost:3002',
  dashboardUrl: import.meta.env.VITE_DASHBOARD_URL || 'http://localhost:3001',
};

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
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private offlineTimeout: ReturnType<typeof setTimeout> | null = null;
  private config: Config = DEFAULT_CONFIG;
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

    // Setup Capacitor plugins
    await this.setupCapacitor();

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
      let tenantReadFailed = false;
      try {
        const storedTenant = await SecureStorage.get({ key: 'tenant_id' });
        this.tenantId = storedTenant.value;
      } catch (err) {
        console.warn('[Vizora] tenant_id read failed — booting in grace mode (F42):', err);
        reportEvent('tenant_read_failed', {});
        this.tenantId = null;
        tenantReadFailed = true;
      }
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
            await Preferences.remove({ key: 'last_playlist' });
            await this.cacheManager.clearCache();
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

      // Start playback immediately from the restored playlist (don't wait for
      // the WebSocket — BUG #7). The loading screen stays up until the first
      // frame commits; the machine enters PLAYING at commit time, so there is
      // no window where the content screen shows an empty container.
      if (this.currentPlaylist && this.currentPlaylist.items?.length > 0) {
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
        await SecureStorage.set({ key: 'device_token', value: plainToken.value });
        if (plainDeviceId.value) {
          await SecureStorage.set({ key: 'device_id', value: plainDeviceId.value });
        }
        // Remove plaintext credentials
        await Preferences.remove({ key: 'device_token' });
        await Preferences.remove({ key: 'device_id' });
        console.log('[Vizora] Credential migration complete');
      }
    } catch (error) {
      console.error('[Vizora] Credential migration failed:', error);
    }
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

      // Generate/display QR code
      if (data.qrCode) {
        this.displayQRCode(data.qrCode);
      } else {
        await this.generateQRCode(data.code);
      }

      // Start polling for pairing completion
      this.startPairingCheck();

      this.updateStatus('connecting', 'Waiting for pairing...');
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
        // socket connection.
        if (!this.pairingCode) return;

        if (data.status === 'paired' && typeof data.deviceToken === 'string' && data.deviceToken) {
          console.log('[Vizora] Device paired successfully!');
          this.pairingCode = null;
          this.stopPairingCheck();
          this.stopPairingCountdown();
          this.pairingRetryCount = 0;

          this.deviceToken = data.deviceToken;
          if (typeof data.deviceId === 'string') {
            this.deviceId = data.deviceId;
          }

          // Store credentials in encrypted storage
          await SecureStorage.set({ key: 'device_token', value: data.deviceToken });
          await SecureStorage.set({ key: 'device_id', value: this.deviceId || '' });
          // Tenant identity binds the cache/playlist (contract §2). Absent on
          // the legacy backend — the load-time check degrades to grace mode.
          if (typeof data.tenantId === 'string' && data.tenantId) {
            this.tenantId = data.tenantId;
            await SecureStorage.set({ key: 'tenant_id', value: data.tenantId });
          }
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
          ack.commands.forEach((cmd) => this.handleCommand(cmd));
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
  private async pullContent(): Promise<void> {
    if (!this.deviceToken || !this.isOnline) return;
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
      this.applyPulledContent(payload);
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
  ): void {
    if (!payload) return;
    const incoming = { playlistId: payload.playlist?.id ?? null, version: payload.version ?? '' };
    const current = { playlistId: this.currentContentPlaylistId, version: this.currentContentVersion };
    if (!shouldApplyContent(incoming, current)) return; // stale/duplicate → no-op, no re-flash
    this.currentContentVersion = incoming.version;
    this.currentContentPlaylistId = incoming.playlistId;
    if (payload.playlist) {
      this.updatePlaylist(payload.playlist);
    }
  }

  // ==================== REALTIME CONNECTION ====================

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
      auth: {
        token: this.deviceToken,
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 60000,
      randomizationFactor: 0.5,
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

      // A successful handshake means the tenant is active — clear any stale
      // suspension latch so playback can resume (F41). The block below owns the
      // actual resume; do not double-render here.
      if (this.tenantSuspended) {
        this.exitTenantSuspended('reconnect_active');
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

    this.socket.on('playlist:update', (data) => {
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
        this.applyPulledContent({ version: data.version, playlist });
      } else {
        this.updatePlaylist(playlist);
      }
    });

    this.socket.on('command', (command) => {
      console.log('[Vizora] Received command:', command);
      this.handleCommand(command);
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
      await this.purgeDeviceState(`revocation_confirmed:${source}`);
      if (source === 'unpair_command') {
        window.location.reload();
      } else {
        this.startPairing();
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

  /** Tenant suspension: fail closed for rendering, keep credentials (§3.1). */
  private enterTenantSuspended(source: string) {
    console.warn('[Vizora] Tenant suspended:', source);
    reportEvent('tenant_suspended', { source });
    this.tenantSuspended = true;
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
    reportEvent('tenant_unsuspended', { source });
  }

  /**
   * Destroy all tenant-bound device state. Only reachable via a confirmed
   * revocation (§3.4) or the legacy unpair carve-out (§7.1a).
   */
  private async purgeDeviceState(reason: string) {
    console.warn('[Vizora] Purging device state:', reason);
    reportEvent('device_purged', { reason });

    // Halt playback first: no further frame of this tenant's content renders.
    this.playbackGeneration++;
    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.temporaryContentTimer) {
      clearTimeout(this.temporaryContentTimer);
      this.temporaryContentTimer = null;
    }
    this.exitAuthDegraded();
    this.tenantSuspended = false;
    this.currentPlaylist = null;
    this.savedPlaylistState = null;
    this.temporaryContent = null;
    this.deviceToken = null;
    this.deviceId = null;
    this.tenantId = null;
    setCrashReportingDevice(null);

    if (this.socket) {
      this.stopHeartbeat();
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }

    await SecureStorage.remove({ key: 'device_token' });
    await SecureStorage.remove({ key: 'device_id' });
    await SecureStorage.remove({ key: 'tenant_id' });
    await Preferences.remove({ key: 'last_playlist' });
    await this.cacheManager.clearCache();
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
    } catch (err) {
      console.warn('[Vizora] Failed to persist playlist:', err);
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

  // ==================== COMMANDS ====================

  private async handleCommand(command: { type: string; payload?: Record<string, unknown>; [key: string]: unknown }) {
    switch (command.type) {
      case 'reload':
        window.location.reload();
        break;

      case 'clear_cache':
        await this.cacheManager.clearCache();
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

      default:
        console.warn('[Vizora] Unknown command:', command.type);
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

  private async renderQrOverlay(config: QrOverlayConfig | undefined) {
    const overlay = document.getElementById('qr-overlay');
    if (!overlay) return;

    if (!config || !config.enabled) {
      overlay.classList.add('hidden');
      while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
      return;
    }
    overlay.innerHTML = '';
    overlay.className = config.position || 'bottom-right';
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

    if (config.position === 'top-left') { overlay.style.top = margin + 'px'; overlay.style.left = margin + 'px'; }
    else if (config.position === 'top-right') { overlay.style.top = margin + 'px'; overlay.style.right = margin + 'px'; }
    else if (config.position === 'bottom-left') { overlay.style.bottom = margin + 'px'; overlay.style.left = margin + 'px'; }
    else { overlay.style.bottom = margin + 'px'; overlay.style.right = margin + 'px'; }

    const size = config.size || 120;
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

    // Transform URL (skip for HTML/template which contain raw markup)
    const contentUrl = (contentType === 'html' || contentType === 'template')
      ? content.url
      : transformContentUrl(content.url, this.config.apiUrl, this.deviceToken, {
          rewriteLocalhostForEmulator: isNativeCapacitor(),
        });

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
        const iframe = document.createElement('iframe');
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
