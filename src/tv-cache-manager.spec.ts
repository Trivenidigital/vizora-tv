/**
 * TvCacheManager unit tests (src/tv-cache-manager.ts).
 *
 * The manager is exercised against an in-memory TvCacheStore so the
 * tenant-binding / LRU / dedup / degradation logic is tested without an
 * IndexedDB shim. fetch and the object-URL APIs are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TvCacheManager, type TvCacheStore } from './tv-cache-manager';

type Entry = {
  contentId: string;
  blob: Blob;
  size: number;
  mimeType: string;
  lastAccessed: number;
  downloadedAt: number;
};

class MemoryStore implements TvCacheStore {
  entries = new Map<string, Entry>();
  meta: { tenantId?: string } | null = null;
  failNextGet = false;

  async getEntry(id: string) {
    if (this.failNextGet) {
      this.failNextGet = false;
      throw new Error('simulated store failure');
    }
    return this.entries.get(id) ?? null;
  }
  async putEntry(entry: Entry) { this.entries.set(entry.contentId, { ...entry }); }
  async deleteEntry(id: string) { this.entries.delete(id); }
  async listEntries() {
    return Array.from(this.entries.values()).map(({ blob: _b, ...rest }) => ({ ...rest }));
  }
  async getMeta() { return this.meta; }
  async putMeta(meta: { tenantId?: string }) { this.meta = { ...meta }; }
  async clearAll() { this.entries.clear(); this.meta = null; }
}

let store: MemoryStore;
let urlCounter: number;
let revoked: string[];

function makeFetchResponse(bytes: number, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: async () => new Blob(['x'.repeat(bytes)], { type: 'image/jpeg' }),
  };
}

beforeEach(() => {
  store = new MemoryStore();
  urlCounter = 0;
  revoked = [];
  vi.stubGlobal('fetch', vi.fn(async () => makeFetchResponse(4)));
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => `blob:mock-${++urlCounter}`),
    revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Manager with a byte-denominated max size (constructor takes MB). */
function manager(maxBytes = 1024 * 1024, s: TvCacheStore = store) {
  return new TvCacheManager(maxBytes / (1024 * 1024), s);
}

describe('downloadContent', () => {
  it('downloads, persists, and returns an object URL', async () => {
    const m = manager();
    const uri = await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(uri).toBe('blob:mock-1');
    expect(store.entries.get('c1')?.size).toBe(4);
    expect(store.entries.get('c1')?.mimeType).toBe('image/jpeg');
  });

  it('returns the existing cached URL instead of re-downloading', async () => {
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    const second = await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(second).toBe('blob:mock-1'); // live URL reused
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-2xx response (caller streams direct)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(0, 404) as unknown as Response);
    const m = manager();
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBeNull();
    expect(store.entries.has('c1')).toBe(false);
  });

  it('returns null on a network error and clears the in-flight latch', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    const m = manager();
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBeNull();
    // Latch released: a later retry proceeds
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBe('blob:mock-1');
  });

  it('stamps the tenant on the cache meta', async () => {
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(store.meta?.tenantId).toBe('tenant-a');
  });
});

describe('tenant binding at init', () => {
  it('purges a cache written under a different tenant', async () => {
    store.meta = { tenantId: 'tenant-a' };
    store.entries.set('old', {
      contentId: 'old', blob: new Blob(['zz']), size: 2, mimeType: 'image/jpeg',
      lastAccessed: 1, downloadedAt: 1,
    });
    const m = manager();
    m.setExpectedTenant('tenant-b');
    await m.init();
    expect(store.entries.size).toBe(0);
    expect(store.meta).toBeNull();
  });

  it('keeps a same-tenant cache', async () => {
    store.meta = { tenantId: 'tenant-a' };
    store.entries.set('old', {
      contentId: 'old', blob: new Blob(['zz']), size: 2, mimeType: 'image/jpeg',
      lastAccessed: 1, downloadedAt: 1,
    });
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.init();
    expect(store.entries.size).toBe(1);
  });

  it('keeps a legacy unbound cache (grace mode)', async () => {
    store.entries.set('old', {
      contentId: 'old', blob: new Blob(['zz']), size: 2, mimeType: 'image/jpeg',
      lastAccessed: 1, downloadedAt: 1,
    });
    const m = manager();
    m.setExpectedTenant('tenant-b');
    await m.init();
    expect(store.entries.size).toBe(1);
  });

  it('setExpectedTenant RE-ARMS the purge — re-pairing to a new tenant in the same process purges', async () => {
    // The purge lives inside doInit(), which init() early-returns past once
    // initialized, so setExpectedTenant() after first use was a silent no-op for
    // purge purposes. Reachable today: a confirmed revocation calls startPairing()
    // WITHOUT a reload, so tenant A -> tenant B happens in one process and tenant
    // A's IndexedDB blobs survived it.
    store.meta = { tenantId: 'tenant-a' };
    store.entries.set('old', {
      contentId: 'old', blob: new Blob(['zzzz']), size: 4, mimeType: 'image/jpeg',
      lastAccessed: Date.now(), downloadedAt: Date.now(),
    });
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.init();
    expect(await m.getCachedUri('old')).toBe('blob:mock-1'); // baseline: tenant-a's cache is live

    m.setExpectedTenant('tenant-b'); // re-pair, same process

    // Through a real public entry point, not by re-calling init() by hand.
    expect(await m.getCachedUri('old')).toBeNull();
    expect(store.entries.size).toBe(0);
    expect(store.meta).toBeNull();
  });

  it('NEGATIVE CONTROL: re-setting the SAME tenant does not re-arm the purge', async () => {
    // Proves the purge above came from the tenant CHANGING, not from
    // setExpectedTenant blindly discarding the cache on every call.
    store.meta = { tenantId: 'tenant-a' };
    store.entries.set('old', {
      contentId: 'old', blob: new Blob(['zzzz']), size: 4, mimeType: 'image/jpeg',
      lastAccessed: Date.now(), downloadedAt: Date.now(),
    });
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.init();
    const getMetaSpy = vi.spyOn(store, 'getMeta');

    m.setExpectedTenant('tenant-a');

    expect(await m.getCachedUri('old')).toBe('blob:mock-1');
    expect(store.entries.size).toBe(1);
    expect(getMetaSpy).not.toHaveBeenCalled(); // doInit did not re-run
  });
});

describe('tenant change racing an in-flight init', () => {
  /** Seed a tenant-a cache with one entry. */
  function seedTenantA() {
    store.meta = { tenantId: 'tenant-a' };
    store.entries.set('c1', {
      contentId: 'c1', blob: new Blob(['zzzz']), size: 4, mimeType: 'image/jpeg',
      lastAccessed: Date.now(), downloadedAt: Date.now(),
    });
  }

  /** Park doInit inside listEntries — i.e. AFTER the tenant comparison, BEFORE the
   *  `initialized = true` that concludes it. */
  function gateListEntries() {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inCall = new Promise<void>(r => { entered = r; });
    const original = store.listEntries.bind(store);
    store.listEntries = async () => { entered(); await gate; return original(); };
    return { entered: inCall, release, restore: () => { store.listEntries = original; } };
  }

  it('a tenant change landing INSIDE an in-flight init is not swallowed', async () => {
    // setExpectedTenant re-arms the purge by clearing `initialized`, but doInit sets
    // it back to true at the end regardless of whether the tenant moved under it. A
    // change landing in this window is silently absorbed and the purge NEVER runs —
    // so tenant-b is served tenant-a's blob for the life of the process.
    seedTenantA();
    const m = manager();
    m.setExpectedTenant('tenant-a');

    const { entered, release, restore } = gateListEntries();
    const pending = m.init();
    await entered;
    m.setExpectedTenant('tenant-b');   // lands past the tenant comparison
    release();
    await pending;
    restore();

    expect(await m.getCachedUri('c1')).toBeNull();
    expect(store.entries.size).toBe(0);
    expect(store.meta).toBeNull();
  });

  it('NEGATIVE CONTROL: the same gated init keeps the cache when the tenant does not move', async () => {
    // Same gate, same parking point, tenant untouched. Proves the purge above comes
    // from the tenant change and not from the gate defeating init.
    seedTenantA();
    const m = manager();
    m.setExpectedTenant('tenant-a');

    const { entered, release, restore } = gateListEntries();
    const pending = m.init();
    await entered;
    release();
    await pending;
    restore();

    expect(await m.getCachedUri('c1')).toBe('blob:mock-1');
    expect(store.entries.size).toBe(1);
    expect(store.meta).toEqual({ tenantId: 'tenant-a' });
  });
});

describe('init tenant purge goes through clearCache', () => {
  // doInit called this.store.clearAll() directly rather than this.clearCache(), so
  // the init purge skipped BOTH of clearCache's other jobs: revoking live object
  // URLs and bumping clearGeneration. AndroidCacheManager.doInit already calls
  // clearCache, and with setExpectedTenant re-arming init this branch is reachable
  // mid-session, with live URLs and in-flight downloads in play.

  function seedTenantA(id = 'c1') {
    store.meta = { tenantId: 'tenant-a' };
    store.entries.set(id, {
      contentId: id, blob: new Blob(['zzzz']), size: 4, mimeType: 'image/jpeg',
      lastAccessed: Date.now(), downloadedAt: Date.now(),
    });
  }

  it('revokes object URLs already minted for the purged tenant', async () => {
    seedTenantA();
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.init();
    expect(await m.getCachedUri('c1')).toBe('blob:mock-1'); // live URL on the glass

    // Re-arm, then let the purge be triggered by the NEW tenant asking for its own
    // content — which is what actually happens next on a re-paired device. Asking
    // for 'c1' again would revoke it via getCachedUri's own missing-entry path and
    // tell us nothing about whether the purge did it.
    m.setExpectedTenant('tenant-b');
    expect(await m.getCachedUri('tenant-b-item')).toBeNull();

    // tenant-a's image is still on the glass with this URL as its src. The purge has
    // to kill it, not merely decline to re-issue it.
    expect(revoked).toContain('blob:mock-1');
  });

  it('blocks an in-flight download from writing the purged tenant back', async () => {
    seedTenantA('old');
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.init();

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const inFetch = new Promise<void>(r => { entered = r; });
    vi.stubGlobal('fetch', vi.fn(async () => { entered(); await gate; return makeFetchResponse(4); }));

    const pending = m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    await inFetch;                             // download is in flight under tenant-a

    m.setExpectedTenant('tenant-b');
    await m.init();                            // doInit purges tenant-a's cache
    release();

    expect(await pending).toBeNull();
    expect(store.entries.has('c1')).toBe(false);
    expect(store.entries.size).toBe(0);
    expect(store.meta).toBeNull();
  });

  it('NEGATIVE CONTROL: a same-tenant init purges nothing and revokes nothing', async () => {
    seedTenantA();
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.init();
    expect(await m.getCachedUri('c1')).toBe('blob:mock-1');

    m.setExpectedTenant('tenant-a'); // no-op
    expect(await m.getCachedUri('c1')).toBe('blob:mock-1');
    expect(revoked).toEqual([]);
    expect(store.entries.size).toBe(1);
  });
});

describe('LRU eviction', () => {
  it('evicts oldest-accessed entries beyond the max size', async () => {
    const m = manager(10); // 10-byte budget, 4-byte blobs
    await m.downloadContent('a', 'https://cdn/a.jpg', 'image/jpeg');
    await m.downloadContent('b', 'https://cdn/b.jpg', 'image/jpeg');
    // Third download exceeds 10 bytes -> oldest (a) evicted
    store.entries.get('a')!.lastAccessed = 1;
    store.entries.get('b')!.lastAccessed = 2;
    await m.downloadContent('c', 'https://cdn/c.jpg', 'image/jpeg');
    expect(store.entries.has('a')).toBe(false);
    expect(store.entries.has('b')).toBe(true);
    expect(store.entries.has('c')).toBe(true);
  });
});

describe('getCachedUri', () => {
  it('returns null for a missing entry', async () => {
    const m = manager();
    expect(await m.getCachedUri('nope')).toBeNull();
  });

  it('mints an object URL for an entry persisted in a previous session', async () => {
    store.entries.set('c1', {
      contentId: 'c1', blob: new Blob(['zzzz']), size: 4, mimeType: 'image/jpeg',
      lastAccessed: Date.now(), downloadedAt: Date.now(),
    });
    const m = manager();
    expect(await m.getCachedUri('c1')).toBe('blob:mock-1');
  });

  it('degrades to null when the store throws (caller streams direct)', async () => {
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    store.failNextGet = true;
    expect(await m.getCachedUri('c1')).toBeNull();
  });
});

describe('clearCache', () => {
  it('clears the store and revokes live object URLs', async () => {
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    await m.clearCache();
    expect(store.entries.size).toBe(0);
    expect(revoked).toContain('blob:mock-1');
    expect(m.getCacheStats().itemCount).toBe(0);
  });

  it('REJECTS when the store clear fails, but still revokes the purged tenant URLs', async () => {
    // purgeDeviceState collects this call in a Promise.allSettled, so swallowing
    // recorded a failed cache clear as fulfilled and `device_purge_incomplete` never
    // fired on Tizen/webOS. Revoking first keeps the failure in the safe direction.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    store.clearAll = async () => { throw new Error('idb clear failed'); };

    await expect(m.clearCache()).rejects.toThrow('idb clear failed');

    expect(revoked).toContain('blob:mock-1');
    expect(m.getCacheStats().itemCount).toBe(0);
    errorSpy.mockRestore();
  });
});

describe('purge race', () => {
  it('an in-flight getCachedUri across clearCache never resurrects purged content', async () => {
    const entry = {
      contentId: 'c1', blob: new Blob(['zzzz']), size: 4, mimeType: 'image/jpeg',
      lastAccessed: Date.now(), downloadedAt: Date.now(),
    };
    store.entries.set('c1', entry);
    let releaseGet!: () => void;
    const gate = new Promise<void>(resolve => { releaseGet = resolve; });
    const originalGetEntry = store.getEntry.bind(store);
    store.getEntry = async (id: string) => { await gate; return originalGetEntry(id); };

    const m = manager();
    await m.init();
    const pending = m.getCachedUri('c1'); // suspends inside store.getEntry
    await m.clearCache();                 // revocation purge lands mid-read
    releaseGet();
    expect(await pending).toBeNull();     // no URL minted for purged content
  });
});

describe('init degradation', () => {
  it('disables the cache when the store fails at init, without throwing', async () => {
    const failing: TvCacheStore = {
      ...store,
      getMeta: async () => { throw new Error('idb unavailable'); },
    } as TvCacheStore;
    const m = manager(1024 * 1024, failing);
    await m.init();
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBeNull();
    expect(await m.getCachedUri('c1')).toBeNull();
  });
});
