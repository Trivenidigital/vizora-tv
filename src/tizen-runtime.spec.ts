/**
 * Samsung Tizen runtime coverage for src/main.ts.
 *
 * Why a separate file: `vizora-app.spec.ts` stubs `window.Capacitor` with
 * `isNativePlatform: () => true` at module scope, so all ~700 of its assertions
 * run the Android path and NOTHING exercised the branches a Samsung TV takes.
 * Re-pointing that harness would have traded Android coverage for TV coverage;
 * this file adds the TV runtime alongside it, following the same harness
 * conventions (DOM stub, fake timers, importFresh/waitUntil).
 *
 * What is DELIBERATELY NOT MOCKED here, and why:
 *  - `@capacitor/core`. On a TV there is no native bridge, so `registerPlugin`
 *    hands back the WEB implementation and `CapacitorHttp` is a `fetch` wrapper.
 *    That fall-through is the entire premise of "one codebase, three platforms"
 *    and it was tested nowhere. Mocking CapacitorHttp — as the Android suite
 *    does — asserts against a transport the TV never uses.
 *  - `./secure-storage`. It is the credential store on TV. The Android suite
 *    replaces it with a Map, so nothing proved a device token survives a reboot
 *    on Tizen.
 *  - `./platform`. It is the thing under test.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ======================== BUILD-TIME GLOBALS ========================

vi.stubGlobal('__APP_VERSION__', '1.0.0-test');

// ======================== DOM STUB ========================
//
// Trimmed copy of the Android suite's stub: this file drives boot, pairing and
// the remote-control handler, not content rendering.

interface ElementStub {
  tagName: string;
  textContent: string;
  innerHTML: string;
  id: string;
  style: Record<string, string> & { cssText?: string };
  classList: { add: Mock; remove: Mock; toggle: Mock; contains: Mock };
  appendChild: Mock;
  removeChild: Mock;
  remove: Mock;
  focus: Mock;
  click: Mock;
  setAttribute: Mock;
  getAttribute: Mock;
}

function createElementStub(tag = 'div'): ElementStub {
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  return {
    tagName: tag.toUpperCase(),
    textContent: '',
    innerHTML: '',
    id: '',
    style: {},
    classList: {
      add: vi.fn((c: string) => classes.add(c)),
      remove: vi.fn((c: string) => classes.delete(c)),
      toggle: vi.fn((c: string, force?: boolean) => {
        if (force === undefined) classes.has(c) ? classes.delete(c) : classes.add(c);
        else if (force) classes.add(c);
        else classes.delete(c);
      }),
      contains: vi.fn((c: string) => classes.has(c)),
    },
    appendChild: vi.fn((child: ElementStub) => child),
    removeChild: vi.fn((child: ElementStub) => child),
    remove: vi.fn(),
    focus: vi.fn(),
    click: vi.fn(),
    setAttribute: vi.fn((n: string, v: string) => { attributes[n] = v; }),
    getAttribute: vi.fn((n: string) => attributes[n] ?? null),
  };
}

let domElements: Map<string, ElementStub>;
let documentEventListeners: Map<string, Function[]>;

function resetDOM() {
  domElements = new Map();
  documentEventListeners = new Map();
  for (const id of [
    'pairing-code', 'pairing-countdown', 'qr-code', 'content-container',
    'loading-screen', 'pairing-screen', 'content-screen', 'error-screen',
    'holding-screen', 'holding-message', 'error-message', 'status-dot',
    'status-text', 'status-bar', 'qr-overlay',
  ]) {
    const el = createElementStub('div');
    el.id = id;
    domElements.set(id, el);
  }
  vi.stubGlobal('document', {
    readyState: 'complete',
    getElementById: vi.fn((id: string) => domElements.get(id) || null),
    createElement: vi.fn((tag: string) => createElementStub(tag)),
    querySelectorAll: vi.fn(() => []),
    activeElement: null,
    addEventListener: vi.fn((event: string, handler: Function) => {
      if (!documentEventListeners.has(event)) documentEventListeners.set(event, []);
      documentEventListeners.get(event)!.push(handler);
    }),
    removeEventListener: vi.fn((event: string, handler: Function) => {
      const list = documentEventListeners.get(event);
      if (list) list.splice(list.indexOf(handler), 1);
    }),
    body: { appendChild: vi.fn((c: ElementStub) => c), removeChild: vi.fn() },
  });
}

// ======================== TIZEN RUNTIME GLOBALS ========================
//
// One localStorage, shared by `window.localStorage` (main.ts's command-ring
// terminator) and the bare `localStorage` global (secure-storage.ts). That is
// how a real TV is: one store, two consumers.

let webStorage: Map<string, string>;
let tizenPowerRequest: Mock;

const storageFake = {
  getItem: (k: string) => (webStorage.has(k) ? webStorage.get(k)! : null),
  setItem: (k: string, v: string) => { webStorage.set(k, v); },
  removeItem: (k: string) => { webStorage.delete(k); },
};

function resetTizenGlobals() {
  webStorage = new Map();
  tizenPowerRequest = vi.fn();
  vi.stubGlobal('window', {
    location: { search: '', reload: vi.fn(), href: 'https://localhost/', origin: 'https://localhost' },
    localStorage: storageFake,
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    // The global the Tizen web runtime injects. NOTE the absence of
    // `window.Capacitor` — a packaged .wgt has no native bridge, which is the
    // whole point: everything below has to work without one.
    tizen: { power: { request: tizenPowerRequest } },
  });
  vi.stubGlobal('localStorage', storageFake);
}

// Node 21+ makes `navigator` a getter-only accessor, so vi.stubGlobal silently
// no-ops on it — see the same note in vizora-app.spec.ts. Real Samsung UA.
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent:
      'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Version/6.0 TV Safari/537.36',
    language: 'en-US',
  },
  configurable: true,
  writable: true,
});

class HTMLElementStub { focus() {} click() {} }
vi.stubGlobal('HTMLElement', HTMLElementStub);
vi.stubGlobal('performance', {
  memory: { usedJSHeapSize: 50_000_000, jsHeapSizeLimit: 100_000_000 },
});

// ======================== HTTP: REAL CapacitorHttp OVER A STUBBED fetch ========================
//
// The stub sits at `fetch`, i.e. BELOW the whole Capacitor HTTP web
// implementation, so a request only arrives here if main.ts -> CapacitorHttp ->
// the `web:` fall-through all ran. Real `Response` objects, because the web
// implementation reads `response.headers`, branches on the content type and
// parses the body itself.

interface FetchCall { url: string; init: RequestInit }
let fetchCalls: FetchCall[];
/** Pairing status the poll endpoint reports; tests flip it to 'paired'. */
let pairingStatus: { status: string; deviceToken?: string; deviceId?: string; tenantId?: string };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function resetHttp() {
  fetchCalls = [];
  pairingStatus = { status: 'pending' };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    fetchCalls.push({ url, init });
    if (url.includes('/devices/pairing/request')) {
      return jsonResponse({ data: { code: 'TVCODE01', deviceId: 'dev-tv', expiresInSeconds: 300 } });
    }
    if (url.includes('/devices/pairing/status/')) {
      return jsonResponse({ data: pairingStatus });
    }
    if (url.includes('/devices/auth/check')) {
      return jsonResponse({}, 404); // legacy backend, contract §7.1a
    }
    return jsonResponse({ data: {} });
  }));
}

function pairingRequestBody(): { deviceIdentifier: string; metadata: Record<string, unknown> } {
  const call = fetchCalls.find(c => c.url.includes('/devices/pairing/request'));
  if (!call) throw new Error('no pairing request reached fetch');
  return JSON.parse(String(call.init.body));
}

// ======================== MODULE MOCKS ========================
//
// Only the pieces that are neither the TV path nor observable state.

let preferencesStore: Map<string, string>;
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: preferencesStore.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { preferencesStore.set(key, value); }),
    remove: vi.fn(async ({ key }: { key: string }) => { preferencesStore.delete(key); }),
  },
}));

vi.mock('@capacitor/network', () => ({
  Network: {
    addListener: vi.fn(() => ({ remove: vi.fn() })),
    getStatus: vi.fn(async () => ({ connected: true, connectionType: 'wifi' })),
  },
}));

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: { hide: vi.fn(async () => {}) },
}));

vi.mock('./command-ring-store', () => ({
  CommandRing: { read: vi.fn(async () => null), write: vi.fn(async () => {}) },
}));

vi.mock('./crash-reporting', () => ({
  initCrashReporting: vi.fn(),
  setCrashReportingDevice: vi.fn(),
  reportEvent: vi.fn(),
  isCrashReportingEnabled: vi.fn(() => true),
}));

vi.mock('qrcode', () => ({ toCanvas: vi.fn(async () => undefined) }));

let currentSocket: { on: Mock; emit: Mock; disconnect: Mock; removeAllListeners: Mock; connected: boolean };
const ioFactory = vi.fn(() => {
  currentSocket = {
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    removeAllListeners: vi.fn(),
    connected: false,
  };
  return currentSocket;
});
vi.mock('socket.io-client', () => ({ io: ioFactory }));

// Both cache managers are mocked so the SELECTION at main.ts:265 is observable.
// The managers themselves have their own suites; what has never been asserted is
// which one a TV gets.
const tvCacheInstances: unknown[] = [];
const androidCacheInstances: unknown[] = [];
function cacheManagerStub() {
  return {
    getCachedUri: vi.fn(async () => null),
    downloadContent: vi.fn(async () => null),
    clearCache: vi.fn(async () => {}),
    getCacheStats: vi.fn(() => ({ itemCount: 0, totalSizeMB: 0, maxSizeMB: 200 })),
    init: vi.fn(async () => {}),
    setExpectedTenant: vi.fn(),
  };
}
vi.mock('./tv-cache-manager', () => ({
  TvCacheManager: vi.fn(function TvCacheManagerMock() {
    const inst = cacheManagerStub();
    tvCacheInstances.push(inst);
    return inst;
  }),
}));
vi.mock('./cache-manager', () => ({
  AndroidCacheManager: vi.fn(function AndroidCacheManagerMock() {
    const inst = cacheManagerStub();
    androidCacheInstances.push(inst);
    return inst;
  }),
}));

// ======================== HARNESS ========================

const realSetImmediate: typeof setImmediate = setImmediate;
const realDateNow: () => number = Date.now.bind(Date);

/** One real event-loop turn without disturbing the fake clock — same reasoning
 *  as vizora-app.spec.ts's realYield (the pairing path awaits a dynamic import). */
async function realYield(): Promise<number> {
  const t0 = realDateNow();
  await new Promise<void>(resolve => { realSetImmediate(resolve); });
  return Math.max(realDateNow() - t0, 1);
}

async function waitUntil(label: string, settled: () => boolean, budgetMs = 5000, tickMs = 0) {
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
    throw new Error('importFresh: init never reached the expected state within 5000ms');
  }
}

function dispatchKeydown(event: Partial<KeyboardEvent> & { preventDefault: Mock }) {
  (documentEventListeners.get('keydown') || []).forEach(h => h(event));
}

beforeEach(() => {
  vi.useFakeTimers();
  preferencesStore = new Map();
  tvCacheInstances.length = 0;
  androidCacheInstances.length = 0;
  ioFactory.mockClear();
  resetTizenGlobals();
  resetDOM();
  resetHttp();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ======================== TESTS ========================

describe('Tizen boot path', () => {
  it('runs the TV bootstrap — Tizen keep-awake is requested during init', async () => {
    // `initTvPlatform()` is a no-op on Android, so the Android suite could not
    // tell whether main.ts calls it at all. Without it a Samsung TV blanks the
    // panel over signage content on its own screen timer.
    await importFresh(() => tizenPowerRequest.mock.calls.length > 0);
    expect(tizenPowerRequest).toHaveBeenCalledWith('SCREEN', 'SCREEN_NORMAL');
  });

  it('selects the IndexedDB cache, not the Filesystem cache', async () => {
    // main.ts:265. Capacitor Filesystem URIs are not resolvable by the page on a
    // TV web runtime, so picking AndroidCacheManager here means every cached
    // asset renders as a broken image — offline playback silently stops working
    // while the app still looks healthy.
    await importFresh();
    expect(tvCacheInstances).toHaveLength(1);
    expect(androidCacheInstances).toHaveLength(0);
  });

  it('swallows the Samsung remote BACK key so it cannot exit the signage loop', async () => {
    await importFresh(() => documentEventListeners.has('keydown'));
    const back = { keyCode: 10009, key: 'XF86Back', preventDefault: vi.fn() };
    dispatchKeydown(back);
    expect(back.preventDefault).toHaveBeenCalled();

    // Negative control: an ordinary key is NOT swallowed, so the assertion above
    // is about the TV keyCode branch and not about the handler blanket-eating
    // every keydown.
    const other = { keyCode: 65, key: 'a', preventDefault: vi.fn() };
    dispatchKeydown(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });
});

describe('Tizen HTTP goes through the web fetch implementation', () => {
  it('issues the pairing request over fetch, with Tizen device identity', async () => {
    // Three things at once, all of them TV-only:
    //  - the request reached global fetch, i.e. CapacitorHttp fell through to
    //    its web implementation instead of a native bridge that does not exist;
    //  - the device identifier carries the 'tizen' prefix (the backend keys
    //    fleet rows on it, so an 'android-' prefixed Samsung is a mislabelled
    //    device that no Tizen-specific handling will ever match);
    //  - the pairing metadata reports platform 'tizen_tv'.
    await importFresh(() => fetchCalls.some(c => c.url.includes('/devices/pairing/request')));

    const call = fetchCalls.find(c => c.url.includes('/devices/pairing/request'))!;
    expect(call.url).toBe('https://api.vizora.io/api/v1/devices/pairing/request');
    expect(call.init.method).toBe('POST');

    const body = pairingRequestBody();
    expect(body.deviceIdentifier).toMatch(/^tizen-1920x1080-/);
    expect(body.metadata.platform).toBe('tizen_tv');
    expect(body.metadata.screenWidth).toBe(1920);
  });

  it('polls pairing status over fetch too', async () => {
    // The poll is the only thing that replaces an expired code; if it never
    // armed on TV the device would sit on a dead code forever.
    await importFresh(() => fetchCalls.some(c => c.url.includes('/devices/pairing/request')));
    await waitUntil(
      'pairing poll',
      () => fetchCalls.some(c => c.url.includes('/devices/pairing/status/TVCODE01')),
      5000,
      2000,
    );
    const poll = fetchCalls.find(c => c.url.includes('/devices/pairing/status/'))!;
    expect(poll.init.method).toBe('GET');
  });
});

describe('Tizen credential store is localStorage, via the real SecureStorage web fallback', () => {
  it('persists the paired device token under the SecureStorage namespace', async () => {
    // End-to-end across three modules that the Android suite mocks apart:
    // main.ts's pairing commit -> the real registerPlugin web fall-through ->
    // SecureStorageWeb -> localStorage. On Android this is Keystore-backed; on a
    // TV this localStorage write IS the credential, so if it does not land the
    // device re-pairs on every reboot.
    await importFresh(() => fetchCalls.some(c => c.url.includes('/devices/pairing/request')));

    pairingStatus = { status: 'paired', deviceToken: 'tok-tizen', deviceId: 'dev-tv', tenantId: 'tenant-tv' };
    await waitUntil(
      'credential persisted',
      () => webStorage.has('vizora_secure_device_token'),
      5000,
      2000,
    );

    expect(webStorage.get('vizora_secure_device_token')).toBe('tok-tizen');
    expect(webStorage.get('vizora_secure_device_id')).toBe('dev-tv');
    expect(webStorage.get('vizora_secure_tenant_id')).toBe('tenant-tv');
    // Namespaced, not dumped at the top level next to the app's own keys.
    expect(webStorage.has('device_token')).toBe(false);
  });

  it('reads the credential back out of localStorage on the next boot and connects instead of pairing', async () => {
    // The reboot case. Nothing in the suite proved a Tizen device survives a
    // power cycle: the Android tests seed a mock Map that the production code
    // never reads from.
    webStorage.set('vizora_secure_device_token', 'tok-from-disk');
    webStorage.set('vizora_secure_device_id', 'dev-tv');

    await importFresh(() => ioFactory.mock.calls.length > 0);

    expect(ioFactory).toHaveBeenCalled();
    expect(ioFactory.mock.calls[0][1]).toMatchObject({ auth: { token: 'tok-from-disk' } });
    // ...and it did NOT fall back to requesting a fresh pairing code.
    expect(fetchCalls.some(c => c.url.includes('/devices/pairing/request'))).toBe(false);
  });

  it('survives a reboot end-to-end — pair, restart, reconnect with no seeded state', async () => {
    // The version of the test above with the fixture removed. Nothing here
    // hand-writes a localStorage key: the app pairs, writes its own credential,
    // and a second process reads back what the FIRST process actually stored.
    // That is the shape this repo has been burned by — a harness constructing
    // the state the production code was supposed to produce — so it is worth
    // paying the second import to close it.
    await importFresh(() => fetchCalls.some(c => c.url.includes('/devices/pairing/request')));
    pairingStatus = { status: 'paired', deviceToken: 'tok-earned', deviceId: 'dev-tv' };
    await waitUntil('paired', () => webStorage.has('vizora_secure_device_token'), 5000, 2000);

    // Reboot: fresh module registry, same localStorage — exactly what a power
    // cycle leaves a Tizen app with.
    ioFactory.mockClear();
    fetchCalls.length = 0;
    resetDOM();
    await importFresh(() => ioFactory.mock.calls.length > 0);

    expect(ioFactory.mock.calls[0][1]).toMatchObject({ auth: { token: 'tok-earned' } });
    expect(fetchCalls.some(c => c.url.includes('/devices/pairing/request'))).toBe(false);
  });

  it('an unprefixed localStorage token is NOT accepted as a credential', async () => {
    // Negative control for the test above: proves it passes because the
    // SecureStorage prefix matched, not because any localStorage entry named
    // device_token would do.
    webStorage.set('device_token', 'tok-from-disk');
    webStorage.set('device_id', 'dev-tv');

    await importFresh(() => fetchCalls.some(c => c.url.includes('/devices/pairing/request')));

    expect(ioFactory).not.toHaveBeenCalled();
  });
});
