/**
 * initCrashReporting / isCrashReportingEnabled.
 *
 * These two are load-bearing beyond telemetry: reportCrashLoopMarker DELETES the
 * once-ever crash-loop marker only when isCrashReportingEnabled() returns true. So the
 * flag claiming telemetry the device does not have destroys the single record of why a
 * device is degrading — and the wave's "it is reported, not merely logged" argument
 * rests on the same flag.
 *
 * Sentry is mocked at the module boundary so the DSN outcomes can be driven directly:
 * a valid DSN builds a transport, an invalid or whitespace one does not — Sentry.init
 * does NOT throw for a bad DSN, it constructs no transport and silently discards every
 * event, which is exactly why asking init() "did you work?" was the wrong question.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const initMock = vi.fn();
let transport: unknown = { send: vi.fn() };

vi.mock('@sentry/browser', () => ({
  init: (...args: unknown[]) => initMock(...args),
  getClient: () => (transport ? { getTransport: () => transport } : undefined),
  setTag: vi.fn(),
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
}));

/** Re-import the module fresh so its `enabled` module state starts clean each time. */
async function freshModule(dsn: string | undefined) {
  vi.resetModules();
  vi.stubEnv('VITE_SENTRY_DSN', dsn ?? '');
  return import('./crash-reporting');
}

describe('initCrashReporting — the enabled flag must mean "events actually leave"', () => {
  beforeEach(() => {
    initMock.mockClear();
    transport = { send: vi.fn() };
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('a DSN Sentry REJECTS leaves reporting disabled, even though init() did not throw', async () => {
    // The failure this exists for: makeDsn() returns undefined for an invalid DSN, no
    // transport is constructed, and every event is dropped in silence. Setting
    // enabled = true after init() therefore claimed working telemetry for a device
    // with none — and the crash-loop marker was deleted on the strength of it.
    transport = undefined; // Sentry built no transport
    const mod = await freshModule('not-a-valid-dsn');

    mod.initCrashReporting();

    expect(initMock).toHaveBeenCalled(); // we really did try
    expect(mod.isCrashReportingEnabled()).toBe(false);
  });

  it('a WHITESPACE-only DSN is treated as absent — init is never called', async () => {
    // `if (!dsn)` passed a whitespace string straight through, because it is truthy.
    const mod = await freshModule('   ');

    mod.initCrashReporting();

    expect(initMock).not.toHaveBeenCalled();
    expect(mod.isCrashReportingEnabled()).toBe(false);
  });

  it('NEGATIVE CONTROL: a DSN Sentry accepts enables reporting', async () => {
    // Without this, "disabled" would pass by the flag never being set at all, and the
    // fix would have silently disabled telemetry on every healthy device.
    const mod = await freshModule('https://abc123@o1.ingest.sentry.io/42');

    mod.initCrashReporting();

    expect(initMock).toHaveBeenCalled();
    expect(mod.isCrashReportingEnabled()).toBe(true);
  });

  it('NEGATIVE CONTROL: no DSN at all disables reporting without calling init', async () => {
    const mod = await freshModule(undefined);

    mod.initCrashReporting();

    expect(initMock).not.toHaveBeenCalled();
    expect(mod.isCrashReportingEnabled()).toBe(false);
  });
});
