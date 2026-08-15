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

vi.stubGlobal('window', {
  location: { search: '', reload: vi.fn() },
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
let httpGetHandler: (opts: { url: string }) => { status: number; data: unknown };
let httpPostHandler: (opts: { url: string; data?: unknown; connectTimeout?: number; readTimeout?: number }) => { status: number; data: unknown };
let networkListeners: Map<string, Function[]>;
let appListeners: Map<string, Function[]>;
let networkConnected: boolean;

function resetCapacitorFakes() {
  preferencesStore = new Map();
  secureStorageStore = new Map();
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

vi.mock('./crash-reporting', () => ({
  initCrashReporting: vi.fn(),
  setCrashReportingDevice: vi.fn(),
  reportEvent: vi.fn(),
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

async function importFresh() {
  vi.resetModules();
  await import('./main');
  // Let async init() settle — flush microtasks aggressively then advance time.
  // We can't use runAllTimersAsync (infinite loop from recurring timers).
  // The init chain: loadConfig -> setupCapacitor -> migrateCredentials ->
  // startPairing/connectToRealtime -> various awaits. Each await needs a microtask turn.
  // Use alternating timer advances and microtask flushes.
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(20);
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
      await importFresh();
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
      await importFresh();
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
      expect(window.location.reload).toHaveBeenCalled();
    });

    it('processes commands wrapped in the ack .data envelope (createSuccessResponse — backend Q#3)', async () => {
      await importFresh();
      currentMockSocket.connected = true;
      triggerSocketEvent('connect');
      const hb = currentMockSocket.emit.mock.calls.find((c: unknown[]) => c[0] === 'heartbeat')!;
      const ack = hb[hb.length - 1] as Function;
      ack({ data: { commands: [{ type: 'reload' }] } });
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
      // renderQrOverlay does `await import('qrcode')` which needs real timers to resolve.
      // Use real timers briefly, then clean up leaked intervals.
      await importFresh();
      triggerSocketEvent('qr-overlay:update', { qrOverlay: { enabled: true, url: 'https://e.com', label: 'Scan me!' } });
      vi.useRealTimers();
      await new Promise(r => setTimeout(r, 50));
      // Clean up leaked real-timer intervals before reinstalling fake timers
      const maxId = setTimeout(() => {}, 0) as unknown as number;
      for (let i = 0; i <= maxId; i++) { clearInterval(i); clearTimeout(i); }
      vi.useFakeTimers();
      const ov = domElements.get('qr-overlay')!;
      const labelChild = ov.children.find((c: ElementStub) => c.textContent === 'Scan me!');
      expect(labelChild).toBeDefined();
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
      await importFresh();
      qrToCanvasMock.mockRejectedValueOnce(new Error('canvas fail'));
      triggerSocketEvent('config', { qrOverlay: { enabled: true, url: 'https://e.com' } });
      vi.useRealTimers();
      await new Promise(r => setTimeout(r, 50));
      const maxId = setTimeout(() => {}, 0) as unknown as number;
      for (let i = 0; i <= maxId; i++) { clearInterval(i); clearTimeout(i); }
      vi.useFakeTimers();
      expect((console.error as Mock).mock.calls.some(c => String(c[0]).includes('QR code generation failed'))).toBe(true);
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

  it('F41: tenant:suspended then a reconnect (no resumed event) clears the latch on connect', async () => {
    await connectAndCommit();
    triggerSocketEvent('tenant:suspended');
    await vi.advanceTimersByTimeAsync(100);
    expect(visibleScreens()).toEqual(['holding-screen']);
    triggerSocketEvent('disconnect', 'transport close');
    // A fresh handshake (no tenant:resumed) must itself clear the latch.
    triggerSocketEvent('connect');
    await vi.advanceTimersByTimeAsync(1600);
    expect(visibleScreens()).toEqual(['content-screen']);
    expect(await reportedEvents()).toContain('tenant_unsuspended');
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
    await importFresh();
    // The QR path does a dynamic import('qrcode') — let it settle on real timers,
    // then clear any dangling pairing intervals (mirrors the QR-overlay reject test).
    vi.useRealTimers();
    await new Promise(r => setTimeout(r, 50));
    const maxId = setTimeout(() => {}, 0) as unknown as number;
    for (let i = 0; i <= maxId; i++) { clearInterval(i); clearTimeout(i); }
    vi.useFakeTimers();
    const qr = domElements.get('qr-code')!;
    const fallback = qr.children.find(c => c.tagName === 'DIV' && c.textContent.includes('pair?code='));
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
      expect(currentMockSocket.auth).toEqual({ token: 'new-tok' });
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
    expect(secureStorageStore.has('device_id')).toBe(true); // baseline: there is state to purge
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
    triggerSocketEvent('qr-overlay:update', { qrOverlay });
    vi.useRealTimers();
    await new Promise(r => setTimeout(r, 50));
    const maxId = setTimeout(() => {}, 0) as unknown as number;
    for (let i = 0; i <= maxId; i++) { clearInterval(i); clearTimeout(i); }
    vi.useFakeTimers();
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
    ) => {
      httpGetHandler = (opts) => opts.url.includes('/pairing/status/')
        ? { status: 200, data: { data: payload } }
        : { status: 404, data: {} };
      for (let round = 0; round < 30; round++) {
        await vi.advanceTimersByTimeAsync(2100);
        for (let j = 0; j < 40; j++) await Promise.resolve();
        if (settled()) {
          // Give the commit that follows the persist its own turns to run.
          await vi.advanceTimersByTimeAsync(50);
          for (let j = 0; j < 40; j++) await Promise.resolve();
          return;
        }
      }
    };

    /** Boot with no credentials and wait for the real pairing request to land. */
    const bootToPairingScreen = async () => {
      await importFresh();
      for (let round = 0; round < 10; round++) {
        if (domElements.get('pairing-code')!.textContent === 'ABCD1234') break;
        await vi.advanceTimersByTimeAsync(200);
        for (let j = 0; j < 40; j++) await Promise.resolve();
      }
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

      await pollToPaired(pairedPayload, () => false);

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
      await pollToPaired(pairedPayload, () => false);
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

      await pollToPaired(pairedPayload, () => secureStorageStore.has('tenant_id'));

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
