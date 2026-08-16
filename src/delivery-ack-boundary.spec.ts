/**
 * CROSS-PROCESS BOUNDARY contract for the `deliveryAck` client capability.
 *
 * Why this file exists, stated plainly: every other test of `deliveryAck` in this
 * repo drives the client through an in-repo mock socket. A mock cannot disagree
 * with the client, so all of them stay green no matter what the SERVER's parser
 * or ack-reading logic actually does. The capability is worthless if the gateway
 * does not recognise it — the device would sit on the legacy path, the dashboard
 * would report `{ delivered: true, legacy: true }` for a command written into a
 * half-open socket, and nothing on either side would record that it happened.
 *
 * So this file stands up a REAL socket.io server in-process, lets the REAL client
 * (src/main.ts, booted exactly the way the other specs boot it) connect to it over
 * a REAL Socket.IO transport, and runs the bytes that actually crossed the wire
 * through logic transcribed verbatim from the gateway. Nothing here is a mock of
 * the server's decision-making: the decisions are the gateway's own code.
 *
 * What it deliberately does NOT do is invent a shape. `src/ack-envelope.fixture.json`
 * is this repo's recorded weakness — a hand-written fixture that nothing mechanically
 * checks against the server, which once described a heartbeat ack the server has
 * never emitted. Wherever the client and server shapes must agree, the expectation
 * below is DERIVED by running the client's real output through the transcribed
 * server predicate, never compared against a second hand-written literal.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as IOServer, type Socket as ServerSocket } from 'socket.io';

// ===========================================================================
// TRANSCRIBED SERVER LOGIC — VERBATIM COPIES, NOT PARAPHRASES
// ===========================================================================
//
// Every declaration in this block is a literal transcription of
//
//     C:\projects\vizora\realtime\src\gateways\device.gateway.ts
//
// as deployed to production at commit d323434e. That file is byte-identical
// between d323434e and that repo's `main`; verify with
//
//     git -C C:\projects\vizora diff d323434e main -- realtime/src/gateways/device.gateway.ts
//
// which prints nothing.
//
// >>> THESE ARE COPIES. THEY MUST BE UPDATED TOGETHER WITH THE GATEWAY. <<<
// There is no import between the two repos and no compiler that will tell you they
// have drifted. If you change `supportsDeliveryAck`, `getAckError`,
// `emitWithDeliveryAck` or the ack timeout in device.gateway.ts, change this block
// in the same change — otherwise this file starts certifying a contract that is no
// longer the one production runs.
//
// The only edits made during transcription are called out at each site, and all of
// them are mechanical (class methods becoming module functions, plus one purely
// observational hook). No behaviour was rewritten, simplified or "cleaned up".

/** device.gateway.ts:89-92 */
interface DeliveryAck {
  ok?: boolean;
  error?: string;
}

/** device.gateway.ts:94-98 */
interface DeliveryResult {
  delivered: boolean;
  reason?: string;
  legacy?: boolean;
}

/**
 * device.gateway.ts:254-256, verbatim (transcription edit: `private` method → module
 * function).
 *
 * This is the entire definition of a failed delivery on the server. ONLY an ack whose
 * `ok` is exactly `false` is a failure; `undefined`, `{}`, `{ ok: true }`, a string,
 * null — every other callback invocation counts as DELIVERED.
 */
function getAckError(ack?: DeliveryAck): string | null {
  return ack?.ok === false ? ack.error || 'negative_ack' : null;
}

/**
 * device.gateway.ts:258-269, verbatim (transcription edit: `private` method → module
 * function).
 *
 * The predicate that decides whether a connected device gets the delivery guarantee
 * at all. It accepts an ARRAY containing the string `'deliveryAck'` OR an object with
 * `deliveryAck === true`, read from `client.data.capabilities` if the connection has
 * been latched, else straight off `client.handshake.auth.capabilities`.
 */
function supportsDeliveryAck(client: { data?: Record<string, any>; handshake?: { auth?: any } }): boolean {
  if (client.data?.deliveryAckCapable === true) {
    return true;
  }

  const capabilities = client.data?.capabilities ?? client.handshake?.auth?.capabilities;
  if (Array.isArray(capabilities)) {
    return capabilities.includes('deliveryAck');
  }

  return capabilities?.deliveryAck === true;
}

/** device.gateway.ts:283 — the server's ack deadline, in milliseconds. */
const ACK_TIMEOUT_MS = 10000;

/** What an observed ack looked like on the server side of the wire. */
type AckObserver = (ack: DeliveryAck | undefined, latencyMs: number) => void;

/**
 * device.gateway.ts:271-302, verbatim. Four transcription edits, all non-behavioural
 * and all of them listed here — nothing else in the body was touched:
 *
 *   1. `private async` method → module function.
 *   2. `this.supportsDeliveryAck` / `this.getAckError` → the module copies above.
 *   3. The gateway's inline literal `10000` → the named `ACK_TIMEOUT_MS`, which holds
 *      that same value. Named so the latency assertion in B5 can be written against
 *      the server's deadline instead of against a third copy of the number.
 *   4. `observe` — an added callback that records the RAW ack value and its round-trip
 *      latency so the tests can assert on exactly what the client put on the wire. It
 *      runs after the gateway's own `clearTimeout` and before any decision is taken,
 *      so it cannot influence what this function returns.
 *
 * The `{ delivered: true, legacy: true }` early return for a non-capable client and
 * the ack_timeout/negative_ack reason mapping are the gateway's, unchanged.
 */
async function emitWithDeliveryAck(
  socket: { id?: string; data?: Record<string, any>; emit: Function },
  event: 'playlist:update' | 'command',
  payload: unknown,
  observe: AckObserver = () => {},
): Promise<DeliveryResult> {
  if (!supportsDeliveryAck(socket)) {
    socket.emit(event, payload);
    return { delivered: true, legacy: true };
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const startedAt = Date.now();
      const timeout = setTimeout(() => reject(new Error('ack_timeout')), ACK_TIMEOUT_MS);
      socket.emit(event, payload, (ack?: DeliveryAck) => {
        clearTimeout(timeout);
        observe(ack, Date.now() - startedAt);
        const ackError = getAckError(ack);
        if (ackError) {
          reject(new Error(ackError));
          return;
        }
        resolve();
      });
    });
    return { delivered: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ack_timeout';
    return {
      delivered: false,
      reason: message === 'ack_timeout' ? 'ack_timeout' : 'negative_ack',
    };
  }
}

/**
 * device.gateway.ts:956-962 (pre-verified device path) and :1032-1038 (device-JWT
 * path), the two sites where a connection's capabilities are latched. Both do the
 * same two lines, in this order — `capabilities` is copied off the handshake FIRST,
 * so the `deliveryAckCapable` derived on the next line reads the latched copy.
 *
 * Only the two capability lines are transcribed; the surrounding lines set deviceId /
 * organizationId / token hashes, which this boundary does not exercise.
 */
function latchCapabilities(client: { data: Record<string, any>; handshake: { auth?: any } }): void {
  client.data.capabilities = client.handshake.auth?.capabilities;
  client.data.deliveryAckCapable = supportsDeliveryAck(client);
}

// ===========================================================================
// END TRANSCRIBED SERVER LOGIC
// ===========================================================================

// ======================== TEST-SIDE PLUMBING ========================

/**
 * Real client sockets created during the run, so the file can close every one of
 * them and not leak a handle into the rest of the suite.
 *
 * This is a passthrough over the REAL `socket.io-client`: `importOriginal` gives the
 * genuine module and the wrapper only records the instance it returns. No behaviour
 * is faked — without this the module-level app instance in main.ts owns its socket
 * privately and nothing could ever close it.
 *
 * `vi.hoisted` because `vi.mock` is hoisted above this file's declarations and the
 * factory closes over the array.
 */
const { createdSockets } = vi.hoisted(() => ({
  createdSockets: [] as Array<{ removeAllListeners: () => void; disconnect: () => void }>,
}));

vi.mock('socket.io-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('socket.io-client')>();
  return {
    ...actual,
    io: (...args: unknown[]) => {
      const socket = (actual.io as unknown as (...a: unknown[]) => any)(...args);
      createdSockets.push(socket);
      return socket;
    },
  };
});

// ---- Capacitor / platform fakes. Same shape as src/vizora-app.spec.ts, trimmed to
// ---- what booting the client needs. socket.io-client is pointedly NOT faked.

const preferencesStore = new Map<string, string>();
const secureStorageStore = new Map<string, string>();
/** Flipped by the "handler throws" adversarial case; see that test. */
let preferencesSetThrows = false;

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: preferencesStore.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      if (preferencesSetThrows) throw new Error('simulated Preferences.set failure');
      preferencesStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      preferencesStore.delete(key);
    }),
  },
}));

vi.mock('./secure-storage', () => ({
  SecureStorage: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: secureStorageStore.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      secureStorageStore.set(key, value);
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      secureStorageStore.delete(key);
    }),
    has: vi.fn(async ({ key }: { key: string }) => ({ value: secureStorageStore.has(key) })),
  },
}));

vi.mock('./crash-reporting', () => ({
  initCrashReporting: vi.fn(),
  setCrashReportingDevice: vi.fn(),
  reportEvent: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    // The client pulls authoritative content on every connect and probes auth/check
    // when a connection error needs classifying. Neither is what this file is about;
    // both answer inertly so the socket boundary is the only thing under test.
    get: vi.fn(async (opts: { url: string }) =>
      opts.url.includes('/devices/auth/check')
        ? { status: 404, data: {} }
        : { status: 200, data: { data: { version: '', playlist: null } } },
    ),
    post: vi.fn(async () => ({ status: 200, data: { data: {} } })),
  },
  Capacitor: { convertFileSrc: (uri: string) => uri },
  registerPlugin: vi.fn(() => ({})),
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

vi.mock('./cache-manager', () => ({
  AndroidCacheManager: vi.fn(() => ({
    getCachedUri: vi.fn(async () => null),
    downloadContent: vi.fn(async () => null),
    clearCache: vi.fn(async () => {}),
    getCacheStats: vi.fn(() => ({ itemCount: 0, totalSizeMB: 0, maxSizeMB: 500 })),
    init: vi.fn(async () => {}),
    setExpectedTenant: vi.fn(),
  })),
}));

vi.mock('qrcode', () => ({ toCanvas: vi.fn(async () => undefined) }));

// ---- Minimal DOM. The client renders into these; nothing here is asserted on.

function createElementStub(tag = 'div') {
  const children: any[] = [];
  const classes = new Set<string>();
  const stub: any = {
    tagName: tag.toUpperCase(),
    textContent: '', innerHTML: '', id: '', className: '', src: '', srcdoc: '', alt: '',
    autoplay: false, muted: false, loop: false, playsInline: false, allow: '',
    style: {} as Record<string, string>,
    onerror: null, onload: null, onended: null,
    children,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      toggle: (c: string, force?: boolean) => {
        if (force === undefined) { classes.has(c) ? classes.delete(c) : classes.add(c); }
        else if (force) { classes.add(c); } else { classes.delete(c); }
      },
      contains: (c: string) => classes.has(c),
    },
    sandbox: { add: () => {} },
    appendChild: (child: any) => { children.push(child); return child; },
    removeChild: (child: any) => { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); return child; },
    remove: () => {},
    get firstChild() { return children.length > 0 ? children[0] : null; },
    focus: () => {}, click: () => {},
    querySelectorAll: () => [],
    setAttribute: () => {}, removeAttribute: () => {}, getAttribute: () => null,
    pause: () => {}, load: () => {},
  };
  return stub;
}

const domElements = new Map<string, any>();

function installGlobals(realtimeUrl: string) {
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

  vi.stubGlobal('__APP_VERSION__', '1.0.0-test');
  vi.stubGlobal('document', {
    readyState: 'complete',
    getElementById: (id: string) => domElements.get(id) ?? null,
    createElement: (tag: string) => createElementStub(tag),
    querySelectorAll: () => [],
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    body: {
      appendChild: (child: any) => { if (child.id) domElements.set(child.id, child); return child; },
      removeChild: () => {},
    },
  });
  vi.stubGlobal('window', {
    // The one global that matters here: loadConfig() reads realtime_url off the query
    // string with no allowlist, which is how the real client is pointed at the
    // in-process server without touching its compiled-in origins.
    location: { search: `?realtime_url=${realtimeUrl}`, reload: vi.fn() },
    screen: { width: 1920, height: 1080, colorDepth: 24 },
    devicePixelRatio: 1,
    Capacitor: { isNativePlatform: () => true },
  });
  vi.stubGlobal('HTMLElement', class {});
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'test-agent', language: 'en-US' },
    configurable: true,
    writable: true,
  });
  // `memory` for the heartbeat's metrics; `now` kept real because engine.io uses it.
  const realNow = performance.now.bind(performance);
  vi.stubGlobal('performance', {
    memory: { usedJSHeapSize: 50_000_000, jsHeapSizeLimit: 100_000_000 },
    now: realNow,
  });
}

/**
 * Real timers throughout — there is a real socket carrying real frames, and fake
 * timers would stall the transport. The client's long-lived timers (the 15s heartbeat
 * interval, the 60s offline-overlay timeout at main.ts:1409, Socket.IO's reconnect
 * backoff) would then be live handles holding the event loop open after the file ends,
 * so every timer created while this file runs is unref'd. They still fire; they just
 * stop being the reason the worker will not exit.
 */
const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
function unrefTimers() {
  globalThis.setTimeout = ((...args: any[]) => {
    const t = (realSetTimeout as any)(...args);
    t?.unref?.();
    return t;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.setInterval = ((...args: any[]) => {
    const t = (realSetInterval as any)(...args);
    t?.unref?.();
    return t;
  }) as unknown as typeof globalThis.setInterval;
}
function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;
}

// ======================== THE SERVER ========================

let httpServer: HttpServer;
let ioServer: IOServer;
let baseUrl: string;

/** Connections the server has accepted but no test has claimed yet. */
const pendingConnections: ServerSocket[] = [];
let connectionWaiter: ((s: ServerSocket) => void) | null = null;

function nextConnection(timeoutMs = 20_000): Promise<ServerSocket> {
  const queued = pendingConnections.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => {
      connectionWaiter = null;
      reject(new Error('timed out waiting for a device connection'));
    }, timeoutMs);
    connectionWaiter = (s) => {
      clearTimeout(timer);
      resolve(s);
    };
  });
}

/** The device's current server-side socket. Reassigned when it reconnects. */
let device: ServerSocket;

const INITIAL_TOKEN = 'boundary-tok-initial';
const ROTATED_TOKEN = 'boundary-tok-rotated';

async function reportedEvents(): Promise<unknown[][]> {
  const { reportEvent } = await import('./crash-reporting');
  return (reportEvent as Mock).mock.calls as unknown[][];
}

async function reportedEventNames(): Promise<unknown[]> {
  return (await reportedEvents()).map((c) => c[0]);
}

/**
 * Block until the client has reported `name`, or fail.
 *
 * Polled rather than slept-on: the ack is synchronous but the DISPATCH behind it is
 * not, and a fixed sleep tuned on an idle machine is exactly the assertion that goes
 * intermittent under load and then gets deleted.
 */
async function waitForReportedEvent(name: string, timeoutMs = 10_000): Promise<void> {
  const { reportEvent } = await import('./crash-reporting');
  await waitFor(
    () => (reportEvent as Mock).mock.calls.some((c: unknown[]) => c[0] === name),
    timeoutMs,
    `the client to report ${name}`,
  );
}

/**
 * Wait for `predicate` to hold, polling on real time.
 *
 * The default budget is deliberately UNDER the per-test timeout, so a broken
 * expectation fails with this function's own message naming what never happened
 * rather than an anonymous "Test timed out".
 *
 * 10s against a 30s testTimeout (vite.config.ts), raised together from 3s/5s. This is
 * the only suite running on REAL time against a REAL Socket.IO server, so its duration
 * tracks machine load; the old ~2s of slack was thin enough that a slow run could fail
 * correct code. Cost: a genuinely broken expectation now reports in 10s instead of 3s
 * — the right trade, since a false red costs far more investigation than 7s of CI.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => realSetTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Drive one delivery-guaranteed emit and hand back everything the server saw. */
async function deliver(
  socket: ServerSocket,
  event: 'playlist:update' | 'command',
  payload: unknown,
): Promise<{ result: DeliveryResult; acks: Array<{ ack: DeliveryAck | undefined; latencyMs: number }> }> {
  const acks: Array<{ ack: DeliveryAck | undefined; latencyMs: number }> = [];
  const result = await emitWithDeliveryAck(socket, event, payload, (ack, latencyMs) => {
    acks.push({ ack, latencyMs });
  });
  return { result, acks };
}

beforeAll(async () => {
  unrefTimers();

  httpServer = createServer();
  ioServer = new IOServer(httpServer, { transports: ['websocket', 'polling'] });

  ioServer.on('connection', (socket) => {
    // The gateway latches the handshake capabilities onto the connection at auth
    // time — transcribed above. Doing it here means every later assertion runs
    // against the same per-connection state production would hold.
    latchCapabilities(socket as unknown as { data: Record<string, any>; handshake: { auth?: any } });

    // Answer heartbeats so the client's ack callbacks do not accumulate. The shape
    // is the gateway's active-socket success envelope, and it is deliberately inert
    // (no revoked, no commands, no reconcileContent) — this file tests delivery
    // acks, not the heartbeat contract, which src/ack-envelope.fixture.json owns.
    socket.on('heartbeat', (_payload: unknown, ack?: (r: unknown) => void) => {
      if (typeof ack === 'function') {
        ack({ success: true, data: { nextHeartbeatIn: 15000, commands: [] }, timestamp: new Date().toISOString() });
      }
    });

    if (connectionWaiter) {
      const waiter = connectionWaiter;
      connectionWaiter = null;
      waiter(socket);
    } else {
      pendingConnections.push(socket);
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  installGlobals(baseUrl);
  secureStorageStore.set('device_token', INITIAL_TOKEN);
  secureStorageStore.set('device_id', 'boundary-dev-1');

  // The real client. No `io` stub between it and the server above.
  await import('./main');

  device = await nextConnection();
}, 40_000);

afterAll(async () => {
  for (const socket of createdSockets) {
    try {
      socket.removeAllListeners();
      socket.disconnect();
    } catch {
      /* already gone */
    }
  }
  createdSockets.length = 0;

  ioServer.disconnectSockets(true);
  await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  if (httpServer.listening) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  restoreTimers();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  preferencesSetThrows = false;
  const { reportEvent } = await import('./crash-reporting');
  (reportEvent as Mock).mockClear();
});

// ======================== TESTS ========================

describe('deliveryAck across a REAL Socket.IO process boundary', () => {
  // ======================================================================
  // B1. The capability arrives in a form the SERVER's own predicate accepts.
  // ======================================================================
  //
  // This is the assertion no in-repo mock can make. The mock suite proves the
  // client passes `capabilities: ['deliveryAck']` to `io()`; it cannot prove
  // Socket.IO puts that on the handshake, that it survives serialisation, or
  // that the gateway's predicate says yes to what comes out the other end.

  it('B1: the handshake the server received is accepted by the gateway\'s supportsDeliveryAck()', () => {
    // Pre-latch: straight off the wire, exactly as device.gateway.ts:263 reads it
    // when nothing has been copied onto client.data yet.
    expect(supportsDeliveryAck({ handshake: device.handshake })).toBe(true);

    // Post-latch: the state device.gateway.ts:959-960 leaves behind, and the state
    // every later emitWithDeliveryAck() call in the gateway reads.
    expect(device.data.deliveryAckCapable).toBe(true);
    expect(supportsDeliveryAck(device as unknown as { data?: Record<string, any> })).toBe(true);
  });

  it('B1 NEGATIVE CONTROL: the same predicate rejects a handshake without the capability', () => {
    // Without this, B1 would pass just as well against a predicate that returned
    // true unconditionally — i.e. against a transcription error that deleted the
    // discrimination this whole capability depends on.
    expect(supportsDeliveryAck({ handshake: { auth: { token: INITIAL_TOKEN } } })).toBe(false);
    expect(supportsDeliveryAck({ handshake: { auth: { token: INITIAL_TOKEN, capabilities: [] } } })).toBe(false);
    expect(supportsDeliveryAck({ handshake: { auth: { token: INITIAL_TOKEN, capabilities: ['somethingElse'] } } })).toBe(false);
  });

  // ======================================================================
  // B2/B3. The client's ack is read as DELIVERED by the server's getAckError().
  // ======================================================================

  it('B2: playlist:update — the gateway takes the ack path and getAckError() reads DELIVERED', async () => {
    const { result, acks } = await deliver(device, 'playlist:update', {
      version: '2026-08-15T00:00:00.000Z',
      playlist: {
        id: 'pl-boundary', name: 'boundary', loopPlaylist: true,
        items: [{ id: 'it-1', contentId: 'c1', duration: 10, order: 0,
          content: { id: 'c1', name: 'c1', type: 'image', url: '/c1.jpg' } }],
      },
    });

    expect(acks).toHaveLength(1);
    // The expectation is DERIVED, not a second literal: whatever the client sent is
    // fed back through the gateway's own failure test.
    expect(getAckError(acks[0].ack)).toBeNull();
    expect(result).toEqual({ delivered: true });
    // `legacy` absent is what proves the gateway did NOT take the bare-emit branch
    // at device.gateway.ts:276-279 — the branch this capability exists to leave.
    expect(result.legacy).toBeUndefined();
  });

  it('B3: command — the gateway takes the ack path and getAckError() reads DELIVERED', async () => {
    const { result, acks } = await deliver(device, 'command', {
      type: 'clear_override',
      timestamp: '2026-08-15T00:00:01.000Z',
    });

    expect(acks).toHaveLength(1);
    expect(getAckError(acks[0].ack)).toBeNull();
    expect(result).toEqual({ delivered: true });
    expect(result.legacy).toBeUndefined();
  });

  // ======================================================================
  // B4. The client NEVER produces an ack getAckError() would call a failure.
  // ======================================================================
  //
  // Rule 1 of the ACK SEMANTICS block in main.ts: a nack has no terminator on the
  // server — no attempt counter, no dead-letter queue, and the one circuit breaker
  // is reset by a clean replay and bypassed by the connect-time path. So every
  // adversarial case below is driven through the real socket and the raw ack is run
  // through the gateway's own classifier.

  it('B4a: a MALFORMED playlist:update payload is still acked as delivered', async () => {
    const { result, acks } = await deliver(device, 'playlist:update', { playlist: 'not-a-playlist' });

    expect(acks).toHaveLength(1);
    expect(getAckError(acks[0].ack)).toBeNull();
    expect(result).toEqual({ delivered: true });
  });

  it('B4b: an UNKNOWN command type is acked as delivered — and reported, so the skew is visible', async () => {
    const { result, acks } = await deliver(device, 'command', {
      type: 'a_command_type_this_build_has_never_heard_of',
      timestamp: '2026-08-15T00:00:02.000Z',
    });

    expect(acks).toHaveLength(1);
    expect(getAckError(acks[0].ack)).toBeNull();
    expect(result).toEqual({ delivered: true });

    // The ack alone would make a newly-rolled-out server command type invisible:
    // every dashboard says delivered, every device does nothing. The telemetry is
    // what turns the drop into a signal.
    await waitForReportedEvent('command_unknown');
  });

  it('B4c: a command whose HANDLER THROWS is still acked as delivered', async () => {
    // update_config persists each accepted URL through Preferences.set; making that
    // reject drives handleCommand to reject for real, rather than simulating it.
    // The ack has already gone out by then — that is the property under test.
    preferencesSetThrows = true;

    const { result, acks } = await deliver(device, 'command', {
      type: 'update_config',
      apiUrl: 'https://cdn.vizora.io',
      timestamp: '2026-08-15T00:00:03.000Z',
    });

    expect(acks).toHaveLength(1);
    expect(getAckError(acks[0].ack)).toBeNull();
    expect(result).toEqual({ delivered: true });

    // Proves the handler genuinely threw and was caught by the socket handler's
    // .catch — not that the URL was quietly rejected by the allowlist before the
    // throwing line was ever reached (that path reports `config_rejected`).
    await waitForReportedEvent('command_handler_failed');
    expect(await reportedEventNames()).not.toContain('config_rejected');
  });

  it('B4d: a DUPLICATE replay is suppressed and STILL acked as delivered', async () => {
    // The server requeues anything it does not get a receipt for, so a suppressed
    // duplicate that went unacked would come straight back — forever.
    const replayed = { type: 'clear_override', timestamp: '2026-08-15T00:00:04.000Z' };

    const first = await deliver(device, 'command', replayed);
    // The ring is written BEFORE dispatch (main.ts rememberCommand), so the replay
    // must not be sent until the first delivery has actually recorded its key —
    // otherwise this would be testing a race, not the dedupe.
    await waitFor(
      () => (preferencesStore.get('seen_command_keys') ?? '').includes(replayed.timestamp),
      3000,
      'the first delivery to reach the dedupe ring',
    );
    const second = await deliver(device, 'command', replayed);
    await waitForReportedEvent('command_duplicate_suppressed');

    expect(getAckError(first.acks[0].ack)).toBeNull();
    expect(getAckError(second.acks[0].ack)).toBeNull();
    expect(first.result).toEqual({ delivered: true });
    expect(second.result).toEqual({ delivered: true });

    // The second really was suppressed by the dedupe ring — otherwise this test
    // would pass against a client that had no duplicate handling at all.
    expect(await reportedEventNames()).toContain('command_duplicate_suppressed');
  });

  // ======================================================================
  // B5. The ack lands well inside the server's real timeout window.
  // ======================================================================

  it('B5: the ack round-trip is far inside the gateway\'s transcribed 10s deadline', async () => {
    const { acks } = await deliver(device, 'command', {
      type: 'clear_override',
      timestamp: '2026-08-15T00:00:05.000Z',
    });

    expect(acks).toHaveLength(1);
    const { latencyMs } = acks[0];

    // The contract itself: past this the gateway rejects with `ack_timeout`,
    // requeues, and (for playlist:update) has already deleted its replay entry.
    expect(latencyMs).toBeLessThan(ACK_TIMEOUT_MS);

    // And with an order of magnitude of headroom. The client acks synchronously,
    // BEFORE dispatch, on purpose (rule 3). A future change that moved the ack
    // behind slow async work — a cache read, a content apply, a storage write —
    // would still satisfy the line above on a fast day and fail in the field on a
    // loaded TV. This is the line that catches it.
    expect(latencyMs).toBeLessThan(ACK_TIMEOUT_MS / 10);
  });

  // ======================================================================
  // B6. The capability survives a token rotation — across a REAL reconnect.
  // ======================================================================
  //
  // The landmine: handleTokenRefresh used to assign `socket.auth = { token }`
  // wholesale, which silently dropped `capabilities`. Nothing failed at the moment
  // of rotation — the drop only shows up on the NEXT handshake, which is why this
  // has to be asserted on a reconnected connection and not on the client's own
  // in-memory auth object.

  it('B6: after token:refresh and a real reconnect, the new handshake is still accepted', async () => {
    expect(device.handshake.auth?.token).toBe(INITIAL_TOKEN); // baseline

    device.emit('token:refresh', { token: ROTATED_TOKEN });
    await waitFor(
      () => secureStorageStore.get('device_token') === ROTATED_TOKEN,
      5000,
      'the rotated token to be persisted',
    );

    // Force the client through a genuine reconnect by killing the TRANSPORT, which
    // is what a dropped TCP connection looks like and is the dominant real cause of
    // a device re-handshaking. Deliberately NOT `socket.disconnect(true)`: Socket.IO
    // reports that to the client as reason `io server disconnect` and suppresses
    // automatic reconnection entirely, so it would prove nothing about the next
    // handshake — the very thing this test exists for.
    device.conn.close();
    const reconnected = await nextConnection();

    // It really is the post-rotation handshake, not the old one replayed.
    expect(reconnected.handshake.auth?.token).toBe(ROTATED_TOKEN);
    // …and it still buys the delivery guarantee.
    expect(supportsDeliveryAck({ handshake: reconnected.handshake })).toBe(true);
    expect(reconnected.data.deliveryAckCapable).toBe(true);

    // End to end on the new connection: an emit over it still takes the ack path.
    const { result, acks } = await deliver(reconnected, 'command', {
      type: 'clear_override',
      timestamp: '2026-08-15T00:00:06.000Z',
    });
    expect(getAckError(acks[0].ack)).toBeNull();
    expect(result).toEqual({ delivered: true });
    expect(result.legacy).toBeUndefined();

    device = reconnected;
  }, 30_000);

  // ======================================================================
  // B7. The LEGACY path still works — 1.3.15 clients stay on the wire.
  // ======================================================================

  it('B7: a client that does not advertise the capability takes the gateway\'s legacy branch', async () => {
    // The legacy handshake is DERIVED from the live client's own auth by removing
    // `capabilities`, which is exactly what vizora-tv 1.3.15 sent: `{ token }`
    // (main.ts at f8bc6ff^:1253-1256). Deriving it means this test cannot drift into
    // asserting against a shape no released client ever used.
    const observedAuth = { ...(device.handshake.auth as Record<string, unknown>) };
    expect(observedAuth).toHaveProperty('capabilities'); // guard: the removal is meaningful
    delete observedAuth.capabilities;

    const { io } = await import('socket.io-client');
    const legacyClient = io(baseUrl, { auth: observedAuth, transports: ['websocket'] });

    const received: Array<{ payload: unknown; maybeAck: unknown }> = [];
    legacyClient.on('command', (payload: unknown, maybeAck: unknown) => {
      received.push({ payload, maybeAck });
    });

    const legacySocket = await nextConnection();

    try {
      // The gateway's predicate is what decides, and it says no.
      expect(supportsDeliveryAck({ handshake: legacySocket.handshake })).toBe(false);
      expect(legacySocket.data.deliveryAckCapable).toBe(false);

      const payload = { type: 'clear_override', timestamp: '2026-08-15T00:00:07.000Z' };
      const { result, acks } = await deliver(legacySocket, 'command', payload);

      // device.gateway.ts:276-279 — the bare emit and the legacy receipt. `legacy: true`
      // is the marker that only that branch produces.
      expect(result).toEqual({ delivered: true, legacy: true });
      expect(acks).toHaveLength(0); // no callback was ever attached

      // …and the payload genuinely arrived, with no ack argument behind it.
      await waitFor(() => received.length === 1, 5000, 'the legacy client to receive the command');
      expect(received[0].payload).toEqual(payload);
      expect(received[0].maybeAck).toBeUndefined();
    } finally {
      legacyClient.removeAllListeners();
      legacyClient.disconnect();
    }
  }, 30_000);
});
