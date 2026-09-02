/**
 * SecureStorage unit tests (src/secure-storage.ts).
 *
 * This module had ZERO tests: `vizora-app.spec.ts` replaces it wholesale with a
 * Map, so nothing anywhere exercised the code that actually runs. On Samsung
 * Tizen and LG webOS there is no native SecureStorage plugin, so the fallback
 * class in this file IS the credential store for the whole fleet — the device
 * JWT lives or dies by it. A regression here does not fail loudly; it strands a
 * paired device on the pairing screen after a reboot, which is a truck roll.
 *
 * Deliberately NOT mocked: `@capacitor/core`. `registerPlugin` is the thing that
 * decides whether a TV gets the web fallback at all, and Capacitor resolves its
 * platform to 'web' here (no androidBridge / webkit bridge on globalThis), which
 * is exactly what it resolves to inside a .wgt on a Samsung TV. Mocking
 * registerPlugin would have left the `web:` factory untested, i.e. it would test
 * a class no runtime ever constructs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { SecureStorage } from './secure-storage';

/** The prefix the fallback namespaces every key with. Duplicated here on
 *  purpose: this is a DURABILITY contract, not an implementation detail —
 *  changing it in the source silently orphans the credentials of every device
 *  already in the field, and an upgrade is exactly when that happens. */
const PREFIX = 'vizora_secure_';

let store: Map<string, string>;
let throwOn: { getItem?: Error; setItem?: Error; removeItem?: Error };

beforeEach(() => {
  store = new Map();
  throwOn = {};
  // Bare `localStorage`, not `window.localStorage`: that is what the source
  // reads, and on the TV runtimes it is a genuine global.
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => {
      if (throwOn.getItem) throw throwOn.getItem;
      return store.has(key) ? store.get(key)! : null;
    },
    setItem: (key: string, value: string) => {
      if (throwOn.setItem) throw throwOn.setItem;
      store.set(key, value);
    },
    removeItem: (key: string) => {
      if (throwOn.removeItem) throw throwOn.removeItem;
      store.delete(key);
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('platform resolution', () => {
  it('resolves to the web fallback — the TV runtime has no native plugin', async () => {
    // Guards the `web:` factory in registerPlugin. Drop it and Capacitor throws
    // "not implemented on web" on the first credential read, which on a TV means
    // init() never gets a token and the device re-pairs on every boot.
    expect(Capacitor.isNativePlatform()).toBe(false);
    await expect(SecureStorage.set({ key: 'device_token', value: 'tok' })).resolves.toBeUndefined();
  });
});

describe('web/TV fallback round-trip', () => {
  it('persists a set value under the namespaced key', async () => {
    await SecureStorage.set({ key: 'device_token', value: 'tok-abc' });
    expect(store.get(`${PREFIX}device_token`)).toBe('tok-abc');
  });

  it('reads back what it wrote', async () => {
    await SecureStorage.set({ key: 'device_token', value: 'tok-abc' });
    expect(await SecureStorage.get({ key: 'device_token' })).toEqual({ value: 'tok-abc' });
  });

  it('returns null — not undefined — for an absent key', async () => {
    // main.ts branches on the VALUE (`typeof storedToken.value === 'string'`),
    // so the shape matters: an undefined here would read as "no credential"
    // by accident rather than by contract, and would diverge from the native
    // Android plugin, which returns null.
    expect(await SecureStorage.get({ key: 'device_token' })).toEqual({ value: null });
  });

  it('remove deletes the credential', async () => {
    await SecureStorage.set({ key: 'device_token', value: 'tok-abc' });
    await SecureStorage.remove({ key: 'device_token' });
    expect(await SecureStorage.get({ key: 'device_token' })).toEqual({ value: null });
    expect(store.has(`${PREFIX}device_token`)).toBe(false);
  });

  it('has() reports presence and absence', async () => {
    expect(await SecureStorage.has({ key: 'device_token' })).toEqual({ value: false });
    await SecureStorage.set({ key: 'device_token', value: 'tok-abc' });
    expect(await SecureStorage.has({ key: 'device_token' })).toEqual({ value: true });
  });

  it('has() is true for an empty-string value', async () => {
    // `has` must not be a truthiness check on the value: '' is a stored key.
    // The Android plugin distinguishes presence from emptiness and this one
    // has to agree, or the two platforms disagree about whether a device is
    // paired.
    await SecureStorage.set({ key: 'device_token', value: '' });
    expect(await SecureStorage.has({ key: 'device_token' })).toEqual({ value: true });
  });

  it('keeps each key independent', async () => {
    await SecureStorage.set({ key: 'device_token', value: 'tok' });
    await SecureStorage.set({ key: 'device_id', value: 'dev' });
    await SecureStorage.remove({ key: 'device_token' });
    expect(await SecureStorage.get({ key: 'device_id' })).toEqual({ value: 'dev' });
  });

  it('is namespaced — an unprefixed localStorage entry is not a credential', async () => {
    // The app's own localStorage keys (command-dedupe ring, config) share this
    // store on TV. If the prefix stopped being applied on BOTH sides they would
    // still round-trip through each other and the test would pass, so assert
    // against a raw entry written by "something else".
    store.set('device_token', 'not-a-credential');
    expect(await SecureStorage.get({ key: 'device_token' })).toEqual({ value: null });
    expect(await SecureStorage.has({ key: 'device_token' })).toEqual({ value: false });
  });
});

describe('localStorage failure surfaces to the caller', () => {
  // The failure this whole block exists for: a credential store that swallows a
  // write error reports success while the token is gone. The caller (main.ts
  // pairing commit) is written to await these and treat a rejection as a failed
  // pair — so the rejection must actually arrive. Adding a try/catch to any of
  // these methods would look defensive and would silently brick devices whose
  // storage is full or disabled.

  it('rejects when setItem throws (QuotaExceededError)', async () => {
    const err = new Error('QuotaExceededError');
    throwOn.setItem = err;
    await expect(SecureStorage.set({ key: 'device_token', value: 'tok' })).rejects.toThrow(
      'QuotaExceededError',
    );
  });

  it('rejects when getItem throws (storage disabled / private mode)', async () => {
    throwOn.getItem = new Error('SecurityError: storage disabled');
    await expect(SecureStorage.get({ key: 'device_token' })).rejects.toThrow('storage disabled');
    await expect(SecureStorage.has({ key: 'device_token' })).rejects.toThrow('storage disabled');
  });

  it('rejects when removeItem throws', async () => {
    // De-pair / revocation purge depends on this: a swallowed removal leaves a
    // revoked token on disk and reports the purge complete.
    throwOn.removeItem = new Error('SecurityError: storage disabled');
    await expect(SecureStorage.remove({ key: 'device_token' })).rejects.toThrow('storage disabled');
  });

  it('rejects when the localStorage global is absent entirely', async () => {
    // Some TV firmwares hand web apps a document with no storage at all. The
    // contract is the same as above: fail loudly, never "succeed" with nothing
    // written.
    vi.stubGlobal('localStorage', undefined);
    await expect(SecureStorage.set({ key: 'device_token', value: 'tok' })).rejects.toThrow();
    await expect(SecureStorage.get({ key: 'device_token' })).rejects.toThrow();
  });
});
