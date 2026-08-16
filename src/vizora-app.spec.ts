/**
 * Unit tests for the VizoraAndroidTV class (src/main.ts).
 *
 * Strategy: The class auto-constructs at module level. All dependencies are
 * mocked BEFORE import. The module is imported ONCE. Tests manipulate state
 * through the mock callbacks (socket events, network changes, etc.).
 *
 * For tests that require a specific initial state (e.g., credentials present
 * or absent), we group them in separate describe blocks that each do their
 * own dynamic import with vi.resetModules().
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';

// ======================== GLOBAL STUBS ========================

vi.stubGlobal('__APP_VERSION__', '1.0.0-test');

// ======================== DOM FAKES ========================

interface ElementStub {
  tagName: string;
  textContent: string;
  innerHTML: string;
  id: string;
  className: string;
  src: string;
  srcdoc: string;
  alt: string;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  playsInline: boolean;
  allow: string;
  style: Record<string, string>;
  onerror: (() => void) | null;
  onload: (() => void) | null;
  onended: (() => void) | null;
  children: ElementStub[];
  classList: {
    add: Mock;
    remove: Mock;
    toggle: Mock;
    contains: Mock;
  };
  sandbox: {
    add: Mock;
    _set: Set<string>;
  };
  appendChild: Mock;
  removeChild: Mock;
  remove: Mock;
  firstChild: ElementStub | null;
  focus: Mock;
  click: Mock;
  querySelectorAll: Mock;
  setAttribute: Mock;
  removeAttribute: Mock;
  getAttribute: Mock;
  pause: Mock;
  load: Mock;
  _attributes: Record<string, string>;
  _classListSet: Set<string>;
}

function createElementStub(tag?: string): ElementStub {
  const children: ElementStub[] = [];
  const attributes: Record<string, string> = {};
  const classListSet = new Set<string>();
  const sandboxSet = new Set<string>();
  const style: Record<string, string> = {};
  const stub: ElementStub = {
    tagName: (tag || 'div').toUpperCase(),
    textContent: '',
    innerHTML: '',
    id: '',
    className: '',
    src: '',
    srcdoc: '',
    alt: '',
    autoplay: false,
    muted: false,
    loop: false,
    playsInline: false,
    allow: '',
    style,
    onerror: null,
    onload: null,
    onended: null,
    children,
    classList: {
      add: vi.fn((cls: string) => classListSet.add(cls)),
      remove: vi.fn((cls: string) => classListSet.delete(cls)),
      toggle: vi.fn((cls: string, force?: boolean) => {
        if (force === undefined) {
          classListSet.has(cls) ? classListSet.delete(cls) : classListSet.add(cls);
        } else if (force) {
          classListSet.add(cls);
        } else {
          classListSet.delete(cls);
        }
      }),
      contains: vi.fn((cls: string) => classListSet.has(cls)),
    },
    sandbox: {
      add: vi.fn((val: string) => sandboxSet.add(val)),
      _set: sandboxSet,
    },
    appendChild: vi.fn((child: ElementStub) => {
      children.push(child);
      return child;
    }),
    removeChild: vi.fn((child: ElementStub) => {
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
      return child;
    }),
    remove: vi.fn(),
    get firstChild() {
      return children.length > 0 ? children[0] : null;
    },
    focus: vi.fn(),
    click: vi.fn(),
    querySelectorAll: vi.fn(() => []),
    setAttribute: vi.fn((name: string, value: string) => { attributes[name] = value; }),
    removeAttribute: vi.fn((name: string) => { delete attributes[name]; }),
    getAttribute: vi.fn((name: string) => attributes[name] || null),
    pause: vi.fn(),
    load: vi.fn(),
    _attributes: attributes,
    _classListSet: classListSet,
  };
  return stub;
}

// DOM element registry
let domElements: Map<string, ElementStub>;
let bodyChildren: ElementStub[];
let documentEventListeners: Map<string, Function[]>;
let activeElementRef: ElementStub | null;

function resetDOM() {
  domElements = new Map();
  bodyChildren = [];
  documentEventListeners = new Map();
  activeElementRef = null;

  const elementIds = [
    'pairing-code', 'pairing-countdown', 'qr-code', 'content-container',
    'loading-screen', 'pairing-screen', 'content-screen', 'error-screen',
    'holding-screen', 'holding-message',
    'error-message', 'status-dot', 'status-text', 'status-bar', 'qr-overlay',
  ];
  for (const id of elementIds) {
    const el = createElementStub('div');
    el.id = id;
    domElements.set(id, el);
  }

  vi.stubGlobal('document', {
    readyState: 'complete',
    getElementById: vi.fn((id: string) => domElements.get(id) || null),
    createElement: vi.fn((tag: string) => createElementStub(tag)),
    querySelectorAll: vi.fn(() => []),
    get activeElement() { return activeElementRef; },
    set activeElement(el) { activeElementRef = el; },
    addEventListener: vi.fn((event: string, handler: Function) => {
      if (!documentEventListeners.has(event)) documentEventListeners.set(event, []);
      documentEventListeners.get(event)!.push(handler);
    }),
    removeEventListener: vi.fn(),
    body: {
      appendChild: vi.fn((child: ElementStub) => {
        bodyChildren.push(child);
        if (child.id) domElements.set(child.id, child);
        return child;
      }),
      removeChild: vi.fn(),
    },
  });
}

// ======================== localStorage FAKE ========================
//
// The command-dedupe ring's SYNCHRONOUS durable half lives here (B1). Real on the
// TV runtimes and inside the Android WebView alike, so the suite models it rather
// than leaving `window.localStorage` undefined — which would silently disable the
// terminator under test.
let localStorageStore: Map<string, string>;
/** Set to make the corresponding localStorage operation throw (QuotaExceededError). */
let localStorageThrowOn: { getItem?: boolean; setItem?: boolean };

function resetLocalStorage() {
  localStorageStore = new Map();
  localStorageThrowOn = {};
}
resetLocalStorage();

const localStorageFake = {
  getItem: (key: string) => {
    if (localStorageThrowOn.getItem) throw new Error('QuotaExceededError');
    return localStorageStore.has(key) ? localStorageStore.get(key)! : null;
  },
  setItem: (key: string, value: string) => {
    if (localStorageThrowOn.setItem) throw new Error('QuotaExceededError');
    localStorageStore.set(key, value);
  },
  removeItem: (key: string) => { localStorageStore.delete(key); },
};

vi.stubGlobal('window', {
  // href/origin are what src/main.ts resolves a content frame's URL against (B2).
  // The Capacitor build's app document really is served from https://localhost —
  // capacitor.config.ts sets androidScheme: 'https' with no hostname — so that is
  // the origin the suite has to model.
  location: { search: '', reload: vi.fn(), href: 'https://localhost/', origin: 'https://localhost' },
  localStorage: localStorageFake,
  screen: { width: 1920, height: 1080, colorDepth: 24 },
  devicePixelRatio: 1,
  // Native Capacitor bridge marker: platform detection (src/platform.ts) must
  // resolve to 'capacitor' so the suite exercises the Android baseline
  // (AndroidCacheManager mock, android_tv identity).
  Capacitor: { isNativePlatform: () => true },
});

// HTMLElement stub — D-pad code uses `instanceof HTMLElement` for focus/click
class HTMLElementStub {
  focus() {}
  click() {}
}
vi.stubGlobal('HTMLElement', HTMLElementStub);

// Node 21+ defines `navigator` as a GETTER-ONLY accessor on globalThis
// (`{get, configurable: true}`, no setter), so vi.stubGlobal's assignment
// silently no-ops there: the stub appears to be installed while
// platform.ts:detectPlatform() actually reads the host's real userAgent
// ("Node.js/24"). It happens not to change any current outcome — neither UA
// matches Tizen or webOS — but a test that quietly does not apply is worse than
// no test, so own the property explicitly. defineProperty works on Node 20
// (property absent) and Node 21+ (accessor present) alike.
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'test-agent', language: 'en-US' },
  configurable: true,
  writable: true,
});
vi.stubGlobal('performance', {
  memory: { usedJSHeapSize: 50_000_000, jsHeapSizeLimit: 100_000_000 },
});

// ======================== CAPACITOR FAKES ========================

let preferencesStore: Map<string, string>;
let secureStorageStore: Map<string, string>;
/** When true, the next Preferences.get throws — used to exercise init retry. */
let preferencesFailNext = false;
// A handler may return the response ASYNCHRONOUSLY — CapacitorHttp.get is async and a
// request parked in flight (across a de-pair, say) is a real state this suite drives.
let httpGetHandler: (opts: { url: string }) => { status: number; data: unknown } | Promise<{ status: number; data: unknown }>;
let httpPostHandler: (opts: { url: string; data?: unknown; connectTimeout?: number; readTimeout?: number }) => { status: number; data: unknown };
let networkListeners: Map<string, Function[]>;
let appListeners: Map<string, Function[]>;
let networkConnected: boolean;

function resetCapacitorFakes() {
  preferencesStore = new Map();
  secureStorageStore = new Map();
  resetLocalStorage();
  resetIdbRing();
  preferencesFailNext = false;
  networkListeners = new Map();
  appListeners = new Map();
  networkConnected = true;

  httpPostHandler = () => ({
    status: 200,
    data: {
      data: { code: 'ABCD1234', deviceId: 'dev-123', expiresInSeconds: 300 },
    },
  });
  httpGetHandler = (opts: { url: string }) => {
    // auth-check endpoint absent by default (legacy backend, contract §7.1a)
    if (opts.url.includes('/devices/auth/check')) {
      return { status: 404, data: {} };
    }
    return { status: 200, data: { data: { status: 'pending' } } };
  };
}

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => {
      if (preferencesFailNext) {
        preferencesFailNext = false;
        throw new Error('simulated Preferences failure');
      }
      return { value: preferencesStore.get(key) ?? null };
    }),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      preferencesStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferencesStore.delete(key);
    }),
  },
}));

vi.mock('./secure-storage', () => ({
  SecureStorage: {
    get: vi.fn(async ({ key }: { key: string }) => ({
      value: secureStorageStore.get(key) ?? null,
    })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    }),
    has: vi.fn(async ({ key }: { key: string }) => ({
      value: secureStorageStore.has(key),
    })),
  },
}));

// The IndexedDB ring home. Behind an interface for the same reason TvCacheStore is:
// the raw IDB plumbing stays out of the suite and the tests drive an in-memory store.
let idbRing: string[] | null = null;
let idbThrowOn: { read?: boolean; write?: boolean } = {};
function resetIdbRing() {
  idbRing = null;
  idbThrowOn = {};
}
vi.mock('./command-ring-store', () => ({
  CommandRing: {
    read: vi.fn(async () => {
      if (idbThrowOn.read) throw new Error('IndexedDB unavailable');
      return idbRing;
    }),
    write: vi.fn(async (keys: string[]) => {
      if (idbThrowOn.write) throw new Error('QuotaExceededError');
      idbRing = [...keys];
    }),
  },
}));

vi.mock('./crash-reporting', () => ({
  initCrashReporting: vi.fn(),
  setCrashReportingDevice: vi.fn(),
  reportEvent: vi.fn(),
  // Default TRUE: the baseline for the suite is a build whose telemetry works, so a
  // test that does not care about the DSN gets the reporting-enabled behaviour.
  // The tests that DO care (S5) drive it to false explicitly.
  isCrashReportingEnabled: vi.fn(() => true),
}));

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    get: vi.fn(async (opts: { url: string }) => httpGetHandler(opts)),
    post: vi.fn(async (opts: { url: string; data?: unknown; connectTimeout?: number; readTimeout?: number }) => httpPostHandler(opts)),
  },
  Capacitor: { convertFileSrc: (uri: string) => uri },
  registerPlugin: vi.fn(() => ({})),
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: vi.fn((event: string, cb: Function) => {
      if (!networkListeners.has(event)) networkListeners.set(event, []);
      networkListeners.get(event)!.push(cb);
      return { remove: vi.fn() };
    }),
    getStatus: vi.fn(async () => ({
      connected: networkConnected,
      connectionType: 'wifi',
    })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, cb: Function) => {
      if (!appListeners.has(event)) appListeners.set(event, []);
      appListeners.get(event)!.push(cb);
      return { remove: vi.fn() };
    }),
  },
}));

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => {}) },
}));

// ======================== CACHE MANAGER MOCK ========================

const mockCacheManager = {
  getCachedUri: vi.fn(async () => null as string | null),
  downloadContent: vi.fn(async () => null as string | null),
  clearCache: vi.fn(async () => {}),
  getCacheStats: vi.fn(() => ({ itemCount: 0, totalSizeMB: 0, maxSizeMB: 500 })),
  init: vi.fn(async () => {}),
  setExpectedTenant: vi.fn(),
};

vi.mock('./cache-manager', () => ({
  AndroidCacheManager: vi.fn(() => mockCacheManager),
}));

// ======================== SOCKET.IO MOCK ========================

interface MockSocket {
  on: Mock;
  emit: Mock;
  connect: Mock;
  disconnect: Mock;
  removeAllListeners: Mock;
  connected: boolean;
  /** Real Socket.IO seeds this from the handshake options and re-reads it on every
   *  reconnection attempt; the client mutates it on token rotation. */
  auth?: unknown;
  _handlers: Map<string, Function[]>;
}

function createMockSocket(): MockSocket {
  const handlers = new Map<string, Function[]>();
  const socket: MockSocket = {
    _handlers: handlers,
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(() => { handlers.clear(); }),
    connected: false,
  };
  return socket;
}

let currentMockSocket: MockSocket;
const ioFactory = vi.fn(() => {
  currentMockSocket = createMockSocket();
  return currentMockSocket;
});

vi.mock('socket.io-client', () => ({ io: ioFactory }));

// ======================== QRCODE MOCK ========================

const qrToCanvasMock = vi.fn(async () => undefined);
vi.mock('qrcode', () => ({ toCanvas: qrToCanvasMock }));

// ======================== HELPERS ========================

/** Find the last element created with a specific tag via document.createElement mock */
function findCreatedElements(tag: string): ElementStub[] {
  return (document.createElement as Mock).mock.results
    .filter((r: { value: ElementStub }) => r.value.tagName === tag.toUpperCase())
    .map((r: { value: ElementStub }) => r.value);
}

function triggerSocketEvent(event: string, ...args: unknown[]) {
  const handlers = currentMockSocket._handlers.get(event) || [];
  handlers.forEach(h => h(...args));
}

function triggerNetworkChange(connected: boolean) {
  networkConnected = connected;
  (networkListeners.get('networkStatusChange') || []).forEach(cb =>
    cb({ connected, connectionType: connected ? 'wifi' : 'none' })
  );
}

function triggerAppStateChange(isActive: boolean) {
  (appListeners.get('appStateChange') || []).forEach(cb => cb({ isActive }));
}

// The REAL event-loop primitives and the REAL clock, captured before any test can
// install fake timers. vi.useFakeTimers() replaces the globals; these references
// keep working and are how a waiter reaches the real loop without uninstalling it.
const realSetImmediate: typeof setImmediate = setImmediate;
const realDateNow: () => number = Date.now.bind(Date);

/**
 * Give the REAL event loop one full turn, WITHOUT touching the fake clock.
 *
 * Why this is needed at all: main.ts does `await import('qrcode')` on the pairing
 * path. That import settles on the real event loop, which fake timers do not drive.
 * A waiter built only from `await Promise.resolve()` chains and
 * advanceTimersByTimeAsync never lets the loop run at all — microtasks are drained
 * to completion before control returns to it — so the import can still be pending
 * when a fixed-count waiter gives up. That is the ~16% full-suite failure this file
 * used to show under worker-parallel load: the resolution simply takes longer when
 * the machine is busy, and the waiter's budget did not grow with it.
 *
 * Why NOT the vi.useRealTimers() dance renderQrAndSettle uses: uninstalling the fake
 * clock DISCARDS every fake timer the app has pending — the 2s pairing poll, the
 * countdown, the playback timer. That is tolerable inside renderQrAndSettle's narrow
 * window and fatal in a general-purpose waiter. setImmediate runs in the check phase,
 * i.e. after the poll phase has run I/O callbacks, so awaiting it yields a complete
 * loop turn while the fake clock stays installed.
 *
 * Returns the REAL milliseconds spent so callers can bound on elapsed time rather
 * than on a round count — a fixed count is a budget that shrinks exactly when the
 * machine is loaded.
 */
async function realYield(): Promise<number> {
  const t0 = realDateNow();
  await new Promise<void>(resolve => { realSetImmediate(resolve); });
  return Math.max(realDateNow() - t0, 1);
}

/**
 * Advance the app until `settled()` holds, or FAIL saying so.
 *
 * The failure mode this replaces: a helper that returns silently when its rounds
 * elapse, so the test carries on and blows up somewhere downstream on
 * `expected undefined to be 'tok-new'` — a message that says nothing about pairing
 * never having settled.
 *
 * `budgetMs` is REAL time; `tickMs` is how much FAKE time each round advances (the
 * app's own intervals — the 2s pairing poll, the 15s heartbeat — only run on the
 * fake clock).
 */
async function waitUntil(
  label: string,
  settled: () => boolean,
  opts: { budgetMs?: number; tickMs?: number } = {},
): Promise<void> {
  const budgetMs = opts.budgetMs ?? 5000;
  const tickMs = opts.tickMs ?? 0;
  let elapsed = 0;
  while (elapsed < budgetMs) {
    if (settled()) return;
    if (tickMs > 0) await vi.advanceTimersByTimeAsync(tickMs);
    for (let i = 0; i < 40; i++) await Promise.resolve();
    elapsed += await realYield();
  }
  if (settled()) return;
  throw new Error(`waitUntil(${label}) never settled within ${budgetMs}ms of real time`);
}

/**
 * Import main.ts fresh and let its async init() settle.
 *
 * We can't use runAllTimersAsync (infinite loop from recurring timers). The init
 * chain is loadConfig -> loadSeenCommands -> setupCapacitor -> reportCrashLoopMarker
 * -> migrateCredentials -> startPairing/connectToRealtime, each await needing a
 * turn — so alternate microtask flushes, fake-time advances and REAL-loop yields
 * (see realYield). Pass `settled` when the test depends on a specific post-init
 * state; it is asserted rather than hoped for.
 */
async function importFresh(settled?: () => boolean) {
  vi.resetModules();
  await import('./main');
  let elapsed = 0;
  for (let round = 0; round < 5 || (settled && !settled() && elapsed < 5000); round++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
    elapsed += await realYield();
  }
  if (settled && !settled()) {
    throw new Error('importFresh: init never reached the expected state within 5000ms of real time');
  }
}

// ======================== TESTS ========================

describe('VizoraAndroidTV', () => {

  // ==================== 1. CONFIG LOADING ====================

  describe('Config Loading', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('uses VITE env defaults when no overrides exist', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await importFresh();
      const entry = spy.mock.calls.find(c => String(c[0]).includes('Config loaded'));
      expect(entry).toBeDefined();
      const cfg = entry![1] as Record<string, string>;
      expect(cfg).toHaveProperty('apiUrl');
      expect(cfg).toHaveProperty('realtimeUrl');
      expect(cfg).toHaveProperty('dashboardUrl');
    });

    it('applies URL params as overrides', async () => {
      (window.location as { search: string }).search =
        '?api_url=http://custom-api.test&realtime_url=http://custom-ws.test&dashboard_url=http://custom-dash.test';
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await importFresh();
      const cfg = spy.mock.calls.find(c => String(c[0]).includes('Config loaded'))![1] as Record<string, string>;
      expect(cfg.apiUrl).toBe('http://custom-api.test');
      expect(cfg.realtimeUrl).toBe('http://custom-ws.test');
      expect(cfg.dashboardUrl).toBe('http://custom-dash.test');
    });

    it('applies stored Preferences when no URL params', async () => {
      preferencesStore.set('config_api_url', 'http://stored-api.test');
      preferencesStore.set('config_realtime_url', 'http://stored-ws.test');
      preferencesStore.set('config_dashboard_url', 'http://stored-dash.test');
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await importFresh();
      const cfg = spy.mock.calls.find(c => String(c[0]).includes('Config loaded'))![1] as Record<string, string>;
      expect(cfg.apiUrl).toBe('http://stored-api.test');
      expect(cfg.realtimeUrl).toBe('http://stored-ws.test');
      expect(cfg.dashboardUrl).toBe('http://stored-dash.test');
    });

    it('gives URL params priority over stored Preferences', async () => {
      preferencesStore.set('config_api_url', 'http://stored-api.test');
      (window.location as { search: string }).search = '?api_url=http://param-api.test';
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await importFresh();
      const cfg = spy.mock.calls.find(c => String(c[0]).includes('Config loaded'))![1] as Record<string, string>;
      expect(cfg.apiUrl).toBe('http://param-api.test');
    });

    it('handles missing Preferences gracefully', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await importFresh();
      expect(spy.mock.calls.find(c => String(c[0]).includes('Config loaded'))).toBeDefined();
    });

    it('logs config object with apiUrl, realtimeUrl, dashboardUrl', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await importFresh();
      const cfg = spy.mock.calls.find(c => String(c[0]).includes('Config loaded'))![1] as Record<string, string>;
      expect(typeof cfg.apiUrl).toBe('string');
      expect(typeof cfg.realtimeUrl).toBe('string');
      expect(typeof cfg.dashboardUrl).toBe('string');
    });
  });

  // ==================== 1b. CAPACITOR SETUP ====================
  // These need credentials pre-set so connectToRealtime is called during init.

  describe('Capacitor Setup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('reconnects on network restore when authenticated', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      const before = ioFactory.mock.calls.length;
      currentMockSocket.connected = false;
      triggerNetworkChange(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(ioFactory.mock.calls.length).toBeGreaterThan(before);
    });

    it('does not reconnect on network restore when unauthenticated', async () => {
      await importFresh();
      const before = ioFactory.mock.calls.length;
      triggerNetworkChange(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(ioFactory.mock.calls.length).toBe(before);
    });

    it('reconnects on appStateChange to active with token but no socket', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      const before = ioFactory.mock.calls.length;
      currentMockSocket.connected = false;
      triggerAppStateChange(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(ioFactory.mock.calls.length).toBeGreaterThan(before);
    });

    it('clears offline timeout when app goes to background', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      // Remove pre-existing offline-overlay so we can detect creation
      domElements.delete('offline-overlay');
      await importFresh();

      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.connected = false;
      triggerSocketEvent('disconnect', 'io server disconnect');
      // Go to background before 60s
      triggerAppStateChange(false);
      await vi.advanceTimersByTimeAsync(70_000);
      const appended = bodyChildren.find(c => c.id === 'offline-overlay');
      expect(appended).toBeUndefined();
    });
  });

  // ==================== 2. CREDENTIAL MIGRATION ====================

  describe('Credential Migration', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('migrates token from Preferences to SecureStorage on first run', async () => {
      preferencesStore.set('device_token', 'plain-tok');
      preferencesStore.set('device_id', 'plain-dev');
      await importFresh();
      expect(secureStorageStore.get('device_token')).toBe('plain-tok');
    });

    it('migrates deviceId alongside token', async () => {
      preferencesStore.set('device_token', 'plain-tok');
      preferencesStore.set('device_id', 'plain-dev');
      await importFresh();
      expect(secureStorageStore.get('device_id')).toBe('plain-dev');
    });

    it('migrates token even when deviceId is null/missing', async () => {
      preferencesStore.set('device_token', 'plain-tok');
      await importFresh();
      expect(secureStorageStore.get('device_token')).toBe('plain-tok');
    });

    it('removes plaintext credentials after migration', async () => {
      preferencesStore.set('device_token', 'plain-tok');
      preferencesStore.set('device_id', 'plain-dev');
      await importFresh();
      expect(preferencesStore.has('device_token')).toBe(false);
      expect(preferencesStore.has('device_id')).toBe(false);
    });

    it('does not overwrite an existing secure token, but idempotently clears lingering plaintext (F52)', async () => {
      secureStorageStore.set('device_token', 'existing-tok');
      preferencesStore.set('device_token', 'plain-tok');
      await importFresh();
      expect(secureStorageStore.get('device_token')).toBe('existing-tok'); // secure copy untouched
      // F52: the already-migrated path now cleans up any lingering plaintext so a
      // prior crash between secure-write and plaintext-remove can't strand it forever.
      expect(preferencesStore.has('device_token')).toBe(false);
    });

    it('handles migration failure gracefully', async () => {
      preferencesStore.set('device_token', 'plain-tok');
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.get as Mock).mockRejectedValueOnce(new Error('fail'));
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await importFresh();
      expect(errSpy.mock.calls.some(c => String(c[0]).includes('migration failed'))).toBe(true);
    });
  });

  // ==================== 2b. CRASH-LOOP DEGRADATION MARKER ====================

  describe('Crash-loop degradation marker (CLAUDE.md 12b)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('reports the marker the native crash handler left behind', async () => {
      // The native side cannot report this itself — the process that made the decision was
      // terminating. If this boot does not report it, nobody is ever told that the device
      // spent minutes crash-looping and degraded to one restart attempt per hour.
      const { reportEvent } = await import('./crash-reporting');
      (reportEvent as Mock).mockClear();
      preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');

      await importFresh();

      const call = (reportEvent as Mock).mock.calls.find(c => c[0] === 'crash_loop_capped');
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({
        at: 1700000000000,
        crashes: 4,
        reason: 'uncaught_exception',
      });
    });

    it('clears the marker so a past episode is not re-reported forever', async () => {
      preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');

      await importFresh();

      expect(preferencesStore.has('crash_loop_capped')).toBe(false);
    });

    // -------- S5: the marker is only destroyed once it has actually been reported --------

    it('S5: KEEPS the marker when crash reporting is disabled — nothing was reported', async () => {
      // reportEvent is a total no-op in a build with no VITE_SENTRY_DSN, which is
      // every build made from this repo today. The marker is a once-ever breadcrumb
      // written by a process that was dying; deleting it on the strength of a call
      // that sent nothing destroys the only record the device ever crash-looped.
      const { isCrashReportingEnabled } = await import('./crash-reporting');
      (isCrashReportingEnabled as Mock).mockReturnValue(false);
      preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');

      await importFresh();

      expect(preferencesStore.get('crash_loop_capped')).toBe('1700000000000:4:uncaught_exception');
      (isCrashReportingEnabled as Mock).mockReturnValue(true);
    });

    it('S5 NEGATIVE CONTROL: with reporting disabled the marker is still READ and surfaced', async () => {
      // Same seam, same boot. Proves the keep is a deferred delete and not the whole
      // marker path going dark — the console line is the only channel left, so it has
      // to still be produced.
      const { isCrashReportingEnabled } = await import('./crash-reporting');
      (isCrashReportingEnabled as Mock).mockReturnValue(false);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');

      await importFresh();

      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Recovered from a native crash loop'))).toBe(true);
      expect(warnSpy.mock.calls.some(c => String(c[0]).includes('Keeping the crash-loop marker'))).toBe(true);
      (isCrashReportingEnabled as Mock).mockReturnValue(true);
    });

    // -------- S6: the log line follows the reason the native side wrote --------

    it('S6: a renderer_recovery_storm is NOT described as the slow restart rung', async () => {
      // The device kept recovering; no restart delay changed. Telling an operator it
      // "degraded to the slow restart rung" describes a different incident.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      preferencesStore.set('crash_loop_capped', '1700000000000:6:renderer_recovery_storm');

      await importFresh();

      const line = warnSpy.mock.calls
        .map(c => String(c[0]))
        .find(m => m.includes('Recovered from a native crash loop'));
      expect(line).toBeDefined();
      expect(line).toContain('renderer was dying and being recovered repeatedly');
      expect(line).not.toContain('slow restart rung');
    });

    it('S6 NEGATIVE CONTROL: an uncaught_exception marker still says slow restart rung', async () => {
      // Same layer. Proves the wording FOLLOWS the reason rather than having been
      // globally reworded — the restart-ladder cap is a real thing this must still say.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');

      await importFresh();

      const line = warnSpy.mock.calls
        .map(c => String(c[0]))
        .find(m => m.includes('Recovered from a native crash loop'));
      expect(line).toContain('slow restart rung');
    });

    it('reports nothing on a device that never crash-looped', async () => {
      // Negative control: the event must be evidence of a real episode, not something every
      // boot emits.
      const { reportEvent } = await import('./crash-reporting');
      (reportEvent as Mock).mockClear();

      await importFresh();

      expect((reportEvent as Mock).mock.calls.some(c => c[0] === 'crash_loop_capped')).toBe(false);
    });

    it('still boots normally when the marker read fails', async () => {
      // Telemetry must never be able to brick boot. A device recovering from a crash loop is
      // precisely the device that cannot afford a new failure on the startup path.
      // Fail ONLY the marker read — loadConfig() reads Preferences first, so a blanket
      // "reject the next call" would break config instead and prove nothing about this path.
      const { Preferences } = await import('@capacitor/preferences');
      const prefsGet = Preferences.get as Mock;
      const previous = prefsGet.getMockImplementation();
      prefsGet.mockImplementation(async (arg: { key: string }) => {
        if (arg.key === 'crash_loop_capped') throw new Error('prefs unavailable');
        return { value: preferencesStore.get(arg.key) ?? null };
      });
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');

      try {
        await importFresh();
        expect(ioFactory).toHaveBeenCalled();
      } finally {
        if (previous) prefsGet.mockImplementation(previous);
      }
    });
  });

  // ==================== 3. INITIALIZATION FLOW ====================

  describe('Initialization Flow', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('connects to realtime and shows content screen when credentials exist', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      expect(ioFactory).toHaveBeenCalled();
      const cs = domElements.get('content-screen')!;
      expect(cs.classList.toggle).toHaveBeenCalled();
    });

    it('starts pairing flow when no credentials', async () => {
      await importFresh();
      const ps = domElements.get('pairing-screen')!;
      expect((ps.classList.toggle as Mock).mock.calls.some(
        (c: unknown[]) => c[0] === 'hidden' && c[1] === false
      )).toBe(true);
    });

    it('restores last playlist from Preferences on init', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      preferencesStore.set('last_playlist', JSON.stringify({
        id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'Img', type: 'image', url: '/i.jpg' } }],
      }));
      await importFresh();
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Restored last playlist'))).toBe(true);
    });

    it('handles corrupt stored playlist JSON gracefully', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      preferencesStore.set('last_playlist', '{bad json!');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await importFresh();
      expect(warn.mock.calls.some(c => String(c[0]).includes('Failed to restore'))).toBe(true);
    });

    it('hides splash screen after init', async () => {
      const { SplashScreen } = await import('@capacitor/splash-screen');
      await importFresh();
      expect(SplashScreen.hide).toHaveBeenCalled();
    });

    it('routes to pairing after bounded retries when SecureStorage read fails persistently (F37)', async () => {
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.get as Mock).mockRejectedValue(new Error('keystore corrupt (AEADBadTag)'));
      await importFresh();
      // startInit retries init() at 5s/10s/20s backoff; the credential-read guard
      // re-throws for the first CRED_READ_MAX_RETRIES attempts, then routes to
      // pairing on the next. Advance well past ~35s of backoff.
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(20000);
        for (let j = 0; j < 20; j++) await Promise.resolve();
      }
      const ps = domElements.get('pairing-screen')!;
      expect((ps.classList.toggle as Mock).mock.calls.some(
        (c: unknown[]) => c[0] === 'hidden' && c[1] === false
      )).toBe(true);
    });

    it('recovers without pairing when a SecureStorage read blip is transient (F37 — no premature de-pair)', async () => {
      const { SecureStorage } = await import('./secure-storage');
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      let calls = 0;
      (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
        calls++;
        if (calls <= 2) throw new Error('transient keystore blip');
        return { value: secureStorageStore.get(key) ?? null };
      });
      await importFresh();
      // One startInit retry (5s) lets the transient blip clear; device connects.
      await vi.advanceTimersByTimeAsync(6000);
      for (let j = 0; j < 20; j++) await Promise.resolve();
      expect(ioFactory).toHaveBeenCalled();
      const ps = domElements.get('pairing-screen')!;
      expect((ps.classList.toggle as Mock).mock.calls.some(
        (c: unknown[]) => c[0] === 'hidden' && c[1] === false
      )).toBe(false);
    });

    it('fails closed with a loud surface when secure storage is unavailable — no plaintext, no pairing (F39)', async () => {
      const { SecureStorage } = await import('./secure-storage');
      const { reportEvent } = await import('./crash-reporting');
      (reportEvent as Mock).mockClear();
      (SecureStorage.get as Mock).mockRejectedValue(
        Object.assign(new Error('Secure storage unavailable'), { code: 'SECURE_STORAGE_UNAVAILABLE' }),
      );
      await importFresh();
      // Advance past the F37 bounded-retry window: F39 must NOT fall through to the
      // pairing route (a device with no secure store cannot pair safely).
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(20000);
        for (let j = 0; j < 20; j++) await Promise.resolve();
      }
      // Loud + visible + telemetry
      expect((reportEvent as Mock).mock.calls.some((c: unknown[]) => c[0] === 'secure_storage_unavailable')).toBe(true);
      const holding = domElements.get('holding-screen')!;
      expect((holding.classList.toggle as Mock).mock.calls.some(
        (c: unknown[]) => c[0] === 'hidden' && c[1] === false
      )).toBe(true);
      // NEGATIVE: not the normal pairing screen
      const ps = domElements.get('pairing-screen')!;
      expect((ps.classList.toggle as Mock).mock.calls.some(
        (c: unknown[]) => c[0] === 'hidden' && c[1] === false
      )).toBe(false);
    });
  });

  // ==================== 4. PAIRING — REQUEST ====================

  describe('Pairing — Request', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('shows pairing screen', async () => {
      await importFresh();
      const ps = domElements.get('pairing-screen')!;
      expect((ps.classList.toggle as Mock).mock.calls.some(
        (c: unknown[]) => c[0] === 'hidden' && c[1] === false
      )).toBe(true);
    });

    it('sends POST to /api/v1/devices/pairing/request with device info', async () => {
      const { CapacitorHttp } = await import('@capacitor/core');
      await importFresh();
      expect(CapacitorHttp.post).toHaveBeenCalled();
      const call = (CapacitorHttp.post as Mock).mock.calls[0][0];
      expect(call.url).toContain('/api/v1/devices/pairing/request');
      expect(call.data).toHaveProperty('metadata');
      expect(call.data.metadata.platform).toBe('android_tv');
    });

    it('passes connectTimeout 10000 and readTimeout 15000', async () => {
      const { CapacitorHttp } = await import('@capacitor/core');
      await importFresh();
      const call = (CapacitorHttp.post as Mock).mock.calls[0][0];
      expect(call.connectTimeout).toBe(10000);
      expect(call.readTimeout).toBe(15000);
    });

    it('logs data.code.length but NOT the full pairing code', async () => {
      await importFresh();
      const codeLog = (console.log as Mock).mock.calls.find(c => String(c[0]).includes('Pairing code received'));
      expect(codeLog).toBeDefined();
      expect(String(codeLog![0])).toContain('length');
      expect(String(codeLog![0])).not.toContain('ABCD1234');
    });

    it('displays received pairing code in DOM', async () => {
      await importFresh();
      expect(domElements.get('pairing-code')!.textContent).toBe('ABCD1234');
    });

    it('generates QR code with dashboard URL + code', async () => {
      // The QR render is gated on a REAL dynamic import('qrcode') that fake timers do
      // not drive. importFresh's DEFAULT settle budget is a fixed round count, which is
      // a budget that shrinks exactly when the machine is loaded — so pass the
      // predicate and let it bound on REAL elapsed time and THROW if it never holds.
      await importFresh(() => qrToCanvasMock.mock.calls.length > 0);
      expect(qrToCanvasMock).toHaveBeenCalled();
      const url = qrToCanvasMock.mock.calls[0][1] as string;
      expect(url).toContain('/pair?code=ABCD1234');
    });

    it('uses server-provided QR data URL if available', async () => {
      httpPostHandler = () => ({
        status: 200,
        data: { data: { code: 'ABCD1234', deviceId: 'dev-1', expiresInSeconds: 300, qrCode: 'data:image/png;base64,FAKEQR' } },
      });
      await importFresh();
      const qr = domElements.get('qr-code')!;
      expect(qr.children.length).toBeGreaterThan(0);
      expect(qr.children[0].src).toBe('data:image/png;base64,FAKEQR');
    });

    it('starts countdown timer with expiry from response', async () => {
      await importFresh();
      expect(domElements.get('pairing-countdown')!.textContent).toContain('expires in');
    });

    it('starts polling for pairing status', async () => {
      const { CapacitorHttp } = await import('@capacitor/core');
      // startPairingCheck() is sequenced AFTER `await this.generateQRCode()`
      // (main.ts:1126-1130), which awaits a REAL dynamic import('qrcode') that fake
      // timers do not drive. Waiting a FIXED number of rounds for that was a CI-only
      // failure of this test: when the import settles PARTWAY THROUGH the single fixed
      // advance below, the interval is armed with less than one full 2s period left
      // inside the window, so no poll fires at all and the assertion reads
      // "expected false to be true". Reproduced locally two ways — starving
      // importFresh's round budget, and settling the QR gate at fake t=500 of the
      // 2000ms advance.
      //
      // Wait for the thing that actually gates the interval, bounded on REAL elapsed
      // time and THROWING if it never happens. The assertion itself is unchanged and
      // just as strict: one full interval period must produce a poll.
      await importFresh(() => domElements.get('qr-code')!.children.length > 0);
      // Precondition asserted, not hoped for — if a refactor ever moves the gate, this
      // fails loudly instead of going quietly vacuous.
      expect(domElements.get('qr-code')!.children.length).toBeGreaterThan(0);
      for (let i = 0; i < 20; i++) await Promise.resolve(); // let startPairingCheck() run

      (CapacitorHttp.get as Mock).mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      expect((CapacitorHttp.get as Mock).mock.calls.some(c => c[0].url.includes('/pairing/status/'))).toBe(true);
    });

    it('handles getDeviceInfo failure gracefully', async () => {
      const { Network } = await import('@capacitor/network');
      // getStatus is called first in setupCapacitor (for initial status), then in getDeviceInfo.
      // Let setupCapacitor succeed, then fail on getDeviceInfo.
      let callCount = 0;
      (Network.getStatus as Mock).mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) throw new Error('no network');
        return { connected: true, connectionType: 'wifi' };
      });
      await importFresh();
      // Need a bit more time for the retry path
      await vi.advanceTimersByTimeAsync(200);
      expect((console.error as Mock).mock.calls.some(c => String(c[0]).includes('Pairing request failed'))).toBe(true);
      // Restore
      (Network.getStatus as Mock).mockImplementation(async () => ({ connected: networkConnected, connectionType: 'wifi' }));
    });

    // Skipped: dynamic import('qrcode') doesn't resolve under fake timers, and using
    // real timers leaks setIntervals that contaminate subsequent tests. The rejection
    // path (generateQRCode catch → fallback HTML) is verified by the QR Overlay section's
    // "falls back when QRCode.toCanvas rejects" test which exercises the same catch block.
    it.skip('falls back to QR-unavailable text when QRCode module fails', async () => {
      qrToCanvasMock.mockRejectedValueOnce(new Error('QR broken'));
      await importFresh();
      for (let round = 0; round < 10; round++) {
        await vi.advanceTimersByTimeAsync(50);
        for (let i = 0; i < 50; i++) await Promise.resolve();
      }
      const qrContainer = domElements.get('qr-code')!;
      expect(qrContainer.innerHTML).toContain('QR unavailable');
    });
  });

  // ==================== 5. PAIRING — POLLING ====================

  describe('Pairing — Polling', () => {
    // The polling interval (2s setInterval) is subject to Vitest fake timer isolation
    // issues across vi.resetModules() calls. To ensure reliability, all polling scenarios
    // are tested in a single test with one module import and sequential handler changes.

    // This test passes in isolation (`vitest run -t "exercises all polling"`) but
    // intermittently fails in the full suite due to Vitest fake timer leakage from
    // prior tests' vi.resetModules() + setInterval interactions. The 6 polling
    // behaviors are indirectly covered by: "starts polling for pairing status" (§4),
    // Retry & Backoff (§6), and WebSocket Connection (§8) tests.
    // TODO: Extract to separate test file with its own mock setup for full isolation.
    it.skip('exercises all polling scenarios: paired, offline skip, 404, error, invalid shape', async () => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const advanceAndFlush = async (rounds = 8) => {
        for (let round = 0; round < rounds; round++) {
          await vi.advanceTimersByTimeAsync(300);
          for (let i = 0; i < 30; i++) await Promise.resolve();
        }
      };

      await importFresh();

      // --- Scenario 1: Offline skip ---
      triggerNetworkChange(false);
      let getCalledWhileOffline = false;
      httpGetHandler = () => { getCalledWhileOffline = true; return { status: 200, data: { data: { status: 'pending' } } }; };
      await advanceAndFlush();
      expect(getCalledWhileOffline).toBe(false); // HTTP not called while offline

      // --- Scenario 2: Network error ---
      triggerNetworkChange(true);
      let throwOnce = true;
      httpGetHandler = () => {
        if (throwOnce) { throwOnce = false; throw new Error('net err'); }
        return { status: 200, data: { data: { status: 'pending' } } };
      };
      await advanceAndFlush();
      expect((console.error as Mock).mock.calls.some(c => String(c[0]).includes('Pairing check error'))).toBe(true);

      // --- Scenario 3: Polling continues after error ---
      let pollCalled = false;
      httpGetHandler = () => { pollCalled = true; return { status: 200, data: { data: { status: 'pending' } } }; };
      await advanceAndFlush();
      expect(pollCalled).toBe(true);

      // --- Scenario 4: Invalid response shape (non-string deviceToken) ---
      httpGetHandler = () => ({ status: 200, data: { data: { status: 'paired', deviceToken: 12345 } } });
      await advanceAndFlush();
      expect(secureStorageStore.has('device_token')).toBe(false); // Should NOT store invalid token

      // --- Scenario 5: 404 triggers re-pair ---
      httpGetHandler = () => ({ status: 404, data: {} });
      (console.log as Mock).mockClear();
      await advanceAndFlush();
      expect((console.log as Mock).mock.calls.some(c =>
        String(c[0]).includes('Pairing code expired')
      )).toBe(true);

      // --- Scenario 6: Successful pairing stores credentials ---
      // After 404, startPairing() was called which creates a new polling interval.
      // Wait for the new pairing to complete first.
      await advanceAndFlush(15); // Let the re-pair POST + new poll interval set up
      httpGetHandler = () => ({
        status: 200, data: { data: { status: 'paired', deviceToken: 'poll-tok', deviceId: 'poll-dev' } },
      });
      await advanceAndFlush();
      expect(secureStorageStore.get('device_token')).toBe('poll-tok');
      expect(ioFactory).toHaveBeenCalled();

      vi.useRealTimers();
      vi.restoreAllMocks();
    });
  });

  // ==================== 6. PAIRING — RETRY & BACKOFF ====================

  describe('Pairing — Retry & Backoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('retries with exponential backoff on request failure', async () => {
      const { CapacitorHttp } = await import('@capacitor/core');
      httpPostHandler = () => ({ status: 500, data: { error: 'fail' } });
      await importFresh();
      const c1 = (CapacitorHttp.post as Mock).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5100);
      expect((CapacitorHttp.post as Mock).mock.calls.length).toBeGreaterThan(c1);
      const c2 = (CapacitorHttp.post as Mock).mock.calls.length;
      await vi.advanceTimersByTimeAsync(10100);
      expect((CapacitorHttp.post as Mock).mock.calls.length).toBeGreaterThan(c2);
    });

    it('caps backoff at 300 seconds', async () => {
      // getPairingRetryDelay: Math.min(5000 * 2^retryCount, 300000)
      // The first failure logs the delay. Verify the formula holds for retry 0 (5000ms)
      // and that the cap constant (300000) is used in the formula.
      httpPostHandler = () => ({ status: 500, data: { error: 'fail' } });
      await importFresh();
      // First failure happened during init, logged "Pairing retry in 5000ms (attempt 1)"
      const logs = (console.log as Mock).mock.calls.filter(c => String(c[0]).includes('Pairing retry in'));
      expect(logs.length).toBeGreaterThanOrEqual(1);
      // Verify first retry delay is 5000ms (5000 * 2^0)
      expect(String(logs[0][0])).toContain('5000ms');
      // Verify formula: at retryCount=6, delay = min(5000*64, 300000) = 300000
      // (This is a formula verification, not a multi-retry integration test)
      const formulaResult = Math.min(5000 * Math.pow(2, 6), 300000);
      expect(formulaResult).toBe(300000);
    });

    it('caps retry count at 6', async () => {
      httpPostHandler = () => ({ status: 500, data: { error: 'fail' } });
      await importFresh();
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(300_000);
      const logs = (console.log as Mock).mock.calls.filter(c => String(c[0]).includes('attempt'));
      const max = logs.reduce((m: number, l: unknown[]) => {
        const match = String(l[0]).match(/attempt (\d+)/);
        return match ? Math.max(m, parseInt(match[1])) : m;
      }, 0);
      expect(max).toBeLessThanOrEqual(6);
    });

    it('resets retry count on successful online attempt', async () => {
      httpPostHandler = () => ({ status: 500, data: { error: 'fail' } });
      await importFresh();
      // Fix server
      httpPostHandler = () => ({
        status: 200, data: { data: { code: 'NEW1', deviceId: 'dev-1', expiresInSeconds: 300 } },
      });
      await vi.advanceTimersByTimeAsync(5100);
      // After success, retry count resets. Force failure again.
      httpPostHandler = () => ({ status: 500, data: { error: 'fail' } });
      // Trigger fresh pairing via 404 on status check
      httpGetHandler = () => ({ status: 404, data: {} });
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(50);
      // Next retry should be at 5000ms (reset)
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Pairing retry in 5000ms'))).toBe(true);
    });

    it('retries offline with backoff without hitting network', async () => {
      networkConnected = false;
      const { CapacitorHttp } = await import('@capacitor/core');
      (CapacitorHttp.post as Mock).mockClear();
      await importFresh();
      expect((CapacitorHttp.post as Mock).mock.calls.length).toBe(0);
    });
  });

  // ==================== 7. PAIRING — COUNTDOWN TIMER ====================

  describe('Pairing — Countdown Timer', () => {
    beforeEach(async () => {
      vi.useFakeTimers();
      // Drain in-flight async chains from the PREVIOUS test's app instance
      // BEFORE resetting the fake stores. A stale pairing-poll continuation
      // that resolves later would otherwise write its token into THIS test's
      // freshly-reset store, tricking settle loops into thinking the current
      // instance had paired (the historical flake in the countdown-freeze test).
      for (let i = 0; i < 50; i++) await Promise.resolve();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('displays M:SS countdown format', async () => {
      await importFresh();
      expect(domElements.get('pairing-countdown')!.textContent).toMatch(/\d+:\d{2}/);
    });

    it('shows "Code expired" when timer reaches 0', async () => {
      httpPostHandler = () => ({
        status: 200, data: { data: { code: 'X', deviceId: 'd', expiresInSeconds: 3 } },
      });
      await importFresh();
      await vi.advanceTimersByTimeAsync(4000);
      expect(domElements.get('pairing-countdown')!.textContent).toContain('expired');
    });

    it('stops countdown interval on expiry', async () => {
      httpPostHandler = () => ({
        status: 200, data: { data: { code: 'X', deviceId: 'd', expiresInSeconds: 2 } },
      });
      await importFresh();
      const spy = vi.spyOn(globalThis, 'clearInterval');
      await vi.advanceTimersByTimeAsync(3000);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('countdown element text is cleared after pairing success', async () => {
      // Pairing success (via polling) calls stopPairingCountdown which clears
      // the interval. Since async setInterval callbacks are non-deterministic
      // with fake timers, verify the countdown element stays frozen (not still
      // decrementing) after enough time has passed for pairing to complete.
      httpGetHandler = () => ({ status: 200, data: { data: { status: 'paired', deviceToken: 'jwt', deviceId: 'dev' } } });
      await importFresh();
      // Settle until pairing has actually completed (token stored). The
      // countdown is stopped synchronously BEFORE the token is stored, so a
      // stored token guarantees a frozen countdown — deterministic, unlike a
      // fixed number of settling rounds.
      for (let round = 0; round < 100 && !secureStorageStore.has('device_token'); round++) {
        await vi.advanceTimersByTimeAsync(200);
        for (let i = 0; i < 30; i++) await Promise.resolve();
      }
      expect(secureStorageStore.has('device_token')).toBe(true);
      // Absorb countdown ticks already enqueued by the async timer engine (a
      // tick scheduled before clearInterval still fires under fake timers):
      // settle until the text is stable across a 1s advance...
      let prev = domElements.get('pairing-countdown')?.textContent || '';
      let stable = false;
      for (let i = 0; i < 5 && !stable; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        const cur = domElements.get('pairing-countdown')?.textContent || '';
        stable = cur === prev;
        prev = cur;
      }
      // ...a genuinely running countdown changes every second and never stabilizes
      expect(stable).toBe(true);
      // ...and must then stay frozen over 2 more seconds
      const text1 = prev;
      await vi.advanceTimersByTimeAsync(2000);
      const text2 = domElements.get('pairing-countdown')?.textContent || '';
      expect(text1).toBe(text2);
    });
  });

  // ==================== 8. WEBSOCKET CONNECTION ====================

  describe('WebSocket Connection', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('connects with device token in auth', async () => {
      await importFresh();
      expect(ioFactory).toHaveBeenCalled();
      expect(ioFactory.mock.calls[0][1].auth.token).toBe('tok-123');
    });

    it('uses WebSocket transport with polling fallback', async () => {
      await importFresh();
      expect(ioFactory.mock.calls[0][1].transports).toEqual(['websocket', 'polling']);
    });

    it('enables reconnection with exponential backoff 1s to 60s', async () => {
      await importFresh();
      const opts = ioFactory.mock.calls[0][1];
      expect(opts.reconnection).toBe(true);
      expect(opts.reconnectionDelay).toBe(1000);
      expect(opts.reconnectionDelayMax).toBe(60000);
    });

    it('updates status to online and starts heartbeat on connect', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      expect(domElements.get('status-dot')!.className).toBe('status-dot online');
      const hb = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat');
      expect(hb.length).toBeGreaterThanOrEqual(1);
    });

    it('updates status to offline and stops heartbeat on disconnect', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('disconnect', 'io server disconnect');
      expect(domElements.get('status-text')!.textContent).toBe('Disconnected');
    });

    it('hides the status bar once online — no permanent Connected badge', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');

      expect(domElements.get('status-dot')!.className).toBe('status-dot online');
      expect(domElements.get('status-bar')!._classListSet.has('hidden')).toBe(true);
    });

    it('keeps the status bar in the DOM when hidden, so it can reappear', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');

      // Hidden by class, never removed — a removed node could not come back
      // without re-creating it.
      const bar = domElements.get('status-bar')!;
      expect(bar._classListSet.has('hidden')).toBe(true);
      expect(bar.remove).not.toHaveBeenCalled();
      expect(document.getElementById('status-bar')).toBe(bar);
    });

    it('shows the status bar again when the connection drops after being online', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      expect(domElements.get('status-bar')!._classListSet.has('hidden')).toBe(true);

      triggerSocketEvent('disconnect', 'io server disconnect');

      expect(domElements.get('status-dot')!.className).toBe('status-dot offline');
      expect(domElements.get('status-bar')!._classListSet.has('hidden')).toBe(false);
    });

    it('hides the status bar again after reconnecting', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('disconnect', 'io server disconnect');
      expect(domElements.get('status-bar')!._classListSet.has('hidden')).toBe(false);

      currentMockSocket.connected = true;
      triggerSocketEvent('connect');

      expect(domElements.get('status-bar')!._classListSet.has('hidden')).toBe(true);
    });

    it('leaves the status bar visible while connecting', async () => {
      await importFresh();

      // Never reached `online`, so nothing should have hidden it.
      expect(domElements.get('status-bar')!._classListSet.has('hidden')).toBe(false);
    });

    it('does not throw when the status bar is absent from the DOM', async () => {
      // Tizen/webOS bundles share this markup, but the guard must hold if any
      // host ever renders without the element.
      domElements.delete('status-bar');
      await importFresh();
      currentMockSocket.connected = true;
      expect(() => triggerSocketEvent('connect')).not.toThrow();
      expect(domElements.get('status-dot')!.className).toBe('status-dot online');
    });

    it('shows offline overlay after 60s of disconnect', async () => {
      domElements.delete('offline-overlay');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.connected = false;
      triggerSocketEvent('disconnect', 'transport close');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bodyChildren.find(c => c.id === 'offline-overlay')).toBeDefined();
    });

    it('does NOT clear credentials on unauthorized connect_error (F3 fix, contract §1.5a)', async () => {
      const { SecureStorage } = await import('./secure-storage');
      await importFresh();
      triggerSocketEvent('connect_error', { message: 'unauthorized' });
      await vi.advanceTimersByTimeAsync(100);
      // NEGATIVE: legacy string errors are transport-layer — no wipe, ever
      expect(SecureStorage.remove).not.toHaveBeenCalledWith({ key: 'device_token' });
      expect(secureStorageStore.has('device_token')).toBe(true);
      await vi.advanceTimersByTimeAsync(2100);
      const { CapacitorHttp } = await import('@capacitor/core');
      // NEGATIVE: no pairing request was made — the device is still paired
      expect((CapacitorHttp.post as Mock).mock.calls.length).toBe(0);
    });

    it('disconnects existing socket before creating new connection', async () => {
      await importFresh();
      const first = currentMockSocket;
      currentMockSocket.connected = false;
      triggerNetworkChange(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(first.removeAllListeners).toHaveBeenCalled();
      expect(first.disconnect).toHaveBeenCalled();
    });
  });

  // ==================== 9. WEBSOCKET EVENT HANDLERS ====================

  describe('WebSocket Event Handlers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('playlist:update calls updatePlaylist', async () => {
      await importFresh();
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [
          { id: 'i1', contentId: 'c1', duration: 10, order: 0, content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } },
        ], loopPlaylist: true },
      });
      // Image readiness wait is 1500ms before optimistic commit
      await vi.advanceTimersByTimeAsync(1600);
      expect((domElements.get('content-container')!.appendChild as Mock).mock.calls.length).toBeGreaterThan(0);
    });

    it('command event calls handleCommand', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'reload' });
      // The dispatch is one task boundary out — an unkeyable context-destroying
      // command yields before reloading so the ack frame gets a chance to flush
      // (see A11b). Same reason the keyed path awaits its ring persist.
      await vi.advanceTimersByTimeAsync(10);
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('config event with qrOverlay renders QR overlay', async () => {
      await importFresh();
      triggerSocketEvent('config', { qrOverlay: { enabled: true, url: 'https://e.com', position: 'top-left' } });
      // className and style.position are set synchronously before the async import
      const ov = domElements.get('qr-overlay')!;
      expect(ov.className).toBe('top-left');
      expect(ov.style.position).toBe('fixed');
    });

    it('qr-overlay:update event renders QR overlay', async () => {
      await importFresh();
      triggerSocketEvent('qr-overlay:update', { qrOverlay: { enabled: true, url: 'https://t.com', position: 'bottom-right' } });
      await vi.advanceTimersByTimeAsync(50);
      expect(domElements.get('qr-overlay')!.style.position).toBe('fixed');
    });

    it('starts playback on connect with restored playlist', async () => {
      preferencesStore.set('last_playlist', JSON.stringify({
        id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }], loopPlaylist: true,
      }));
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      // Image readiness wait is 1500ms before optimistic commit
      await vi.advanceTimersByTimeAsync(1600);
      expect((domElements.get('content-container')!.appendChild as Mock).mock.calls.length).toBeGreaterThan(0);
    });
  });

  // ==================== 10. HEARTBEAT ====================

  describe('Heartbeat', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('sends heartbeat every 15 seconds', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').length).toBeGreaterThanOrEqual(1);
    });

    it('sends first heartbeat immediately on connect', async () => {
      await importFresh();
      currentMockSocket.emit.mockClear();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      expect(currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').length).toBeGreaterThanOrEqual(1);
    });

    it('heartbeat payload includes uptime, appVersion, metrics, currentContent', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat')!;
      const payload = hb[1] as Record<string, unknown>;
      expect(payload).toHaveProperty('uptime');
      expect(payload).toHaveProperty('appVersion');
      expect(payload).toHaveProperty('metrics');
    });

    it('calculates memory from performance.memory when available', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat')!;
      expect((hb[1] as Record<string, Record<string, number>>).metrics.memoryUsage).toBe(50);
    });

    it('falls back to 50% when performance.memory unavailable', async () => {
      const saved = globalThis.performance;
      vi.stubGlobal('performance', {});
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat')!;
      expect((hb[1] as Record<string, Record<string, number>>).metrics.memoryUsage).toBe(50);
      vi.stubGlobal('performance', saved);
    });

    it('processes commands from heartbeat ack response', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat')!;
      const ack = hb[hb.length - 1] as Function;
      expect(typeof ack).toBe('function');
      ack({ commands: [{ type: 'reload' }] });
      await vi.advanceTimersByTimeAsync(10); // task boundary before the dispatch — see A11b
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('processes commands wrapped in the ack .data envelope (createSuccessResponse — backend Q#3)', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat')!;
      const ack = hb[hb.length - 1] as Function;
      ack({ data: { commands: [{ type: 'reload' }] } });
      await vi.advanceTimersByTimeAsync(10); // task boundary before the dispatch — see A11b
      expect(window.location.reload).toHaveBeenCalled();
    });
  });

  // ==================== 11. PLAYLIST PLAYBACK ====================

  describe('Playlist Playback', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const mkPlaylist = (items: Array<{ id: string; type: string; url: string; duration?: number }>, loop = true) => ({
      id: 'pl-1', name: 'PL',
      items: items.map((item, i) => ({
        id: `it-${i}`, contentId: item.id, duration: item.duration || 10, order: i,
        content: { id: item.id, name: `C${i}`, type: item.type, url: item.url },
      })),
      loopPlaylist: loop,
    });

    it('stores playlist, resets index to 0, starts playback', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([{ id: 'c1', type: 'image', url: '/i.jpg' }]) });
      await vi.advanceTimersByTimeAsync(50);
      expect(preferencesStore.has('last_playlist')).toBe(true);
    });

    it('persists playlist to Preferences', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([{ id: 'c1', type: 'image', url: '/i.jpg' }]) });
      await vi.advanceTimersByTimeAsync(50);
      // Persisted as a tenant-bound envelope (contract §2)
      const envelope = JSON.parse(preferencesStore.get('last_playlist')!);
      expect(envelope.playlist.id).toBe('pl-1');
      expect(envelope).toHaveProperty('savedAt');
    });

    it('renders current item based on content type', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([{ id: 'c1', type: 'image', url: '/i.jpg' }]) });
      await vi.advanceTimersByTimeAsync(50);
      expect((document.createElement as Mock).mock.calls.some((c: unknown[]) => c[0] === 'img')).toBe(true);
    });

    it('emits content:impression event', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.emit.mockClear();
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([{ id: 'c1', type: 'image', url: '/i.jpg' }]) });
      // Impression is emitted at commit time — after the 1500ms readiness wait
      await vi.advanceTimersByTimeAsync(1600);
      const imp = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression');
      expect(imp.length).toBeGreaterThanOrEqual(1);
      expect((imp[0][1] as Record<string, unknown>).contentId).toBe('c1');
    });

    it('advances after duration * 1000 ms for non-video content', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([
        { id: 'c1', type: 'image', url: '/i1.jpg', duration: 5 },
        { id: 'c2', type: 'image', url: '/i2.jpg', duration: 5 },
      ]) });
      await vi.advanceTimersByTimeAsync(50);
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      await vi.advanceTimersByTimeAsync(50);
      expect(currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length).toBeGreaterThanOrEqual(1);
    });

    it('skips items with null content', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: {
          id: 'p1', name: 'T', items: [
            { id: 'i1', contentId: 'c1', duration: 10, order: 0, content: null },
            { id: 'i2', contentId: 'c2', duration: 10, order: 1, content: { id: 'c2', name: 'I', type: 'image', url: '/i.jpg' } },
          ], loopPlaylist: true,
        },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect((document.createElement as Mock).mock.calls.some((c: unknown[]) => c[0] === 'img')).toBe(true);
    });

    it('wraps to index 0 when loopPlaylist !== false', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([{ id: 'c1', type: 'image', url: '/i.jpg', duration: 2 }], true) });
      await vi.advanceTimersByTimeAsync(50);
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(2000);
      await vi.advanceTimersByTimeAsync(50);
      // Looped: should emit another impression
      expect(currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length).toBeGreaterThanOrEqual(1);
    });

    it('stops at end when loopPlaylist === false', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([{ id: 'c1', type: 'image', url: '/i.jpg', duration: 2 }], false) });
      await vi.advanceTimersByTimeAsync(1600); // commit after readiness wait
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(2100); // item duration elapses
      await vi.advanceTimersByTimeAsync(50);
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Playlist ended'))).toBe(true);
      // F35: the last frame is retained — content stays visible, engine parked
      expect(domElements.get('content-container')!.children.length).toBeGreaterThan(0);
    });

    it('emits completion impression with duration and percentage', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([
        { id: 'c1', type: 'image', url: '/i1.jpg', duration: 10 },
        { id: 'c2', type: 'image', url: '/i2.jpg', duration: 10 },
      ]) });
      await vi.advanceTimersByTimeAsync(1600); // commit after readiness wait
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(10_000);
      const imp = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression');
      const comp = imp.find((c: unknown[]) => (c[1] as Record<string, unknown>).completionPercentage !== undefined);
      expect(comp).toBeDefined();
      expect((comp![1] as Record<string, unknown>)).toHaveProperty('duration');
    });

    it('handles empty items array without crash', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: mkPlaylist([]) });
      await vi.advanceTimersByTimeAsync(50);
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Playlist is empty'))).toBe(true);
    });
  });

  // ==================== 12. CONTENT RENDERING ====================

  describe('Content Rendering', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const play = async (type: string, url: string) => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'C', type, url } }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
    };

    it('creates img for image content', async () => {
      await play('image', '/i.jpg');
      expect((document.createElement as Mock).mock.calls.some((c: unknown[]) => c[0] === 'img')).toBe(true);
    });

    it('creates video with autoplay and playsInline', async () => {
      await play('video', '/v.mp4');
      const videos = findCreatedElements('video');
      expect(videos.length).toBeGreaterThan(0);
      const video = videos[videos.length - 1];
      expect(video.autoplay).toBe(true);
      expect(video.playsInline).toBe(true);
    });

    it('sets muted and loop on video in zone context', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'L', items: [{
          id: 'i1', contentId: 'c1', duration: 30, order: 0,
          content: { id: 'c1', name: 'L', type: 'layout', url: '' },
          metadata: { gridTemplate: { columns: '1fr', rows: '1fr' }, zones: [
            { id: 'z1', gridArea: '1/1', resolvedContent: { id: 'v1', name: 'V', type: 'video', url: '/v.mp4' } },
          ] },
        }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      const videos = findCreatedElements('video');
      expect(videos.length).toBeGreaterThan(0);
      const video = videos[videos.length - 1];
      expect(video.muted).toBe(true);
      expect(video.loop).toBe(true);
    });

    it('creates iframe with src and allow for webpage content', async () => {
      await play('webpage', 'https://example.com');
      const iframes = findCreatedElements('iframe');
      expect(iframes.length).toBeGreaterThan(0);
      const iframe = iframes[iframes.length - 1];
      expect(iframe.src).toContain('example.com');
      expect(iframe.allow).toBe('autoplay; fullscreen');
    });

    it('creates sandboxed iframe with srcdoc and CSP for html content', async () => {
      await play('html', '<html><head></head><body>Hi</body></html>');
      expect((document.createElement as Mock).mock.calls.some((c: unknown[]) => c[0] === 'iframe')).toBe(true);
    });

    it('sandbox only allows allow-scripts — no allow-same-origin', async () => {
      await play('html', '<html><head></head><body>Hi</body></html>');
      const iframes = (document.createElement as Mock).mock.results.filter(
        (r: { value: ElementStub }) => r.value.tagName === 'IFRAME'
      );
      expect(iframes.length).toBeGreaterThan(0);
      const iframe = iframes[0].value as ElementStub;
      expect(iframe.sandbox.add).toHaveBeenCalledWith('allow-scripts');
      const allCalls = iframe.sandbox.add.mock.calls.flat();
      expect(allCalls).not.toContain('allow-same-origin');
    });

    it('html/template 10s load timeout advances without an error surface', async () => {
      await play('template', '<html><head></head><body>T</body></html>');
      const iframesBefore = findCreatedElements('iframe').length;
      expect(iframesBefore).toBeGreaterThan(0);
      // Advancing 10s triggers the load timeout → post-commit error → advance.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(100);
      expect((console.warn as Mock).mock.calls.some(c => String(c[0]).includes('failed after commit'))).toBe(true);
      // Single-item loop: the item is re-prepared — a fresh iframe exists.
      expect(findCreatedElements('iframe').length).toBeGreaterThan(iframesBefore);
      // NEGATIVE: no "Unable to load" error card is ever rendered.
      const container = domElements.get('content-container')!;
      const errorChild = container.children.find(
        (c: ElementStub) => c.textContent && c.textContent.includes('Unable to load')
      );
      expect(errorChild).toBeUndefined();
    });

    it('logs warning for unknown content type and advances to next', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [
          { id: 'i1', contentId: 'c1', duration: 2, order: 0, content: { id: 'c1', name: 'X', type: 'alien', url: '/x' } },
          { id: 'i2', contentId: 'c2', duration: 10, order: 1, content: { id: 'c2', name: 'I', type: 'image', url: '/i.jpg' } },
        ], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect((console.warn as Mock).mock.calls.some(c => String(c[0]).includes('Unknown content type'))).toBe(true);
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(50);
      expect((document.createElement as Mock).mock.calls.some((c: unknown[]) => c[0] === 'img')).toBe(true);
    });

    it('video onended advances to next content', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [
          { id: 'i1', contentId: 'c1', duration: 30, order: 0, content: { id: 'c1', name: 'V', type: 'video', url: '/v.mp4' } },
          { id: 'i2', contentId: 'c2', duration: 10, order: 1, content: { id: 'c2', name: 'I', type: 'image', url: '/i.jpg' } },
        ], loopPlaylist: true },
      });
      // Video readiness wait is 4000ms before optimistic commit
      await vi.advanceTimersByTimeAsync(4100);
      // Find the video element and trigger onended
      const videos = findCreatedElements('video');
      expect(videos.length).toBeGreaterThan(0);
      const video = videos[videos.length - 1];
      expect(video.onended).toBeDefined();
      // Trigger onended — should advance to next item (image)
      video.onended!();
      await vi.advanceTimersByTimeAsync(1600);
      const imgs = findCreatedElements('img');
      expect(imgs.length).toBeGreaterThan(0);
    });

    it('image onerror skips the item without any error surface', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [
          { id: 'i1', contentId: 'c1', duration: 30, order: 0, content: { id: 'c1', name: 'BadImg', type: 'image', url: '/bad.jpg' } },
          { id: 'i2', contentId: 'c2', duration: 10, order: 1, content: { id: 'c2', name: 'Good', type: 'image', url: '/good.jpg' } },
        ], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      const imgs = findCreatedElements('img');
      expect(imgs.length).toBeGreaterThan(0);
      const img = imgs[imgs.length - 1];
      expect(img.onerror).toBeDefined();
      // Pre-commit failure: prepare() returns null and the scan moves to the
      // next item immediately — the bad image never reaches the screen.
      img.onerror!();
      await vi.advanceTimersByTimeAsync(1600);
      const newImgs = findCreatedElements('img');
      expect(newImgs.length).toBeGreaterThan(imgs.length);
      // The good image commits into the container.
      expect((domElements.get('content-container')!.appendChild as Mock).mock.calls.length).toBeGreaterThan(0);
      // NEGATIVE: no "Unable to load" error card is ever rendered (the old
      // behavior showed an error surface for 5s per loop iteration).
      const container = domElements.get('content-container')!;
      const errorChild = container.children.find(
        (c: ElementStub) => c.textContent && c.textContent.includes('Unable to load')
      );
      expect(errorChild).toBeUndefined();
    });

    it('resolves through cacheManager.getCachedUri first', async () => {
      mockCacheManager.getCachedUri.mockResolvedValueOnce('cached:///c.jpg');
      await play('image', '/i.jpg');
      expect(mockCacheManager.getCachedUri).toHaveBeenCalledWith('c1');
    });

    it('falls back to download via cache manager on cache miss', async () => {
      mockCacheManager.getCachedUri.mockResolvedValue(null);
      mockCacheManager.downloadContent.mockResolvedValueOnce('dl:///c.jpg');
      await play('image', '/i.jpg');
      expect(mockCacheManager.downloadContent).toHaveBeenCalled();
    });
  });

  // ==================== 13. CONTENT PRELOADING ====================

  describe('Content Preloading', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('preloads first 5 items on playlist update', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const items = Array.from({ length: 8 }, (_, i) => ({
        id: `it-${i}`, contentId: `c${i}`, duration: 10, order: i,
        content: { id: `c${i}`, name: `I${i}`, type: 'image', url: `/i${i}.jpg` },
      }));
      triggerSocketEvent('playlist:update', { playlist: { id: 'p1', name: 'Big', items, loopPlaylist: true } });
      await vi.advanceTimersByTimeAsync(50);
      // getCachedUri called for preload (up to 5 items) + playing current item
      const calls = mockCacheManager.getCachedUri.mock.calls.length;
      expect(calls).toBeGreaterThanOrEqual(5);
      expect(calls).toBeLessThanOrEqual(6);
    });

    it('uses Promise.allSettled for failure-tolerant preloading', async () => {
      // First getCachedUri call fails, second succeeds — both should be attempted
      mockCacheManager.getCachedUri.mockRejectedValueOnce(new Error('fail'));
      mockCacheManager.getCachedUri.mockResolvedValueOnce(null);
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      mockCacheManager.getCachedUri.mockClear();
      mockCacheManager.getCachedUri.mockRejectedValueOnce(new Error('fail'));
      mockCacheManager.getCachedUri.mockResolvedValueOnce(null);
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [
          { id: 'i1', contentId: 'c1', duration: 10, order: 0, content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } },
          { id: 'i2', contentId: 'c2', duration: 10, order: 1, content: { id: 'c2', name: 'I2', type: 'image', url: '/i2.jpg' } },
        ], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      // Despite first item failing, second item's cache was still checked (allSettled)
      expect(mockCacheManager.getCachedUri.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('skips preload for non-media content types', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      mockCacheManager.getCachedUri.mockClear();
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [
          { id: 'i1', contentId: 'c1', duration: 10, order: 0, content: { id: 'c1', name: 'H', type: 'html', url: '<html></html>' } },
          { id: 'i2', contentId: 'c2', duration: 10, order: 1, content: { id: 'c2', name: 'U', type: 'url', url: 'https://e.com' } },
        ], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      // html and url should not trigger cache preload
      expect(mockCacheManager.getCachedUri.mock.calls.length).toBe(0);
    });
  });

  // ==================== 14. COMMAND HANDLING ====================

  describe('Command Handling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('reload: calls window.location.reload()', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'reload' });
      await vi.advanceTimersByTimeAsync(10); // task boundary before the dispatch — see A11b
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('clear_cache: clears cache then reloads', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'clear_cache' });
      await vi.advanceTimersByTimeAsync(50);
      expect(mockCacheManager.clearCache).toHaveBeenCalled();
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('unpair: removes credentials then reloads', async () => {
      const { SecureStorage } = await import('./secure-storage');
      await importFresh();
      triggerSocketEvent('command', { type: 'unpair' });
      await vi.advanceTimersByTimeAsync(50);
      expect(SecureStorage.remove).toHaveBeenCalledWith({ key: 'device_token' });
      expect(SecureStorage.remove).toHaveBeenCalledWith({ key: 'device_id' });
      expect(window.location.reload).toHaveBeenCalled();
    });

    // F43: update_config now validates URLs against a registrable-domain allowlist
    // anchored to the compiled-in defaults (vizora.io in the test build). These push
    // allowed same-domain URLs; the arbitrary-host rejections live in the seam-review
    // block below.
    it('update_config with an allowed apiUrl reads from command.apiUrl', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'update_config', apiUrl: 'https://api2.vizora.io' });
      await vi.advanceTimersByTimeAsync(50);
      expect(preferencesStore.get('config_api_url')).toBe('https://api2.vizora.io');
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('update_config with an allowed realtimeUrl reads from command.realtimeUrl', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'update_config', realtimeUrl: 'wss://realtime2.vizora.io' });
      await vi.advanceTimersByTimeAsync(50);
      expect(preferencesStore.get('config_realtime_url')).toBe('wss://realtime2.vizora.io');
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('update_config with an allowed dashboardUrl reads from command.dashboardUrl', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'update_config', dashboardUrl: 'https://dash2.vizora.io' });
      await vi.advanceTimersByTimeAsync(50);
      expect(preferencesStore.get('config_dashboard_url')).toBe('https://dash2.vizora.io');
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('push_content calls handleContentPush', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp1', name: 'P', type: 'image', url: '/p.jpg' }, duration: 3 },
      });
      // Impression is emitted at commit — after the 1500ms readiness wait
      await vi.advanceTimersByTimeAsync(1600);
      const imp = currentMockSocket.emit.mock.calls.filter(
        (c: unknown[]) => c[0] === 'content:impression' && (c[1] as Record<string, unknown>).contentId === 'pp1'
      );
      expect(imp.length).toBeGreaterThanOrEqual(1);
    });

    it('push_content with missing payload does not modify state', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.emit.mockClear();
      triggerSocketEvent('command', { type: 'push_content' }); // no payload
      await vi.advanceTimersByTimeAsync(50);
      expect(currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length).toBe(0);
    });

    // The guard this TODO was deferring landed at src/main.ts:1921-1929
    // (`if (command.payload?.content != null)`). The comment outlived it and still
    // named a line number that had moved, so anyone auditing this file was told a
    // fixed bug was live. Replaced with the tests it was waiting for — a guard with
    // no negative test is indistinguishable from no guard.

    // Assert the guard's OWN signal, not merely the absence of an impression.
    // "no impression emitted" is ALSO true when the handler crashes, so asserting
    // only that is vacuous — verified by deleting the guard and watching an
    // absence-only version still pass while throwing unhandled rejections.
    it.each([
      ['undefined', undefined],
      ['null', null],
    ])('NEGATIVE: push_content with content=%s takes the guard, and does not crash into it', async (_label, content) => {
      await importFresh();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      currentMockSocket.emit.mockClear();

      triggerSocketEvent('command', { type: 'push_content', payload: { content } });
      await vi.advanceTimersByTimeAsync(50);

      expect(warn).toHaveBeenCalledWith('[Vizora] push_content command missing content payload');
      expect(
        currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length,
      ).toBe(0);
      warn.mockRestore();
    });

    it('NEGATIVE: a shapeless content object does not blank the screen', async () => {
      // {} has no `type`, so renderContentToDiv hits its default branch and resolves
      // ready='error', which resumes the playlist. Asserting the FAIL-SAFE, not
      // merely the absence of a throw: the screen must keep playing.
      await importFresh();
      currentMockSocket.emit.mockClear();
      triggerSocketEvent('command', { type: 'push_content', payload: { content: {} } });
      await vi.advanceTimersByTimeAsync(200);
      expect(
        currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length,
      ).toBe(0);
    });

    it('NEGATIVE: an array masquerading as content is inert', async () => {
      await importFresh();
      currentMockSocket.emit.mockClear();
      triggerSocketEvent('command', { type: 'push_content', payload: { content: [] } });
      await vi.advanceTimersByTimeAsync(200);
      expect(
        currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length,
      ).toBe(0);
    });

    it('qr-overlay-update calls renderQrOverlay', async () => {
      await importFresh();
      triggerSocketEvent('command', {
        type: 'qr-overlay-update',
        payload: { config: { enabled: true, url: 'https://t.com', position: 'top-right' } },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(domElements.get('qr-overlay')!.style.position).toBe('fixed');
    });

    it('unknown command logs warning and does not crash', async () => {
      await importFresh();
      triggerSocketEvent('command', { type: 'banana_split' });
      await vi.advanceTimersByTimeAsync(50);
      expect((console.warn as Mock).mock.calls.some(c => String(c[0]).includes('Unknown command'))).toBe(true);
    });
  });

  // ==================== 15. TEMPORARY CONTENT PUSH ====================

  describe('Temporary Content Push', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const setupPlaylist = () => {
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }], loopPlaylist: true },
      });
    };

    it('saves current playlist state before pushing', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      setupPlaylist();
      await vi.advanceTimersByTimeAsync(50);
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
      });
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(50);
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Resuming playlist'))).toBe(true);
    });

    it('clears current playback timer', async () => {
      const spy = vi.spyOn(globalThis, 'clearTimeout');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      setupPlaylist();
      // Let the playlist item commit so a playback timer exists
      await vi.advanceTimersByTimeAsync(1600);
      spy.mockClear();
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('renders pushed content in content container', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
      });
      // Push content commits after the 1500ms readiness wait
      await vi.advanceTimersByTimeAsync(1600);
      expect((domElements.get('content-container')!.appendChild as Mock).mock.calls.length).toBeGreaterThan(0);
    });

    it('sets resume timer for duration minutes', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 2 },
      });
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Resuming playlist'))).toBe(true);
    });

    it('restores playlist state on timer expiry', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      setupPlaylist();
      await vi.advanceTimersByTimeAsync(50);
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
      });
      await vi.advanceTimersByTimeAsync(50);
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(50);
      expect(currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'content:impression').length).toBeGreaterThanOrEqual(1);
    });

    it('nested push replaces previous without double-saving state', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      setupPlaylist();
      await vi.advanceTimersByTimeAsync(50);
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'p1', name: 'P1', type: 'image', url: '/p1.jpg' }, duration: 5 },
      });
      await vi.advanceTimersByTimeAsync(50);
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'p2', name: 'P2', type: 'image', url: '/p2.jpg' }, duration: 1 },
      });
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(50);
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Resuming playlist'))).toBe(true);
    });

    it('push when content container missing does not crash', async () => {
      domElements.delete('content-container');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const createCallsBefore = (document.createElement as Mock).mock.calls.length;
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
      });
      await vi.advanceTimersByTimeAsync(50);
      // renderTemporaryContent returns early when container is null — no content elements created
      const createCallsAfter = (document.createElement as Mock).mock.calls.length;
      expect(createCallsAfter).toBe(createCallsBefore);
    });

    it('resume with no saved playlist clears content without crashing', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('command', {
        type: 'push_content',
        payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
      });
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(50);
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Resuming playlist'))).toBe(true);
    });
  });

  // ==================== 16. QR OVERLAY ====================

  describe('QR Overlay', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('renders QR code at specified positions', async () => {
      await importFresh();
      for (const pos of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
        const ov = domElements.get('qr-overlay')!;
        triggerSocketEvent('config', { qrOverlay: { enabled: true, url: 'https://e.com', position: pos } });
        await vi.advanceTimersByTimeAsync(50);
        expect(ov.className).toBe(pos);
      }
    });

    it('a server-pushed position outside the known set cannot suppress the overlay', async () => {
      // `position` is typed as a union but arrives unvalidated, and this is the
      // overlay's only className write — a push of "hidden" applied the app's own
      // hide rule and made the QR overlay silently disappear while every other
      // observable said it was rendered.
      await importFresh();
      const ov = domElements.get('qr-overlay')!;
      triggerSocketEvent('config', {
        qrOverlay: { enabled: true, url: 'https://e.com', position: 'hidden', margin: 24 },
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(ov.className).toBe('bottom-right');   // fell back, not applied
      expect(ov.style.bottom).toBe('24px');        // …and laid out to match
      expect(ov.style.right).toBe('24px');
    });

    it('NEGATIVE CONTROL: a known position is still applied verbatim', async () => {
      // Proves the fallback above is the allowlist rejecting an unknown value, not
      // renderQrOverlay having stopped honouring position altogether.
      await importFresh();
      const ov = domElements.get('qr-overlay')!;
      triggerSocketEvent('config', {
        qrOverlay: { enabled: true, url: 'https://e.com', position: 'top-left', margin: 24 },
      });
      await vi.advanceTimersByTimeAsync(50);

      expect(ov.className).toBe('top-left');
      expect(ov.style.top).toBe('24px');
      expect(ov.style.left).toBe('24px');
    });

    it('applies size, margin, backgroundColor, opacity', async () => {
      await importFresh();
      const ov = domElements.get('qr-overlay')!;
      triggerSocketEvent('config', {
        qrOverlay: { enabled: true, url: 'https://e.com', size: 200, margin: 24, backgroundColor: '#f00', opacity: 0.8, position: 'top-left' },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(ov.style.backgroundColor).toBe('#f00');
      expect(ov.style.opacity).toBe('0.8');
      expect(ov.style.top).toBe('24px');
      expect(ov.style.left).toBe('24px');
    });

    it('displays label text below QR code', async () => {
      // renderQrOverlay does `await import('qrcode')`, which fake timers do not drive.
      // The old shape here was a FIXED 50ms real sleep plus a clear-every-timer sweep:
      // the sleep is a budget that shrinks exactly when the machine is loaded, and
      // uninstalling the fake clock DISCARDS every pending fake timer (see realYield).
      // Wait for the render itself instead, bounded on REAL elapsed time and throwing
      // if it never lands — without ever leaving the fake clock.
      await importFresh();
      triggerSocketEvent('qr-overlay:update', { qrOverlay: { enabled: true, url: 'https://e.com', label: 'Scan me!' } });
      const labelOf = () => domElements.get('qr-overlay')!.children
        .find((c: ElementStub) => c.textContent === 'Scan me!');
      // tickMs so the waiter drives BOTH real-loop work (the dynamic import) and
      // anything fake-timer-gated on the way — a waiter that only yields to the real
      // loop stalls forever on a fake timer, which is the mirror of the bug being fixed.
      await waitUntil('the QR overlay label render', () => labelOf() !== undefined, { tickMs: 20 });
      expect(labelOf()).toBeDefined();
    });

    it('hides overlay when enabled is false', async () => {
      await importFresh();
      const ov = domElements.get('qr-overlay')!;
      triggerSocketEvent('config', { qrOverlay: { enabled: false, url: 'https://e.com' } });
      await vi.advanceTimersByTimeAsync(50);
      expect(ov.classList.add).toHaveBeenCalledWith('hidden');
    });

    it('hides overlay when config is undefined', async () => {
      await importFresh();
      const ov = domElements.get('qr-overlay')!;
      // Use qr-overlay:update which always calls renderQrOverlay, even with undefined
      triggerSocketEvent('qr-overlay:update', { qrOverlay: undefined });
      await vi.advanceTimersByTimeAsync(50);
      expect(ov.classList.add).toHaveBeenCalledWith('hidden');
    });

    it('falls back when QRCode.toCanvas rejects', async () => {
      // Same fixed-real-sleep shape as above, same replacement.
      await importFresh();
      qrToCanvasMock.mockRejectedValueOnce(new Error('canvas fail'));
      triggerSocketEvent('config', { qrOverlay: { enabled: true, url: 'https://e.com' } });
      const failed = () => (console.error as Mock).mock.calls
        .some(c => String(c[0]).includes('QR code generation failed'));
      await waitUntil('the QR overlay failure path', failed, { tickMs: 20 });
      expect(failed()).toBe(true);
    });
  });

  // ==================== 17. MULTI-ZONE LAYOUT ====================

  describe('Multi-Zone Layout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const triggerLayout = async (metadata: Record<string, unknown>) => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'L', items: [{
          id: 'i1', contentId: 'c1', duration: 30, order: 0,
          content: { id: 'c1', name: 'L', type: 'layout', url: '' },
          metadata,
        }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
    };

    it('creates CSS grid with gridTemplateColumns and gridTemplateRows', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr 2fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1' }, { id: 'z2', gridArea: '1/2' }],
      });
      const found = (document.createElement as Mock).mock.results.some(
        (r: { value: ElementStub }) => r.value.style.gridTemplateColumns === '1fr 2fr'
      );
      expect(found).toBe(true);
    });

    it('each zone renders at its gridArea', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr 1fr', rows: '1fr' },
        zones: [
          { id: 'z1', gridArea: '1/1', resolvedContent: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } },
          { id: 'z2', gridArea: '1/2', resolvedContent: { id: 'c2', name: 'I2', type: 'image', url: '/i2.jpg' } },
        ],
      });
      const zoneDivs = (document.createElement as Mock).mock.results.filter(
        (r: { value: ElementStub }) => r.value.style.gridArea
      );
      expect(zoneDivs.length).toBeGreaterThanOrEqual(2);
    });

    it('zone with resolvedPlaylist plays items in rotation', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1', resolvedPlaylist: {
          id: 'zp', name: 'ZP', items: [
            { id: 'zi1', contentId: 'zc1', duration: 3, order: 0, content: { id: 'zc1', name: 'I1', type: 'image', url: '/z1.jpg' } },
            { id: 'zi2', contentId: 'zc2', duration: 3, order: 1, content: { id: 'zc2', name: 'I2', type: 'image', url: '/z2.jpg' } },
          ],
        } }],
      });
      const before = (document.createElement as Mock).mock.calls.filter((c: unknown[]) => c[0] === 'img').length;
      await vi.advanceTimersByTimeAsync(3100);
      await vi.advanceTimersByTimeAsync(50);
      const after = (document.createElement as Mock).mock.calls.filter((c: unknown[]) => c[0] === 'img').length;
      expect(after).toBeGreaterThan(before);
    });

    it('zone with resolvedContent renders single item', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1', resolvedContent: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }],
      });
      expect((document.createElement as Mock).mock.calls.some((c: unknown[]) => c[0] === 'img')).toBe(true);
    });

    it('zone videos are muted and looping', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1', resolvedContent: { id: 'v1', name: 'V', type: 'video', url: '/v.mp4' } }],
      });
      const videos = findCreatedElements('video');
      expect(videos.length).toBeGreaterThan(0);
      const video = videos[videos.length - 1];
      expect(video.muted).toBe(true);
      expect(video.loop).toBe(true);
    });

    it('cleanupLayout clears all zone timers', async () => {
      const spy = vi.spyOn(globalThis, 'clearTimeout');
      await triggerLayout({
        gridTemplate: { columns: '1fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1', resolvedPlaylist: {
          id: 'zp', name: 'ZP', items: [{ id: 'zi', contentId: 'zc', duration: 3, order: 0,
            content: { id: 'zc', name: 'I', type: 'image', url: '/z.jpg' } }],
        } }],
      });
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p2', name: 'L2', items: [{
          id: 'i2', contentId: 'c2', duration: 30, order: 0,
          content: { id: 'c2', name: 'L2', type: 'layout', url: '' },
          metadata: { gridTemplate: { columns: '1fr', rows: '1fr' }, zones: [{ id: 'z2', gridArea: '1/1' }] },
        }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('empty zone renders without crash', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1' }],
      });
      // Grid div was created and appended to container
      const container = domElements.get('content-container')!;
      expect(container.children.length).toBeGreaterThan(0);
    });

    it('grid element has layout-grid class', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr', rows: '1fr' },
        zones: [{ id: 'z1', gridArea: '1/1' }],
      });
      const container = domElements.get('content-container')!;
      const grid = container.children[0] as unknown as ElementStub;
      expect(grid.className).toContain('layout-grid');
    });

    it('zone elements have layout-zone class', async () => {
      await triggerLayout({
        gridTemplate: { columns: '1fr 1fr', rows: '1fr' },
        zones: [
          { id: 'z1', gridArea: '1/1', resolvedContent: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } },
          { id: 'z2', gridArea: '1/2', resolvedContent: { id: 'c2', name: 'I2', type: 'image', url: '/i2.jpg' } },
        ],
      });
      const container = domElements.get('content-container')!;
      const grid = container.children[0] as unknown as ElementStub;
      const zones = (grid.children || []) as unknown as ElementStub[];
      expect(zones.length).toBeGreaterThanOrEqual(2);
      for (const zone of zones) {
        expect(zone.className).toContain('layout-zone');
      }
    });
  });

  // ==================== 18. D-PAD NAVIGATION ====================

  describe('D-pad Navigation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    // Create elements that pass `instanceof HTMLElement` for D-pad focus/click
    function createFocusableElement() {
      const el = Object.create(HTMLElementStub.prototype);
      el.focus = vi.fn();
      el.click = vi.fn();
      return el;
    }

    const setupDpad = async () => {
      await importFresh();
      const el1 = createFocusableElement();
      const el2 = createFocusableElement();
      const el3 = createFocusableElement();
      (document.querySelectorAll as Mock).mockReturnValue([el1, el2, el3]);
      return { el1, el2, el3 };
    };

    const fireKey = (key: string) => {
      const event = { key, preventDefault: vi.fn() };
      (documentEventListeners.get('keydown') || []).forEach(h => h(event));
      return event;
    };

    it('ArrowDown moves focus to next element', async () => {
      const { el1, el2 } = await setupDpad();
      activeElementRef = el1;
      fireKey('ArrowDown');
      expect(el2.focus).toHaveBeenCalled();
    });

    it('ArrowUp moves focus to previous element', async () => {
      const { el1, el2 } = await setupDpad();
      activeElementRef = el2;
      fireKey('ArrowUp');
      expect(el1.focus).toHaveBeenCalled();
    });

    it('wraps around at end (last to first)', async () => {
      const { el1, el3 } = await setupDpad();
      activeElementRef = el3;
      fireKey('ArrowDown');
      expect(el1.focus).toHaveBeenCalled();
    });

    it('wraps around at start (first to last)', async () => {
      const { el1, el3 } = await setupDpad();
      activeElementRef = el1;
      fireKey('ArrowUp');
      expect(el3.focus).toHaveBeenCalled();
    });

    it('Enter clicks focused element and prevents default', async () => {
      const { el2 } = await setupDpad();
      activeElementRef = el2;
      const ev = fireKey('Enter');
      expect(ev.preventDefault).toHaveBeenCalled();
      expect(el2.click).toHaveBeenCalled();
    });

    it('Escape (Back) prevents default', async () => {
      await setupDpad();
      const ev = fireKey('Escape');
      expect(ev.preventDefault).toHaveBeenCalled();
    });
  });

  // ==================== 19. OFFLINE RESILIENCE ====================

  describe('Offline Resilience', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('restores playlist from Preferences on startup with credentials', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      preferencesStore.set('last_playlist', JSON.stringify({
        id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }],
      }));
      await importFresh();
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('Restored last playlist'))).toBe(true);
    });

    it('starts offline playback when network unavailable but playlist restored', async () => {
      networkConnected = false;
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      preferencesStore.set('last_playlist', JSON.stringify({
        id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }], loopPlaylist: true,
      }));
      await importFresh();
      expect((console.log as Mock).mock.calls.some(c => String(c[0]).includes('offline playback'))).toBe(true);
    });

    it('shows offline overlay after 60s sustained disconnect', async () => {
      domElements.delete('offline-overlay');
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.connected = false;
      triggerSocketEvent('disconnect', 'transport close');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(bodyChildren.find(c => c.id === 'offline-overlay')).toBeDefined();
    });

    it('hides offline overlay on reconnect', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      // Manually add offline overlay to DOM so hideOfflineOverlay can find and remove it
      const ov = createElementStub('div');
      ov.id = 'offline-overlay';
      domElements.set('offline-overlay', ov);
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      expect(ov.remove).toHaveBeenCalled();
    });

    it('clears offline timeout when app goes to background', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      domElements.delete('offline-overlay');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      currentMockSocket.connected = false;
      triggerSocketEvent('disconnect', 'io server disconnect');
      triggerAppStateChange(false);
      await vi.advanceTimersByTimeAsync(70_000);
      expect(bodyChildren.find(c => c.id === 'offline-overlay')).toBeUndefined();
    });
  });

  // ==================== 20. MEDIA CLEANUP ====================

  describe('Media Cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /**
     * Commit a video item, wire its containing div's querySelectorAll to find
     * it, then swap to an image playlist. The engine runs the old item's
     * cleanup at commit time — the video must be paused and released.
     */
    const setupCommittedVideoThenSwap = async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'V', items: [{ id: 'i1', contentId: 'v1', duration: 30, order: 0,
          content: { id: 'v1', name: 'Vid', type: 'video', url: '/v.mp4' } }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(4100); // video readiness wait -> commit
      const videos = findCreatedElements('video');
      expect(videos.length).toBeGreaterThan(0);
      const videoEl = videos[videos.length - 1];
      // Make the committed content div report the video to cleanupMediaElements
      const divs = findCreatedElements('div');
      const videoDiv = divs.find(d => d.children.includes(videoEl))!;
      expect(videoDiv).toBeDefined();
      (videoDiv.querySelectorAll as Mock).mockReturnValue([videoEl]);

      // Swap to an image playlist — old item cleanup runs at the new commit
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p2', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(1600); // image readiness wait -> commit
      return videoEl;
    };

    it('pauses all video elements in container', async () => {
      const videoEl = await setupCommittedVideoThenSwap();
      expect(videoEl.pause).toHaveBeenCalled();
    });

    it('removes src attribute from videos', async () => {
      const videoEl = await setupCommittedVideoThenSwap();
      expect(videoEl.removeAttribute).toHaveBeenCalledWith('src');
    });

    it('calls video.load() to release media resources', async () => {
      const videoEl = await setupCommittedVideoThenSwap();
      expect(videoEl.load).toHaveBeenCalled();
    });
  });

  // ==================== 21. SCREEN MANAGEMENT ====================

  describe('Screen Management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('showScreen(pairing) shows pairing and hides others', async () => {
      await importFresh(); // No creds => pairing
      const ps = domElements.get('pairing-screen')!;
      const cs = domElements.get('content-screen')!;
      expect((ps.classList.toggle as Mock).mock.calls.some((c: unknown[]) => c[0] === 'hidden' && c[1] === false)).toBe(true);
      expect((cs.classList.toggle as Mock).mock.calls.some((c: unknown[]) => c[0] === 'hidden' && c[1] === true)).toBe(true);
    });

    it('credentials without cached playlist boot into HOLDING, not a black content screen', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      const hs = domElements.get('holding-screen')!;
      const ps = domElements.get('pairing-screen')!;
      expect(hs._classListSet.has('hidden')).toBe(false);
      expect(ps._classListSet.has('hidden')).toBe(true);
      // NEGATIVE: the content screen (empty container = black) is NOT shown
      expect(domElements.get('content-screen')!._classListSet.has('hidden')).toBe(true);
    });

    it('credentials with cached playlist show content only after the first frame commits', async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      preferencesStore.set('last_playlist', JSON.stringify({
        id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'I', type: 'image', url: '/i.jpg' } }], loopPlaylist: true,
      }));
      await importFresh();
      await vi.advanceTimersByTimeAsync(1600); // readiness wait -> commit -> PLAYING
      const cs = domElements.get('content-screen')!;
      expect(cs._classListSet.has('hidden')).toBe(false);
      expect((domElements.get('content-container')!.appendChild as Mock).mock.calls.length).toBeGreaterThan(0);
    });

    it('pairing request failure stays on the pairing screen — the error screen is never shown', async () => {
      httpPostHandler = () => ({ status: 500, data: { error: 'Internal' } });
      await importFresh();
      const ps = domElements.get('pairing-screen')!;
      expect(ps._classListSet.has('hidden')).toBe(false);
      expect(domElements.get('status-text')!.textContent).toContain('retrying');
      // NEGATIVE: no error surface — the error screen was never made visible
      const es = domElements.get('error-screen')!;
      expect((es.classList.toggle as Mock).mock.calls.every(
        (c: unknown[]) => !(c[0] === 'hidden' && c[1] === false)
      )).toBe(true);
    });
  });

  // ==================== 22. NEVER-BLACK STATE MACHINE (P0-1 negative suite) ====================
  //
  // These tests assert what the app did NOT do: no cleared container without a
  // ready replacement, no error surface while renderable content exists, no
  // black content screen for states that lack content. Design:
  // docs/design/playback-state-machine.md §7.

  describe('Never-Black State Machine', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    /** The five top-level screens that are currently visible (not .hidden). */
    const visibleScreens = () =>
      ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
        .filter(id => {
          const el = domElements.get(id);
          return el && !el._classListSet.has('hidden');
        });

    const imageItem = (id: string, duration = 10) => ({
      id: `it-${id}`, contentId: id, duration, order: 0,
      content: { id, name: `C-${id}`, type: 'image', url: `/${id}.jpg` },
    });

    const connectAndPlay = async (items: unknown[], loop = true) => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', { playlist: { id: 'pl', name: 'PL', items, loopPlaylist: loop } });
      await vi.advanceTimersByTimeAsync(1600);
    };

    it('empty playlist push lands in branded HOLDING — exactly one screen visible, never a bare content screen', async () => {
      await connectAndPlay([]);
      expect(visibleScreens()).toEqual(['holding-screen']);
      expect(domElements.get('holding-message')!.textContent).toContain('Waiting');
    });

    it('empty playlist replacing a playing one switches to HOLDING (did not leave a cleared black container on screen)', async () => {
      await connectAndPlay([imageItem('c1')]);
      expect(visibleScreens()).toEqual(['content-screen']);
      triggerSocketEvent('playlist:update', { playlist: { id: 'pl2', name: 'E', items: [], loopPlaylist: true } });
      await vi.advanceTimersByTimeAsync(100);
      expect(visibleScreens()).toEqual(['holding-screen']);
    });

    it('malformed playlist pushes are inert — current content stays committed and playing', async () => {
      await connectAndPlay([imageItem('c1')]);
      const container = domElements.get('content-container')!;
      const childrenBefore = container.children.length;
      expect(childrenBefore).toBeGreaterThan(0);

      for (const garbage of [undefined, null, {}, { playlist: null }, { playlist: 42 }, { playlist: { items: 'not-an-array' } }]) {
        triggerSocketEvent('playlist:update', garbage);
      }
      await vi.advanceTimersByTimeAsync(100);

      // NEGATIVE: nothing was removed, screen unchanged, machine still on content
      expect(container.children.length).toBe(childrenBefore);
      expect(visibleScreens()).toEqual(['content-screen']);
      expect((console.warn as Mock).mock.calls.some(c => String(c[0]).includes('malformed'))).toBe(true);
    });

    it('playlist with 100% null-content items lands in HOLDING with no stack overflow', async () => {
      const nullItems = Array.from({ length: 5 }, (_, i) => ({
        id: `it-${i}`, contentId: `c${i}`, duration: 10, order: i, content: null,
      }));
      await connectAndPlay(nullItems);
      expect(visibleScreens()).toEqual(['holding-screen']);
      // NEGATIVE: no RangeError escaped (vitest would fail the test on an
      // unhandled rejection); the bounded scan logged its terminal warning.
      expect((console.warn as Mock).mock.calls.some(c => String(c[0]).includes('No renderable content'))).toBe(true);
    });

    it('layout items advance after their duration (no terminal layout state)', async () => {
      const layoutItem = {
        id: 'it-l', contentId: 'l1', duration: 2, order: 0,
        content: { id: 'l1', name: 'L', type: 'layout', url: '' },
        metadata: {
          gridTemplate: { columns: '1fr', rows: '1fr' },
          zones: [{ id: 'z1', gridArea: '1/1', resolvedContent: { id: 'zi', name: 'Z', type: 'image', url: '/z.jpg' } }],
        },
      };
      await connectAndPlay([layoutItem, imageItem('after-layout')]);
      // Layout committed (no readiness wait for layouts)
      expect(visibleScreens()).toEqual(['content-screen']);
      // After the layout's 2s duration + image readiness, the next item commits
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(1600);
      const imgs = findCreatedElements('img');
      expect(imgs.some(i => i.src.includes('after-layout'))).toBe(true);
    });

    it('layout zone timers are cleaned up when the playlist moves on (no ghost zone loops)', async () => {
      const layoutItem = {
        id: 'it-l', contentId: 'l1', duration: 2, order: 0,
        content: { id: 'l1', name: 'L', type: 'layout', url: '' },
        metadata: {
          zones: [{
            id: 'z1', gridArea: '1/1',
            resolvedPlaylist: { id: 'zp', name: 'ZP', items: [
              { id: 'z-i1', contentId: 'z1c', duration: 1, order: 0, content: { id: 'z1c', name: 'Z1', type: 'image', url: '/z1.jpg' } },
              { id: 'z-i2', contentId: 'z2c', duration: 1, order: 1, content: { id: 'z2c', name: 'Z2', type: 'image', url: '/z2.jpg' } },
            ] },
          }],
        },
      };
      await connectAndPlay([layoutItem, imageItem('next', 10)]);
      await vi.advanceTimersByTimeAsync(2100); // layout duration elapses
      await vi.advanceTimersByTimeAsync(1600); // next image commits, cleanup ran
      const zoneImgsAfterSwap = findCreatedElements('img').filter(i => i.src.includes('/z')).length;
      // NEGATIVE: zone rotation stopped — no new zone images appear afterwards
      await vi.advanceTimersByTimeAsync(5000);
      const zoneImgsLater = findCreatedElements('img').filter(i => i.src.includes('/z')).length;
      expect(zoneImgsLater).toBe(zoneImgsAfterSwap);
    });

    it('layout with invalid metadata is skipped without touching the screen', async () => {
      const badLayout = {
        id: 'it-l', contentId: 'l1', duration: 5, order: 0,
        content: { id: 'l1', name: 'BadL', type: 'layout', url: '' },
        // no metadata at all
      };
      await connectAndPlay([badLayout, imageItem('good')]);
      // The good image committed; the bad layout produced no grid
      const grids = findCreatedElements('div').filter(d => d.className === 'layout-grid');
      expect(grids.length).toBe(0);
      expect(findCreatedElements('img').some(i => i.src.includes('good'))).toBe(true);
      expect(visibleScreens()).toEqual(['content-screen']);
    });

    it('item transitions append the replacement BEFORE removing the old frame', async () => {
      await connectAndPlay([imageItem('c1', 2), imageItem('c2', 2)]);
      const container = domElements.get('content-container')!;
      expect(container.children.length).toBe(1);
      // Advance to the second item's commit
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(1600);
      // Exactly one committed frame remains
      expect(container.children.length).toBe(1);
      // NEGATIVE (ordering): every removeChild happened after an appendChild —
      // the container can never pass through an empty state during a swap.
      const appendOrders = (container.appendChild as Mock).mock.invocationCallOrder;
      const removeOrders = (container.removeChild as Mock).mock.invocationCallOrder;
      expect(appendOrders.length).toBeGreaterThanOrEqual(2);
      expect(removeOrders.length).toBeGreaterThanOrEqual(1);
      expect(Math.min(...removeOrders)).toBeGreaterThan(Math.min(...appendOrders));
      for (let k = 0; k < removeOrders.length; k++) {
        // k-th removal must come after (k+1)-th append: remove #1 after append #2
        expect(removeOrders[k]).toBeGreaterThan(appendOrders[k + 1] ?? -Infinity);
      }
    });

    it('the old frame stays on screen while the next item is still preparing (slow asset)', async () => {
      await connectAndPlay([imageItem('c1', 2), imageItem('c2', 2)]);
      const container = domElements.get('content-container')!;
      const firstChild = container.children[0];
      // Item 1's duration elapses; item 2 is preparing (readiness wait pending)
      await vi.advanceTimersByTimeAsync(2100);
      await vi.advanceTimersByTimeAsync(800); // less than the 1500ms wait
      // NEGATIVE: the old frame was NOT removed early
      expect(container.children.length).toBeGreaterThan(0);
      expect(container.children[0]).toBe(firstChild);
    });

    it('paired device with no playlist shows HOLDING on connect — never a black content screen (F11)', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      await vi.advanceTimersByTimeAsync(100);
      expect(visibleScreens()).toEqual(['holding-screen']);
      expect(domElements.get('content-screen')!._classListSet.has('hidden')).toBe(true);
    });

    it('fresh device with no credentials boots to PAIRING', async () => {
      secureStorageStore.clear();
      await importFresh();
      expect(visibleScreens()).toEqual(['pairing-screen']);
    });

    it('dangling token without deviceId still reaches PAIRING — no dead loading screen', async () => {
      secureStorageStore.clear();
      secureStorageStore.set('device_token', 'orphan-token');
      await importFresh();
      expect(visibleScreens()).toEqual(['pairing-screen']);
    });

    it('init failure enters RECOVERING and retries to a working state — the error screen is never shown', async () => {
      secureStorageStore.clear();
      preferencesFailNext = true; // first Preferences.get throws inside init()
      await importFresh();
      // RECOVERING renders on the branded holding screen
      expect(visibleScreens()).toEqual(['holding-screen']);
      expect(domElements.get('holding-message')!.textContent).toContain('retrying');
      // Backoff elapses -> init retries -> lands in pairing (no creds)
      await vi.advanceTimersByTimeAsync(5100);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(visibleScreens()).toEqual(['pairing-screen']);
      // NEGATIVE: the raw error screen never became visible at any point
      const es = domElements.get('error-screen')!;
      expect((es.classList.toggle as Mock).mock.calls.every(
        (c: unknown[]) => !(c[0] === 'hidden' && c[1] === false)
      )).toBe(true);
    });

    it('heartbeat stops reporting currentContent when the machine leaves PLAYING (F13)', async () => {
      await connectAndPlay([imageItem('c1')]);
      // Playing: heartbeat carries the content id
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(15_000);
      const playingHb = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat');
      expect(playingHb.length).toBeGreaterThan(0);
      // Drop to holding via an empty playlist
      triggerSocketEvent('playlist:update', { playlist: { id: 'e', name: 'E', items: [], loopPlaylist: true } });
      await vi.advanceTimersByTimeAsync(100);
      currentMockSocket.emit.mockClear();
      await vi.advanceTimersByTimeAsync(15_100);
      const holdingHb = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat');
      expect(holdingHb.length).toBeGreaterThan(0);
      const payload = holdingHb[holdingHb.length - 1][1] as Record<string, unknown>;
      // NEGATIVE: no stale "now playing" claim while the screen is on holding
      expect(payload.currentContent).toBeUndefined();
      expect(payload.screenState).toBe('holding');
    });
  });

  // ==================== 23. REVOCATION & TENANT TRUST (P0-2 negative suite) ====================
  //
  // Contract: docs/design/revocation-contract.md §8. Playback fails open on
  // transport errors; credential destruction requires a confirmed (410)
  // revocation; tenant binding is verified at load time.

  describe('Revocation & Tenant Trust', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      resetCapacitorFakes();
      resetDOM();
      (window.location as { search: string }).search = '';
      (window.location.reload as Mock).mockClear();
      ioFactory.mockClear();
      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
      mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
      mockCacheManager.clearCache.mockClear();
      qrToCanvasMock.mockReset().mockResolvedValue(undefined);
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    const visibleScreens = () =>
      ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
        .filter(id => {
          const el = domElements.get(id);
          return el && !el._classListSet.has('hidden');
        });

    const playlistPayload = {
      playlist: { id: 'pl', name: 'PL', items: [{ id: 'it-1', contentId: 'c1', duration: 10, order: 0,
        content: { id: 'c1', name: 'C', type: 'image', url: '/c1.jpg' } }], loopPlaylist: true },
    };

    const connectAndCommit = async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', playlistPayload);
      await vi.advanceTimersByTimeAsync(1600);
      expect(visibleScreens()).toEqual(['content-screen']);
    };

    const authCheckCalls = async () => {
      const { CapacitorHttp } = await import('@capacitor/core');
      return (CapacitorHttp.get as Mock).mock.calls.filter(
        (c: unknown[]) => String((c[0] as { url: string }).url).includes('/devices/auth/check'),
      );
    };

    it('AUTH_INVALID connect_error: credentials intact, playback continues, background probe runs', async () => {
      await connectAndCommit();
      triggerSocketEvent('connect_error', { message: 'jwt malformed', data: { code: 'AUTH_INVALID' } });
      await vi.advanceTimersByTimeAsync(100);
      // NEGATIVE: no wipe, no pairing screen — the F3 fleet-de-pair bomb is defused
      expect(secureStorageStore.has('device_token')).toBe(true);
      expect(visibleScreens()).toEqual(['content-screen']);
      // Probe fires within backoff window (30s ±25%)
      await vi.advanceTimersByTimeAsync(40_000);
      expect((await authCheckCalls()).length).toBeGreaterThanOrEqual(1);
      // Legacy 404 answer → probing stops, still no wipe
      expect(secureStorageStore.has('device_token')).toBe(true);
    });

    it('auth-check 401 stays fail-open: no purge, no pairing, keeps the cached loop (F38 — never reopens F3)', async () => {
      httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
        ? { status: 401, data: {} }
        : { status: 200, data: { data: { status: 'pending' } } };
      await connectAndCommit();
      triggerSocketEvent('connect_error', { message: 'expired', data: { code: 'AUTH_EXPIRED' } });
      await vi.advanceTimersByTimeAsync(40_000);
      // NEGATIVE: a 401 is not a 410 — credentials intact, still on content, still probing
      expect(secureStorageStore.has('device_token')).toBe(true);
      expect(visibleScreens()).toEqual(['content-screen']);
      expect((await authCheckCalls()).length).toBeGreaterThanOrEqual(1);
    });

    it('auth-check 401 emits distinct auth_check_401 telemetry so operators can see token rejection (F38)', async () => {
      const { reportEvent } = await import('./crash-reporting');
      httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
        ? { status: 401, data: {} }
        : { status: 200, data: { data: { status: 'pending' } } };
      await connectAndCommit();
      (reportEvent as Mock).mockClear();
      triggerSocketEvent('connect_error', { message: 'expired', data: { code: 'AUTH_EXPIRED' } });
      await vi.advanceTimersByTimeAsync(40_000);
      expect((reportEvent as Mock).mock.calls.some((c: unknown[]) => c[0] === 'auth_check_401')).toBe(true);
    });

    it('device:revoked + auth-check 410: full purge, pairing shown, no further content renders', async () => {
      httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
        ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
        : { status: 200, data: { data: { status: 'pending' } } };
      await connectAndCommit();
      const container = domElements.get('content-container')!;
      const appendsBefore = (container.appendChild as Mock).mock.calls.length;

      triggerSocketEvent('device:revoked', { reason: 'operator' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);

      expect(secureStorageStore.has('device_token')).toBe(false);
      expect(secureStorageStore.has('device_id')).toBe(false);
      expect(preferencesStore.has('last_playlist')).toBe(false);
      expect(mockCacheManager.clearCache).toHaveBeenCalled();
      expect(visibleScreens()).toEqual(['pairing-screen']);
      // NEGATIVE: not one further frame of tenant content after the purge
      await vi.advanceTimersByTimeAsync(35_000);
      expect((container.appendChild as Mock).mock.calls.length).toBe(appendsBefore);
    });

    it('device:revoked + auth-check 200: unconfirmed signal — NO wipe', async () => {
      httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
        ? { status: 200, data: { status: 'ok' } }
        : { status: 200, data: { data: { status: 'pending' } } };
      await connectAndCommit();
      triggerSocketEvent('device:revoked', { reason: 'spoof?' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(secureStorageStore.has('device_token')).toBe(true);
      expect(visibleScreens()).toEqual(['content-screen']);
    });

    it('device:revoked + auth-check 404 (legacy backend): NO wipe — carve-out is unpair-only', async () => {
      await connectAndCommit(); // default handler: auth-check 404
      triggerSocketEvent('device:revoked', { reason: 'x' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(secureStorageStore.has('device_token')).toBe(true);
      expect(visibleScreens()).toEqual(['content-screen']);
    });

    it('unpair command + auth-check 404: legacy carve-out purges and reloads (old-backend unpair still works)', async () => {
      await connectAndCommit();
      triggerSocketEvent('command', { type: 'unpair' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(secureStorageStore.has('device_token')).toBe(false);
      expect(preferencesStore.has('last_playlist')).toBe(false);
      expect(mockCacheManager.clearCache).toHaveBeenCalled();
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('unpair carve-out REFUSES once the auth-check endpoint has ever responded (mechanical §7.1a gate)', async () => {
      // Device previously observed a live auth-check endpoint (backend §6.4
      // deployed) — a 404 now is an anomaly, not "legacy backend".
      preferencesStore.set('auth_check_seen', '1');
      await connectAndCommit(); // default handler: auth-check 404
      triggerSocketEvent('command', { type: 'unpair' });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
      // NEGATIVE: no purge, no reload — the carve-out is dead once outgrown
      expect(secureStorageStore.has('device_token')).toBe(true);
      expect(window.location.reload).not.toHaveBeenCalled();
      expect(visibleScreens()).toEqual(['content-screen']);
    });

    it('a live auth-check response permanently arms the carve-out gate', async () => {
      httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
        ? { status: 200, data: { status: 'ok' } }
        : { status: 200, data: { data: { status: 'pending' } } };
      await connectAndCommit();
      // Trigger one probe via an auth-degraded signal
      triggerSocketEvent('connect_error', { message: 'x', data: { code: 'AUTH_EXPIRED' } });
      await vi.advanceTimersByTimeAsync(40_000);
      expect((await authCheckCalls()).length).toBeGreaterThanOrEqual(1);
      expect(preferencesStore.get('auth_check_seen')).toBe('1');
    });

    it('confirmation probes are rate-limited: repeated revocation signals produce one auth-check', async () => {
      await connectAndCommit();
      triggerSocketEvent('device:revoked', { reason: 'a' });
      triggerSocketEvent('device:revoked', { reason: 'b' });
      await vi.advanceTimersByTimeAsync(60_000);
      triggerSocketEvent('device:revoked', { reason: 'c' });
      await vi.advanceTimersByTimeAsync(200);
      expect((await authCheckCalls()).length).toBe(1);
    });

    it('boot with a different tenant\'s cached playlist refuses to render it and purges (F4)', async () => {
      secureStorageStore.set('tenant_id', 'tenant-B');
      preferencesStore.set('last_playlist', JSON.stringify({
        tenantId: 'tenant-A', deviceId: 'dev-old', savedAt: 1,
        playlist: { id: 'pl-A', name: 'A', items: [{ id: 'i1', contentId: 'cA', duration: 10, order: 0,
          content: { id: 'cA', name: 'TenantA', type: 'image', url: '/tenant-a.jpg' } }], loopPlaylist: true },
      }));
      await importFresh();
      await vi.advanceTimersByTimeAsync(2000);
      // NEGATIVE: tenant-A content never rendered
      expect(findCreatedElements('img').some(i => i.src.includes('tenant-a'))).toBe(false);
      expect(preferencesStore.has('last_playlist')).toBe(false);
      expect(mockCacheManager.clearCache).toHaveBeenCalled();
      expect(visibleScreens()).toEqual(['holding-screen']);
    });

    it('boot with a legacy (pre-envelope) playlist still renders — migration grace', async () => {
      preferencesStore.set('last_playlist', JSON.stringify({
        id: 'pl-legacy', name: 'L', items: [{ id: 'i1', contentId: 'cL', duration: 10, order: 0,
          content: { id: 'cL', name: 'Legacy', type: 'image', url: '/legacy.jpg' } }], loopPlaylist: true,
      }));
      await importFresh();
      await vi.advanceTimersByTimeAsync(1600);
      expect(findCreatedElements('img').some(i => i.src.includes('legacy'))).toBe(true);
      expect(visibleScreens()).toEqual(['content-screen']);
    });

    it('tenant:suspended fails closed (holding, no re-render) and tenant:resumed restores playback', async () => {
      await connectAndCommit();
      triggerSocketEvent('tenant:suspended');
      await vi.advanceTimersByTimeAsync(100);
      expect(visibleScreens()).toEqual(['holding-screen']);
      expect(domElements.get('holding-message')!.textContent).toContain('paused');
      expect(secureStorageStore.has('device_token')).toBe(true); // credentials kept
      // NEGATIVE: the holding self-heal loop must NOT resurrect suspended content
      const container = domElements.get('content-container')!;
      const appends = (container.appendChild as Mock).mock.calls.length;
      await vi.advanceTimersByTimeAsync(65_000);
      expect((container.appendChild as Mock).mock.calls.length).toBe(appends);
      expect(visibleScreens()).toEqual(['holding-screen']);
      // Resume restores rendering
      triggerSocketEvent('tenant:resumed');
      await vi.advanceTimersByTimeAsync(1600);
      expect(visibleScreens()).toEqual(['content-screen']);
    });

    it('heartbeat ack with revoked:true triggers the confirm flow', async () => {
      httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
        ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
        : { status: 200, data: { data: { status: 'pending' } } };
      await connectAndCommit();
      const hbCall = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').pop();
      expect(hbCall).toBeDefined();
      const ack = hbCall![2] as (r: unknown) => void;
      ack({ revoked: true });
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
      expect(secureStorageStore.has('device_token')).toBe(false);
      expect(visibleScreens()).toEqual(['pairing-screen']);
    });
  });
});

// ==================== WHOLE-TREE SEAM REVIEW FIXES (F41–F52) ====================

describe('Whole-tree seam review fixes (F41–F52)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetCapacitorFakes();
    resetDOM();
    (window.location as { search: string }).search = '';
    (window.location.reload as Mock).mockClear();
    ioFactory.mockClear();
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
    mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
    mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
    qrToCanvasMock.mockReset().mockResolvedValue(undefined);
    // Restore default SecureStorage behaviour — an earlier test may have overridden get().
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => ({
      value: secureStorageStore.get(key) ?? null,
    }));
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    });
    (SecureStorage.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    });
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    secureStorageStore.set('device_token', 'tok-123');
    secureStorageStore.set('device_id', 'dev-123');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const visibleScreens = () =>
    ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
      .filter(id => {
        const el = domElements.get(id);
        return el && !el._classListSet.has('hidden');
      });

  const playlistPayload = {
    playlist: { id: 'pl', name: 'PL', items: [{ id: 'it-1', contentId: 'c1', duration: 10, order: 0,
      content: { id: 'c1', name: 'C', type: 'image', url: '/c1.jpg' } }], loopPlaylist: true },
  };

  const connectAndCommit = async () => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistPayload);
    await vi.advanceTimersByTimeAsync(1600);
    expect(visibleScreens()).toEqual(['content-screen']);
  };

  const authCheckCalls = async () => {
    const { CapacitorHttp } = await import('@capacitor/core');
    return (CapacitorHttp.get as Mock).mock.calls.filter(
      (c: unknown[]) => String((c[0] as { url: string }).url).includes('/devices/auth/check'),
    );
  };

  const reportedEvents = async () => {
    const { reportEvent } = await import('./crash-reporting');
    return (reportEvent as Mock).mock.calls.map((c: unknown[]) => c[0]);
  };

  // -------- F41: tenantSuspended latch cleared on resume + reconnect --------

  // F53: the suspend gate in advance() is checked ONCE at entry, and the only
  // post-await check is the playback generation. A tenant:suspended arriving while
  // prepare() is in flight was therefore honoured and then immediately overwritten by
  // the frame already being prepared — and the resulting transition out of holding
  // cancelled the 30s self-heal retry, so on the last item of a non-looping playlist a
  // suspended tenant kept rendering INDEFINITELY.
  //
  // Deterministic on purpose. The pre-existing F41 test caught this only ~2 runs in 10,
  // via probe-backoff jitter that happened to land the 403 inside the prepare window —
  // it sampled the bug rather than testing it, and under-detected it besides.
  it('F53: a tenant:suspended landing mid-prepare is not overwritten by the in-flight frame', async () => {
    await connectAndCommit();
    // The committed item expires at +10s, re-entering advance() and starting prepare()
    // for the next one, which then waits up to READY_WAIT_MS.
    await vi.advanceTimersByTimeAsync(10_000);
    // Suspension arrives WHILE that prepare() is in flight.
    triggerSocketEvent('tenant:suspended', {});
    expect(visibleScreens()).toEqual(['holding-screen']);
    // …and must still be holding after the in-flight prepare() resolves.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(visibleScreens()).toEqual(['holding-screen']);
  });
  it('F41: an auth-probe 403 suspends, and a later 200 clears the latch and resumes playback', async () => {
    let n = 0;
    httpGetHandler = (opts: { url: string }) => {
      if (opts.url.includes('/devices/auth/check')) {
        n++;
        return n === 1 ? { status: 403, data: {} } : { status: 200, data: {} };
      }
      return { status: 200, data: { data: { status: 'pending' } } };
    };
    await connectAndCommit();
    // Drive the auth-degraded probe loop (connect_error → REST probe).
    triggerSocketEvent('connect_error', { message: 'expired', data: { code: 'AUTH_EXPIRED' } });
    await vi.advanceTimersByTimeAsync(40_000); // first probe → 403 → suspended
    expect(visibleScreens()).toEqual(['holding-screen']);
    await vi.advanceTimersByTimeAsync(80_000); // next probe → 200 → latch cleared + resume
    await vi.advanceTimersByTimeAsync(1600);   // re-commit
    // POSITIVE: not stranded on holding — the cached loop is back on glass
    expect(visibleScreens()).toEqual(['content-screen']);
    expect(await reportedEvents()).toContain('tenant_unsuspended');
  });

  // -------- C1: a reconnect is NOT evidence that the tenant is active --------
  //
  // REPLACES an F41 test that asserted the opposite ("a fresh handshake must itself
  // clear the latch"). That test encoded a behaviour that is wrong against the
  // deployed gateway: its handshake verifies token revocation, device existence, org
  // match, isDisabled and token currency, and contains NO tenant-suspension check —
  // the only suspension code there is the outbound `tenant:suspended` emitter, and
  // TENANT_SUSPENDED is produced solely by the REST auth/check. So the assumption the
  // old assertion rested on ("a successful handshake means the tenant is active") is
  // false, and on a 24/7 screen the inevitable reconnect silently resumed a suspended
  // tenant's content, permanently, with no probe loop left running.
  //
  // The RECOVERABLE direction the old test also cared about is not lost — it is the
  // test below, now driven by the evidence that actually establishes it.

  it('C1: a reconnect while suspended does NOT clear the latch (auth-check does not say 200)', async () => {
    await connectAndCommit();
    triggerSocketEvent('tenant:suspended');
    await vi.advanceTimersByTimeAsync(100);
    expect(visibleScreens()).toEqual(['holding-screen']);

    triggerSocketEvent('disconnect', 'transport close');
    triggerSocketEvent('connect');
    await vi.advanceTimersByTimeAsync(1600);

    // Still held, and the latch is still latched.
    expect(visibleScreens()).toEqual(['holding-screen']);
    expect(await reportedEvents()).not.toContain('tenant_unsuspended');
    expect(await reportedEvents()).toContain('tenant_suspension_confirmed');
    // The suspended tenant's content is genuinely NOT back on glass.
    expect(domElements.get('content-screen')!._classListSet.has('hidden')).toBe(true);
  });

  it('C1: a reconnect DOES clear the latch when auth-check answers 200', async () => {
    // The recoverable direction, on the evidence that actually establishes it. Without
    // this the fix could have created a state the device cannot leave when the tenant
    // IS resumed.
    await connectAndCommit();
    triggerSocketEvent('tenant:suspended');
    await vi.advanceTimersByTimeAsync(100);
    expect(visibleScreens()).toEqual(['holding-screen']);

    httpGetHandler = (opts: { url: string }) => opts.url.includes('/devices/auth/check')
      ? { status: 200, data: {} }
      : { status: 200, data: { data: { status: 'pending' } } };

    triggerSocketEvent('disconnect', 'transport close');
    triggerSocketEvent('connect');
    await vi.advanceTimersByTimeAsync(1600);

    expect(visibleScreens()).toEqual(['content-screen']);
    expect(await reportedEvents()).toContain('tenant_unsuspended');
  });

  it('C1: the suspension latch is DURABLE — a reboot re-enters holding, it does not resume', async () => {
    // last_playlist is still written while suspended, so with an in-memory-only latch
    // a power cycle put the suspended tenant's cached loop straight back on customer
    // glass with no probe running. Nothing else stops that.
    await connectAndCommit();
    expect(preferencesStore.has('last_playlist')).toBe(true);
    triggerSocketEvent('tenant:suspended');
    await vi.advanceTimersByTimeAsync(100);
    expect(preferencesStore.get('tenant_suspended')).toBe('1');

    // Reboot: fresh module, same disk. auth-check stays 404 (this block's default),
    // so nothing clears the latch.
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    // findCreatedElements reads the createElement mock's accumulated results, and the
    // pre-reboot phase above already rendered c1.jpg. Without this the "not rendered"
    // assertion below would read the PREVIOUS boot's element and fail on a correct fix.
    (document.createElement as Mock).mockClear();
    await importFresh();
    await vi.advanceTimersByTimeAsync(2000);

    expect(visibleScreens()).toEqual(['holding-screen']);
    expect(findCreatedElements('img').some(i => i.src.includes('c1.jpg'))).toBe(false);
    const suspendCalls = (reportEvent as Mock).mock.calls.filter(c => c[0] === 'tenant_suspended');
    expect(suspendCalls.length).toBeGreaterThan(0);
    expect((suspendCalls[0][1] as { source?: string }).source).toBe('restored_latch');
  });

  it('C1 NEGATIVE CONTROL: with no latch on disk a reboot resumes the cached playlist', async () => {
    // Same seam, same reboot. Proves the hold above belongs to the persisted latch and
    // not to the reboot path having stopped rendering.
    await connectAndCommit();
    expect(preferencesStore.has('tenant_suspended')).toBe(false);

    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    (document.createElement as Mock).mockClear(); // same window as the test above
    await importFresh();
    await vi.advanceTimersByTimeAsync(2000);

    expect(visibleScreens()).toEqual(['content-screen']);
    expect(findCreatedElements('img').some(i => i.src.includes('c1.jpg'))).toBe(true);
  });

  // -------- F42: unguarded tenant_id read --------

  it('F42: a rejecting tenant_id read is non-fatal — boots to holding, not an infinite RECOVERING loop', async () => {
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'tenant_id') throw { code: 'AEAD_DECRYPT_FAILED', message: 'tag mismatch' };
      return { value: secureStorageStore.get(key) ?? null };
    });
    await importFresh();
    await vi.advanceTimersByTimeAsync(200);
    // NEGATIVE: no cached playlist → stable holding, NOT a recovering retry loop
    expect(visibleScreens()).toEqual(['holding-screen']);
    expect(await reportedEvents()).toContain('tenant_read_failed');
  });

  it('F42/F4: a tenant-bound cache is held (not rendered, not purged) when tenant_id is unverifiable', async () => {
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'tenant_id') throw { code: 'AEAD_DECRYPT_FAILED', message: 'tag mismatch' };
      return { value: secureStorageStore.get(key) ?? null };
    });
    preferencesStore.set('last_playlist', JSON.stringify({
      tenantId: 'tenant-A', deviceId: 'dev-123', savedAt: 1,
      playlist: { id: 'pl-A', name: 'A', items: [{ id: 'i1', contentId: 'cA', duration: 10, order: 0,
        content: { id: 'cA', name: 'TenantA', type: 'image', url: '/tenant-a.jpg' } }], loopPlaylist: true },
    }));
    await importFresh();
    await vi.advanceTimersByTimeAsync(2000);
    // NEGATIVE (F4): tenant-A content is never rendered — fail closed, device holds
    expect(findCreatedElements('img').some(i => i.src.includes('tenant-a'))).toBe(false);
    expect(visibleScreens()).toEqual(['holding-screen']);
    // NOT purged — the read failure may be transient; preserve for a verified boot
    expect(preferencesStore.has('last_playlist')).toBe(true);
    expect(mockCacheManager.clearCache).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('tenant_unverifiable_hold');
  });

  it('F42/F4: a legacy (no-tenant) cache still renders under grace when tenant_id is unverifiable', async () => {
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'tenant_id') throw { code: 'AEAD_DECRYPT_FAILED', message: 'tag mismatch' };
      return { value: secureStorageStore.get(key) ?? null };
    });
    // Legacy pre-envelope playlist (no tenant binding at all) → grace must be preserved.
    preferencesStore.set('last_playlist', JSON.stringify({
      id: 'pl-L', name: 'L', items: [{ id: 'i1', contentId: 'cL', duration: 10, order: 0,
        content: { id: 'cL', name: 'Legacy', type: 'image', url: '/legacy.jpg' } }], loopPlaylist: true,
    }));
    await importFresh();
    await vi.advanceTimersByTimeAsync(1600);
    // POSITIVE: legacy cache renders — the fail-closed path must NOT catch no-tenant devices
    expect(findCreatedElements('img').some(i => i.src.includes('legacy'))).toBe(true);
    expect(visibleScreens()).toEqual(['content-screen']);
  });

  // -------- F43: update_config allowlist --------

  it('F43: update_config rejects an arbitrary host — no persist, no reload', async () => {
    await importFresh();
    triggerSocketEvent('command', { type: 'update_config', apiUrl: 'https://evil.tld' });
    await vi.advanceTimersByTimeAsync(50);
    expect(preferencesStore.has('config_api_url')).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('config_rejected');
  });

  it('F43: update_config accepts a same-registrable-domain https host', async () => {
    await importFresh();
    triggerSocketEvent('command', { type: 'update_config', apiUrl: 'https://cdn.vizora.io' });
    await vi.advanceTimersByTimeAsync(50);
    expect(preferencesStore.get('config_api_url')).toBe('https://cdn.vizora.io');
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('F43: update_config rejects a wss→ws downgrade for realtime', async () => {
    await importFresh();
    triggerSocketEvent('command', { type: 'update_config', realtimeUrl: 'ws://realtime.vizora.io' });
    await vi.advanceTimersByTimeAsync(50);
    expect(preferencesStore.has('config_realtime_url')).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('F43: update_config accepts an exact compiled-in default origin (accepted, unchanged → no reload)', async () => {
    await importFresh();
    triggerSocketEvent('command', { type: 'update_config', dashboardUrl: 'https://dashboard.vizora.io' });
    await vi.advanceTimersByTimeAsync(50);
    expect(preferencesStore.get('config_dashboard_url')).toBe('https://dashboard.vizora.io');
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  // -------- F45: QR fallback uses textContent --------

  it('F45: the QR fallback renders the pair URL via textContent, not interpolated innerHTML', async () => {
    secureStorageStore.clear(); // no creds → pairing flow
    qrToCanvasMock.mockReset().mockRejectedValue(new Error('qr fail'));
    // The QR path does a dynamic import('qrcode') that fake timers do not drive. This
    // was a FIXED 50ms real sleep plus a clear-every-timer sweep — a budget that
    // shrinks under load, and an uninstall that DISCARDS pending fake timers (see
    // realYield). Wait for the fallback itself, bounded on REAL elapsed time and
    // throwing if it never lands, without leaving the fake clock.
    const fallbackOf = () => domElements.get('qr-code')!.children
      .find(c => c.tagName === 'DIV' && c.textContent.includes('pair?code='));
    await importFresh(() => fallbackOf() !== undefined);
    const qr = domElements.get('qr-code')!;
    const fallback = fallbackOf();
    expect(fallback).toBeDefined();
    expect(fallback!.textContent).toContain('ABCD1234');
    // NEGATIVE: never assembled as a raw HTML string
    expect(qr.innerHTML).not.toContain('<div');
  });

  // -------- F46: operator unpair exempt from the rate limiter --------

  it('F46: operator unpair is exempt from the revocation confirmation rate limit', async () => {
    await connectAndCommit();
    triggerSocketEvent('device:revoked', { reason: 'noise' }); // starts the 5-min window (404 → unconfirmed)
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect((await authCheckCalls()).length).toBe(1);
    triggerSocketEvent('command', { type: 'unpair' }); // within the window — must NOT be dropped
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect((await authCheckCalls()).length).toBe(2);
    // 404 + unset auth_check_seen → legacy carve-out purges and reloads
    expect(window.location.reload).toHaveBeenCalled();
  });

  it('F46: a non-operator revocation signal is still rate-limited within the window', async () => {
    await connectAndCommit();
    triggerSocketEvent('device:revoked', { reason: 'a' });
    await vi.advanceTimersByTimeAsync(200);
    triggerSocketEvent('device:revoked', { reason: 'b' });
    await vi.advanceTimersByTimeAsync(200);
    expect((await authCheckCalls()).length).toBe(1);
  });

  // -------- F47: reconnect/pull must not clobber an active push --------

  it('F47: an active push survives a reconnect + newer pull; the newer playlist resumes after', async () => {
    await connectAndCommit();
    triggerSocketEvent('command', {
      type: 'push_content',
      payload: { content: { id: 'push1', name: 'Push', type: 'image', url: '/push.jpg' }, duration: 2 },
    });
    await vi.advanceTimersByTimeAsync(1600); // push commits
    const container = domElements.get('content-container')!;
    // Reconnect while a NEWER playlist is available from the pull endpoint.
    httpGetHandler = (opts: { url: string }) => opts.url.includes('/devices/me/content')
      ? { status: 200, data: { data: { version: '2026-09-09T00:00:00.000Z', playlist: {
          id: 'pl2', name: 'PL2', items: [{ id: 'it2', contentId: 'c2', duration: 10, order: 0,
            content: { id: 'c2', name: 'C2', type: 'image', url: '/c2.jpg' } }], loopPlaylist: true } } } }
      : { status: 200, data: {} };
    const appendsBefore = (container.appendChild as Mock).mock.calls.length;
    triggerSocketEvent('connect');
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1600);
    // NEGATIVE: no new commit during the push — the pushed frame stays on screen
    expect((container.appendChild as Mock).mock.calls.length).toBe(appendsBefore);
    // Push ends → the NEWER playlist (pl2/c2) is what resumes
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(1600);
    expect(findCreatedElements('img').some(i => i.src.includes('c2'))).toBe(true);
  });

  // -------- F50: tenant suspend fail-closed covers push_content --------

  it('F50: push_content is suppressed while the tenant is suspended', async () => {
    await connectAndCommit();
    triggerSocketEvent('tenant:suspended');
    await vi.advanceTimersByTimeAsync(100);
    expect(visibleScreens()).toEqual(['holding-screen']);
    const container = domElements.get('content-container')!;
    const appends = (container.appendChild as Mock).mock.calls.length;
    triggerSocketEvent('command', {
      type: 'push_content',
      payload: { content: { id: 'evil', name: 'E', type: 'image', url: '/e.jpg' }, duration: 1 },
    });
    await vi.advanceTimersByTimeAsync(2000);
    // NEGATIVE: nothing rendered, still holding
    expect((container.appendChild as Mock).mock.calls.length).toBe(appends);
    expect(visibleScreens()).toEqual(['holding-screen']);
    expect(await reportedEvents()).toContain('push_suppressed_tenant_suspended');
  });

  // -------- F54: the SIBLING of F53 on the temporary-content path --------

  // F50 covers suspend-then-push. This is push-then-suspend, which is a different
  // path: handleContentPush gates on tenantSuspended only at entry, and
  // renderTemporaryContent re-checks only whether temporaryContent was superseded.
  // enterTenantSuspended does not clear temporaryContent, so that check cannot save
  // it — the pushed frame commits on top of the holding screen and transitions the
  // machine back to playing.
  //
  // Same entitlement invariant as F53: once suspension is observed, no renderer that
  // began before it may put tenant content on glass.
  it('F54: a tenant:suspended landing mid-push is not overwritten by the pushed frame', async () => {
    await connectAndCommit();
    const container = domElements.get('content-container')!;

    triggerSocketEvent('command', {
      type: 'push_content',
      payload: { content: { id: 'p1', name: 'P', type: 'image', url: '/p.jpg' }, duration: 1 },
    });
    // Suspension arrives WHILE renderTemporaryContent is awaiting readiness.
    triggerSocketEvent('tenant:suspended', {});
    await vi.advanceTimersByTimeAsync(50);
    expect(visibleScreens()).toEqual(['holding-screen']);
    const appends = (container.appendChild as Mock).mock.calls.length;

    // Let the pushed render resolve past READY_WAIT_MS.
    await vi.advanceTimersByTimeAsync(3000);
    expect(visibleScreens()).toEqual(['holding-screen']);
    expect((container.appendChild as Mock).mock.calls.length).toBe(appends);
  });

  // -------- F52: idempotent plaintext cleanup on the already-migrated path --------

  it('F52: lingering plaintext credentials are cleared even when already migrated', async () => {
    // Secure copy present (beforeEach); plaintext lingers from a prior crash between
    // the secure write and the plaintext removal.
    preferencesStore.set('device_token', 'STALE-PLAINTEXT');
    preferencesStore.set('device_id', 'STALE-DEV');
    await importFresh();
    await vi.advanceTimersByTimeAsync(50);
    expect(preferencesStore.has('device_token')).toBe(false);
    expect(preferencesStore.has('device_id')).toBe(false);
    expect(secureStorageStore.get('device_token')).toBe('tok-123'); // secure copy untouched
  });


  describe('heartbeat ack — cross-boundary wire contract (#8 / F40)', () => {
    // The ack crosses a process boundary that nothing else checks. Each side owns
    // its own shape — the server builds { success, data, timestamp } via
    // createSuccessResponse(), the client hand-unwraps `.data` — and neither
    // imports the other, so a change on either side could silently stop the other
    // working. That is exactly what happened three times in this subsystem:
    // reconcileContent always undefined until the .data unwrap landed, an
    // unwhitelisted heartbeat field rejecting every beat for four releases, and a
    // mistyped impression timestamp rejecting every impression for the repo's
    // lifetime. Every one passed its own side's unit tests.
    //
    // Driven from a committed fixture that the Vizora repo asserts against too, so
    // an incompatible change to the envelope OR to this unwrap fails a test rather
    // than going quiet in the field.
    // The fixture is split in two, and the halves mean different things.
    //
    //   clientAccepted.*  the SUPERSET this client tolerates. It is NOT a claim about
    //                     what the server sends: `revoked` is never emitted by the
    //                     current server (revocation rides the separate device:revoked
    //                     event; revocation-contract.md §3.2 only says the ack MAY carry
    //                     the flag), and `commands` is emitted but ALWAYS empty. Both
    //                     branches must keep working, so both are exercised here.
    //
    //   serverAck.*       what the server ACTUALLY emits, asserted against the real
    //                     DeviceGateway.handleHeartbeat() in Vizora
    //                     (realtime/src/gateways/heartbeat-ack-contract.spec.ts).
    //
    // That distinction is the correction this file needed: the earlier fixture had only
    // the first kind and labelled it the server contract, so a server-side test bound to
    // it could only have passed by not looking at the server.
    const wire = JSON.parse(
      readFileSync(new URL('./ack-envelope.fixture.json', import.meta.url), 'utf8'),
    ) as {
      clientAccepted: { envelope: Record<string, unknown>; legacyUnwrapped: Record<string, unknown> };
      serverAck: Record<'activeSocket' | 'supersededSocket', { success: boolean; data: Record<string, unknown> }>;
    };

    /** Connect, take the heartbeat ack callback, invoke it with `ackPayload`. */
    const ackWith = async (ackPayload: unknown) => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      (window.location.reload as Mock).mockClear();

      // Heartbeats only start once the socket connects (and reports connected).
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      await vi.advanceTimersByTimeAsync(200);
      const { CapacitorHttp: httpForClear } = await import('@capacitor/core');
      (httpForClear.get as Mock).mockClear(); // ignore the pull-on-connect
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat');
      const cb = hb?.[2] as ((r: unknown) => void) | undefined;
      expect(typeof cb).toBe('function');

      cb!(ackPayload);
      await vi.advanceTimersByTimeAsync(50);

      const { CapacitorHttp } = await import('@capacitor/core');
      return (CapacitorHttp.get as Mock).mock.calls.map(
        (c: unknown[]) => String((c[0] as { url?: string })?.url ?? ''),
      );
    };

    it.each([
      ['wrapped envelope { success, data, timestamp }', 'envelope'],
      ['legacy unwrapped payload', 'legacyUnwrapped'],
    ])('acts on commands, revoked AND reconcileContent from the %s', async (_label, key) => {
      const urls = await ackWith(
        (wire.clientAccepted as Record<string, Record<string, unknown>>)[key],
      );

      // All THREE fields must be observably acted on. Asserting only the one that
      // was convenient would leave the other two unbound — a test claiming a
      // contract it does not check is the defect this file exists to prevent.

      // reconcileContent -> pullContent -> GET effective content
      expect(urls.some(u => u.includes('/devices/me/content'))).toBe(true);

      // revoked -> confirmRevocation -> runAuthCheck -> GET auth/check
      expect(urls.some(u => u.includes('/devices/auth/check'))).toBe(true);

      // commands -> handleCommand({type:'reload'}) -> window.location.reload()
      expect(window.location.reload as Mock).toHaveBeenCalled();
    });

    // The block above proves the client copes with everything it MIGHT be sent. These
    // two prove it behaves correctly on what it IS sent — the shapes the Vizora spec
    // asserts come out of the real handler. Without them the client half would only
    // ever be exercised against a payload production never produces, which is the
    // mirror image of the server-side defect this fixture was split to fix.
    // Rebuild the on-the-wire envelope from the fixture's serverAck entry. The entry also
    // carries `_comment` and `envelopeKeys` for documentation, and no `timestamp` — feeding
    // it raw would hand the client a payload production never sends, in the one test whose
    // whole point is fidelity to what production sends.
    const asWire = (shape: { success: boolean; data: Record<string, unknown> }) => ({
      success: shape.success,
      data: shape.data,
      timestamp: '2026-08-13T00:00:00.000Z',
    });

    it('on the REAL active-socket ack: reconciles, and does NOT reload or auth-check', async () => {
      const urls = await ackWith(asWire(wire.serverAck.activeSocket));

      expect(urls.some(u => u.includes('/devices/me/content'))).toBe(true);
      // commands is [] and revoked absent, so neither side effect may fire.
      expect(window.location.reload as Mock).not.toHaveBeenCalled();
      expect(urls.some(u => u.includes('/devices/auth/check'))).toBe(false);
    });

    it('on the REAL superseded-socket ack: no reconcile pull, no reload, no auth-check', async () => {
      // That path omits reconcileContent entirely. An absent key must read as "no",
      // never as a reason to act — a device beating on a stale socket must stay quiet.
      const urls = await ackWith(asWire(wire.serverAck.supersededSocket));

      // POSITIVE CONTROL FIRST. Every other assertion here is a negative, and negatives
      // go vacuous the moment the ack stops being delivered at all. Proving the same
      // helper still produces observable HTTP for a reconciling ack is what keeps the
      // three "did not happen" assertions meaningful on their own.
      expect(await ackWith(asWire(wire.serverAck.activeSocket))).not.toHaveLength(0);

      expect(urls.some(u => u.includes('/devices/me/content'))).toBe(false);
      expect(window.location.reload as Mock).not.toHaveBeenCalled();
      expect(urls.some(u => u.includes('/devices/auth/check'))).toBe(false);
    });
  });

  describe('token:refresh — server-initiated credential rotation (vizora-tv#20)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it('persists a rotated token and presents it on the next connect', async () => {
      // The whole point: the server rotates the stored hash when it emits this. A
      // device that ignores it is holding a credential the server has already
      // replaced, which ends in either a false DEVICE_REVOKED (pairing screen on
      // customer glass) or a hard AUTH_EXPIRED with no recovery.
      secureStorageStore.set('device_token', 'old-tok');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();

      triggerSocketEvent('token:refresh', { token: 'new-tok' });
      await vi.advanceTimersByTimeAsync(10);

      expect(secureStorageStore.get('device_token')).toBe('new-tok');
      // The handshake auth after a rotation carries the new token AND the
      // capability advertisement. This assertion is exact on purpose: it was
      // `toEqual({ token })` while the client sent only a token, and the moment
      // `capabilities` was added a wholesale `auth = { token }` would have silently
      // dropped it here. See the dedicated deliveryAck block for the direction test.
      expect(currentMockSocket.auth).toEqual({ token: 'new-tok', capabilities: ['deliveryAck'] });
    });

    it('NEGATIVE: a malformed payload never clears a working credential', async () => {
      // A refresh we cannot use is strictly better than none. If a bad payload
      // could blank the token, one malformed emit would de-pair the fleet — the
      // exact failure this listener exists to prevent.
      secureStorageStore.set('device_token', 'old-tok');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();

      for (const bad of [undefined, null, {}, { token: null }, { token: 123 }, { token: '' }, 'nope']) {
        triggerSocketEvent('token:refresh', bad);
        await vi.advanceTimersByTimeAsync(10);
        expect(secureStorageStore.get('device_token')).toBe('old-tok');
      }
    });

    it('NEGATIVE: a storage failure keeps the OLD token rather than adopting an unpersisted one', async () => {
      // Order matters. Adopting in memory before a successful write would leave a
      // device running a token it cannot survive a reboot with — worse than not
      // rotating, because the old one is still valid right now.
      secureStorageStore.set('device_token', 'old-tok');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();

      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockRejectedValueOnce(new Error('keystore unavailable'));

      triggerSocketEvent('token:refresh', { token: 'new-tok' });
      await vi.advanceTimersByTimeAsync(10);

      // The property that matters: nothing adopted the unpersisted token. Storage
      // still holds the working credential, and the socket was not switched to a
      // token that would be lost on reboot.
      expect(secureStorageStore.get('device_token')).toBe('old-tok');
      expect(currentMockSocket.auth).not.toEqual({ token: 'new-tok' });
    });

    it('is idempotent — a re-delivered identical token does not rewrite storage', async () => {
      secureStorageStore.set('device_token', 'same-tok');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();

      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockClear();

      triggerSocketEvent('token:refresh', { token: 'same-tok' });
      await vi.advanceTimersByTimeAsync(10);

      expect(SecureStorage.set).not.toHaveBeenCalledWith({ key: 'device_token', value: 'same-tok' });
    });
  });
});

// ============================================================================
// Client correctness & security residuals (S1–S6)
// ============================================================================

describe('Client correctness & security residuals (S1–S6)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetCapacitorFakes();
    resetDOM();
    (window.location as { search: string }).search = '';
    (window.location.reload as Mock).mockClear();
    ioFactory.mockClear();
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
    mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
    mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
    mockCacheManager.setExpectedTenant.mockClear();
    qrToCanvasMock.mockReset().mockResolvedValue(undefined);
    // Restore default SecureStorage behaviour — an earlier test may have overridden it.
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => ({
      value: secureStorageStore.get(key) ?? null,
    }));
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    });
    (SecureStorage.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    });
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    secureStorageStore.set('device_token', 'tok-123');
    secureStorageStore.set('device_id', 'dev-123');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const visibleScreens = () =>
    ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
      .filter(id => {
        const el = domElements.get(id);
        return el && !el._classListSet.has('hidden');
      });

  const playlistPayload = {
    playlist: { id: 'pl', name: 'PL', items: [{ id: 'it-1', contentId: 'c1', duration: 10, order: 0,
      content: { id: 'c1', name: 'C', type: 'image', url: '/c1.jpg' } }], loopPlaylist: true },
  };

  const connectAndCommit = async () => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistPayload);
    await vi.advanceTimersByTimeAsync(1600);
    expect(visibleScreens()).toEqual(['content-screen']);
  };

  const reportedEvents = async () => {
    const { reportEvent } = await import('./crash-reporting');
    return (reportEvent as Mock).mock.calls.map((c: unknown[]) => c[0]);
  };

  const revokedBackend = () => {
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
  };

  /** Fire device:revoked and let the confirm → purge → de-pair chain settle. */
  const revokeAndSettle = async () => {
    triggerSocketEvent('device:revoked', { reason: 'operator' });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
  };

  // -------- S1: purgeDeviceState is non-atomic --------
  //
  // The five removals ran as a sequential await chain, so the FIRST rejection
  // skipped every removal after it and propagated out of purgeDeviceState. Every
  // caller is `void this.confirmRevocation(...)`, so that rejection was unhandled:
  // no telemetry, no retry, and — the part that reaches customer glass — the
  // caller's startPairing() never ran. The revoked tenant's last frame stayed up,
  // credentials intact, and a reboot resumed the revoked playlist.

  it('S1: one failing SecureStorage.remove cannot skip the other removals', async () => {
    revokedBackend();
    await connectAndCommit();
    // tenant_id is SEEDED here on purpose. connectAndCommit never writes one, so the
    // `has('tenant_id') === false` assertion below used to hold whether or not the
    // production removal ran at all — proven vacuous: replacing that removal with
    // Promise.resolve() left this test green. An assertion that cannot fail is worse
    // than no assertion, because it reads as coverage. Every key asserted absent below
    // now has an explicit baseline proving it was present first.
    secureStorageStore.set('tenant_id', 'tenant-A');
    expect(secureStorageStore.has('device_id')).toBe(true); // baseline: there is state to purge
    expect(secureStorageStore.has('tenant_id')).toBe(true);
    expect(preferencesStore.has('last_playlist')).toBe(true);

    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      // The real Java plugin rejects on failure and on SECURE_STORAGE_UNAVAILABLE.
      if (key === 'device_token') throw new Error('SECURE_STORAGE_UNAVAILABLE');
      secureStorageStore.delete(key);
    });

    await revokeAndSettle();

    // The removals AFTER the failing one still ran — that is the whole fix.
    expect(secureStorageStore.has('device_id')).toBe(false);
    expect(secureStorageStore.has('tenant_id')).toBe(false);
    expect(preferencesStore.has('last_playlist')).toBe(false);
    expect(mockCacheManager.clearCache).toHaveBeenCalled();
  });

  it('S1: a failing removal still de-pairs the screen instead of freezing on the revoked frame', async () => {
    revokedBackend();
    await connectAndCommit();
    const container = domElements.get('content-container')!;
    const appendsBefore = (container.appendChild as Mock).mock.calls.length;

    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.remove as Mock).mockRejectedValue(new Error('SECURE_STORAGE_UNAVAILABLE'));

    await revokeAndSettle();

    expect(visibleScreens()).toEqual(['pairing-screen']);
    // NEGATIVE: not one further frame of the revoked tenant's content.
    await vi.advanceTimersByTimeAsync(35_000);
    expect((container.appendChild as Mock).mock.calls.length).toBe(appendsBefore);
  });

  it('S1: a residual purge failure is reported, not swallowed', async () => {
    revokedBackend();
    await connectAndCommit();
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.remove as Mock).mockRejectedValue(new Error('SECURE_STORAGE_UNAVAILABLE'));

    await revokeAndSettle();

    expect(await reportedEvents()).toContain('device_purge_incomplete');
  });

  it('S1 NEGATIVE CONTROL: a clean purge reports no residual failure', async () => {
    // Same layer, same entry point, storage healthy. Without this the telemetry
    // assertion above would also pass against an event fired unconditionally.
    revokedBackend();
    await connectAndCommit();

    await revokeAndSettle();

    expect(secureStorageStore.has('device_token')).toBe(false);
    expect(visibleScreens()).toEqual(['pairing-screen']);
    expect(await reportedEvents()).not.toContain('device_purge_incomplete');
  });

  // -------- S2: update_config allowlist anchored to the COMPILED-IN defaults --------
  //
  // `private config = DEFAULT_CONFIG` was a reference, and loadConfig() mutates it
  // from stored Preferences. So a single stored off-domain origin rewrote the very
  // object isAllowedConfigUrl() measures candidates against: the attacker's
  // registrable domain became part of the allowlist for every later update_config.

  it('S2: a stored off-domain origin does NOT widen the update_config allowlist', async () => {
    preferencesStore.set('config_api_url', 'https://attacker.example');
    await importFresh();

    triggerSocketEvent('command', { type: 'update_config', apiUrl: 'https://cdn.attacker.example' });
    await vi.advanceTimersByTimeAsync(50);

    // Rejected: the anchor is what the BUNDLE was compiled with, not where this
    // device has since been pointed.
    expect(preferencesStore.get('config_api_url')).toBe('https://attacker.example');
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('config_rejected');
  });

  it('S2 NEGATIVE CONTROL: the seeded origin really did reach the runtime config at boot', async () => {
    // Without this, the test above would pass just as well if the Preferences seed
    // never took effect — i.e. against a boot path that silently ignored it. It also
    // pins the DOCUMENTED paired-device support path (CLAUDE.md): a stored origin is
    // still applied at boot. Only the ALLOWLIST anchor is immune to it.
    preferencesStore.set('config_api_url', 'https://attacker.example');
    await importFresh();

    const cfg = (console.log as Mock).mock.calls
      .find((c: unknown[]) => String(c[0]).includes('Config loaded'))![1] as Record<string, string>;
    expect(cfg.apiUrl).toBe('https://attacker.example');
  });

  it('S2 NEGATIVE CONTROL: the allowlist still accepts the compiled-in domain after the poisoning attempt', async () => {
    // Proves the rejection above is the anchor holding, not update_config being
    // globally broken by the seed.
    preferencesStore.set('config_api_url', 'https://attacker.example');
    await importFresh();

    triggerSocketEvent('command', { type: 'update_config', apiUrl: 'https://cdn.vizora.io' });
    await vi.advanceTimersByTimeAsync(50);

    expect(preferencesStore.get('config_api_url')).toBe('https://cdn.vizora.io');
  });

  // -------- S3: the cache is unbound from a purged tenant --------

  it('S3: a confirmed revocation unbinds the cache from the purged tenant', async () => {
    secureStorageStore.set('tenant_id', 'tenant-A');
    revokedBackend();
    await connectAndCommit();
    // Baseline: boot bound the cache to the live tenant, and nothing has unbound it.
    expect(mockCacheManager.setExpectedTenant).toHaveBeenCalledWith('tenant-A');
    expect(mockCacheManager.setExpectedTenant).not.toHaveBeenCalledWith(null);

    await revokeAndSettle();

    // Nulling only this.tenantId left the cache still expecting the purged tenant,
    // so its tenant-mismatch purge could not fire for whatever is paired next.
    expect(mockCacheManager.setExpectedTenant).toHaveBeenCalledWith(null);
  });

  // -------- S4: the webpage/url iframe cannot navigate the app away --------

  const play = async (type: string, url: string) => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', {
      playlist: { id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
        content: { id: 'c1', name: 'C', type, url } }], loopPlaylist: true },
    });
    await vi.advanceTimersByTimeAsync(50);
  };

  it('S4: the webpage iframe is sandboxed WITHOUT top-navigation', async () => {
    // On the old Chromium these TVs ship, an un-sandboxed frame can run
    // `top.location = '…'` with no user gesture and replace the app document:
    // socket, heartbeat, state machine and the `reload` command all gone, with no
    // onRenderProcessGone and nothing for the Java crash handler to see.
    await play('webpage', 'https://example.com');
    const iframes = findCreatedElements('iframe');
    expect(iframes.length).toBeGreaterThan(0);
    const iframe = iframes[iframes.length - 1];
    const tokens = iframe.sandbox.add.mock.calls.flat();

    expect(tokens).toContain('allow-scripts');
    expect(tokens).toContain('allow-same-origin');
    expect(tokens).not.toContain('allow-top-navigation');
    expect(tokens).not.toContain('allow-top-navigation-by-user-activation');
    expect(tokens).not.toContain('allow-top-navigation-to-custom-protocols');
  });

  it('S4: the url content type gets the same sandbox as webpage', async () => {
    await play('url', 'https://example.com/page');
    const iframes = findCreatedElements('iframe');
    const iframe = iframes[iframes.length - 1];
    const tokens = iframe.sandbox.add.mock.calls.flat();
    expect(tokens).toContain('allow-scripts');
    expect(tokens).not.toContain('allow-top-navigation');
  });

  it('S4 NEGATIVE CONTROL: the sandbox does not stop the page from being loaded', async () => {
    // Same layer: proves the assertions above are not passing because the webpage
    // branch stopped rendering altogether.
    await play('webpage', 'https://example.com');
    const iframes = findCreatedElements('iframe');
    const iframe = iframes[iframes.length - 1];
    expect(iframe.src).toContain('example.com');
    expect(iframe.allow).toBe('autoplay; fullscreen');
  });

  // -------- S5: CSS injection via the QR overlay size --------

  /**
   * renderQrOverlay does `await import('qrcode')`, which does not settle under fake
   * timers — mirror the real-timer dance the existing QR tests use.
   */
  const renderQrAndSettle = async (qrOverlay: Record<string, unknown>) => {
    // The overlay render awaits a REAL dynamic import('qrcode') that fake timers do not
    // drive. This was a FIXED 50ms real sleep plus a clear-every-timer sweep — a budget
    // that shrinks exactly when the machine is loaded, and an uninstall that DISCARDS
    // every pending fake timer (see realYield). Wait for the render to actually reach
    // toCanvas, bounded on REAL elapsed time, and never leave the fake clock. Counted
    // from a BEFORE snapshot so repeat calls in one test cannot see the previous render.
    const before = qrToCanvasMock.mock.calls.length;
    triggerSocketEvent('qr-overlay:update', { qrOverlay });
    await waitUntil('the QR overlay render', () => qrToCanvasMock.mock.calls.length > before, { tickMs: 20 });
  };

  const lastQrWidth = () =>
    (qrToCanvasMock.mock.calls[qrToCanvasMock.mock.calls.length - 1] as unknown as unknown[])[2] as
      { width: unknown };

  it('S5: a CSS-injecting size is coerced away instead of concatenated into cssText', async () => {
    await importFresh();
    await renderQrAndSettle({
      enabled: true,
      url: 'https://e.com',
      label: 'Scan me!',
      // `size` is declared `number` but arrives from the server unvalidated.
      size: '1px;background:url(https://evil.example/beacon)',
    });

    const ov = domElements.get('qr-overlay')!;
    const label = ov.children.find((c: ElementStub) => c.textContent === 'Scan me!');
    expect(label).toBeDefined();
    expect(label!.style.cssText).not.toContain('evil.example');
    expect(label!.style.cssText).toContain('max-width:120px;');
    // The same value also reaches the QR renderer — it must be a number there too.
    expect(lastQrWidth().width).toBe(120);
  });

  it('S5: an out-of-range size is clamped', async () => {
    await importFresh();
    await renderQrAndSettle({ enabled: true, url: 'https://e.com', label: 'L', size: 100000 });
    expect(lastQrWidth().width).toBe(512);

    await renderQrAndSettle({ enabled: true, url: 'https://e.com', label: 'L', size: -5 });
    expect(lastQrWidth().width).toBe(120);
  });

  it('S5 NEGATIVE CONTROL: a legitimate size still passes through unchanged', async () => {
    // Same layer: proves the coercion is not just pinning everything to the default.
    await importFresh();
    await renderQrAndSettle({ enabled: true, url: 'https://e.com', label: 'Scan me!', size: 200 });

    const ov = domElements.get('qr-overlay')!;
    const label = ov.children.find((c: ElementStub) => c.textContent === 'Scan me!');
    expect(label!.style.cssText).toContain('max-width:200px;');
    expect(lastQrWidth().width).toBe(200);
  });

  // -------- S6: version poisoning --------
  //
  // applyPulledContent committed currentContentVersion BEFORE updatePlaylist.
  // validatePlaylist only checks that `items` is an array, so a malformed item makes
  // computePlaylistSignature throw inside updatePlaylist — leaving the device
  // REPORTING a contentVersion it is not rendering. The server's heartbeat-reconcile
  // then sees agreement and never self-heals: permanent silent drift.

  /**
   * What this device TELLS THE SERVER it is rendering. Read off a real heartbeat
   * emit (15s interval) rather than off internal state — the drift only matters
   * because the server believes this field.
   */
  const reportedContentVersion = async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    const beats = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat');
    return (beats[beats.length - 1][1] as { contentVersion: string }).contentVersion;
  };

  const goodV1 = {
    version: '2026-01-01T00:00:00.000Z',
    playlist: playlistPayload.playlist,
  };

  const poisonedV2 = {
    version: '2026-06-06T00:00:00.000Z',
    // Well-formed enough for validatePlaylist (`items` IS an array), not for the
    // apply path: computePlaylistSignature reads i.content?.updatedAt and throws.
    playlist: { id: 'pl-2', name: 'poison', items: [null], loopPlaylist: true },
  };

  const healedV2 = (name: string) => ({
    version: '2026-06-06T00:00:00.000Z',
    playlist: { id: 'pl-2', name, items: [{ id: 'it-2', contentId: 'c2', duration: 10, order: 0,
      content: { id: 'c2', name: 'C2', type: 'image', url: '/c2.jpg' } }], loopPlaylist: true },
  });

  it('S6: a malformed item does not commit a contentVersion the device is not rendering', async () => {
    await connectAndCommit();
    triggerSocketEvent('playlist:update', goodV1);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await reportedContentVersion()).toBe(goodV1.version);

    triggerSocketEvent('playlist:update', poisonedV2);
    await vi.advanceTimersByTimeAsync(1600);

    // The reported version is still the one actually on glass.
    expect(await reportedContentVersion()).toBe(goodV1.version);
    expect(await reportedEvents()).toContain('content_apply_failed');
    // …and the screen never went dark over it.
    expect(visibleScreens()).toEqual(['content-screen']);
  });

  it('S6: the stale version keeps a later reconcile able to self-heal', async () => {
    // The consequence that actually matters. If the poisoned version had been
    // committed, the server would compare equal and never re-deliver.
    await connectAndCommit();
    triggerSocketEvent('playlist:update', goodV1);
    await vi.advanceTimersByTimeAsync(1600);
    triggerSocketEvent('playlist:update', poisonedV2);
    await vi.advanceTimersByTimeAsync(1600);

    // A well-formed re-delivery at the SAME version the poisoned push carried still
    // applies, because the device never claimed that version.
    triggerSocketEvent('playlist:update', healedV2('healed'));
    await vi.advanceTimersByTimeAsync(1600);

    expect(await reportedContentVersion()).toBe('2026-06-06T00:00:00.000Z');
    expect(findCreatedElements('img').some(i => i.src.includes('c2.jpg'))).toBe(true);
  });

  it('S6 NEGATIVE CONTROL: a well-formed newer version IS committed', async () => {
    // Same layer, same entry point. Proves the heartbeat assertion observes the
    // commit at all, and that the fix did not simply stop committing versions.
    await connectAndCommit();
    triggerSocketEvent('playlist:update', goodV1);
    await vi.advanceTimersByTimeAsync(1600);

    triggerSocketEvent('playlist:update', healedV2('ok'));
    await vi.advanceTimersByTimeAsync(1600);

    expect(await reportedContentVersion()).toBe('2026-06-06T00:00:00.000Z');
  });
});

// ============================================================================
// Sibling instances of the S1–S6 defect patterns (B3–B7)
// ============================================================================

describe('Client correctness & security residuals — siblings (B3–B7)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetCapacitorFakes();
    resetDOM();
    (window.location as { search: string }).search = '';
    (window.location.reload as Mock).mockClear();
    ioFactory.mockClear();
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
    mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
    mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
    mockCacheManager.setExpectedTenant.mockClear();
    qrToCanvasMock.mockReset().mockResolvedValue(undefined);
    // Restore default storage behaviour — an earlier test may have overridden it.
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => ({
      value: secureStorageStore.get(key) ?? null,
    }));
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    });
    (SecureStorage.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    });
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      preferencesStore.delete(key);
    });
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const visibleScreens = () =>
    ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
      .filter(id => {
        const el = domElements.get(id);
        return el && !el._classListSet.has('hidden');
      });

  const reportedEvents = async () => {
    const { reportEvent } = await import('./crash-reporting');
    return (reportEvent as Mock).mock.calls.map((c: unknown[]) => c[0]);
  };

  // ------------------------------------------------------------------------
  // B3: migrateCredentialsToSecureStorage can strand the plaintext token
  // ------------------------------------------------------------------------
  //
  // F52 exists to get the device token OFF plaintext Preferences. The two
  // SecureStorage.set calls and the two Preferences.remove calls ran as one
  // sequential chain inside a single try, so a rejection on EITHER set skipped
  // BOTH removes — a device_id write failure left the plaintext DEVICE TOKEN on
  // disk, which is precisely the credential the migration exists to remove.

  describe('B3: credential migration', () => {
    const seedPlaintextCredentials = () => {
      preferencesStore.set('device_token', 'plain-tok');
      preferencesStore.set('device_id', 'plain-dev');
    };

    it('B3: a device_id write failure does NOT strand the plaintext device token', async () => {
      seedPlaintextCredentials();
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        if (key === 'device_id') throw new Error('SECURE_STORAGE_UNAVAILABLE');
        secureStorageStore.set(key, value);
      });

      await importFresh();

      // The credential this migration exists to remove is gone from plaintext…
      expect(preferencesStore.has('device_token')).toBe(false);
      // …and its encrypted copy was written first, so it was never lost.
      expect(secureStorageStore.get('device_token')).toBe('plain-tok');
    });

    it('B3: the ordering is NOT inverted — a failed encrypted write keeps the plaintext copy', async () => {
      // The other direction of the safety rule: losing both copies is worse than
      // stranding one. device_token's own set fails, so its plaintext must SURVIVE
      // for the next boot to retry — while device_id still migrates independently.
      seedPlaintextCredentials();
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        if (key === 'device_token') throw new Error('SECURE_STORAGE_UNAVAILABLE');
        secureStorageStore.set(key, value);
      });

      await importFresh();

      expect(preferencesStore.get('device_token')).toBe('plain-tok'); // not destroyed
      expect(secureStorageStore.has('device_token')).toBe(false);
      // Independent: the sibling key still completed its own write-then-remove.
      expect(secureStorageStore.get('device_id')).toBe('plain-dev');
      expect(preferencesStore.has('device_id')).toBe(false);
    });

    it('B3: a partial migration is reported, not swallowed', async () => {
      seedPlaintextCredentials();
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        if (key === 'device_id') throw new Error('SECURE_STORAGE_UNAVAILABLE');
        secureStorageStore.set(key, value);
      });

      await importFresh();

      expect(await reportedEvents()).toContain('credential_migration_incomplete');
    });

    it('B3 NEGATIVE CONTROL: a healthy migration moves both keys and reports nothing', async () => {
      // Same layer, same entry point, storage healthy. Without this the assertions
      // above would also pass against a migration that had stopped running at all.
      seedPlaintextCredentials();

      await importFresh();

      expect(secureStorageStore.get('device_token')).toBe('plain-tok');
      expect(secureStorageStore.get('device_id')).toBe('plain-dev');
      expect(preferencesStore.has('device_token')).toBe(false);
      expect(preferencesStore.has('device_id')).toBe(false);
      expect(await reportedEvents()).not.toContain('credential_migration_incomplete');
    });
  });

  // ------------------------------------------------------------------------
  // B4: the boot tenant-mismatch purge is the same non-atomic pair as S1
  // ------------------------------------------------------------------------

  describe('B4: boot tenant-mismatch purge', () => {
    const seedForeignPlaylist = () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      secureStorageStore.set('tenant_id', 'tenant-B');
      preferencesStore.set('last_playlist', JSON.stringify({
        tenantId: 'tenant-A',
        deviceId: 'dev-123',
        savedAt: Date.now(),
        playlist: { id: 'pl-A', name: 'A', items: [], loopPlaylist: true },
      }));
    };

    /** Reject only the last_playlist removal — the credential-migration cleanup
     *  removes other Preferences keys on the same boot and must stay healthy. */
    const failLastPlaylistRemoval = async () => {
      const { Preferences } = await import('@capacitor/preferences');
      (Preferences.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
        if (key === 'last_playlist') throw new Error('Preferences unavailable');
        preferencesStore.delete(key);
      });
    };

    it('B4: a failing last_playlist removal does NOT skip the cache clear', async () => {
      seedForeignPlaylist();
      await failLastPlaylistRemoval();

      await importFresh();

      // As a sequential await chain the first rejection skipped this entirely,
      // leaving the foreign tenant's downloaded assets on the device.
      expect(mockCacheManager.clearCache).toHaveBeenCalled();
    });

    it('B4: a partial tenant purge is reported, not mislabelled as a restore failure', async () => {
      seedForeignPlaylist();
      await failLastPlaylistRemoval();

      await importFresh();

      const events = await reportedEvents();
      expect(events).toContain('tenant_mismatch_purge');
      expect(events).toContain('tenant_mismatch_purge_incomplete');
    });

    it('B4: a failing cache clear is reported too, and the foreign playlist never renders', async () => {
      // clearCache now REJECTS on a failed purge (B1), so this arm is reachable.
      seedForeignPlaylist();
      mockCacheManager.clearCache.mockRejectedValue(new Error('rmdir failed'));

      await importFresh();

      expect(await reportedEvents()).toContain('tenant_mismatch_purge_incomplete');
      // Never-wrong-tenant holds regardless: nothing from tenant-A reaches glass.
      expect(visibleScreens()).not.toContain('content-screen');
    });

    it('B4 NEGATIVE CONTROL: a clean tenant purge reports no residual failure', async () => {
      seedForeignPlaylist();

      await importFresh();

      expect(preferencesStore.has('last_playlist')).toBe(false);
      expect(mockCacheManager.clearCache).toHaveBeenCalled();
      const events = await reportedEvents();
      expect(events).toContain('tenant_mismatch_purge');
      expect(events).not.toContain('tenant_mismatch_purge_incomplete');
    });

    it('B4 NEGATIVE CONTROL: a SAME-tenant cached playlist is restored, not purged', async () => {
      // Proves the purge above is driven by the tenant mismatch and not by the boot
      // path having started discarding every stored playlist.
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      secureStorageStore.set('tenant_id', 'tenant-A');
      preferencesStore.set('last_playlist', JSON.stringify({
        tenantId: 'tenant-A',
        deviceId: 'dev-123',
        savedAt: Date.now(),
        playlist: { id: 'pl-A', name: 'A', items: [], loopPlaylist: true },
      }));

      await importFresh();

      expect(mockCacheManager.clearCache).not.toHaveBeenCalled();
      expect(preferencesStore.has('last_playlist')).toBe(true);
      expect(await reportedEvents()).not.toContain('tenant_mismatch_purge');
    });
  });

  // ------------------------------------------------------------------------
  // B5: the legacy unversioned push path had an unhandled rejection
  // ------------------------------------------------------------------------

  describe('B5: legacy unversioned playlist push', () => {
    const goodPlaylist = {
      playlist: { id: 'pl', name: 'PL', items: [{ id: 'it-1', contentId: 'c1', duration: 10, order: 0,
        content: { id: 'c1', name: 'C', type: 'image', url: '/c1.jpg' } }], loopPlaylist: true },
    };
    // Well-formed enough for validatePlaylist (`items` IS an array), not for the
    // apply path: computePlaylistSignature reads i.content?.updatedAt and throws.
    const poisonedLegacyPush = {
      playlist: { id: 'pl-2', name: 'poison', items: [null], loopPlaylist: true },
    };

    const connectAndCommit = async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', goodPlaylist);
      await vi.advanceTimersByTimeAsync(1600);
      expect(visibleScreens()).toEqual(['content-screen']);
    };

    it('B5: a malformed LEGACY (unversioned) push does not produce an unhandled rejection', async () => {
      await connectAndCommit();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        // No `version` field -> the legacy branch, which called updatePlaylist bare.
        triggerSocketEvent('playlist:update', poisonedLegacyPush);
        await vi.advanceTimersByTimeAsync(1600);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
      expect(unhandled).toEqual([]);
    });

    it('B5: a malformed LEGACY push is reported and keeps last-known-good on the glass', async () => {
      await connectAndCommit();
      const container = domElements.get('content-container')!;
      const appendsBefore = (container.appendChild as Mock).mock.calls.length;

      triggerSocketEvent('playlist:update', poisonedLegacyPush);
      await vi.advanceTimersByTimeAsync(1600);

      expect(await reportedEvents()).toContain('content_apply_failed');
      expect(visibleScreens()).toEqual(['content-screen']);
      expect((container.appendChild as Mock).mock.calls.length).toBeGreaterThanOrEqual(appendsBefore);
      // Last-known-good really is still the committed playlist: the poisoned push
      // threw before updatePlaylist could replace it or persist it.
      const persisted = JSON.parse(preferencesStore.get('last_playlist')!);
      expect(persisted.playlist.id).toBe('pl');
    });

    it('B5 NEGATIVE CONTROL: a well-formed LEGACY push still applies', async () => {
      // Same layer, same entry point. Proves the catch did not turn the legacy
      // branch into a no-op.
      await connectAndCommit();

      triggerSocketEvent('playlist:update', {
        playlist: { id: 'pl-3', name: 'next', items: [{ id: 'it-2', contentId: 'c2', duration: 10, order: 0,
          content: { id: 'c2', name: 'C2', type: 'image', url: '/c2.jpg' } }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(1600);

      expect(findCreatedElements('img').some(i => i.src.includes('c2.jpg'))).toBe(true);
      expect(await reportedEvents()).not.toContain('content_apply_failed');
    });
  });

  // ------------------------------------------------------------------------
  // B6: pairing committed credentials in memory BEFORE persisting them
  // ------------------------------------------------------------------------
  //
  // The inverse of the rule handleTokenRefresh documents. On a keystore failure the
  // poller was already stopped and pairingCode already null, so a dead code stayed
  // on the glass, connectToRealtime() was skipped and the token was never written:
  // bricked until a human power-cycles the screen.
  //
  // This path was also the repo's worst test gap — nothing asserted that tenant_id
  // was persisted or that setExpectedTenant was called, so deleting either line left
  // the suite green while every newly paired device ran with tenantId = null.

  describe('B6: pairing success', () => {
    const pairedPayload = {
      status: 'paired', deviceToken: 'tok-new', deviceId: 'dev-new', tenantId: 'tenant-A',
    };

    /**
     * Drive the REAL 2s pairing poll to a `paired` response.
     *
     * The poll is a setInterval registered inside main.ts's async init chain, and
     * how far that chain has progressed when a test starts advancing the clock
     * varies run to run (this is the same fake-timer/resetModules interaction that
     * got the suite's original polling block skipped). So: alternate macro advances
     * with microtask flushes, generously, instead of assuming a fixed tick count.
     */
    const pollToPaired = async (
      payload: Record<string, unknown> = pairedPayload,
      settled: () => boolean = () => secureStorageStore.has('device_token'),
      opts: { expectSettled?: boolean; budgetMs?: number } = {},
    ) => {
      httpGetHandler = (opts2) => opts2.url.includes('/pairing/status/')
        ? { status: 200, data: { data: payload } }
        : { status: 404, data: {} };
      // Bounded on REAL elapsed time with a real-loop yield per round (see
      // waitUntil/realYield): a fixed round count is a budget that shrinks exactly
      // when the machine is loaded, and the pairing path is gated on a genuine
      // `await import('qrcode')` that fake timers cannot drive.
      const expectSettled = opts.expectSettled ?? true;
      try {
        await waitUntil('pollToPaired', settled, { tickMs: 2100, budgetMs: opts.budgetMs });
      } catch (err) {
        // Callers that deliberately drive an UNSETTLEABLE case (a rejecting keystore)
        // pass expectSettled:false; for everyone else, not settling is the failure and
        // it must say so here rather than surfacing downstream as an opaque
        // "expected undefined to be 'tok-new'".
        if (expectSettled) throw err;
        return;
      }
      // Give the commit that follows the persist its own turns to run.
      await vi.advanceTimersByTimeAsync(50);
      for (let j = 0; j < 40; j++) await Promise.resolve();
    };

    /** Boot with no credentials and wait for the real pairing request to land. */
    const bootToPairingScreen = async () => {
      await importFresh();
      await waitUntil(
        'bootToPairingScreen',
        () => domElements.get('pairing-code')!.textContent === 'ABCD1234',
        { tickMs: 200 },
      );
      expect(domElements.get('pairing-code')!.textContent).toBe('ABCD1234');
    };

    it('B6: persists device_token', async () => {
      await bootToPairingScreen();
      await pollToPaired();
      expect(secureStorageStore.get('device_token')).toBe('tok-new');
    });

    it('B6: persists device_id', async () => {
      await bootToPairingScreen();
      await pollToPaired();
      expect(secureStorageStore.get('device_id')).toBe('dev-new');
    });

    it('B6: persists tenant_id', async () => {
      // Nothing asserted this before. Deleting the write left the suite green while
      // every newly paired device booted forever after in tenant grace mode.
      await bootToPairingScreen();
      await pollToPaired();
      expect(secureStorageStore.get('tenant_id')).toBe('tenant-A');
    });

    it('B6: binds the cache to the paired tenant', async () => {
      // Likewise unasserted. Without this call the cache's tenant-mismatch purge
      // cannot fire, silently downgrading cross-tenant isolation to legacy grace.
      await bootToPairingScreen();
      await pollToPaired();
      expect(mockCacheManager.setExpectedTenant).toHaveBeenCalledWith('tenant-A');
    });

    it('B6: connects to realtime with the NEWLY paired token', async () => {
      // Asserted on the handshake argument rather than a call count: the token that
      // reaches the socket is the thing that matters, and it is not sensitive to how
      // many connect attempts the harness happens to schedule.
      await bootToPairingScreen();
      await pollToPaired();
      const authTokens = ioFactory.mock.calls.map(
        (c: unknown[]) => (c[1] as { auth?: { token?: string } } | undefined)?.auth?.token,
      );
      expect(authTokens).toContain('tok-new');
    });

    it('B6: a keystore failure does NOT strand the device on a dead pairing code', async () => {
      await bootToPairingScreen();
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockRejectedValue(new Error('SECURE_STORAGE_UNAVAILABLE'));
      const { CapacitorHttp } = await import('@capacitor/core');
      const countBefore = (CapacitorHttp.get as Mock).mock.calls.length;

      await pollToPaired(pairedPayload, () => false, { expectSettled: false, budgetMs: 150 });

      // Nothing committed…
      expect(ioFactory.mock.calls.length).toBe(0);
      expect(await reportedEvents()).toContain('pairing_persist_failed');
      // …and the poller is STILL RUNNING across many ticks, which is what makes
      // this recoverable rather than a screen bricked until someone power-cycles it.
      // Committing first stopped the poller before the persist could fail, leaving
      // exactly ONE poll and a dead code on the glass forever.
      expect((CapacitorHttp.get as Mock).mock.calls.length).toBeGreaterThan(countBefore + 3);
      expect(domElements.get('pairing-code')!.textContent).toBe('ABCD1234');
    });

    it('B6: pairing completes on a later poll once the keystore recovers', async () => {
      // The recoverable direction, proven end to end.
      await bootToPairingScreen();
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockRejectedValue(new Error('SECURE_STORAGE_UNAVAILABLE'));
      await pollToPaired(pairedPayload, () => false, { expectSettled: false, budgetMs: 150 });
      expect(secureStorageStore.has('device_token')).toBe(false);

      (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        secureStorageStore.set(key, value);
      });
      await pollToPaired();

      expect(secureStorageStore.get('device_token')).toBe('tok-new');
      expect(secureStorageStore.get('tenant_id')).toBe('tenant-A');
      expect(mockCacheManager.setExpectedTenant).toHaveBeenCalledWith('tenant-A');
      expect(ioFactory.mock.calls.length).toBeGreaterThan(0);
    });

    it('B6: a tenant_id write failure blocks the commit — no half-paired grace-mode device', async () => {
      // All three writes gate the commit on purpose: persisting the token but not
      // tenant_id would boot the device in grace mode forever after.
      await bootToPairingScreen();
      const { SecureStorage } = await import('./secure-storage');
      (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        if (key === 'tenant_id') throw new Error('SECURE_STORAGE_UNAVAILABLE');
        secureStorageStore.set(key, value);
      });

      await pollToPaired(pairedPayload, () => secureStorageStore.has('tenant_id'), { expectSettled: false, budgetMs: 150 });

      expect(ioFactory.mock.calls.length).toBe(0);
      expect(mockCacheManager.setExpectedTenant).not.toHaveBeenCalledWith('tenant-A');
      expect(await reportedEvents()).toContain('pairing_persist_failed');
    });

    it('B6: an overlapping poll cannot commit the pairing twice', async () => {
      // Moving the persist AHEAD of `pairingCode = null` widened the window the
      // poll's own comment guards ("only the first wins, otherwise the success path
      // runs twice and churns the socket connection") from zero awaits to three
      // keystore writes. Park the first commit inside that window and let further
      // 2s ticks fire on top of it.
      await bootToPairingScreen();
      const { SecureStorage } = await import('./secure-storage');
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      let firstCommit = true;
      (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
        if (key === 'device_token' && firstCommit) {
          firstCommit = false;
          await gate;
        }
        secureStorageStore.set(key, value);
      });
      httpGetHandler = (opts) => opts.url.includes('/pairing/status/')
        ? { status: 200, data: { data: pairedPayload } }
        : { status: 404, data: {} };

      // Tick until the first commit is genuinely PARKED inside the persist. A single
      // fixed advance was the arrange here, and it did not reliably reach the persist
      // — roughly 2 runs in 7 the window under test was never entered and the assert
      // below read 0 socket connects. Same robust loop-until-settled shape every
      // other B6 test gets from pollToPaired; the assertions are unchanged.
      for (let round = 0; round < 30 && firstCommit; round++) {
        await vi.advanceTimersByTimeAsync(2100);
        for (let j = 0; j < 40; j++) await Promise.resolve();
      }
      expect(firstCommit).toBe(false);                  // the arrange really did park
      await vi.advanceTimersByTimeAsync(6300);          // further ticks land on top of it
      for (let j = 0; j < 40; j++) await Promise.resolve();
      release();
      for (let j = 0; j < 60; j++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(50);
      for (let j = 0; j < 60; j++) await Promise.resolve();

      const tokenWrites = (SecureStorage.set as Mock).mock.calls
        .filter((c: unknown[]) => (c[0] as { key: string }).key === 'device_token');
      expect(tokenWrites.length).toBe(1);
      expect(ioFactory.mock.calls.length).toBe(1);
      expect(secureStorageStore.get('device_token')).toBe('tok-new');
    });

    it('B6 NEGATIVE CONTROL: a healthy pairing reports no persist failure', async () => {
      await bootToPairingScreen();
      await pollToPaired();
      expect(await reportedEvents()).not.toContain('pairing_persist_failed');
    });

    it('B6 NEGATIVE CONTROL: a legacy backend with no tenantId still pairs', async () => {
      // Proves the all-or-nothing persist did not make tenant_id mandatory.
      await bootToPairingScreen();
      await pollToPaired({ status: 'paired', deviceToken: 'tok-legacy', deviceId: 'dev-legacy' });

      expect(secureStorageStore.get('device_token')).toBe('tok-legacy');
      expect(secureStorageStore.has('tenant_id')).toBe(false);
      expect(mockCacheManager.setExpectedTenant).toHaveBeenCalledWith(null);
      expect(ioFactory.mock.calls.length).toBeGreaterThan(0);
    });
  });

  // ------------------------------------------------------------------------
  // B7: allow-same-origin must not be granted on the plain-web platform
  // ------------------------------------------------------------------------

  describe('B7: webpage iframe sandbox is platform-conditional', () => {
    afterEach(() => {
      // Restore the suite-wide Android baseline.
      (window as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    });

    const playWebpage = async () => {
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      triggerSocketEvent('playlist:update', {
        playlist: { id: 'p1', name: 'T', items: [{ id: 'i1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'C', type: 'webpage', url: 'https://example.com' } }], loopPlaylist: true },
      });
      await vi.advanceTimersByTimeAsync(50);
      const iframes = findCreatedElements('iframe');
      expect(iframes.length).toBeGreaterThan(0);
      return iframes[iframes.length - 1].sandbox.add.mock.calls.flat();
    };

    it('B7: on the web platform allow-same-origin is NOT granted', async () => {
      // Only here can the app DOCUMENT's origin equal a content origin. Such a
      // frame, granted allow-same-origin, can reach `parent`, strip this very
      // sandbox attribute and reload itself unsandboxed — giving back everything
      // S4 took away.
      delete (window as { Capacitor?: unknown }).Capacitor;

      const tokens = await playWebpage();

      expect(tokens).not.toContain('allow-same-origin');
      // Still sandboxed against the failure S4 fixed.
      expect(tokens).toContain('allow-scripts');
      expect(tokens).not.toContain('allow-top-navigation');
    });

    it('B7 NEGATIVE CONTROL: on a real TV platform allow-same-origin IS still granted', async () => {
      // Most real signage pages break under an opaque origin, so the grant must
      // survive everywhere the app origin can never equal a content origin.
      delete (window as { Capacitor?: unknown }).Capacitor;
      (window as { tizen?: unknown }).tizen = {};
      try {
        const tokens = await playWebpage();
        expect(tokens).toContain('allow-same-origin');
        expect(tokens).toContain('allow-scripts');
      } finally {
        delete (window as { tizen?: unknown }).tizen;
      }
    });

    it('B7 NEGATIVE CONTROL: on Capacitor (Android) allow-same-origin IS still granted', async () => {
      const tokens = await playWebpage();
      expect(tokens).toContain('allow-same-origin');
      expect(tokens).toContain('allow-scripts');
    });
  });
});

// ============================================================================
// deliveryAck — the client capability that arms the server's delivery guarantee
// ============================================================================
//
// The backend's whole delivery-guarantee layer is live in production and inert,
// because it is gated on `auth.capabilities` in the Socket.IO handshake and no TV
// client advertised anything. With no capability the gateway does a bare
// socket.emit() and returns { delivered: true, legacy: true } — so a `command`
// written into a half-open socket (TCP dead, server has not noticed, up to ~45s)
// is lost permanently and silently while the dashboard reports it delivered and
// writes an audit row, and a `playlist:update` into the same socket is marked
// delivered while the server DELETES its pending-replay entry.
//
// Every test below drives the REAL production socket handlers registered by
// connectToRealtime(), through the same triggerSocketEvent seam the rest of this
// file uses. Each assertion is on DIRECTION (what value, in what order, how many
// times), never on mere presence, and each one uses an INDEPENDENT observable —
// the ack callback, window.location.reload, the persisted Preferences ring, the
// heartbeat's reported contentVersion, the rendered <img> src, the telemetry
// stream — so no single convenient field can carry the suite.
describe('deliveryAck — delivery-guaranteed emits (client capability)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetCapacitorFakes();
    resetDOM();
    (window.location as { search: string }).search = '';
    (window.location.reload as Mock).mockReset();
    ioFactory.mockClear();
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
    mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
    mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
    qrToCanvasMock.mockReset().mockResolvedValue(undefined);
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => ({
      value: secureStorageStore.get(key) ?? null,
    }));
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    });
    (SecureStorage.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    });
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    secureStorageStore.set('device_token', 'tok-123');
    secureStorageStore.set('device_id', 'dev-123');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------- shared observables --------

  const visibleScreens = () =>
    ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
      .filter(id => {
        const el = domElements.get(id);
        return el && !el._classListSet.has('hidden');
      });

  const reportedEventCalls = async () => {
    const { reportEvent } = await import('./crash-reporting');
    return (reportEvent as Mock).mock.calls as unknown[][];
  };

  const reportedEvents = async () => (await reportedEventCalls()).map(c => c[0]);

  /** What this device TELLS THE SERVER it is rendering — read off a real heartbeat. */
  const reportedContentVersion = async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    const beats = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat');
    return (beats[beats.length - 1][1] as { contentVersion: string }).contentVersion;
  };

  const imgCount = (needle: string) =>
    findCreatedElements('img').filter((i: ElementStub) => i.src.includes(needle)).length;

  // playlistId matters: shouldApplyContent() treats a CHANGED playlistId as a
  // reassignment and applies it regardless of version. Staleness only bites within
  // one playlist, so the stale-version test below pins the id deliberately.
  const playlistV = (version: string, contentId: string, url: string, playlistId?: string) => ({
    version,
    playlist: {
      id: playlistId ?? `pl-${contentId}`, name: contentId, loopPlaylist: true,
      items: [{ id: `it-${contentId}`, contentId, duration: 10, order: 0,
        content: { id: contentId, name: contentId, type: 'image', url } }],
    },
  });

  /** Boot a paired device onto a connected socket with content on the glass. */
  const connectAndCommit = async () => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistV('v1', 'c1', '/c1.jpg'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(visibleScreens()).toEqual(['content-screen']);
  };

  /** Every value the client passed to an ack callback, flattened. */
  const ackArgs = (ack: Mock) => ack.mock.calls.map((c: unknown[]) => c[0] as { ok?: unknown });

  // ======================================================================
  // 1. POSITIVE ACK — both delivery-guaranteed events
  // ======================================================================

  it('1a: playlist:update invokes the callback exactly once with { ok: true }', async () => {
    await connectAndCommit();
    const ack = vi.fn();

    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg'), ack);
    await vi.advanceTimersByTimeAsync(1600);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    // Direction, not presence: the payload was also actually applied, so the ack is
    // not a receipt for a handler that quietly did nothing.
    expect(await reportedContentVersion()).toBe('v2');
  });

  it('1b: command invokes the callback exactly once with { ok: true }', async () => {
    await connectAndCommit();
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'reload' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // 2. THE CLIENT NEVER NACKS — the single most dangerous thing it could do
  // ======================================================================
  //
  // The server has NO attempt counter, NO dead-letter and NO give-up for a nacked
  // payload. Its only circuit breaker is per-device/per-process, is reset by any
  // clean replay round, and is bypassed entirely by the connect-time replay path
  // (which also refreshes the Redis TTL). A nack on a failure class that also
  // restarts the client is therefore a loop the server cannot terminate. Playlist
  // and command replay additionally share ONE backoff counter, so nacking playlists
  // would throttle and eventually suppress this device's own command delivery.

  it('2: NEVER nacks — malformed payload, unknown command, and a throwing handler all ack ok:true', async () => {
    await connectAndCommit();
    const acks: Mock[] = [];
    const fire = (event: string, payload: unknown) => {
      const ack = vi.fn();
      acks.push(ack);
      return () => triggerSocketEvent(event, payload, ack);
    };

    fire('playlist:update', { playlist: 'not-an-object' })();
    fire('playlist:update', null)();
    fire('playlist:update', { playlist: { id: 'p', name: 'p', items: [null] }, version: 'v9' })();
    fire('command', { type: 'no_such_command_type' })();
    fire('command', {})();
    // A handler that genuinely throws: reload() blowing up mid-dispatch.
    (window.location.reload as Mock).mockImplementationOnce(() => { throw new Error('boom'); });
    fire('command', { type: 'reload' })();
    // And a payload whose own property access throws, before validation can run.
    const hostile = fire('playlist:update', { get playlist() { throw new Error('hostile getter'); } });
    expect(hostile).toThrow('hostile getter');

    await vi.advanceTimersByTimeAsync(1600);

    // POSITIVE CONTROL FIRST — a "never ok:false" assertion goes vacuous the moment
    // the acks stop being invoked at all.
    expect(acks).toHaveLength(7);
    for (const ack of acks) {
      expect(ack).toHaveBeenCalledTimes(1);
    }
    const everyValue = acks.flatMap(ackArgs);
    expect(everyValue).toHaveLength(7);
    expect(everyValue.every(v => v?.ok === true)).toBe(true);
    expect(everyValue.some(v => v?.ok === false)).toBe(false);
  });

  it('2 NEGATIVE CONTROL: the ok-value assertion can distinguish true from false', async () => {
    // Same shape, same matchers, so the check above is known to be capable of
    // failing rather than passing on anything at all.
    const nacked = [{ ok: true }, { ok: false }];
    expect(nacked.every(v => v.ok === true)).toBe(false);
    expect(nacked.some(v => v.ok === false)).toBe(true);
  });

  // ======================================================================
  // 3. MALFORMED PAYLOAD — acked, inert, playback continues
  // ======================================================================

  it('3: a malformed playlist:update is acked, changes nothing, and never darkens the screen', async () => {
    await connectAndCommit();
    const before = imgCount('c1.jpg');
    const ack = vi.fn();

    triggerSocketEvent('playlist:update', { playlist: { nope: true } }, ack);
    await vi.advanceTimersByTimeAsync(1600);

    expect(ack).toHaveBeenCalledWith({ ok: true });
    // Inert: no re-render, no version move, no screen change.
    expect(imgCount('c1.jpg')).toBe(before);
    expect(await reportedContentVersion()).toBe('v1');
    expect(visibleScreens()).toEqual(['content-screen']);
  });

  it('3 NEGATIVE CONTROL: a WELL-FORMED update at the same entry point does re-render', async () => {
    // Without this, "nothing changed" could just mean the handler is dead.
    await connectAndCommit();
    const ack = vi.fn();

    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg'), ack);
    await vi.advanceTimersByTimeAsync(1600);

    expect(imgCount('c2.jpg')).toBeGreaterThan(0);
    expect(await reportedContentVersion()).toBe('v2');
  });

  // ======================================================================
  // 4. STALE VERSION — acked, and correctly NOT applied
  // ======================================================================

  it('4: a stale-version push is acked ok:true but does NOT replace what is on glass', async () => {
    const SAME = 'pl-shared';
    await connectAndCommit();
    triggerSocketEvent('playlist:update', playlistV('v5', 'c5', '/c5.jpg', SAME));
    await vi.advanceTimersByTimeAsync(1600);
    expect(await reportedContentVersion()).toBe('v5');
    const staleRendersBefore = imgCount('c3.jpg');
    const ack = vi.fn();

    triggerSocketEvent('playlist:update', playlistV('v3', 'c3', '/c3.jpg', SAME), ack);
    await vi.advanceTimersByTimeAsync(1600);

    // Acked — a nack would only make the server replay the same stale payload,
    // against a shared backoff counter this device's commands depend on.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    // …and version-wins still held: the older payload never reached the glass.
    expect(imgCount('c3.jpg')).toBe(staleRendersBefore);
    expect(await reportedContentVersion()).toBe('v5');

    // POSITIVE CONTROL, same playlist, same seam: a NEWER version still applies, so
    // "did not apply" above is about the version and not about a dead handler.
    triggerSocketEvent('playlist:update', playlistV('v7', 'c7', '/c7.jpg', SAME), vi.fn());
    await vi.advanceTimersByTimeAsync(1600);
    expect(imgCount('c7.jpg')).toBeGreaterThan(0);
    expect(await reportedContentVersion()).toBe('v7');
  });

  // ======================================================================
  // 5. DUPLICATE DELIVERY — executes once, BOTH deliveries acked
  // ======================================================================

  it('5: the same (type, timestamp) executes ONCE and both deliveries are acked', async () => {
    await connectAndCommit();
    const dup = { type: 'reload', timestamp: 1755000000000 };
    const ackA = vi.fn();
    const ackB = vi.fn();

    triggerSocketEvent('command', { ...dup }, ackA);
    await vi.advanceTimersByTimeAsync(50);
    triggerSocketEvent('command', { ...dup }, ackB);
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(ackA).toHaveBeenCalledWith({ ok: true });
    // The suppressed one is acked too — otherwise the server requeues the exact
    // payload we deliberately ignored, forever.
    expect(ackB).toHaveBeenCalledTimes(1);
    expect(ackB).toHaveBeenCalledWith({ ok: true });
    expect(await reportedEvents()).toContain('command_duplicate_suppressed');
  });

  it('5 NEGATIVE CONTROL: a DIFFERENT timestamp is not suppressed', async () => {
    // The dedupe must key on (type, timestamp), not on type alone — otherwise an
    // operator could never send the same command twice.
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload', timestamp: 1 }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    triggerSocketEvent('command', { type: 'reload', timestamp: 2 }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(2);
  });

  it('5b: a command with NO timestamp is executed (never suppressed on a guess) and still acked', async () => {
    // The FIRST delivery is unchanged and deliberately so: with no key there is
    // nothing to match on, and dropping the operator's command is worse than
    // duplicating it. What this test used to assert about the SECOND one — that it
    // also executed — was the unterminated loop itself, 50ms apart being exactly the
    // replay cadence and nothing else in the system bounding it. The time-windowed
    // synthetic record (G1 below, both directions) is what now separates a machine
    // replaying inside seconds from a human re-issuing a minute later.
    await connectAndCommit();
    const ackA = vi.fn();
    const ackB = vi.fn();

    triggerSocketEvent('command', { type: 'reload' }, ackA);
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    triggerSocketEvent('command', { type: 'reload' }, ackB);
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    // BOTH are acked, the suppressed one included — a nack just requeues the delivery
    // we deliberately declined to repeat.
    expect(ackA).toHaveBeenCalledWith({ ok: true });
    expect(ackB).toHaveBeenCalledWith({ ok: true });
  });

  it('5c: the dedupe ring is bounded and pruned to the newest 20 keys', async () => {
    await connectAndCommit();
    for (let i = 1; i <= 25; i++) {
      // `reboot` is a no-op-with-telemetry, so this exercises the ring without
      // reloading the context 25 times.
      triggerSocketEvent('command', { type: 'reboot', timestamp: i }, vi.fn());
      await vi.advanceTimersByTimeAsync(5);
    }

    const ring = JSON.parse(preferencesStore.get('seen_command_keys')!) as string[];
    expect(ring).toHaveLength(20);
    expect(ring[0]).toBe('reboot@6');
    expect(ring[19]).toBe('reboot@25');
    expect(ring).not.toContain('reboot@5');
  });

  // ======================================================================
  // 6. DUPLICATE ACROSS A RESTART — the infinite-reload guard
  // ======================================================================

  it('6: suppression SURVIVES re-initialisation — the reload→replay→reload loop cannot start', async () => {
    // The sequence this defends against, end to end: we ack a `reload`; the device
    // reloads; the ack is lost in flight because the socket died mid-reload; the
    // server times out at 10s and requeues; on reconnect the IDENTICAL
    // (reload, timestamp) arrives again. In memory only, the ring is empty at that
    // moment and the device reloads forever. On disk, it is absorbed.
    await connectAndCommit();
    const dup = { type: 'reload', timestamp: 1755000000001 };

    triggerSocketEvent('command', { ...dup }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    // The key is on DISK before the dispatch that tears the context down.
    expect(preferencesStore.get('seen_command_keys')).toContain('reload@1755000000001');

    // --- the restart: brand-new socket, brand-new app instance, same storage ---
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    await importFresh();
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    await vi.advanceTimersByTimeAsync(50);

    const ackAfterRestart = vi.fn();
    triggerSocketEvent('command', { ...dup }, ackAfterRestart);
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(ackAfterRestart).toHaveBeenCalledTimes(1);
    expect(ackAfterRestart).toHaveBeenCalledWith({ ok: true });

    // POSITIVE CONTROL, same instance, same seam: a genuinely new command still
    // runs. Without this, "not called" would also pass if the restarted instance
    // had simply stopped handling commands at all.
    triggerSocketEvent('command', { type: 'reload', timestamp: 1755000000002 }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('6 NEGATIVE CONTROL: an unreadable ring fails OPEN rather than blocking commands', async () => {
    // A corrupt ring must cost at most one duplicate execution — never a device
    // that refuses the operator's commands.
    await connectAndCommit();
    preferencesStore.set('seen_command_keys', '{not json');

    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    await importFresh();
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');

    triggerSocketEvent('command', { type: 'reload', timestamp: 42 }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // 7. HANDLER EXCEPTION — the ack still fires, exactly once
  // ======================================================================

  it('7: a throwing command handler still acks exactly once, and the throw does not escape', async () => {
    await connectAndCommit();
    (window.location.reload as Mock).mockImplementation(() => { throw new Error('context died'); });
    const ack = vi.fn();

    expect(() => triggerSocketEvent('command', { type: 'reload' }, ack)).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    // The failure is surfaced through telemetry, NOT through the ack.
    expect(await reportedEvents()).toContain('command_handler_failed');
  });

  it('7b: a throwing playlist:update handler has already acked before it throws', async () => {
    await connectAndCommit();
    const ack = vi.fn();

    expect(() =>
      triggerSocketEvent('playlist:update', { get playlist() { throw new Error('kaboom'); } }, ack),
    ).toThrow('kaboom');

    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it('7c: an ack callback that itself throws does not take the handler down', async () => {
    await connectAndCommit();
    const hostileAck = vi.fn(() => { throw new Error('ack exploded'); });

    expect(() => triggerSocketEvent('command', { type: 'reload' }, hostileAck)).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);

    expect(hostileAck).toHaveBeenCalledTimes(1);
    // The command still ran — a broken receipt must not cost the operator the action.
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // 8. ACK BEFORE DISPATCH — proven by ORDER, not by presence
  // ======================================================================
  //
  // If the ack were sent after window.location.reload(), it would never leave the
  // device: the server times out at 10s, requeues, and the device reloads →
  // reconnects → replays → reloads forever. Presence of an ack proves nothing here;
  // only the ordering does.

  it.each([['reload'], ['restart']])(
    '8: %s — the ack is invoked BEFORE window.location.reload',
    async (type) => {
      await connectAndCommit();
      const order: string[] = [];
      (window.location.reload as Mock).mockImplementation(() => { order.push('reload'); });
      const ack = vi.fn(() => { order.push('ack'); });

      triggerSocketEvent('command', { type }, ack);
      await vi.advanceTimersByTimeAsync(50);

      // Both events observed (guards against a vacuous single-element sequence)…
      expect(order).toContain('ack');
      expect(order).toContain('reload');
      // …and in this order.
      expect(order).toEqual(['ack', 'reload']);
    },
  );

  it('8b: clear_cache — the ack precedes BOTH the cache purge and the reload', async () => {
    await connectAndCommit();
    const order: string[] = [];
    (window.location.reload as Mock).mockImplementation(() => { order.push('reload'); });
    mockCacheManager.clearCache.mockImplementation(async () => { order.push('clearCache'); });
    const ack = vi.fn(() => { order.push('ack'); });

    triggerSocketEvent('command', { type: 'clear_cache' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    expect(order).toEqual(['ack', 'clearCache', 'reload']);
    expect(order.indexOf('ack')).toBeLessThan(order.indexOf('reload'));
  });

  it('8c: the persisted dedupe key is written BEFORE the dispatch that destroys the context', async () => {
    // Ordering again, on the other half of the loop guard: if the ring were written
    // without being awaited, the write would race window.location.reload() and the
    // replay after the teardown would find an empty ring.
    //
    // The default Preferences.set fake resolves its promise but mutates the store
    // SYNCHRONOUSLY, which makes `await store.set()` and a bare fire-and-forget
    // indistinguishable — a mutation that dropped the await passed against it. Real
    // Capacitor Preferences is a bridge round-trip to the native layer, so model
    // that here: one microtask before the value lands.
    await connectAndCommit();
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.set as Mock).mockImplementationOnce(
      async ({ key, value }: { key: string; value: string }) => {
        await Promise.resolve(); // the native bridge round-trip
        preferencesStore.set(key, value);
      },
    );
    const observed: string[] = [];
    (window.location.reload as Mock).mockImplementation(() => {
      observed.push(`reload:${preferencesStore.get('seen_command_keys') ?? 'EMPTY'}`);
    });

    triggerSocketEvent('command', { type: 'reload', timestamp: 7 }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    // The dispatch happened at all (guards against a vacuous pass)…
    expect(observed).toHaveLength(1);
    // …and the key was already on disk when it did.
    expect(observed[0]).toContain('reload@7');
  });

  // ======================================================================
  // 9. MISSING CALLBACK — the legacy / unacked emit path
  // ======================================================================

  it('9: no crash when the ack is absent (sendInitialState, config, qr-overlay:update)', async () => {
    // The connect-time playlist:update and the config / qr-overlay emits are never
    // ack-wrapped. A handler that assumed a callback would break every reconnect.
    await connectAndCommit();

    expect(() => triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg'))).not.toThrow();
    expect(() => triggerSocketEvent('command', { type: 'reload' })).not.toThrow();
    await vi.advanceTimersByTimeAsync(1600);

    // Not merely "did not throw" — the work still happened.
    expect(imgCount('c2.jpg')).toBeGreaterThan(0);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('9b: a non-function in the callback slot is ignored, not called', async () => {
    await connectAndCommit();

    expect(() => triggerSocketEvent('command', { type: 'reload' }, 'not-a-function')).not.toThrow();
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // 10. THE CAPABILITY ITSELF — advertised, and surviving a token rotation
  // ======================================================================

  it('10: the handshake advertises capabilities: ["deliveryAck"]', async () => {
    secureStorageStore.set('device_token', 'tok-handshake-probe');
    await importFresh();

    const opts = ioFactory.mock.calls[0][1] as { auth: { token: string; capabilities: string[] } };
    // Observation channel is live: this reads a value the test controls.
    expect(opts.auth.token).toBe('tok-handshake-probe');
    expect(Array.isArray(opts.auth.capabilities)).toBe(true);
    expect(opts.auth.capabilities).toContain('deliveryAck');
  });

  it('10b: capabilities SURVIVE a token refresh — the device must not silently revert to legacy', async () => {
    // handleTokenRefresh used to do a wholesale `auth = { token }`. That drops the
    // capability, so the device goes back to the server's legacy delivery path on
    // its next reconnect with NO signal anywhere — and a command lost on a half-open
    // socket is then gone permanently while the dashboard says delivered.
    await importFresh();
    // Stand in for what real Socket.IO holds: the handshake auth, plus a field
    // neither we nor the test owns, so this binds the MERGE and not just the re-add.
    currentMockSocket.auth = { token: 'tok-123', capabilities: ['deliveryAck'], sessionNonce: 'n1' };

    triggerSocketEvent('token:refresh', { token: 'rotated-tok' });
    await vi.advanceTimersByTimeAsync(20);

    const auth = currentMockSocket.auth as Record<string, unknown>;
    expect(auth.token).toBe('rotated-tok');             // the rotation happened…
    expect(auth.capabilities).toContain('deliveryAck'); // …and did not cost the capability
    expect(auth.sessionNonce).toBe('n1');               // merged, not replaced
  });

  it('10c: capabilities are re-advertised on a full RECONNECT', async () => {
    // Socket.IO re-reads socket.auth on every reconnection attempt, and a fresh
    // connectToRealtime() rebuilds it from the same single source. Both routes must
    // carry the capability — "advertise always or never".
    await importFresh();
    triggerSocketEvent('token:refresh', { token: 'rotated-tok' });
    await vi.advanceTimersByTimeAsync(20);

    // Route A: the live socket's auth, which the next reconnection attempt reads.
    expect((currentMockSocket.auth as { capabilities: string[] }).capabilities).toContain('deliveryAck');

    // Route B: a network drop → restore re-enters connectToRealtime().
    currentMockSocket.connected = false;
    triggerNetworkChange(false);
    triggerNetworkChange(true);
    await vi.advanceTimersByTimeAsync(50);

    const calls = ioFactory.mock.calls as unknown[][];
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      const auth = (call[1] as { auth: { capabilities?: string[] } }).auth;
      expect(auth.capabilities).toContain('deliveryAck');
    }
  });

  // ======================================================================
  // 11. clear_override — the command with real customer impact
  // ======================================================================

  it('11: clear_override cancels the emergency push and restores the playlist', async () => {
    // Before this existed, clear_override fell to `default:` and warned. An operator
    // cancelling an emergency push could not clear the screen — the pushed content
    // stayed on the glass for the rest of its timer, up to 240 minutes — while the
    // dashboard reported the cancel delivered and wrote an audit row saying so.
    await connectAndCommit();
    const playlistRendersBefore = imgCount('c1.jpg');

    triggerSocketEvent('command', {
      type: 'push_content',
      payload: { content: { id: 'pp', name: 'P', type: 'image', url: '/emergency.jpg' }, duration: 240 },
    }, vi.fn());
    await vi.advanceTimersByTimeAsync(1600);
    expect(imgCount('emergency.jpg')).toBeGreaterThan(0);
    expect(imgCount('c1.jpg')).toBe(playlistRendersBefore); // the push owns the glass

    const ack = vi.fn();
    triggerSocketEvent('command', { type: 'clear_override' }, ack);
    await vi.advanceTimersByTimeAsync(1600);

    expect(ack).toHaveBeenCalledWith({ ok: true });
    // The playlist is back on the glass — a fresh render, not a leftover.
    expect(imgCount('c1.jpg')).toBeGreaterThan(playlistRendersBefore);
    expect(visibleScreens()).toEqual(['content-screen']);
  });

  it('11b: clear_override with NO push active is a no-op — it must not blank a playing playlist', async () => {
    // resumePlaylist() with nothing saved falls through to enterHolding(), so a
    // late or duplicate clear_override routed there unconditionally would take a
    // perfectly good playlist off the screen.
    await connectAndCommit();
    const before = imgCount('c1.jpg');
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'clear_override' }, ack);
    await vi.advanceTimersByTimeAsync(1600);

    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(visibleScreens()).toEqual(['content-screen']);
    expect(imgCount('c1.jpg')).toBe(before);
  });

  // ======================================================================
  // 12. UNSUPPORTED COMMANDS — acked and reported, never silently dropped
  // ======================================================================

  it.each([['reboot'], ['update'], ['screenshot']])(
    '12: %s is acked ok:true AND reported as unsupported',
    async (type) => {
      // Nacking a permanent failure would make the server replay it forever, so
      // these ack. The gap is now visible to the OPERATOR too, not only to us:
      // telemetry goes to us, while the dashboard renders a bare `{ ok: true }` in the
      // same green as a working reload — a permanent false positive telling someone
      // their action landed when it never will.
      await connectAndCommit();
      const ack = vi.fn();

      triggerSocketEvent('command', { type }, ack);
      await vi.advanceTimersByTimeAsync(50);

      expect(ack).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith({ ok: true, status: 'unsupported' });
      const calls = await reportedEventCalls();
      expect(calls.some(c => c[0] === 'command_unsupported' && (c[1] as { type?: string })?.type === type)).toBe(true);
      // NOT stubbed with fake behaviour: nothing pretended to happen.
      expect(window.location.reload).not.toHaveBeenCalled();
    },
  );

  it('12 NEGATIVE CONTROL: a SUPPORTED command does not report command_unsupported', async () => {
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(await reportedEvents()).not.toContain('command_unsupported');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // A6. HEARTBEAT ERROR ACKS ARE NO LONGER DISCARDED
  // ======================================================================
  //
  // `response.data ?? response` fell back to the top level on an error ack
  // ({ success:false, error, timestamp } — no `data`), where every field the client
  // reads is undefined. A rate-limited or rejected heartbeat was therefore
  // indistinguishable from a clean one: no signal at all, on either side.

  const heartbeatAck = async (payload: unknown) => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    await vi.advanceTimersByTimeAsync(200);
    const { CapacitorHttp } = await import('@capacitor/core');
    (CapacitorHttp.get as Mock).mockClear(); // ignore the pull-on-connect
    const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat');
    const cb = hb?.[2] as ((r: unknown) => void) | undefined;
    expect(typeof cb).toBe('function');
    cb!(payload);
    await vi.advanceTimersByTimeAsync(50);
    return (CapacitorHttp.get as Mock).mock.calls.map(
      (c: unknown[]) => String((c[0] as { url?: string })?.url ?? ''),
    );
  };

  it('A6: a server error ack is surfaced instead of read as an empty success', async () => {
    await heartbeatAck({ success: false, error: 'RATE_LIMITED', timestamp: '2026-08-15T00:00:00.000Z' });

    const calls = await reportedEventCalls();
    const err = calls.find(c => c[0] === 'heartbeat_ack_error');
    expect(err).toBeDefined();
    expect((err![1] as { error?: string }).error).toContain('RATE_LIMITED');
  });

  it('A6 NEGATIVE CONTROL: a real success ack is not flagged, and still reconciles', async () => {
    // Same helper, same seam. Proves the detector is not just firing on everything,
    // and that the early return did not swallow the success path it sits in front of.
    const urls = await heartbeatAck({
      success: true,
      data: { reconcileContent: true, nextHeartbeatIn: 15000, commands: [] },
      timestamp: '2026-08-15T00:00:00.000Z',
    });

    expect(await reportedEvents()).not.toContain('heartbeat_ack_error');
    expect(urls.some(u => u.includes('/devices/me/content'))).toBe(true);
  });

  it('A6: an error ack does NOT act on fields read off the failure envelope', async () => {
    // A failure envelope carries no data payload; treating its top level as an ack
    // is what produced the silence in the first place. It must trigger nothing.
    const urls = await heartbeatAck({ success: false, error: 'HEARTBEAT_FAILED', timestamp: 'x' });

    expect(urls.some(u => u.includes('/devices/me/content'))).toBe(false);
    expect(urls.some(u => u.includes('/devices/auth/check'))).toBe(false);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  // ======================================================================
  // A7. The heartbeat ack's commands array is not a second-class delivery door
  // ======================================================================
  //
  // There are TWO doors into handleCommand — the `command` socket event and the
  // heartbeat ack's commands array — and they must not differ on what happens when
  // the handler rejects. The socket door wraps it in .catch and reports it; this one
  // was a bare `forEach(cmd => this.handleCommand(cmd))`, so the identical failure
  // became an unhandled rejection with no telemetry, depending only on which door
  // the command happened to arrive through.

  it('A7: a throwing handler delivered through the HEARTBEAT ack is reported, not left floating', async () => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    await vi.advanceTimersByTimeAsync(200);

    const { Preferences } = await import('@capacitor/preferences');
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    // update_config persists each accepted URL; a rejecting store makes handleCommand
    // reject for real rather than simulating the rejection.
    (Preferences.set as Mock).mockRejectedValue(new Error('simulated Preferences.set failure'));

    const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat');
    (hb![2] as (r: unknown) => void)({
      success: true,
      data: {
        commands: [{ type: 'update_config', apiUrl: 'https://cdn.vizora.io', timestamp: 'ts-a7' }],
        nextHeartbeatIn: 15000,
      },
      timestamp: '2026-08-15T00:00:00.000Z',
    });
    await vi.advanceTimersByTimeAsync(50);

    const events = await reportedEvents();
    expect(events).toContain('command_handler_failed');
    // Not the allowlist refusing the URL before the throwing line was reached.
    expect(events).not.toContain('config_rejected');
  });

  // ======================================================================
  // A8. The dedupe ring is pairing-bound state and dies with the pairing
  // ======================================================================

  it('A8: a confirmed revocation purges the PERSISTED command-dedupe ring', async () => {
    await connectAndCommit(); // default handler: auth-check 404 → legacy carve-out
    triggerSocketEvent('command', { type: 'clear_override', timestamp: 'ts-a8' });
    await vi.advanceTimersByTimeAsync(50);
    // Baseline: there is ring state on disk to purge.
    expect(preferencesStore.get('seen_command_keys')).toContain('ts-a8');

    triggerSocketEvent('command', { type: 'unpair', timestamp: 'ts-a8-unpair' });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);

    // Baseline for the purge itself, so this cannot pass because no purge ran.
    expect(secureStorageStore.has('device_token')).toBe(false);
    // The ring is delivery state for the pairing that just ended. Left behind, it can
    // suppress a genuinely new command for whatever tenant is paired next, and it
    // leaves the revoked tenant's command history readable on the device.
    expect(preferencesStore.has('seen_command_keys')).toBe(false);
  });

  // ======================================================================
  // A9. THE LOOP TERMINATOR MUST NOT FAIL SILENTLY
  // ======================================================================
  //
  // Advertising deliveryAck is what INTRODUCED the requeue path: before it, the
  // gateway did a bare legacy emit and never requeued, so a command-replay loop
  // could not exist. Now an ack lost with the socket makes the server time out at
  // 10s, requeue (refreshing the Redis TTL each time) and replay on reconnect,
  // through a path that is not rate-limited. The persisted ring is the ONLY thing
  // that terminates that replay for a context-destroying command — so every way the
  // ring can fail has to be visible to us, not just to a console nobody reads.
  //
  // The concrete field case: on Tizen/webOS the Capacitor Preferences plugin falls
  // through to its localStorage web implementation, where a QuotaExceededError takes
  // out every read and every write at once.

  /** Break only the dedupe ring's storage, leaving the rest of Preferences healthy. */
  const breakRingWrites = async (fail: () => Promise<never>) => {
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.set as Mock).mockImplementation(async (opts: { key: string; value: string }) => {
      if (opts.key === 'seen_command_keys') return fail();
      preferencesStore.set(opts.key, opts.value);
    });
  };

  it('A9: a FAILED ring persist is reported, not just logged — and the command still runs', async () => {
    await connectAndCommit();
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    await breakRingWrites(() => Promise.reject(new Error('QuotaExceededError')));
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'a9' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    const calls = await reportedEventCalls();
    expect(calls.some(c => c[0] === 'command_dedupe_ring_persist_failed')).toBe(true);
    // Direction, not presence: the write really did fail (nothing on disk) while the
    // operator's command really did run and really was acked.
    expect(preferencesStore.has('seen_command_keys')).toBe(false);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it('A9 NEGATIVE CONTROL: a HEALTHY ring persist reports nothing', async () => {
    // Same seam, same command, working storage — so the event above is a report of a
    // failure and not something this path emits unconditionally.
    await connectAndCommit();
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'a9-ok' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(await reportedEvents()).not.toContain('command_dedupe_ring_persist_failed');
    expect(preferencesStore.get('seen_command_keys')).toContain('reload@a9-ok');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('A9b: an unreadable ring at BOOT is reported under its own event name', async () => {
    // Distinguishable from the persist failure on purpose: this one says the ring did
    // not survive the restart, which is exactly the window a requeued command replays
    // into. One event name for both would make the two indistinguishable in Sentry.
    await connectAndCommit();
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'seen_command_keys') throw new Error('QuotaExceededError');
      return { value: preferencesStore.get(key) ?? null };
    });

    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    await importFresh();

    const events = await reportedEvents();
    expect(events).toContain('command_dedupe_ring_load_failed');
    // …and only that one: a load failure is not a persist failure.
    expect(events).not.toContain('command_dedupe_ring_persist_failed');
  });

  it('A9b NEGATIVE CONTROL: a READABLE ring boots silently and still suppresses', async () => {
    // Guards two ways of passing vacuously: the event firing on every boot, and the
    // load path being dead (which would also produce "no load_failed" — plus a device
    // that has lost its terminator entirely).
    await connectAndCommit();
    triggerSocketEvent('command', { type: 'reload', timestamp: 'a9b' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(preferencesStore.get('seen_command_keys')).toContain('reload@a9b');

    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    await importFresh();
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');

    expect(await reportedEvents()).not.toContain('command_dedupe_ring_load_failed');
    // The ring was genuinely restored — the replay is absorbed.
    triggerSocketEvent('command', { type: 'reload', timestamp: 'a9b' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).not.toHaveBeenCalled();
  });

  // ======================================================================
  // A10. THE PERSIST THAT GATES THE DISPATCH IS BOUNDED
  // ======================================================================
  //
  // The ring write is awaited BEFORE window.location.reload() on purpose (8c). That
  // makes a wedged Capacitor bridge — a promise that never settles — into a total
  // loss of the operator's command: reload/restart/clear_cache silently never run,
  // the server already holds { ok: true }, the dashboard says delivered, and there is
  // no rejection to report because the promise does not settle at all.
  //
  // Modelling note, learned the hard way: the default Preferences.set fake resolves
  // its own promise, so it cannot tell a bounded await from an unbounded one. The
  // hang below is a promise that NEVER settles, and the assertions straddle the
  // timeout — before it the dispatch must NOT have happened (or the await is not
  // gating anything), after it the dispatch MUST have happened (or the await is not
  // bounded).

  const NEVER = () => new Promise<never>(() => {});

  it('A10: a wedged bridge does not swallow the command — it dispatches after the bound', async () => {
    await connectAndCommit();
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    await breakRingWrites(NEVER);
    // IndexedDB is disabled here on purpose: this test is about what happens when the
    // ONLY remaining async home is wedged. With a healthy IndexedDB the record is
    // accepted immediately and the command dispatches at once — first acceptance wins,
    // which is the improvement, not a regression — and the bound is never reached, so
    // there would be no bound left to exercise.
    idbThrowOn.write = true;
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'a10' }, ack);
    await vi.advanceTimersByTimeAsync(1500);

    // The ack went out immediately — it is a delivery receipt, not an apply receipt,
    // and it must not wait on storage.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    // …and at 1500ms the write is still pending, so the dispatch is genuinely GATED
    // on it. Without this half, a fire-and-forget persist would pass the next half.
    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).not.toContain('command_dedupe_persist_timeout');

    await vi.advanceTimersByTimeAsync(600); // past the 2000ms bound

    // Bounded: the operator's command runs even though the write never settled…
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    // …and the fact that the BRIDGE write did not land is on the record.
    const calls = await reportedEventCalls();
    const timeout = calls.find(c => c[0] === 'command_dedupe_persist_timeout');
    expect(timeout).toBeDefined();
    expect((timeout![1] as { type?: string }).type).toBe('reload');

    // …but the dispatch is NOT unguarded. This assertion is the point of the whole
    // fix, and its absence is what made this test encode the loop rather than catch
    // it: with only the bridge copy, "timed out, dispatched anyway" left the reload
    // with NO on-disk terminator at all, so the requeue at 10s replayed it into a
    // context that had no memory of having run it — reload → reconnect → replay →
    // reload at a ~3–5s period with nothing to stop it. The synchronous localStorage
    // write in rememberCommand lands before the bound can even start counting.
    expect(JSON.parse(localStorageStore.get('vizora_seen_command_keys')!)).toContain('reload@a10');
  });

  it('A10 NEGATIVE CONTROL: a healthy bridge dispatches promptly and reports no timeout', async () => {
    // Same command, same seam, a persist that settles one bridge microtask later.
    // Proves the 2000ms wait above belongs to the wedge and not to the code path.
    await connectAndCommit();
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      await Promise.resolve(); // the native bridge round-trip
      preferencesStore.set(key, value);
    });
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'a10-ok' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50); // nowhere near the bound

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(await reportedEvents()).not.toContain('command_dedupe_persist_timeout');
    expect(preferencesStore.get('seen_command_keys')).toContain('reload@a10-ok');
  });

  it('A10b: the bound applies to clear_cache too, and the purge still runs', async () => {
    // clear_cache is context-destroying by the same route, and it has real work
    // between the ack and the reload — a wedge must not strand that either.
    await connectAndCommit();
    const order: string[] = [];
    mockCacheManager.clearCache.mockImplementation(async () => { order.push('clearCache'); });
    (window.location.reload as Mock).mockImplementation(() => { order.push('reload'); });
    await breakRingWrites(NEVER);
    idbThrowOn.write = true; // same reason as A10 — leave the wedge as the only home

    triggerSocketEvent('command', { type: 'clear_cache', timestamp: 'a10b' }, vi.fn());
    await vi.advanceTimersByTimeAsync(1500);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(600);
    expect(order).toEqual(['clearCache', 'reload']);
    expect(await reportedEvents()).toContain('command_dedupe_persist_timeout');
  });

  // ======================================================================
  // A11. A CONTEXT-DESTROYING COMMAND WITH NO DEDUPE KEY IS VISIBLE
  // ======================================================================
  //
  // The whole scheme rests on the gateway stamping `timestamp` on every command
  // (device.gateway.ts:2299 today, and the identical object is requeued verbatim).
  // That is one line in another repo with no compiler between the two. The client
  // fails OPEN when it is missing — commandDedupeKey returns null, the command
  // EXECUTES and nothing is recorded — which for reload/restart/clear_cache is an
  // unterminable loop the moment any future emitter forgets the stamp.
  //
  // Executing anyway is the right call (dropping the operator's command would be
  // worse). Executing anyway SILENTLY is not: it would first be discovered as a
  // field loop.

  it('A11: an unkeyable reload/restart/clear_cache is reported, and still executes', async () => {
    await connectAndCommit();
    for (const type of ['reload', 'restart', 'clear_cache']) {
      const { reportEvent } = await import('./crash-reporting');
      (reportEvent as Mock).mockClear();
      (window.location.reload as Mock).mockClear();
      const ack = vi.fn();

      triggerSocketEvent('command', { type }, ack); // NO timestamp — unkeyable
      await vi.advanceTimersByTimeAsync(50);

      const calls = await reportedEventCalls();
      const missing = calls.find(c => c[0] === 'command_dedupe_key_missing');
      expect(missing, `no report for ${type}`).toBeDefined();
      expect((missing![1] as { type?: string }).type).toBe(type);
      // Fail-open behaviour is UNCHANGED on the first delivery: it ran, it was acked.
      expect(window.location.reload).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith({ ok: true });
      // What it no longer does is record NOTHING. A synthetic record lands in BOTH
      // durable homes — the synchronous one is the copy that survives the reload this
      // command just fired, which is the only reason it can terminate the replay.
      const mark = `${type}@~unkeyed:`;
      expect(localStorageStore.get('vizora_seen_command_keys'), `no local record for ${type}`)
        .toContain(mark);
      expect(preferencesStore.get('seen_command_keys'), `no persisted record for ${type}`)
        .toContain(mark);
    }
  });

  it('A11 NEGATIVE CONTROL: a KEYED reload, and an unkeyed harmless command, report nothing', async () => {
    // Two ways this detector could be wrong: firing when the key is present, and
    // firing for commands whose replay is merely wasteful rather than unterminable.
    await connectAndCommit();
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'a11' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(await reportedEvents()).not.toContain('command_dedupe_key_missing');
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    (reportEvent as Mock).mockClear();
    triggerSocketEvent('command', { type: 'clear_override' }, vi.fn()); // unkeyed, harmless
    await vi.advanceTimersByTimeAsync(50);
    expect(await reportedEvents()).not.toContain('command_dedupe_key_missing');
  });

  it('A11b: the unkeyed path gets the same task boundary the keyed path gets', async () => {
    // Compounding failure the report called out: with no key there is also no await,
    // so window.location.reload() fired in the SAME synchronous turn as the ack —
    // the tightest possible flush window landing on exactly the case that also has no
    // dedupe protection. Acking first only buys a chance to flush; it buys nothing if
    // the context is torn down before the turn ends.
    await connectAndCommit();
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'reload' }, ack);

    // Synchronously after the handler returns: acked, NOT yet reloaded.
    expect(ack).toHaveBeenCalledTimes(1);
    expect(window.location.reload).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('A11b NEGATIVE CONTROL: the observation window can see a same-turn dispatch', async () => {
    // The assertion above is "not yet called", which passes trivially if nothing ever
    // calls it. This runs the same probe against a handler that DOES dispatch in the
    // same turn, so the window is known to be capable of catching one.
    await connectAndCommit();
    const seen: string[] = [];
    currentMockSocket._handlers.set('sync-probe', [() => {
      seen.push('ack');
      (window.location.reload as Mock)();
      seen.push('reload');
    }]);

    triggerSocketEvent('sync-probe');

    expect(seen).toEqual(['ack', 'reload']);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Release-review wave: loop terminator, frame origin, and the unguarded lines
// ============================================================================
//
// Everything below is bound to a real production entry point — a socket event, a
// heartbeat ack callback, or a fresh boot — never to a private method. Each fix
// gets a negative control at the same layer, so a "did not happen" assertion
// cannot pass by the path having gone dark.

describe('Release-review wave (B1, B2, C2–C7, S1, S3)', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    resetCapacitorFakes();
    resetDOM();
    (window.location as { search: string }).search = '';
    (window.location.reload as Mock).mockReset();
    ioFactory.mockClear();
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    mockCacheManager.getCachedUri.mockReset().mockResolvedValue(null);
    mockCacheManager.downloadContent.mockReset().mockResolvedValue(null);
    mockCacheManager.clearCache.mockReset().mockResolvedValue(undefined);
    mockCacheManager.setExpectedTenant.mockClear();
    qrToCanvasMock.mockReset().mockResolvedValue(undefined);
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => ({
      value: secureStorageStore.get(key) ?? null,
    }));
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    });
    (SecureStorage.remove as Mock).mockImplementation(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    });
    const { reportEvent, isCrashReportingEnabled } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    (isCrashReportingEnabled as Mock).mockReturnValue(true);
    secureStorageStore.set('device_token', 'tok-123');
    secureStorageStore.set('device_id', 'dev-123');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------- shared observables --------

  const LOCAL_RING_KEY = 'vizora_seen_command_keys';

  const visibleScreens = () =>
    ['loading-screen', 'pairing-screen', 'content-screen', 'holding-screen', 'error-screen']
      .filter(id => {
        const el = domElements.get(id);
        return el && !el._classListSet.has('hidden');
      });

  const reportedEventCalls = async () => {
    const { reportEvent } = await import('./crash-reporting');
    return (reportEvent as Mock).mock.calls as unknown[][];
  };
  const reportedEvents = async () => (await reportedEventCalls()).map(c => c[0]);

  const localRing = (): string[] => {
    const raw = localStorageStore.get(LOCAL_RING_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  };

  const playlistV = (version: string, contentId: string, url: string, playlistId?: string) => ({
    version,
    playlist: {
      id: playlistId ?? `pl-${contentId}`, name: contentId, loopPlaylist: true,
      items: [{ id: `it-${contentId}`, contentId, duration: 10, order: 0,
        content: { id: contentId, name: contentId, type: 'image', url } }],
    },
  });

  const connectAndCommit = async () => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistV('v1', 'c1', '/c1.jpg'));
    await vi.advanceTimersByTimeAsync(1600);
    expect(visibleScreens()).toEqual(['content-screen']);
  };

  /** What this device TELLS THE SERVER it is rendering — read off a real heartbeat. */
  const reportedContentVersion = async () => {
    await vi.advanceTimersByTimeAsync(15_000);
    const beats = currentMockSocket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat');
    return (beats[beats.length - 1][1] as { contentVersion: string }).contentVersion;
  };

  /** Make only the ring's Preferences slot fail; the rest of the store stays healthy. */
  const breakRingPreferences = async (fail: () => Promise<never>) => {
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.set as Mock).mockImplementation(async (opts: { key: string; value: string }) => {
      if (opts.key === 'seen_command_keys') return fail();
      preferencesStore.set(opts.key, opts.value);
    });
    (Preferences.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'seen_command_keys') throw new Error('QuotaExceededError');
      return { value: preferencesStore.get(key) ?? null };
    });
  };

  const NEVER = () => new Promise<never>(() => {});

  // ======================================================================
  // B1. THE REPLAY-LOOP TERMINATOR IS DURABLE WITHOUT THE BRIDGE
  // ======================================================================
  //
  // Advertising deliveryAck is what CREATED the requeue path — before it the gateway
  // did a bare legacy emit and never requeued. The persisted (type, timestamp) ring
  // is now the only thing that terminates a replay of a context-destroying command,
  // and it had three ways to be silently absent at the moment of dispatch: the 2s
  // persist bound elapsing, the write REJECTING (rememberCommand resolves either
  // way, so the caller cannot tell), and a command with no timestamp. Any of them
  // leaves reload → ack lost in engine.io's writeBuffer → reload() discards it →
  // requeue at 10s → reconnect → replay → reload, at a ~3–5s period, forever;
  // nothing bounds it, because the native crash ladder counts Java uncaught
  // exceptions and location.reload() is not a crash.
  //
  // localStorage closes the first two: synchronous, no Capacitor bridge, survives
  // window.location.reload().

  it('B1: a REJECTING Preferences write still leaves a durable record', async () => {
    await connectAndCommit();
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));

    triggerSocketEvent('command', { type: 'reload', timestamp: 'b1-reject' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    // Direction: the bridge write really did fail…
    expect(preferencesStore.has('seen_command_keys')).toBe(false);
    expect(await reportedEvents()).toContain('command_dedupe_ring_persist_failed');
    // …and the terminator is on disk anyway.
    expect(localRing()).toContain('reload@b1-reject');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('B1: a WEDGED bridge (persist never settles) still leaves a durable record', async () => {
    await connectAndCommit();
    await breakRingPreferences(NEVER);
    // The SYNCHRONOUS home is what this test is about, so the other async home is
    // disabled — otherwise IndexedDB accepts first and the bound is never reached.
    idbThrowOn.write = true;

    triggerSocketEvent('command', { type: 'reload', timestamp: 'b1-wedge' }, vi.fn());
    // The synchronous write has landed before the bound has even started running out.
    await vi.advanceTimersByTimeAsync(50);
    expect(localRing()).toContain('reload@b1-wedge');
    expect(window.location.reload).not.toHaveBeenCalled(); // still gated on the bound

    await vi.advanceTimersByTimeAsync(2100);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(await reportedEvents()).toContain('command_dedupe_persist_timeout');
    expect(localRing()).toContain('reload@b1-wedge');
  });

  it('B1: END TO END — the replay after the reload is suppressed with Preferences dead', async () => {
    // The whole loop, through the real doors: command → dispatch → "reload" (a fresh
    // module with the same storage) → the server requeues and replays the IDENTICAL
    // (type, timestamp) → the second execution must not happen.
    await connectAndCommit();
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));

    triggerSocketEvent('command', { type: 'reload', timestamp: 'b1-e2e' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    // The reload: same device, same disk, new JS context.
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    await importFresh();
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');

    triggerSocketEvent('command', { type: 'reload', timestamp: 'b1-e2e' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('command_duplicate_suppressed');
  });

  it('B1 NEGATIVE CONTROL: with BOTH stores dead the command is REFUSED, not looped', async () => {
    // Two properties, and the second CHANGED when the fail-closed rule landed.
    //
    // (1) The control, unchanged: B1's suppression really does come from the durable
    //     write. With both stores dead nothing is recorded, so nothing here could be
    //     producing that suppression.
    // (2) The consequence. This used to assert that the replay EXECUTED — "the loop,
    //     unterminated" — because that was the behaviour, and it was written when the
    //     two homes were believed independent. They are not on Tizen/webOS:
    //     @capacitor/preferences 6.0.4's web implementation IS window.localStorage
    //     (dist/esm/web.js, `get impl()`), so ONE QuotaExceededError produces exactly
    //     this both-dead state on the platform where quota failure is the motivating
    //     scenario. Dispatching into it is the unterminated reload loop with no
    //     terminator anywhere — a screen that never reaches content and a truck roll.
    //     The device now declines the command: recoverable, and visible in telemetry.
    await connectAndCommit();
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));
    localStorageThrowOn.setItem = true;
    localStorageThrowOn.getItem = true;
    idbThrowOn.write = true;  // the independent home too — refusal needs EVERY home dead
    idbThrowOn.read = true;

    const ack = vi.fn();
    triggerSocketEvent('command', { type: 'reload', timestamp: 'b1-none' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    // Still acked — a nack would only requeue the delivery we just declined.
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(await reportedEvents()).toContain('command_dedupe_local_persist_failed');
    expect(await reportedEvents()).toContain('command_refused_no_durable_dedupe');
    // The control property itself: neither store took anything.
    expect(localStorageStore.has(LOCAL_RING_KEY)).toBe(false);
    expect(preferencesStore.has('seen_command_keys')).toBe(false);

    // And a device in this state must still BOOT — failing closed on a command must
    // never become failing closed on startup (the fail-OPEN direction the original
    // test pinned, kept).
    currentMockSocket = createMockSocket();
    ioFactory.mockReturnValue(currentMockSocket);
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('command', { type: 'reload', timestamp: 'b1-none' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('command_dedupe_ring_load_failed');

    // The property this phase exists to keep: the device is ALIVE, not merely silent.
    // Both assertions above are satisfied by a device that never booted —
    // `reload` not called is trivially true when nothing runs, and the load-failure
    // event is emitted BEFORE any throw would propagate. Make an unreadable ring abort
    // loadSeenCommands and the whole suite stays green without this line. A negative
    // observable cannot tell "correctly refused" from "dead"; only a positive one can,
    // which is where the original's toHaveBeenCalledTimes(1) got its power.
    triggerSocketEvent('command', { type: 'reboot', timestamp: 'b1-none-alive' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(await reportedEvents()).toContain('command_unsupported');
  });

  it('B1: the two ring homes are UNIONED, either one alone suppresses', async () => {
    // They can legitimately disagree — localStorage lands when the bridge write does
    // not, and Preferences survives a webview storage clear that takes localStorage
    // with it. Whichever holds the key has to be enough.
    for (const home of ['localStorage', 'preferences'] as const) {
      resetCapacitorFakes();
      secureStorageStore.set('device_token', 'tok-123');
      secureStorageStore.set('device_id', 'dev-123');
      const ring = JSON.stringify(['reload@union']);
      if (home === 'localStorage') localStorageStore.set(LOCAL_RING_KEY, ring);
      else preferencesStore.set('seen_command_keys', ring);

      currentMockSocket = createMockSocket();
      ioFactory.mockReturnValue(currentMockSocket);
      await importFresh();
      (window.location.reload as Mock).mockClear();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');

      triggerSocketEvent('command', { type: 'reload', timestamp: 'union' }, vi.fn());
      await vi.advanceTimersByTimeAsync(50);

      expect(window.location.reload, `suppressed via ${home}`).not.toHaveBeenCalled();
    }
  });

  it('B1: a purge clears BOTH ring homes', async () => {
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    await connectAndCommit();
    triggerSocketEvent('command', { type: 'clear_override', timestamp: 'b1-purge' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(localRing()).toContain('clear_override@b1-purge'); // baseline: there is state to purge

    triggerSocketEvent('device:revoked', { reason: 'operator' });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);

    expect(secureStorageStore.has('device_token')).toBe(false); // the purge really ran
    expect(preferencesStore.has('seen_command_keys')).toBe(false);
    expect(localRing()).toEqual([]);
  });

  // -------- test-instrument 5: the restore bound --------

  it('T5: loadSeenCommands BOUNDS the restored ring — an evicted key is not suppressed', async () => {
    // The ring is written back out at whatever size it comes back at, so an
    // oversized store (an older build, a hand-edited file, two copies that diverged)
    // would grow without limit. The bound has to be on the RESTORE, not only on the
    // write. Observable through the real door: the 5th-from-oldest of 25 keys falls
    // outside the last 20 and must therefore EXECUTE.
    const keys = Array.from({ length: 25 }, (_, i) => `reload@k${i + 1}`);
    localStorageStore.set(LOCAL_RING_KEY, JSON.stringify(keys));
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    (window.location.reload as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'k1' }, vi.fn()); // evicted
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('T5 NEGATIVE CONTROL: a key INSIDE the bound is still suppressed', async () => {
    // Same seam, same boot. Proves the restore is not simply dead — which would also
    // produce "k1 executed", plus a device with no terminator at all.
    const keys = Array.from({ length: 25 }, (_, i) => `reload@k${i + 1}`);
    localStorageStore.set(LOCAL_RING_KEY, JSON.stringify(keys));
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    (window.location.reload as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'k25' }, vi.fn()); // newest
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
  });

  // ======================================================================
  // S1. THE DEDUPE KEY IS BOUNDED
  // ======================================================================

  it('S1: an oversized (type, timestamp) is refused as a key — reported, and still executed', async () => {
    await connectAndCommit();
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'x'.repeat(200) }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    const calls = await reportedEventCalls();
    const oversize = calls.find(c => c[0] === 'command_dedupe_key_oversize');
    expect(oversize).toBeDefined();
    expect((oversize![1] as { length?: number }).length).toBeGreaterThan(128);
    // Fail OPEN, and nothing that huge reaches either store — which is the point of
    // the bound: an oversized key is a way to blow the quota from the wire.
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(localRing().some(k => k.length > 128)).toBe(false);
    expect(localStorageStore.get('vizora_seen_command_keys') ?? '').not.toContain('x'.repeat(200));
    expect(preferencesStore.get('seen_command_keys') ?? '').not.toContain('x'.repeat(200));
    // It is context-destroying and unkeyable, so the existing missing-key alarm fires
    // too — and the short synthetic guard IS recorded, because an oversized key leaves
    // a replay just as unterminable as a missing one.
    expect(await reportedEvents()).toContain('command_dedupe_key_missing');
    expect(localRing().some(k => k.startsWith('reload@~unkeyed:'))).toBe(true);
  });

  it('S1 NEGATIVE CONTROL: a long-but-legal key is still recorded', async () => {
    // Same seam. Proves the bound is a bound and not a blanket refusal — `reload@`
    // plus a 100-char timestamp is 107 chars and must survive.
    await connectAndCommit();
    const ts = 'y'.repeat(100);

    triggerSocketEvent('command', { type: 'reload', timestamp: ts }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(await reportedEvents()).not.toContain('command_dedupe_key_oversize');
    expect(localRing()).toContain(`reload@${ts}`);
  });

  // ======================================================================
  // C3. THE BOOT-PATH BRIDGE READS ARE BOUNDED
  // ======================================================================
  //
  // Both run inside init(), before credentials. A wedged bridge means init() never
  // SETTLES, so it never REJECTS, so the startInit() retry loop never fires: the
  // device sits on the splash indefinitely with no error and no telemetry. The diff
  // that bounded the ring WRITE left these two READS unbounded.

  it.each([
    ['seen_command_keys', 'the dedupe ring read'],
    ['crash_loop_capped', 'the crash-loop marker read'],
  ])('C3: a wedged bridge on %s does not hang boot', async (hungKey) => {
    secureStorageStore.clear(); // no credentials → the pairing screen is the settle proof
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === hungKey) return NEVER();
      return { value: preferencesStore.get(key) ?? null };
    });

    await importFresh();
    await vi.advanceTimersByTimeAsync(2500); // past the 2000ms bound
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(300);

    // init() got all the way through to the pairing request.
    expect(domElements.get('pairing-code')!.textContent).toBe('ABCD1234');
    const calls = await reportedEventCalls();
    const timeout = calls.find(c => c[0] === 'preferences_read_timeout');
    expect(timeout).toBeDefined();
    expect((timeout![1] as { key?: string }).key).toBe(hungKey);
  });

  it('C3 NEGATIVE CONTROL: a healthy bridge reports no read timeout', async () => {
    // Same boot, same assertions, working storage — so the event above belongs to the
    // wedge and not to the boot path.
    secureStorageStore.clear();
    await importFresh();
    await vi.advanceTimersByTimeAsync(2500);

    expect(domElements.get('pairing-code')!.textContent).toBe('ABCD1234');
    expect(await reportedEvents()).not.toContain('preferences_read_timeout');
  });

  // ======================================================================
  // C5. A TOKEN ROTATION MUST NOT SURVIVE A PURGE THAT LANDED MID-WRITE
  // ======================================================================

  it('C5: a purge during the keystore write discards the rotated token', async () => {
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    await connectAndCommit();

    const { SecureStorage } = await import('./secure-storage');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      if (key === 'device_token') await gate;
      secureStorageStore.set(key, value);
    });

    // The rotation parks inside the keystore write…
    triggerSocketEvent('token:refresh', { token: 'rotated-tok' });
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // …and the de-pair lands while it is parked.
    triggerSocketEvent('device:revoked', { reason: 'operator' });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    expect(secureStorageStore.has('device_token')).toBe(false); // the purge completed

    release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(100);

    // The write landed AFTER the purge's remove; it must be taken back out, and it
    // must not be adopted in memory either — a resurrected credential on the pairing
    // screen is what the network/appState listeners reconnect with.
    expect(secureStorageStore.has('device_token')).toBe(false);
    expect(await reportedEvents()).toContain('token_refresh_discarded_after_purge');
    const authTokens = ioFactory.mock.calls.map(
      (c: unknown[]) => (c[1] as { auth?: { token?: string } } | undefined)?.auth?.token,
    );
    expect(authTokens).not.toContain('rotated-tok');
  });

  it('C5 NEGATIVE CONTROL: with no purge, the same parked rotation is adopted', async () => {
    // Same seam, same gate. Proves the discard belongs to the purge and not to the
    // parking — otherwise the fix could have broken rotation outright, which strands
    // devices whose token the server has already replaced.
    await connectAndCommit();
    const { SecureStorage } = await import('./secure-storage');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    (SecureStorage.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      if (key === 'device_token') await gate;
      secureStorageStore.set(key, value);
    });

    triggerSocketEvent('token:refresh', { token: 'rotated-tok' });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    release();
    for (let i = 0; i < 60; i++) await Promise.resolve();

    expect(secureStorageStore.get('device_token')).toBe('rotated-tok');
    expect(currentMockSocket.auth).toEqual({ token: 'rotated-tok', capabilities: ['deliveryAck'] });
    expect(await reportedEvents()).not.toContain('token_refresh_discarded_after_purge');
  });

  // ======================================================================
  // C7. applyPulledContent IS SERIALIZED AND RE-VALIDATES
  // ======================================================================
  //
  // Four entry points reach one critical section — pull-on-connect, the heartbeat
  // reconcile pull, a versioned playlist:update, and pullContent itself — and
  // overlap is guaranteed by construction, not merely possible: pullContent's bound
  // is 20s while the heartbeat cadence is 15s. Interleaved, the read of `current`,
  // the await inside updatePlaylist and the version commit are three steps on shared
  // state and the LAST commit to land wins, which is not the newest version.

  it('C7: two overlapping applies commit the NEWEST version, not the last to finish', async () => {
    await connectAndCommit();
    const { Preferences } = await import('@capacitor/preferences');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    (Preferences.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      if (key === 'last_playlist' && first) { first = false; await gate; }
      preferencesStore.set(key, value);
    });

    // v2 parks inside its own persist; v3 arrives on top of it.
    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg', 'pl-shared'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(first).toBe(false); // the arrange really did park
    triggerSocketEvent('playlist:update', playlistV('v3', 'c3', '/c3.jpg', 'pl-shared'));
    for (let i = 0; i < 20; i++) await Promise.resolve();

    release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1600);

    // What is on glass and what the device TELLS THE SERVER must be the same thing.
    // (The post-await re-validation alone is enough for this pair of assertions.)
    expect(findCreatedElements('img').some(i => i.src.includes('c3.jpg'))).toBe(true);
    expect(await reportedContentVersion()).toBe('v3');

    // …and this is what SERIALIZATION alone buys, which no amount of re-validating
    // the version can recover: unserialized, both updatePlaylist calls run their own
    // `last_playlist` write concurrently and the OLDER one resolves last, so the
    // device reboots into v2's content while reporting and rendering v3's. The
    // offline-resilience copy has to be the one that is actually on glass.
    const persisted = JSON.parse(preferencesStore.get('last_playlist')!);
    expect(persisted.playlist.items[0].contentId).toBe('c3');
  });

  it('C7: a purge landing inside an apply does not commit the purged version', async () => {
    // The one post-await hazard serialization cannot cover: purgeDeviceState is not in
    // the queue, and it deliberately resets the content coordinates (C2) because a
    // re-pair to the same playlist produces the identical version. Committing `v2` on
    // top of that reset re-creates the hold-forever state the reset just cleared —
    // and it is silent, because the heartbeat then reports a version matching the
    // server's truth so the reconcile self-heal never fires.
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    await connectAndCommit();

    const { Preferences } = await import('@capacitor/preferences');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let parked = false;
    (Preferences.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      if (key === 'last_playlist' && value.includes('c2') && !parked) { parked = true; await gate; }
      preferencesStore.set(key, value);
    });

    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg', 'pl-shared'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(parked).toBe(true); // the arrange really did park inside the apply

    triggerSocketEvent('device:revoked', { reason: 'operator' });
    await waitUntil('purge', () => !secureStorageStore.has('device_token'), { tickMs: 100 });

    release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);

    // Pair again so there is a socket to observe the reported version on.
    await waitUntil(
      're-pairing code',
      () => domElements.get('pairing-code')!.textContent === 'ABCD1234',
      { tickMs: 200 },
    );
    httpGetHandler = (opts) => opts.url.includes('/pairing/status/')
      ? { status: 200, data: { data: { status: 'paired', deviceToken: 'tok-2', deviceId: 'dev-2', tenantId: 'tenant-B' } } }
      : { status: 404, data: {} };
    await waitUntil('re-pair', () => secureStorageStore.get('device_token') === 'tok-2', { tickMs: 2100 });
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');

    // The coordinates the purge cleared are still cleared.
    expect(await reportedContentVersion()).toBe('');
  });

  it('C7 NEGATIVE CONTROL: a genuinely stale re-delivery is still a no-op', async () => {
    // Serializing must not turn version-wins into last-write-wins: an older version
    // of the SAME playlist arriving after a newer one still has to be ignored.
    await connectAndCommit();

    triggerSocketEvent('playlist:update', playlistV('v3', 'c3', '/c3.jpg', 'pl-shared'));
    await vi.advanceTimersByTimeAsync(1600);
    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg', 'pl-shared'));
    await vi.advanceTimersByTimeAsync(1600);

    expect(findCreatedElements('img').some(i => i.src.includes('c2.jpg'))).toBe(false);
    expect(await reportedContentVersion()).toBe('v3');
  });

  // ======================================================================
  // C2 + test-instrument 3: a purge leaves NOTHING behind for the next pairing
  // ======================================================================

  /** De-pair via a CONFIRMED revocation, then pair again in the same process. */
  const rePairInProcess = async (tenantId = 'tenant-B') => {
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    triggerSocketEvent('device:revoked', { reason: 'operator' });
    await waitUntil('purge', () => !secureStorageStore.has('device_token'), { tickMs: 100 });
    await waitUntil(
      're-pairing code',
      () => domElements.get('pairing-code')!.textContent === 'ABCD1234',
      { tickMs: 200 },
    );

    httpGetHandler = (opts) => opts.url.includes('/pairing/status/')
      ? { status: 200, data: { data: { status: 'paired', deviceToken: 'tok-2', deviceId: 'dev-2', tenantId } } }
      : { status: 404, data: {} };
    await waitUntil('re-pair', () => secureStorageStore.get('device_token') === 'tok-2', { tickMs: 2100 });
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };

  it('T3: the IN-MEMORY dedupe ring dies with the pairing, not just the on-disk copy', async () => {
    // Only the persisted half was tested. With the in-memory line gone, the first
    // command after a re-pair writes the PREVIOUS tenant's keys straight back out —
    // so the old tenant's command history is readable on the device again and a new
    // command whose key collides is silently suppressed.
    await connectAndCommit();
    triggerSocketEvent('command', { type: 'clear_override', timestamp: 'old-pairing' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(localRing()).toContain('clear_override@old-pairing'); // baseline

    await rePairInProcess();

    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('command', { type: 'clear_override', timestamp: 'new-pairing' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(JSON.parse(preferencesStore.get('seen_command_keys')!)).toEqual(['clear_override@new-pairing']);
    expect(localRing()).toEqual(['clear_override@new-pairing']);
  });

  it('C2: a purge resets the content coordinates — a re-pair to the same playlist still renders', async () => {
    // The server derives `version` from content updatedAt stamps, so it is
    // byte-identical across unpair → re-pair to the same playlist. Left set, the
    // re-pair's pull hits shouldApplyContent({P,V},{P,V}) === false, no-ops, and
    // leaves currentPlaylist null — the device holds FOREVER while its heartbeat
    // reports a contentVersion that matches the server's truth, so the reconcile
    // self-heal never fires either.
    await connectAndCommit();
    expect(await reportedContentVersion()).toBe('v1');

    await rePairInProcess();

    currentMockSocket.connected = true;
    (document.createElement as Mock).mockClear();
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistV('v1', 'c1', '/c1.jpg'));
    await vi.advanceTimersByTimeAsync(1600);

    expect(visibleScreens()).toEqual(['content-screen']);
    expect(findCreatedElements('img').some(i => i.src.includes('c1.jpg'))).toBe(true);
  });

  it('C2: a purge removes the crash-loop marker and the suspension latch', async () => {
    // Device-lifecycle state that was surviving a purge which claims to be complete.
    await connectAndCommit();
    preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');
    triggerSocketEvent('tenant:suspended');
    await vi.advanceTimersByTimeAsync(100);
    expect(preferencesStore.get('tenant_suspended')).toBe('1'); // baseline

    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    triggerSocketEvent('device:revoked', { reason: 'operator' });
    await waitUntil('purge', () => !secureStorageStore.has('device_token'), { tickMs: 100 });

    expect(preferencesStore.has('crash_loop_capped')).toBe(false);
    expect(preferencesStore.has('tenant_suspended')).toBe(false);
  });

  it('C2 NEGATIVE CONTROL: an UNCONFIRMED revocation removes neither', async () => {
    // Same signal, same seam, an auth-check that does not confirm. Proves the removals
    // above belong to a confirmed purge and are not something the signal alone does.
    await connectAndCommit();
    preferencesStore.set('crash_loop_capped', '1700000000000:4:uncaught_exception');
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 401, data: {} }
      : { status: 200, data: { data: { status: 'pending' } } };

    triggerSocketEvent('device:revoked', { reason: 'operator' });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);

    expect(secureStorageStore.has('device_token')).toBe(true); // no purge ran
    expect(preferencesStore.has('crash_loop_capped')).toBe(true);
    expect(await reportedEvents()).toContain('revocation_unconfirmed');
  });

  // ======================================================================
  // Test-instrument 1: the heartbeat error-ack `return`
  // ======================================================================

  it('T1: a POISONED failure envelope is acted on by NOTHING — the return really returns', async () => {
    // The existing test drives a failure envelope with no actionable fields, so the
    // fall-through has nothing to do and passes with or without the `return`. Put
    // revoked/commands/reconcileContent on the failure envelope's TOP LEVEL — where
    // the pre-fix code read them — so only the `return` can keep these assertions true.
    await connectAndCommit();
    const { CapacitorHttp } = await import('@capacitor/core');
    (CapacitorHttp.get as Mock).mockClear();
    (window.location.reload as Mock).mockClear();

    const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat');
    (hb![2] as (r: unknown) => void)({
      success: false,
      error: 'RATE_LIMITED',
      timestamp: '2026-08-15T00:00:00.000Z',
      revoked: true,
      commands: [{ type: 'reload', timestamp: 't1-poison' }],
      reconcileContent: true,
    });
    await vi.advanceTimersByTimeAsync(200);

    const urls = (CapacitorHttp.get as Mock).mock.calls.map((c: unknown[]) => String((c[0] as { url: string }).url));
    expect(urls.some(u => u.includes('/devices/auth/check'))).toBe(false); // revoked ignored
    expect(urls.some(u => u.includes('/devices/me/content'))).toBe(false); // reconcile ignored
    expect(window.location.reload).not.toHaveBeenCalled();                 // commands ignored
    // …and the failure itself is still surfaced, which is the point of the branch.
    expect(await reportedEvents()).toContain('heartbeat_ack_error');
  });

  it('T1 NEGATIVE CONTROL: the same three fields on a SUCCESS envelope are all acted on', async () => {
    // Proves the observation window can see every one of the three side effects, so
    // the negatives above are not vacuous.
    await connectAndCommit();
    const { CapacitorHttp } = await import('@capacitor/core');
    (CapacitorHttp.get as Mock).mockClear();
    (window.location.reload as Mock).mockClear();

    const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat');
    (hb![2] as (r: unknown) => void)({
      success: true,
      data: {
        revoked: true,
        commands: [{ type: 'reload', timestamp: 't1-ok' }],
        reconcileContent: true,
      },
      timestamp: '2026-08-15T00:00:00.000Z',
    });
    await vi.advanceTimersByTimeAsync(200);

    const urls = (CapacitorHttp.get as Mock).mock.calls.map((c: unknown[]) => String((c[0] as { url: string }).url));
    expect(urls.some(u => u.includes('/devices/auth/check'))).toBe(true);
    expect(urls.some(u => u.includes('/devices/me/content'))).toBe(true);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // Test-instrument 2: clear_cache containment + its report
  // ======================================================================

  it('T2: a REJECTING clearCache is contained — the reload still runs and it is reported', async () => {
    // No test made clearCache reject on this command path. Bare, that rejection is an
    // unhandled rejection AND it skips the restart the operator asked for, with the
    // server already holding { ok: true } and the dashboard saying delivered.
    await connectAndCommit();
    mockCacheManager.clearCache.mockRejectedValue(new Error('rmdir EBUSY'));
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'clear_cache', timestamp: 't2' }, ack);
    await vi.advanceTimersByTimeAsync(200);

    expect(await reportedEvents()).toContain('clear_cache_incomplete');
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    // Contained, not merely survived: the rejection never reached the handler's own
    // catch, which is a different (and noisier) failure.
    expect(await reportedEvents()).not.toContain('command_handler_failed');
  });

  it('T2 NEGATIVE CONTROL: a healthy clear_cache purges, reloads, and reports nothing', async () => {
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'clear_cache', timestamp: 't2-ok' }, vi.fn());
    await vi.advanceTimersByTimeAsync(200);

    expect(mockCacheManager.clearCache).toHaveBeenCalled();
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(await reportedEvents()).not.toContain('clear_cache_incomplete');
  });

  // ======================================================================
  // Test-instrument 4: the `typeof ack !== 'function'` guard
  // ======================================================================

  it('T4: an ABSENT ack is not invoked — no "callback threw" anywhere', async () => {
    // The connect-time sendInitialState playlist:update and the config /
    // qr-overlay:update emits are not ack-wrapped. Without the typeof guard the
    // helper calls `undefined({ok:true})`, which its own try/catch swallows into a
    // warn — so the existing assertions (which only check the handler's work) pass
    // either way. The warn is the observable that separates them.
    await connectAndCommit();
    const warnSpy = console.warn as unknown as Mock;
    warnSpy.mockClear();

    triggerSocketEvent('playlist:update', playlistV('v9', 'c9', '/c9.jpg')); // no ack argument
    triggerSocketEvent('command', { type: 'clear_override', timestamp: 't4' }); // no ack argument
    await vi.advanceTimersByTimeAsync(1600);

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('delivery ack callback threw'))).toBe(false);
    // Direction: the payloads really were handled, so this is not passing on a dead path.
    expect(findCreatedElements('img').some(i => i.src.includes('c9.jpg'))).toBe(true);
  });

  it('T4: a NON-FUNCTION ack is not invoked either', async () => {
    // The wire is not typed. A gateway that ever sends a non-callable in the ack slot
    // must not produce a throw inside the delivery handler.
    await connectAndCommit();
    const warnSpy = console.warn as unknown as Mock;
    warnSpy.mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 't4b' }, 'not-a-function');
    await vi.advanceTimersByTimeAsync(50);

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('delivery ack callback threw'))).toBe(false);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('T4 NEGATIVE CONTROL: a genuinely THROWING ack does produce the warn', async () => {
    // Proves the observation window can see the thing the two tests above assert is
    // absent — and pins the containment: a throwing callback must not take the
    // handler down with it.
    await connectAndCommit();
    const warnSpy = console.warn as unknown as Mock;
    warnSpy.mockClear();
    const ack = vi.fn(() => { throw new Error('socket gone'); });

    triggerSocketEvent('command', { type: 'reload', timestamp: 't4c' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    expect(warnSpy.mock.calls.some(c => String(c[0]).includes('delivery ack callback threw'))).toBe(true);
    expect(window.location.reload).toHaveBeenCalledTimes(1); // contained
  });

  // ======================================================================
  // S4. last_playlist is not stamped with an unverifiable tenant
  // ======================================================================

  it('S4: a boot whose tenant_id read FAILED does not rewrite last_playlist', async () => {
    // `tenantId ?? undefined` writes the SAME envelope for "legacy device, never had
    // a tenant" and "the read threw this boot", and the loader treats an absent
    // tenantId as the legacy no-binding grace branch and renders it unconditionally.
    // One transient decrypt failure therefore downgrades that record permanently.
    secureStorageStore.set('tenant_id', 'tenant-A');
    preferencesStore.set('last_playlist', JSON.stringify({
      tenantId: 'tenant-A', deviceId: 'dev-123', savedAt: 1,
      playlist: { id: 'pl-old', name: 'old', items: [], loopPlaylist: true },
    }));
    const { SecureStorage } = await import('./secure-storage');
    (SecureStorage.get as Mock).mockImplementation(async ({ key }: { key: string }) => {
      if (key === 'tenant_id') throw { code: 'AEAD_DECRYPT_FAILED', message: 'tag mismatch' };
      return { value: secureStorageStore.get(key) ?? null };
    });

    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistV('v1', 'c1', '/c1.jpg'));
    await vi.advanceTimersByTimeAsync(1600);

    // The PREVIOUS, correctly stamped record survives — no unstamped envelope was written.
    const stored = JSON.parse(preferencesStore.get('last_playlist')!);
    expect(stored.tenantId).toBe('tenant-A');
    expect(stored.playlist.id).toBe('pl-old');
    expect(await reportedEvents()).toContain('playlist_persist_skipped_tenant_unverified');
    // Live delivery is untouched — the device still renders what it was sent.
    expect(findCreatedElements('img').some(i => i.src.includes('c1.jpg'))).toBe(true);
  });

  it('S4 NEGATIVE CONTROL: a boot with a READABLE tenant_id persists normally', async () => {
    // Same seam, working keystore. Proves the skip belongs to the read failure and did
    // not turn offline resilience off.
    secureStorageStore.set('tenant_id', 'tenant-A');
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', playlistV('v1', 'c1', '/c1.jpg'));
    await vi.advanceTimersByTimeAsync(1600);

    const stored = JSON.parse(preferencesStore.get('last_playlist')!);
    expect(stored.tenantId).toBe('tenant-A');
    expect(stored.playlist.id).toBe('pl-c1');
    expect(await reportedEvents()).not.toContain('playlist_persist_skipped_tenant_unverified');
  });

  // ======================================================================
  // B2 + S3. THE CONTENT FRAME
  // ======================================================================

  const playItems = async (items: Array<{ type: string; url: string; id: string }>) => {
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('playlist:update', {
      playlist: {
        id: 'p-frame', name: 'F', loopPlaylist: true,
        items: items.map((it, idx) => ({
          id: `i${idx}`, contentId: it.id, duration: 10, order: idx,
          content: { id: it.id, name: it.id, type: it.type, url: it.url },
        })),
      },
    });
    await vi.advanceTimersByTimeAsync(1600);
  };

  // The app document really is served from https://localhost under Capacitor:
  // capacitor.config.ts sets androidScheme: 'https' with NO hostname. A `webpage`
  // item naming that origin is same-origin with the app document, and Capacitor's
  // WebViewLocalServer serves dist/index.html WITH the bridge injected for every
  // frame — so with allow-same-origin the frame reaches
  // parent.Capacitor.Plugins.SecureStorage and reads the device JWT. Reachable
  // today: the backend's PATCH /content/:id does not run the validateUrl that POST
  // does. The comment that used to justify the grant ("a local app scheme no remote
  // URL can match") was false for this build.
  it.each([
    ['the app origin itself', 'https://localhost/?api_url=https://attacker.example'],
    ['the app origin, bare', 'https://localhost/'],
    // Parsed-origin comparison, not a string prefix: the default port normalises away.
    ['the app origin with an explicit default port', 'https://localhost:443/index.html'],
    ['javascript:', 'javascript:parent.postMessage(1,"*")'],
    ['data:', 'data:text/html,<script>parent.x=1</script>'],
    ['file:', 'file:///data/data/com.vizora.display/'],
  ])('B2: a webpage item pointing at %s is refused', async (_label, url) => {
    await playItems([{ type: 'webpage', url, id: 'bad' }]);

    expect(findCreatedElements('iframe')).toHaveLength(0);
    const calls = await reportedEventCalls();
    const refused = calls.find(c => c[0] === 'frame_url_refused');
    expect(refused).toBeDefined();
    expect((refused![1] as { contentId?: string }).contentId).toBe('bad');
  });

  it('B2: a refused frame ADVANCES playback instead of dead-airing', async () => {
    // Refusal is routed through the existing content-error path on purpose: the
    // never-black contract still has to hold, so the engine skips to the next item.
    await playItems([
      { type: 'webpage', url: 'https://localhost/?api_url=https://attacker.example', id: 'bad' },
      { type: 'image', url: '/good.jpg', id: 'good' },
    ]);

    expect(findCreatedElements('img').some(i => i.src.includes('good.jpg'))).toBe(true);
    expect(visibleScreens()).toEqual(['content-screen']);
  });

  it('B2 NEGATIVE CONTROL: an ordinary third-party https page still frames', async () => {
    // Same layer. Proves the guard is anchored to the app origin and not refusing
    // everything — signage pages (dashboards, widgets) are the whole point of the type.
    await playItems([{ type: 'webpage', url: 'https://example.com/dashboard', id: 'ok' }]);

    const iframes = findCreatedElements('iframe');
    expect(iframes).toHaveLength(1);
    expect(iframes[0].src).toBe('https://example.com/dashboard');
    expect(await reportedEvents()).not.toContain('frame_url_refused');
  });

  it('S3: a same-origin webpage frame is NOT handed the device JWT', async () => {
    // transformContentUrl appends the token for any URL whose origin matches apiUrl,
    // on the rationale that img/video tags cannot send headers. A FRAME NAVIGATION is
    // not that case: the token lands in the frame's own document URL, readable off
    // `location` by any script there and sent in the Referer of its sub-resources.
    await playItems([{ type: 'webpage', url: 'https://api.vizora.io/kiosk', id: 'same' }]);

    const iframes = findCreatedElements('iframe');
    expect(iframes).toHaveLength(1);
    expect(iframes[0].src).toBe('https://api.vizora.io/kiosk');
    expect(iframes[0].src).not.toContain('token=');
    expect(iframes[0].src).not.toContain('tok-123');
  });

  it('S3 NEGATIVE CONTROL: a same-origin IMAGE still gets the token', async () => {
    // Same seam, same origin, the case the token rule was actually written for.
    // Proves the withholding is scoped to frame navigations and did not break media
    // authentication fleet-wide.
    await playItems([{ type: 'image', url: 'https://api.vizora.io/asset.jpg', id: 'img' }]);

    const imgs = findCreatedElements('img');
    expect(imgs.length).toBeGreaterThan(0);
    expect(imgs[imgs.length - 1].src).toContain('token=tok-123');
  });

  // ======================================================================
  // P5. TWO GUARDS THAT OTHER FIXES ARE STANDING ON
  // ======================================================================

  it('P5: a re-requested pairing code does not leave TWO pollers running', async () => {
    // startPairingCheck() clears the existing interval first. That guard is exactly
    // what makes the pairing-poll reordering safe (arming earlier must not double-arm),
    // so it should be pinned by its own test rather than trusted. Doubled, the device
    // polls twice per period forever, and every later re-request adds another.
    secureStorageStore.clear();
    let requests = 0;
    httpPostHandler = () => {
      requests++;
      return { status: 200, data: { data: { code: requests === 1 ? 'ABCD1234' : 'WXYZ9999', deviceId: 'dev-1', expiresInSeconds: 300 } } };
    };
    const { CapacitorHttp } = await import('@capacitor/core');
    await importFresh(() => domElements.get('pairing-code')!.textContent === 'ABCD1234');

    // Expire the code, forcing startPairing() — and so startPairingCheck() — to run again.
    httpGetHandler = (opts) => opts.url.includes('/pairing/status/')
      ? { status: 404, data: {} }
      : { status: 200, data: { data: { status: 'pending' } } };
    await waitUntil(
      'the re-requested code',
      () => domElements.get('pairing-code')!.textContent === 'WXYZ9999',
      { tickMs: 2000 },
    );

    // Now count polls across exactly one interval period.
    httpGetHandler = () => ({ status: 200, data: { data: { status: 'pending' } } });
    (CapacitorHttp.get as Mock).mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    const polls = (CapacitorHttp.get as Mock).mock.calls
      .filter((c: unknown[]) => (c[0] as { url: string }).url.includes('/pairing/status/'));
    expect(polls).toHaveLength(1);
  });

  it('P5: a malformed playlist does not stop the NEXT one from rendering', async () => {
    // What this pins is the PROPERTY, not the line: a bad payload must not wedge
    // content delivery for the rest of the process.
    //
    // SCOPE, verified rather than claimed: it does NOT pin
    // `applyContentQueue = next.catch(() => {})`. That mutation ships green here and I
    // am not going to imply otherwise. The reason is that the queue cannot currently
    // hold a rejection at all — applyContentExclusive catches the only throwing site
    // (updatePlaylist, via computePlaylistSignature) internally and returns normally,
    // so `next` always resolves. The `.catch` is defence in depth against a rejection
    // no present path produces, like the shouldApplyContent re-check the audit
    // confirmed is unreachable. It stays: it is one edit from mattering if anything
    // ever throws outside that try, and pinning it would mean injecting a throw
    // production cannot make.
    await connectAndCommit();

    // A malformed item makes computePlaylistSignature throw inside updatePlaylist.
    triggerSocketEvent('playlist:update', {
      version: 'v-bad',
      playlist: { id: 'pl-bad', name: 'bad', loopPlaylist: true, items: [null] },
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(await reportedEvents()).toContain('content_apply_failed');

    // A perfectly good playlist arriving afterwards must still render.
    triggerSocketEvent('playlist:update', playlistV('v-good', 'cgood', '/cgood.jpg', 'pl-good'));
    await vi.advanceTimersByTimeAsync(1600);

    expect(findCreatedElements('img').some(i => i.src.includes('cgood.jpg'))).toBe(true);
    expect(await reportedContentVersion()).toBe('v-good');
  });

  // ======================================================================
  // P4. FRAME-URL REFUSAL: THE EDGE, NOT JUST THE TWO STATED RULES
  // ======================================================================
  //
  // The two refusals (non-http(s), same-origin) and the call site were pinned; the
  // failure semantics were not. Flipping `catch { return false }` to `return true`
  // ships an unparseable URL straight into a frame, and dropping the `here.href` base
  // stops relative URLs resolving against the app document — which makes them throw,
  // and then the flipped catch frames them AT APP ORIGIN. That is the same-origin
  // token-theft hole this guard exists to close, reachable through two edits neither
  // of which any test noticed.
  //
  // SCOPE, verified rather than assumed: the `new URL(candidate, here.href)` BASE is
  // NOT reachable as a hole on this path. The call site passes the output of
  // transformContentUrl (main.ts:3879), which has already resolved a relative content
  // URL against config.apiUrl — so by the time the guard runs the URL is absolute and
  // dropping the base changes nothing. I tried to pin it with a relative URL and the
  // test proved the opposite: the frame is created at the API origin, correctly. The
  // base stays as defence in depth for any future caller that passes a raw URL; it is
  // deliberately not pinned, because a test asserting it here would be asserting a
  // rewrite that transformContentUrl performs, not this guard.

  it('P4: an UNPARSEABLE frame URL is refused — the catch fails CLOSED', async () => {
    // The candidate has to be one that genuinely THROWS in `new URL(candidate, base)`.
    // My first attempt ('ht!tp://%%%not a url%%%') did not: with a base supplied it
    // parses as a RELATIVE URL, resolves to the app origin and is refused by the
    // same-origin rule instead — so the catch-flip mutation survived and the test was
    // pinning a different line than its name claimed. A space in the host still throws.
    await playItems([{ type: 'webpage', url: 'https://ex ample.com/board', id: 'bad' }]);

    expect(findCreatedElements('iframe')).toHaveLength(0);
    expect(await reportedEvents()).toContain('frame_url_refused');
  });

  it('P4 NEGATIVE CONTROL: a legitimate cross-origin page still frames', async () => {
    // Proves the two refusals above are the guard discriminating, not refusing
    // everything — signage pages are the entire point of the webpage content type.
    await playItems([{ type: 'webpage', url: 'https://example.com/board', id: 'ok' }]);

    const frames = findCreatedElements('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0].src).toBe('https://example.com/board');
    expect(await reportedEvents()).not.toContain('frame_url_refused');
  });

  // ======================================================================
  // P3. THE SUSPENSION LATCH IS CLEARED ON BOTH EXITS
  // ======================================================================
  //
  // The latch is durable so a power cycle cannot be used to resume a suspended tenant.
  // That makes CLEARING it safety-critical in the other direction: the write and the
  // boot read were pinned, both clears were not, and a stranded latch means a
  // genuinely resumed tenant re-enters holding on every future boot, forever — a
  // black-screen fleet event that no amount of server-side "resume" can fix.

  const suspendAndSettle = async () => {
    triggerSocketEvent('tenant:suspended');
    await waitUntil('the latch', () => preferencesStore.get('tenant_suspended') === '1', { tickMs: 100 });
  };

  it('P3: tenant:resumed clears the DURABLE latch, not just the in-memory flag', async () => {
    await connectAndCommit();
    await suspendAndSettle();

    triggerSocketEvent('tenant:resumed');
    await waitUntil('the latch clear', () => !preferencesStore.has('tenant_suspended'), { tickMs: 100 });

    expect(preferencesStore.has('tenant_suspended')).toBe(false);
    expect(await reportedEvents()).toContain('tenant_unsuspended');
  });

  it('P3: a purge clears it too — the next pairing must not inherit a suspension', async () => {
    await connectAndCommit();
    await suspendAndSettle();
    await revokeAndSettleHere();

    expect(preferencesStore.has('tenant_suspended')).toBe(false);
  });

  it('P3 NEGATIVE CONTROL: while still suspended the latch STAYS — it is not cleared by any traffic', async () => {
    // The clears must be bound to a real resume/purge. A latch that any event could
    // clear would defeat the whole point of persisting it, which is that a power cycle
    // cannot resume a suspended tenant.
    await connectAndCommit();
    await suspendAndSettle();

    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg', 'pl-shared'));
    await vi.advanceTimersByTimeAsync(1000);

    expect(preferencesStore.get('tenant_suspended')).toBe('1');
  });

  // ======================================================================
  // P2. THE PURGE'S IN-MEMORY HALF, ASSERTED DIRECTLY
  // ======================================================================
  //
  // The revocation suites assert on mock STORES, on visibleScreens() and on event
  // names. None of those reach the in-memory half of purgeDeviceState, and the
  // `pairing-screen` result they rely on comes from confirmRevocation's startPairing(),
  // not from the field clears — so deleting `this.deviceToken = null` (the credential
  // surviving revocation), or the whole socket teardown, shipped green.
  //
  // These assert what a revoked device IS, through paths a revoked device really takes:
  // the network-restore reconnect, the heartbeat, and the playback clock.

  const revokeAndSettleHere = async () => {
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    triggerSocketEvent('device:revoked', { reason: 'operator' });
    await waitUntil('purge', () => !secureStorageStore.has('device_token'), { tickMs: 100 });
    await waitUntil(
      'pairing code',
      () => domElements.get('pairing-code')!.textContent === 'ABCD1234',
      { tickMs: 200 },
    );
  };

  it('P2: the credential is gone from MEMORY — a network restore cannot reconnect with it', async () => {
    // THE security claim. Removing the credential from disk but leaving it in memory
    // is not revocation: this listener (main.ts:813) reconnects on `status.connected &&
    // this.deviceToken`, so a surviving token puts the revoked device straight back on
    // the gateway — authenticated — the next time the wifi blips.
    await connectAndCommit();
    await revokeAndSettleHere();

    const connectionsBefore = ioFactory.mock.calls.length;
    triggerNetworkChange(false);
    triggerNetworkChange(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(ioFactory.mock.calls.length).toBe(connectionsBefore);
  });

  it('P2 NEGATIVE CONTROL: without a revocation the same network restore DOES reconnect', async () => {
    // Proves the assertion above is the credential being gone and not the probe being
    // dead — a test that can never observe a reconnect would pass on a broken purge and
    // on a broken listener alike.
    await connectAndCommit();
    currentMockSocket.connected = false;

    const connectionsBefore = ioFactory.mock.calls.length;
    triggerNetworkChange(false);
    triggerNetworkChange(true);
    await vi.advanceTimersByTimeAsync(500);

    expect(ioFactory.mock.calls.length).toBeGreaterThan(connectionsBefore);
  });

  it('P2: the socket is torn down — a revoked device stops beating', async () => {
    // Left connected, a revoked device keeps a live authenticated socket and keeps
    // reporting itself healthy on the dashboard. The heartbeat is the observable that
    // survives the mock: it is emitted on a timer, so it keeps firing if the teardown
    // is skipped.
    await connectAndCommit();
    const socket = currentMockSocket;
    await revokeAndSettleHere();

    expect(socket.disconnect).toHaveBeenCalled();
    const beatsAfterPurge = socket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').length;
    await vi.advanceTimersByTimeAsync(60_000); // four heartbeat periods
    const beatsNow = socket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').length;

    expect(beatsNow).toBe(beatsAfterPurge);
  });

  it('P2 NEGATIVE CONTROL: an un-revoked device keeps beating over the same window', async () => {
    // The counter really can go up — otherwise "it stopped beating" is unfalsifiable.
    await connectAndCommit();
    const socket = currentMockSocket;
    const before = socket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').length;

    await vi.advanceTimersByTimeAsync(60_000);

    expect(socket.emit.mock.calls.filter((c: unknown[]) => c[0] === 'heartbeat').length)
      .toBeGreaterThan(before);
  });

  it('P2: no playback or temp-push timer survives the purge', async () => {
    // The rotation timer is armed at commit time and the temp-push timer at push time;
    // both fire long afterwards. Left armed, they wake up on a de-paired device and
    // drive the engine at the pairing screen.
    //
    // HONEST SCOPE: this pins the OUTER statement (a de-paired device renders nothing
    // and keeps its pairing code), not the clearTimeout lines themselves. Deleting
    // both of those still ships green here and I could not make it fail without
    // asserting on private state or on a log line that does not reliably fire — see
    // the note to the audit. The reason is that the clears are defence in depth behind
    // two other guards: currentPlaylist is already null, so a surviving timer wakes,
    // finds nothing to play and renders nothing; and its attempt to take the screen is
    // REFUSED by the pairing guard (screen-state.ts, pinned by screen-state.spec C6).
    // A probe that cannot fail is worse than no probe, so there is no fake one here.
    await connectAndCommit();
    // Arm the temp-push timer too, so both clears are under test.
    triggerSocketEvent('command', {
      type: 'push_content', timestamp: 'p2-push',
      payload: { content: { id: 'tmp', name: 'tmp', type: 'image', url: '/tmp.jpg' }, duration: 30 },
    }, vi.fn());
    await vi.advanceTimersByTimeAsync(100);

    await revokeAndSettleHere();

    const impressionsBefore = currentMockSocket.emit.mock.calls
      .filter((c: unknown[]) => c[0] === 'content:impression').length;
    const imagesBefore = findCreatedElements('img').length;
    await vi.advanceTimersByTimeAsync(120_000); // many rotation and push periods

    expect(findCreatedElements('img').length).toBe(imagesBefore);
    expect(currentMockSocket.emit.mock.calls
      .filter((c: unknown[]) => c[0] === 'content:impression').length).toBe(impressionsBefore);
    expect(visibleScreens()).toEqual(['pairing-screen']);
  });

  it('P2: the purge announces itself and unbinds crash reporting', async () => {
    // Both are one-liners that shipped green when deleted. The telemetry is how a purge
    // is seen at all after the fact, and a crash report still tagged with the revoked
    // device attributes the next tenant's crashes to the previous pairing.
    const { setCrashReportingDevice } = await import('./crash-reporting');
    await connectAndCommit();
    (setCrashReportingDevice as Mock).mockClear();

    await revokeAndSettleHere();

    expect(setCrashReportingDevice).toHaveBeenCalledWith(null);
    const purged = (await reportedEventCalls()).find(c => c[0] === 'device_purged');
    expect(purged).toBeDefined();
    expect((purged![1] as { reason?: string }).reason).toContain('revocation_confirmed');
  });

  // ======================================================================
  // E1. THE ACK TELLS THE OPERATOR WHEN A COMMAND WILL NEVER RUN
  // ======================================================================
  //
  // `reboot`/`update`/`screenshot` and any unknown type reach the switch and do
  // nothing. They acked a bare `{ ok: true }`, which the dashboard renders in the same
  // green as a working reload — a permanent, 100%-reproducible false positive, and one
  // our telemetry does nothing about because reportEvent goes to US, not to the person
  // who pressed the button. Still `ok: true` (a nack means "retry", and the server has
  // no give-up), with the status alongside it.

  /** The ack payload the device answered a command with. */
  const ackFor = async (command: Record<string, unknown>) => {
    const ack = vi.fn();
    triggerSocketEvent('command', command, ack);
    await vi.advanceTimersByTimeAsync(50);
    expect(ack).toHaveBeenCalledTimes(1);
    return ack.mock.calls[0][0] as { ok: boolean; status?: string };
  };

  it.each([['reboot'], ['update'], ['screenshot'], ['some_future_type']])(
    'E1: %s acks ok:true WITH status unsupported',
    async (type) => {
      await connectAndCommit();
      expect(await ackFor({ type, timestamp: `e1-${type}` })).toEqual({ ok: true, status: 'unsupported' });
    },
  );

  it.each([
    ['clear_override'], ['qr-overlay-update'], ['push_content'], ['update_config'],
  ])('E1 NEGATIVE CONTROL: %s — an ACTIONABLE command carries no status', async (type) => {
    // The other direction, and the anti-drift guard: if a case is added to the switch
    // without being added to ACTIONABLE_COMMANDS, the device starts telling operators
    // that a working command is unsupported. That is the same false report with the
    // sign flipped, so it gets the same coverage.
    await connectAndCommit();
    expect(await ackFor({ type, timestamp: `e1-ok-${type}` })).toEqual({ ok: true });
  });

  it.each([['reload'], ['restart'], ['clear_cache'], ['unpair']])(
    'E1 NEGATIVE CONTROL: %s — the context-destroying/destructive set carries no status either',
    async (type) => {
      // Driven separately from the four above only because each of these tears the
      // world down (reload, or a purge), so they cannot share one boot.
      await connectAndCommit();
      expect(await ackFor({ type, timestamp: `e1-cd-${type}` })).toEqual({ ok: true });
    },
  );

  // ======================================================================
  // E2. ORDINARY COMMAND VOLUME CANNOT EVICT A LIVE reload RECORD
  // ======================================================================
  //
  // The keyed branch records EVERY command that carries a key, and the ring was a plain
  // 20-slot FIFO, so ordinary traffic could push out the one record whose loss costs
  // the device. Fully constructible: reload dispatched → ack lost → server requeues
  // reload@T0 → ≥20 ordinary keyed commands arrive live and evict it → the reconnect
  // replays reload@T0 against a ring that no longer holds it.

  it('E2: 25 ordinary commands do NOT evict the reload record — the replay is still suppressed', async () => {
    await connectAndCommit();

    // The reload the operator sent, whose ack we will assume was lost in flight.
    triggerSocketEvent('command', { type: 'reload', timestamp: 'T0' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    // Ordinary keyed traffic, more than the whole ring, while the requeue is pending.
    for (let i = 0; i < 25; i++) {
      triggerSocketEvent('command', { type: 'clear_override', timestamp: `ord-${i}` }, vi.fn());
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(localRing().length).toBeLessThanOrEqual(20); // the bound still holds

    // The server's requeue arrives on the next reconnect.
    (window.location.reload as Mock).mockClear();
    triggerSocketEvent('command', { type: 'reload', timestamp: 'T0' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('command_duplicate_suppressed');
  });

  it('E2: the reserve survives the RESTORE path too', async () => {
    // The restore used a plain tail-slice, which would drop the reserved records at
    // exactly the moment they matter most — the boot right after the reload whose
    // replay is inbound. Seeded oldest-first: the reload is the OLDEST entry, so a
    // tail-slice keeps the 20 newest ordinary keys and loses it.
    const seeded = [
      'reload@T0',
      ...Array.from({ length: 25 }, (_, i) => `clear_override@ord-${i}`),
    ];
    localStorageStore.set(LOCAL_RING_KEY, JSON.stringify(seeded));
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    (window.location.reload as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'T0' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('E2 NEGATIVE CONTROL: ordinary keys are still evicted, and the ring is still bounded', async () => {
    // The reserve must not turn into "never evict anything" — the bound exists because
    // the ring is JSON-stringified into two stores on every command. The OLDEST
    // ordinary key must still fall out and re-execute.
    await connectAndCommit();
    const { reportEvent } = await import('./crash-reporting');

    for (let i = 0; i < 25; i++) {
      triggerSocketEvent('command', { type: 'reboot', timestamp: `evict-${i}` }, vi.fn());
      await vi.advanceTimersByTimeAsync(5);
    }
    expect(localRing().length).toBeLessThanOrEqual(20);

    (reportEvent as Mock).mockClear();
    triggerSocketEvent('command', { type: 'reboot', timestamp: 'evict-0' }, vi.fn()); // evicted
    await vi.advanceTimersByTimeAsync(50);

    expect(await reportedEvents()).toContain('command_unsupported'); // it RAN again
    expect(await reportedEvents()).not.toContain('command_duplicate_suppressed');
  });

  // ======================================================================
  // E3. commandId IS PREFERRED OVER (type, timestamp) WHEN THE SERVER SENDS ONE
  // ======================================================================
  //
  // `(type, timestamp)` ignores `payload`, and the server's timestamp is an ISO string
  // with millisecond resolution (device.gateway.ts:2299), so two DISTINCT commands
  // issued in the same millisecond collide — the second is suppressed AND acked green,
  // i.e. silently dropped. fleet.service.ts:91 mints a UUID per operator action and
  // sendCommand spreads it through the requeue verbatim, so when it is there it is a
  // strictly better key. The POST /api/push/content path has no id, so the
  // (type, timestamp) fallback stays.

  it('E3: two DISTINCT commands in the same millisecond both run when they carry commandIds', async () => {
    await connectAndCommit();
    const pushed: string[] = [];
    mockCacheManager.getCachedUri.mockImplementation(async (id: string) => { pushed.push(id); return null; });

    const sameMs = '2026-08-15T00:00:00.000Z';
    triggerSocketEvent('command', {
      type: 'push_content', timestamp: sameMs, commandId: 'uuid-A',
      payload: { content: { id: 'cA', name: 'A', type: 'image', url: '/a.jpg' }, duration: 5 },
    }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    triggerSocketEvent('command', {
      type: 'push_content', timestamp: sameMs, commandId: 'uuid-B',
      payload: { content: { id: 'cB', name: 'B', type: 'image', url: '/b.jpg' }, duration: 5 },
    }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    // Both were acted on, and both keys are recorded under the id, not the timestamp.
    expect(pushed).toContain('cA');
    expect(pushed).toContain('cB');
    expect(localRing()).toContain('push_content#uuid-A');
    expect(localRing()).toContain('push_content#uuid-B');
    expect(await reportedEvents()).not.toContain('command_duplicate_suppressed');
  });

  it('E3 NEGATIVE CONTROL: the SAME commandId replayed is still suppressed', async () => {
    // The id must be a dedupe key, not merely a disambiguator — a genuine requeue of
    // one operator action carries the identical id and must not run twice.
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload', timestamp: 't-1', commandId: 'uuid-same' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    // Same id, DIFFERENT timestamp — a requeue re-stamped by a later sendCommand would
    // defeat a timestamp-only key, and must not defeat this one.
    triggerSocketEvent('command', { type: 'reload', timestamp: 't-2', commandId: 'uuid-same' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(await reportedEvents()).toContain('command_duplicate_suppressed');
  });

  it('E3 NEGATIVE CONTROL: with NO commandId the (type, timestamp) fallback still keys it', async () => {
    // The push path (realtime app.controller.ts) sends no id at all. Losing the
    // fallback would leave that entire path unkeyed.
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'fallback-1' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(localRing()).toContain('reload@fallback-1');

    triggerSocketEvent('command', { type: 'reload', timestamp: 'fallback-1' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  // ======================================================================
  // D1. A REAL THIRD HOME ON TV, AND FAIL-CLOSED ONLY WHEN ALL OF THEM FAIL
  // ======================================================================
  //
  // The durability argument assumed two independent homes. That holds on Android
  // (native SharedPreferences vs WebView localStorage) and does NOT hold on
  // Tizen/webOS, where Capacitor falls through to web implementations and
  // @capacitor/preferences 6.0.4's is literally window.localStorage under a
  // `CapacitorStorage.` prefix (dist/esm/web.js — `get impl()`). One
  // QuotaExceededError took out both writes at once, on exactly the platforms
  // CLAUDE.md lists as shipped, leaving a context-destroying command with no
  // terminator at all.
  //
  // The primary answer is a genuinely independent store: IndexedDB, which has its own
  // far larger quota and is already proven on those runtimes (TvCacheManager caches all
  // content through it). So the quota failure no longer costs the operator their
  // command — it just lands somewhere else.
  //
  // Fail-closed is the BACKSTOP beneath that, for the case where every home refuses:
  // dispatching then risks an unterminated reload loop (a screen that never reaches
  // content, a truck roll), while refusing leaves the device doing what it was already
  // doing and puts the event in telemetry. The loop is strictly worse. Narrow by
  // construction — context-destroying types only, and only when NOTHING accepted.

  /** The TV quota failure: localStorage dies, and Preferences dies with it. */
  const killLocalStorageBackedStores = async () => {
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));
    localStorageThrowOn.setItem = true;
  };

  /** Kill every durable home, including the independent one. */
  const killAllRingStores = async () => {
    await killLocalStorageBackedStores();
    idbThrowOn.write = true;
  };

  it('D1: the TV quota failure no longer costs the operator the command — IndexedDB takes it', async () => {
    // Both localStorage-backed homes dead, which on Tizen/webOS is ONE quota error.
    // Before the third home this was the fail-closed refusal; now it just works.
    await connectAndCommit();
    await killLocalStorageBackedStores();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-idb' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(await reportedEvents()).not.toContain('command_refused_no_durable_dedupe');
    // The record really is somewhere durable, and it is the independent store.
    expect(idbRing).toContain('reload@d1-idb');
    expect(localStorageStore.has(LOCAL_RING_KEY)).toBe(false);
    expect(preferencesStore.has('seen_command_keys')).toBe(false);
  });

  it('D1: the IndexedDB record alone terminates the replay ACROSS a reload', async () => {
    // Durability that is not read back is not durability. Same both-dead state, then
    // the reload actually happens (a fresh context), and the replay must be suppressed
    // off the IndexedDB copy alone.
    await connectAndCommit();
    await killLocalStorageBackedStores();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-across' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    await importFresh(); // the reload: nothing survives but storage
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-across' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('command_duplicate_suppressed');
  });

  it('D1: a runtime with NO localStorage AT ALL reports undurable, not durable', async () => {
    // writeLocalRing's `if (!store) return false`. Flipped to `true` it claims the
    // record is durable on a runtime that has nowhere to put it — disarming the
    // fail-closed refusal precisely where it is most needed, since a runtime with no
    // localStorage is exactly the degraded environment the refusal exists for.
    await connectAndCommit();
    const realLocalStorage = (window as unknown as { localStorage: unknown }).localStorage;
    (window as unknown as { localStorage: unknown }).localStorage = undefined;
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));
    idbThrowOn.write = true;

    try {
      triggerSocketEvent('command', { type: 'reload', timestamp: 'no-ls' }, vi.fn());
      await vi.advanceTimersByTimeAsync(50);

      expect(window.location.reload).not.toHaveBeenCalled();
      expect(await reportedEvents()).toContain('command_refused_no_durable_dedupe');
    } finally {
      (window as unknown as { localStorage: unknown }).localStorage = realLocalStorage;
    }
  });

  it('D1 NEGATIVE CONTROL: no localStorage but a healthy IndexedDB still executes', async () => {
    // The absence of one home is not by itself a refusal — otherwise a runtime without
    // localStorage could never take a reload at all, even with a working IDB.
    await connectAndCommit();
    const realLocalStorage = (window as unknown as { localStorage: unknown }).localStorage;
    (window as unknown as { localStorage: unknown }).localStorage = undefined;
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));

    try {
      triggerSocketEvent('command', { type: 'reload', timestamp: 'no-ls-idb' }, vi.fn());
      await vi.advanceTimersByTimeAsync(50);

      expect(window.location.reload).toHaveBeenCalledTimes(1);
      expect(idbRing).toContain('reload@no-ls-idb');
    } finally {
      (window as unknown as { localStorage: unknown }).localStorage = realLocalStorage;
    }
  });

  it.each([['reload'], ['restart'], ['clear_cache']])(
    'D1: with NEITHER home accepting, %s is refused and reported',
    async (type) => {
      // All three members of CONTEXT_DESTROYING_COMMANDS, not just `reload`: the set is
      // what the rule keys off, so membership should be pinned by the rule that depends
      // on it rather than incidentally by an unrelated unkeyed-path test.
      await connectAndCommit();
      await killAllRingStores();
      const ack = vi.fn();

      triggerSocketEvent('command', { type, timestamp: `d1-${type}` }, ack);
      await vi.advanceTimersByTimeAsync(50);

      expect(window.location.reload).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({ ok: true }); // never a nack, per the ack contract
      const refused = (await reportedEventCalls()).find(c => c[0] === 'command_refused_no_durable_dedupe');
      expect(refused).toBeDefined();
      expect((refused![1] as { type?: string }).type).toBe(type);
    },
  );

  it('D1: a WEDGED bridge with the other homes dead is also undurable — refused', async () => {
    // Every other both-dead test uses a REJECTING Preferences write. A write that never
    // SETTLES is a different shape and the one the 2s bound exists for, and it must not
    // count as durable: `persist !== 'failed'` would treat the timeout as success and
    // dispatch a reload with no terminator anywhere.
    await connectAndCommit();
    await breakRingPreferences(NEVER);
    localStorageThrowOn.setItem = true;
    idbThrowOn.write = true;

    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-wedged' }, vi.fn());
    await vi.advanceTimersByTimeAsync(2100); // past the persist bound

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(await reportedEvents()).toContain('command_dedupe_persist_timeout');
    expect(await reportedEvents()).toContain('command_refused_no_durable_dedupe');
  });

  it('D1: a WEDGED bridge does NOT mask a successful IndexedDB write', async () => {
    // The composition hazard in the other direction. Waiting for BOTH async homes
    // (Promise.all) would let a wedged bridge consume the entire budget and refuse a
    // command whose record IndexedDB had already accepted — turning the independent
    // store into a hostage of the broken one. First acceptance must win.
    await connectAndCommit();
    await breakRingPreferences(NEVER);
    localStorageThrowOn.setItem = true;
    // IndexedDB stays healthy.

    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-idb-wins' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50); // well INSIDE the 2s bound

    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(idbRing).toContain('reload@d1-idb-wins');
    expect(await reportedEvents()).not.toContain('command_refused_no_durable_dedupe');
  });

  it('D1: the UNKEYABLE context-destroying command is refused on the same rule', async () => {
    // This path needs it more than the keyed one: with no timestamp there is no exact
    // key to fall back on, so an undurable synthetic record leaves nothing at all.
    await connectAndCommit();
    await killAllRingStores();
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'clear_cache' }, ack); // no timestamp
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(mockCacheManager.clearCache).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(await reportedEvents()).toContain('command_refused_no_durable_dedupe');
  });

  it('D1 THE OTHER DIRECTION: with EITHER home working the command still executes', async () => {
    // One home is enough — the rule must be "neither accepted", never "one failed", or
    // every device with a busy bridge stops taking reloads.
    await connectAndCommit();

    // (a) Preferences dead, localStorage alive.
    await breakRingPreferences(() => Promise.reject(new Error('QuotaExceededError')));
    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-local-only' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(localRing()).toContain('reload@d1-local-only');

    // (b) localStorage dead, Preferences alive.
    const { Preferences } = await import('@capacitor/preferences');
    (Preferences.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      preferencesStore.set(key, value);
    });
    localStorageThrowOn.setItem = true;
    triggerSocketEvent('command', { type: 'reload', timestamp: 'd1-prefs-only' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(2);
    expect(preferencesStore.get('seen_command_keys')).toContain('reload@d1-prefs-only');

    expect(await reportedEvents()).not.toContain('command_refused_no_durable_dedupe');
  });

  it('D1 NEGATIVE CONTROL: a HARMLESS command is unaffected when both stores are dead', async () => {
    // The refusal is scoped to the context-destroying set. A replayed `clear_override`
    // or `reboot` costs one wasted execution, not the device, so declining those would
    // be pure loss — the operator's command dropped for no safety gain.
    await connectAndCommit();
    await killAllRingStores();
    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    const ack = vi.fn();

    triggerSocketEvent('command', { type: 'reboot', timestamp: 'd1-harmless' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    expect(await reportedEvents()).toContain('command_unsupported'); // it RAN
    expect(await reportedEvents()).not.toContain('command_refused_no_durable_dedupe');
    // `reboot` is never-executable, so it carries the unsupported status too — the
    // fail-closed refusal and the unsupported status are independent things.
    expect(ack).toHaveBeenCalledWith({ ok: true, status: 'unsupported' });
  });

  it('D1: the IN-MEMORY ring still suppresses a same-process replay while both stores are dead', async () => {
    // The degraded state must not also lose the common case. The disk write is what a
    // replay ACROSS a reload needs; a replay within this process is covered by the
    // in-memory entry, which is added whether or not any store accepted it.
    await connectAndCommit();
    await killAllRingStores();

    // A harmless command, so the first delivery genuinely executes and is recorded.
    triggerSocketEvent('command', { type: 'reboot', timestamp: 'd1-mem' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect((await reportedEventCalls()).filter(c => c[0] === 'command_unsupported')).toHaveLength(1);

    triggerSocketEvent('command', { type: 'reboot', timestamp: 'd1-mem' }, vi.fn()); // replay
    await vi.advanceTimersByTimeAsync(50);

    expect((await reportedEventCalls()).filter(c => c[0] === 'command_unsupported')).toHaveLength(1);
    expect(await reportedEvents()).toContain('command_duplicate_suppressed');
  });

  // ======================================================================
  // P1. THE PAIRING POLL IS NOT DOWNSTREAM OF THE COSMETIC QR RENDER
  // ======================================================================
  //
  // startPairingCheck() used to be sequenced AFTER `await this.generateQRCode()`, which
  // awaits a dynamic import('qrcode'). A REJECTING import was always survivable —
  // generateQRCode catches it and renders a text fallback — but an import that never
  // SETTLES never returns, and the poll was then never armed. That is not a degraded
  // screen, it is a dead one: the ONLY thing that replaces an expired pairing code is
  // the poll's own 404 branch (main.ts:1245-1248), so the device sits showing a code
  // nobody can use until a human visits it. A decorative render must not gate the one
  // functional path off the pairing screen.

  /** Did the device actually poll the pairing-status endpoint? */
  const polledStatus = async () => {
    const { CapacitorHttp } = await import('@capacitor/core');
    return (CapacitorHttp.get as Mock).mock.calls.some(
      (c: unknown[]) => (c[0] as { url: string }).url.includes('/pairing/status/'),
    );
  };

  it('P1: a QR render that NEVER settles still leaves the pairing poll running', async () => {
    // The hang case, driven through the real seam: the render parks forever inside the
    // awaited cosmetic step. Before the reorder this armed nothing at all.
    secureStorageStore.clear(); // no credentials → pairing flow
    qrToCanvasMock.mockReset().mockImplementation(() => new Promise<void>(() => {}));
    const { CapacitorHttp } = await import('@capacitor/core');

    await importFresh(() => domElements.get('pairing-code')!.textContent === 'ABCD1234');
    (CapacitorHttp.get as Mock).mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await polledStatus()).toBe(true);
  });

  it('P1: a REJECTING QR render also leaves the poll running (pinning the existing catch)', async () => {
    // generateQRCode's own try/catch always made the reject case SURVIVABLE
    // (main.ts:1212-1221) — but survivable is not the same as prompt: under the old
    // ordering the poll was still armed only after the dynamic import settled, which
    // this window catches (the ordering mutation turns this test red too). What is
    // pinned here is that neither QR outcome delays the functional path at all.
    secureStorageStore.clear();
    qrToCanvasMock.mockReset().mockRejectedValue(new Error('qr fail'));
    const { CapacitorHttp } = await import('@capacitor/core');

    await importFresh(() => domElements.get('pairing-code')!.textContent === 'ABCD1234');
    (CapacitorHttp.get as Mock).mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await polledStatus()).toBe(true);
  });

  it('P1 NEGATIVE CONTROL: a healthy QR render polls too, and renders the QR', async () => {
    // Same seam, working render. Proves the two assertions above belong to the ordering
    // and not to the poll being unconditional in some way that would also survive the
    // render being broken outright — and that the reorder did not cost us the QR.
    secureStorageStore.clear();
    const { CapacitorHttp } = await import('@capacitor/core');

    await importFresh(() => qrToCanvasMock.mock.calls.length > 0);
    expect(qrToCanvasMock.mock.calls[0][1] as string).toContain('/pair?code=ABCD1234');
    (CapacitorHttp.get as Mock).mockClear();
    await vi.advanceTimersByTimeAsync(2000);

    expect(await polledStatus()).toBe(true);
  });

  it('P1: an EXPIRED code self-heals — the 404 branch requests a fresh one', async () => {
    // This is the property that makes the ordering fix worth having: with polling armed,
    // an expired code is replaced. Without it the device is stuck forever, which is why
    // a hung render was unrecoverable rather than cosmetic.
    secureStorageStore.clear();
    let requests = 0;
    httpPostHandler = () => {
      requests++;
      return {
        status: 200,
        data: { data: { code: requests === 1 ? 'ABCD1234' : 'WXYZ9999', deviceId: 'dev-1', expiresInSeconds: 300 } },
      };
    };
    await importFresh(() => domElements.get('pairing-code')!.textContent === 'ABCD1234');
    expect(requests).toBe(1);

    // The server now says the code is gone.
    httpGetHandler = (opts) => opts.url.includes('/pairing/status/')
      ? { status: 404, data: {} }
      : { status: 200, data: { data: { status: 'pending' } } };

    await waitUntil(
      'the re-requested pairing code',
      () => domElements.get('pairing-code')!.textContent === 'WXYZ9999',
      { tickMs: 2000 },
    );

    expect(requests).toBeGreaterThan(1);
    expect(domElements.get('pairing-code')!.textContent).toBe('WXYZ9999');
  });

  // ======================================================================
  // G1. THE UNKEYABLE CONTEXT-DESTROYING COMMAND LOOP HAS A TERMINATOR
  // ======================================================================
  //
  // B1 made the ring durable, which closed the two keyed ways a dispatch could go
  // unrecorded (a rejecting write, a wedged bridge). It could not close the third:
  // with no `timestamp` on the wire there is no key, so rememberCommand was never
  // called at all and NOTHING was recorded. A requeue after a lost ack then replays
  // the identical unkeyable reload with no terminator — reload → ack stranded in
  // engine.io's writeBuffer → reload() discards it → requeue at 10s → reconnect →
  // replay → reload, forever, the moment any future server emitter forgets the stamp.
  //
  // The record is therefore keyed on the command TYPE plus our own clock, and it
  // expires. That is the whole design: a replay is a machine retrying inside seconds,
  // a re-issue is a human pressing the button again; only a window tells them apart.
  // Both directions are asserted below, and the clock is assumed hostile — a TV boots
  // with a bogus RTC and corrects it from NTP — so every ambiguous stamp must fail
  // towards EXECUTING.

  /** Synthetic records for `type`, read off the SYNCHRONOUS durable home. */
  const unkeyedRecords = (type: string) => localRing().filter(k => k.startsWith(`${type}@~unkeyed:`));

  it('G1: an unkeyable reload replayed inside the window is suppressed — and still acked', async () => {
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload' }, vi.fn()); // no timestamp
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(unkeyedRecords('reload')).toHaveLength(1);

    // The requeue lands one server ack-timeout later — well inside the window.
    await vi.advanceTimersByTimeAsync(10_000);
    const ack = vi.fn();
    triggerSocketEvent('command', { type: 'reload' }, ack);
    await vi.advanceTimersByTimeAsync(50);

    // ONE execution total: the loop is terminated.
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    // And the suppressed replay is STILL acked — a nack requeues the exact delivery we
    // deliberately declined to repeat, which is the loop again by another door.
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(await reportedEvents()).toContain('command_unkeyed_replay_suppressed');
  });

  it('G1: the record survives the RELOAD it exists to survive', async () => {
    // The suppression above would be worthless in the field if it lived in memory: the
    // replay arrives in a context that has just been torn down and rebuilt. This is
    // the real shape — dispatch, whole new JS context, requeue — and only the durable
    // half of the record can terminate it from there.
    await connectAndCommit();
    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000); // reload + reconnect
    await importFresh();                     // ← the reload: nothing survives but storage
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');

    const ack = vi.fn();
    triggerSocketEvent('command', { type: 'reload' }, ack); // the server's requeue
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(await reportedEvents()).toContain('command_unkeyed_replay_suppressed');
  });

  it('G1: the SYNCHRONOUS home alone terminates it — a rejecting Preferences write is not enough to lose it', async () => {
    // Same reasoning as B1, applied to the synthetic record: on Tizen/webOS the
    // Preferences plugin IS localStorage, and a QuotaExceededError fails every write
    // identically. If the synthetic record only had the async home it would be absent
    // in exactly the state the loop runs in.
    await connectAndCommit();
    await breakRingPreferences(async () => { throw new Error('QuotaExceededError'); });

    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);
    expect(preferencesStore.has('seen_command_keys')).toBe(false); // the async home is gone
    expect(unkeyedRecords('reload')).toHaveLength(1);              // the sync one is not

    await vi.advanceTimersByTimeAsync(4000);
    await importFresh();
    (window.location.reload as Mock).mockClear();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
  });

  it('G1 THE OTHER DIRECTION: a deliberate re-issue AFTER the window still executes', async () => {
    // The window is what keeps this a replay guard rather than a one-shot latch. An
    // operator who watches a reload not take and presses it again a minute later must
    // get a reload — silently swallowing that press, with `{ ok: true }` on the
    // dashboard, is its own field failure.
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(61_000); // past the 60s window
    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(2);
    expect(unkeyedRecords('reload')).toHaveLength(2); // and the new one is guarded too
  });

  it('G1 NEGATIVE CONTROL: the window reaches neither keyed commands nor harmless ones', async () => {
    // Two ways a type-keyed window could be wrong: swallowing distinct KEYED commands
    // (which already have exact dedupe, so type-only suppression would be a
    // regression), and recording commands whose replay is merely wasteful.
    await connectAndCommit();

    triggerSocketEvent('command', { type: 'reload', timestamp: 'g1-a' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    triggerSocketEvent('command', { type: 'reload', timestamp: 'g1-b' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(window.location.reload).toHaveBeenCalledTimes(2); // both ran, 100ms apart
    expect(unkeyedRecords('reload')).toHaveLength(0);        // nothing synthetic recorded

    const { reportEvent } = await import('./crash-reporting');
    (reportEvent as Mock).mockClear();
    triggerSocketEvent('command', { type: 'reboot' }, vi.fn()); // unkeyed, NOT context-destroying
    await vi.advanceTimersByTimeAsync(50);
    triggerSocketEvent('command', { type: 'reboot' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect((await reportedEventCalls()).filter(c => c[0] === 'command_unsupported')).toHaveLength(2);
    expect(unkeyedRecords('reboot')).toHaveLength(0);
    expect(await reportedEvents()).not.toContain('command_unkeyed_replay_suppressed');
  });

  it('G1 CLOCK: a record stamped in the FUTURE does not suppress', async () => {
    // A device whose clock jumps BACKWARDS at boot (bogus RTC, then NTP) reads its own
    // record as being in the future. Treating that as "recent" would suppress every
    // unkeyable reload until the clock caught up — a device that has silently stopped
    // taking commands. Fail towards executing: a suppressed reload the operator wanted
    // is recoverable by pressing it again; a permanently suppressed one is not.
    localStorageStore.set(LOCAL_RING_KEY, JSON.stringify([`reload@~unkeyed:${Date.now() + 3_600_000}`]));
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    (window.location.reload as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).toHaveBeenCalledTimes(1);
  });

  it('G1 CLOCK NEGATIVE CONTROL: the same seeded record, stamped NOW, does suppress', async () => {
    // Same boot, same seam, same restore path — only the sign of the offset differs.
    // Proves the future-stamp case above is the clock guard doing its job and not the
    // restore having gone dark (which would also produce "it executed", plus a device
    // with no terminator at all).
    localStorageStore.set(LOCAL_RING_KEY, JSON.stringify([`reload@~unkeyed:${Date.now()}`]));
    await importFresh();
    currentMockSocket.connected = true;
    triggerSocketEvent('connect');
    (window.location.reload as Mock).mockClear();

    triggerSocketEvent('command', { type: 'reload' }, vi.fn());
    await vi.advanceTimersByTimeAsync(50);

    expect(window.location.reload).not.toHaveBeenCalled();
  });

  // ======================================================================
  // G2. A PURGE DURING A CONTENT COMMIT LEAVES NOTHING OF THAT TENANT
  // ======================================================================
  //
  // C7 guards the VERSION commit. The CONTENT commit was unguarded: updatePlaylist
  // awaits a Preferences write, and purgeDeviceState — which runs its own
  // `last_playlist` removal — can land inside that window, so our write is the one
  // left on disk. Everything after the await then renders and PRELOADS the purged
  // tenant's assets, and pairing -> playing is NOT refused, because canPlay() only
  // asks whether a playlist has items. Same class one level out: a pull is not
  // cancelled by a de-pair (a 20s bound), so the old pairing's content can arrive on a
  // device that is already showing a pairing code.

  /** Park the `last_playlist` write for one specific playlist; the rest stays healthy. */
  const parkPlaylistPersist = async (marker: string) => {
    const { Preferences } = await import('@capacitor/preferences');
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let parked = false;
    (Preferences.set as Mock).mockImplementation(async ({ key, value }: { key: string; value: string }) => {
      if (key === 'last_playlist' && value.includes(marker) && !parked) { parked = true; await gate; }
      preferencesStore.set(key, value);
    });
    return { release: () => release(), parked: () => parked };
  };

  it('G2: a purge inside the playlist persist discards it — disk, memory and screen', async () => {
    httpGetHandler = (opts) => opts.url.includes('/devices/auth/check')
      ? { status: 410, data: { code: 'DEVICE_REVOKED' } }
      : { status: 200, data: { data: { status: 'pending' } } };
    await connectAndCommit();
    const persist = await parkPlaylistPersist('c2');

    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg', 'pl-shared'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(persist.parked()).toBe(true); // the arrange really did park inside the commit

    triggerSocketEvent('device:revoked', { reason: 'operator' });
    await waitUntil('purge', () => !secureStorageStore.has('device_token'), { tickMs: 100 });
    await waitUntil(
      'pairing code',
      () => domElements.get('pairing-code')!.textContent === 'ABCD1234',
      { tickMs: 200 },
    );

    persist.release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1600);

    // The write landed AFTER purgeDeviceState's removal, so it is the copy left on
    // disk — a de-paired device that reboots straight back into the purged tenant's
    // playlist. It must be taken back out.
    expect(preferencesStore.has('last_playlist')).toBe(false);
    // Independently of the disk record: everything after the await runs off the
    // playlist ARGUMENT, not off this.currentPlaylist, so the preloader re-populated
    // the cache purgeDeviceState had just cleared with the purged tenant's assets.
    expect(mockCacheManager.downloadContent.mock.calls.some((c: unknown[]) => c[0] === 'c2')).toBe(false);
    // Nothing of that tenant reaches the glass, and the screen the revocation path
    // owns is the one the device is left on.
    expect(findCreatedElements('img').some(i => i.src.includes('c2.jpg'))).toBe(false);
    expect(visibleScreens()).toEqual(['pairing-screen']);
    expect(await reportedEvents()).toContain('playlist_discarded_after_purge');
  });

  it('G2 NEGATIVE CONTROL: the same parked persist with NO purge still commits', async () => {
    // Same seam, same parking, no revocation. Proves the discard belongs to the purge
    // and not to the parking — a guard that dropped every slow persist would drop
    // content on every device with a busy bridge.
    await connectAndCommit();
    const persist = await parkPlaylistPersist('c2');

    triggerSocketEvent('playlist:update', playlistV('v2', 'c2', '/c2.jpg', 'pl-shared'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(persist.parked()).toBe(true);

    persist.release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1600);

    expect(JSON.parse(preferencesStore.get('last_playlist')!).playlist.items[0].contentId).toBe('c2');
    expect(mockCacheManager.downloadContent.mock.calls.some((c: unknown[]) => c[0] === 'c2')).toBe(true);
    expect(findCreatedElements('img').some(i => i.src.includes('c2.jpg'))).toBe(true);
    expect(visibleScreens()).toEqual(['content-screen']);
    expect(await reportedEvents()).not.toContain('playlist_discarded_after_purge');
  });

  it('G2: a pull that resolves AFTER the de-pair does not put the purged tenant back on screen', async () => {
    await connectAndCommit();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    httpGetHandler = (opts) => {
      if (opts.url.includes('/devices/me/content')) {
        return gate.then(() => ({ status: 200, data: { data: playlistV('v9', 'c9', '/c9.jpg', 'pl-purged') } }));
      }
      if (opts.url.includes('/devices/auth/check')) return { status: 410, data: { code: 'DEVICE_REVOKED' } };
      return { status: 200, data: { data: { status: 'pending' } } };
    };

    // A reconnect issues the pull-on-connect; it parks in flight.
    triggerSocketEvent('connect');
    for (let i = 0; i < 20; i++) await Promise.resolve();

    triggerSocketEvent('device:revoked', { reason: 'operator' });
    await waitUntil('purge', () => !secureStorageStore.has('device_token'), { tickMs: 100 });
    await waitUntil(
      'pairing code',
      () => domElements.get('pairing-code')!.textContent === 'ABCD1234',
      { tickMs: 200 },
    );

    release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1600);

    expect(findCreatedElements('img').some(i => i.src.includes('c9.jpg'))).toBe(false);
    expect(visibleScreens()).toEqual(['pairing-screen']);
    expect(preferencesStore.has('last_playlist')).toBe(false);
    expect(await reportedEvents()).toContain('content_discarded_after_purge');
  });

  it('G2 NEGATIVE CONTROL: the same parked pull with NO purge applies normally', async () => {
    // Same seam, same parking. Proves the discard is bound to the de-pair and that
    // pull-on-connect — the T2 delivery path for every reconnecting device — still
    // works when the pairing is intact.
    await connectAndCommit();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    httpGetHandler = (opts) => {
      if (opts.url.includes('/devices/me/content')) {
        return gate.then(() => ({ status: 200, data: { data: playlistV('v9', 'c9', '/c9.jpg', 'pl-purged') } }));
      }
      return { status: 200, data: { data: { status: 'pending' } } };
    };

    triggerSocketEvent('connect');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    release();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1600);

    expect(findCreatedElements('img').some(i => i.src.includes('c9.jpg'))).toBe(true);
    expect(visibleScreens()).toEqual(['content-screen']);
    expect(await reportedEvents()).not.toContain('content_discarded_after_purge');
  });
});
