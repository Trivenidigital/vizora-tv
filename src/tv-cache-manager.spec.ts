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
