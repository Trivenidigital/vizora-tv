/**
 * IndexedDbCacheStore tests (src/tv-cache-manager.ts:74-156).
 *
 * `tv-cache-manager.spec.ts` injects a MemoryStore, so the production default —
 * the IndexedDB store every Samsung/LG device actually runs on — had 0% coverage:
 * it was never constructed under test at all. This file closes that by
 * constructing `new TvCacheManager(mb)` with NO store argument, which is the
 * production construction site (`main.ts:265`), and running it against an
 * in-memory IndexedDB double installed as `globalThis.indexedDB`.
 *
 * The double replaces the BROWSER, not the class under test. Everything in
 * IndexedDbCacheStore — the schema, the two object stores, the out-of-line meta
 * key, `req()`, and `txDone()`'s commit-vs-success distinction — runs for real.
 * `fake-indexeddb` is not a devDependency here and adding one is out of scope
 * for a test-only change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TvCacheManager, isQuotaExceeded } from './tv-cache-manager';

// ======================== IN-MEMORY IndexedDB DOUBLE ========================
//
// Faithful on the three points the code under test depends on:
//  1. requests settle ASYNCHRONOUSLY, after the caller has attached onsuccess;
//  2. a transaction commits only once its queued requests have drained, and
//     fires `oncomplete` SEPARATELY from any request's `onsuccess`;
//  3. an aborted transaction rolls its writes back and fires `onabort` AFTER
//     the individual requests have already reported success — which is the
//     exact quota shape txDone() was written for.

type Rec = Record<string, unknown>;

/** The "disk": survives FakeDatabase instances, like a real origin's IDB does. */
class FakeDisk {
  version = 0;
  stores = new Map<string, { keyPath: string | null; data: Map<unknown, Rec> }>();
  /** Abort at COMMIT for readwrite transactions touching this store (quota shape). */
  abortWritesTo: string | null = null;
  /**
   * Abort only the NEXT readwrite transaction touching this store, then clear.
   *
   * Needed to model recoverable quota pressure. `abortWritesTo` fails every write,
   * which also fails the eviction DELETEs — so the cache could never free space and
   * the evict-then-retry path was untestable. A real quota rejection blocks the write
   * that does not fit while deletes still work; this models that.
   */
  abortNextWriteTo: string | null = null;
  abortError: DOMException | Error = new Error('QuotaExceededError');
  /** Make the next read request fire onerror. */
  failNextGet = false;
  /** Make the next open() fail (transient IDB unavailability at boot). */
  failNextOpen = false;
}

interface Handlers {
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

class FakeRequest<T> implements Handlers {
  result!: T;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
}

class FakeTransaction {
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: Error | null = null;
  private pending = 0;
  private finished = false;
  private snapshots = new Map<string, Map<unknown, Rec>>();

  constructor(
    private disk: FakeDisk,
    private names: string[],
    private mode: 'readonly' | 'readwrite',
  ) {
    if (mode === 'readwrite') {
      for (const n of names) {
        this.snapshots.set(n, new Map(this.disk.stores.get(n)!.data));
      }
    }
    // A transaction with no requests still commits; scheduling the drain check
    // here is what makes that true.
    this.scheduleDrain();
  }

  objectStore(name: string): FakeObjectStore {
    if (!this.names.includes(name)) {
      throw new Error(`NotFoundError: ${name} is not in this transaction's scope`);
    }
    return new FakeObjectStore(this.disk, name, this);
  }

  enqueue<T>(op: () => T, failsWithError = false): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending++;
    queueMicrotask(() => {
      if (this.finished) return;
      if (failsWithError) {
        request.error = new Error('IndexedDB read failed');
        request.onerror?.();
      } else {
        try {
          request.result = op();
          request.onsuccess?.();
        } catch (err) {
          request.error = err as Error;
          request.onerror?.();
        }
      }
      this.pending--;
      this.scheduleDrain();
    });
    return request;
  }

  private scheduleDrain(): void {
    queueMicrotask(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      const oneShot = !this.disk.abortWritesTo && this.disk.abortNextWriteTo;
      const abortTarget = this.disk.abortWritesTo ?? this.disk.abortNextWriteTo;
      if (this.mode === 'readwrite' && abortTarget && this.names.includes(abortTarget)) {
        if (oneShot) this.disk.abortNextWriteTo = null;
        // Roll back, exactly like a real abort — the writes the requests
        // already reported as successful never reach the store.
        for (const [name, snapshot] of this.snapshots) {
          this.disk.stores.get(name)!.data = snapshot;
        }
        this.error = this.disk.abortError as Error;
        this.onabort?.();
        return;
      }
      this.oncomplete?.();
    });
  }
}

class FakeObjectStore {
  constructor(
    private disk: FakeDisk,
    private name: string,
    private tx: FakeTransaction,
  ) {}

  private get store() {
    return this.disk.stores.get(this.name)!;
  }

  get(key: unknown): FakeRequest<Rec | undefined> {
    const fail = this.disk.failNextGet;
    this.disk.failNextGet = false;
    return this.tx.enqueue(() => this.store.data.get(key), fail);
  }

  getAll(): FakeRequest<Rec[]> {
    const fail = this.disk.failNextGet;
    this.disk.failNextGet = false;
    return this.tx.enqueue(() => Array.from(this.store.data.values()), fail);
  }

  put(value: Rec, key?: unknown): FakeRequest<unknown> {
    return this.tx.enqueue(() => {
      const { keyPath } = this.store;
      // Real IDB throws DataError on both of these. Keeping them enforced is
      // what makes the schema in onupgradeneeded load-bearing: give the meta
      // store a keyPath, or drop the files store's, and these throw.
      if (keyPath && key !== undefined) {
        throw new Error('DataError: in-line keys cannot take an explicit key');
      }
      if (!keyPath && key === undefined) {
        throw new Error('DataError: out-of-line keys require an explicit key');
      }
      const k = keyPath ? (value as Record<string, unknown>)[keyPath] : key;
      this.store.data.set(k, { ...value });
      return k;
    });
  }

  delete(key: unknown): FakeRequest<undefined> {
    return this.tx.enqueue(() => {
      this.store.data.delete(key);
      return undefined;
    });
  }

  clear(): FakeRequest<undefined> {
    return this.tx.enqueue(() => {
      this.store.data.clear();
      return undefined;
    });
  }
}

class FakeDatabase {
  constructor(private disk: FakeDisk) {}

  get objectStoreNames() {
    const disk = this.disk;
    return { contains: (name: string) => disk.stores.has(name) };
  }

  createObjectStore(name: string, options?: { keyPath?: string }): void {
    this.disk.stores.set(name, { keyPath: options?.keyPath ?? null, data: new Map() });
  }

  transaction(names: string | string[], mode: 'readonly' | 'readwrite' = 'readonly'): FakeTransaction {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) {
      if (!this.disk.stores.has(n)) throw new Error(`NotFoundError: no object store ${n}`);
    }
    return new FakeTransaction(this.disk, list, mode);
  }
}

class FakeOpenRequest extends FakeRequest<FakeDatabase> {
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

function installFakeIndexedDb(disk: FakeDisk): void {
  vi.stubGlobal('indexedDB', {
    open(_name: string, version: number) {
      const request = new FakeOpenRequest();
      queueMicrotask(() => {
        if (disk.failNextOpen) {
          disk.failNextOpen = false;
          request.error = new Error('IndexedDB open failed');
          request.onerror?.();
          return;
        }
        request.result = new FakeDatabase(disk);
        if (version > disk.version) {
          disk.version = version;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  });
}

// ======================== TEST FIXTURES ========================

const FILES_STORE = 'files';
const META_STORE = 'meta';
const META_KEY = 'cache-meta';

let disk: FakeDisk;
let mintedBlobs: Blob[];
let revoked: string[];
let urlCounter: number;

function fileRows(): Rec[] {
  return Array.from(disk.stores.get(FILES_STORE)?.data.values() ?? []);
}

function fetchOf(bytes: number, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: async () => new Blob(['x'.repeat(bytes)], { type: 'image/jpeg' }),
  };
}

/** Production construction site: no store argument, so the real
 *  IndexedDbCacheStore is what gets built. Size is given in bytes for legibility. */
function manager(maxBytes = 1024 * 1024) {
  return new TvCacheManager(maxBytes / (1024 * 1024));
}

beforeEach(() => {
  disk = new FakeDisk();
  mintedBlobs = [];
  revoked = [];
  urlCounter = 0;
  installFakeIndexedDb(disk);
  vi.stubGlobal('fetch', vi.fn(async () => fetchOf(4)));
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn((b: Blob) => {
      mintedBlobs.push(b);
      return `blob:mock-${++urlCounter}`;
    }),
    revokeObjectURL: vi.fn((u: string) => revoked.push(u)),
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('schema + round-trip through real IndexedDB plumbing', () => {
  it('creates both object stores on first open', async () => {
    // onupgradeneeded had no coverage at all. If either createObjectStore is
    // lost, every transaction below throws NotFoundError and the cache is dead
    // on a factory-fresh TV — the one device state nobody tests on.
    await manager().init();
    expect(disk.stores.has(FILES_STORE)).toBe(true);
    expect(disk.stores.has(META_STORE)).toBe(true);
    expect(disk.stores.get(FILES_STORE)!.keyPath).toBe('contentId');
    expect(disk.stores.get(META_STORE)!.keyPath).toBeNull();
  });

  it('persists a downloaded asset that a SEPARATE store instance can read back', async () => {
    const first = manager();
    expect(await first.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBe('blob:mock-1');

    // A brand-new manager builds a brand-new IndexedDbCacheStore with an empty
    // dbPromise, so this read can only succeed by going back through open() and
    // a fresh readonly transaction. That is what makes it an offline-survival
    // test rather than an in-memory-map test.
    const second = manager();
    expect(await second.getCachedUri('c1')).toBe('blob:mock-2');
    expect(await mintedBlobs[1].text()).toBe('xxxx');
    expect(mintedBlobs[1].type).toBe('image/jpeg');
  });

  it('stores the blob itself, not a stripped record', async () => {
    // Harness self-check: if the double dropped blobs on write, the round-trip
    // above would be asserting against a blob it never persisted.
    await manager().downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(fileRows()[0].blob).toBeInstanceOf(Blob);
    expect(fileRows()[0].size).toBe(4);
  });

  it('returns null for an id that was never cached, and mints no URL', async () => {
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(await m.getCachedUri('never-seen')).toBeNull();
    expect(urlCounter).toBe(1); // only c1's
  });

  it('writes cache meta under the out-of-line key', async () => {
    // The meta store is keyed OUT OF LINE (put(value, META_KEY)). A schema
    // change that gives it a keyPath makes this a DataError at runtime, which
    // would surface as "tenant stamp silently never written" — i.e. a cache
    // that dodges the tenant purge.
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(disk.stores.get(META_STORE)!.data.get(META_KEY)).toEqual({ tenantId: 'tenant-a' });
  });

  it('deletes rows from IndexedDB on tenant purge — files AND the stamp', async () => {
    const m = manager();
    m.setExpectedTenant('tenant-a');
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    expect(fileRows()).toHaveLength(1);

    m.setExpectedTenant('tenant-b'); // re-pair in the same process
    expect(await m.getCachedUri('c1')).toBeNull();

    expect(fileRows()).toHaveLength(0);
    expect(disk.stores.get(META_STORE)!.data.size).toBe(0);
    // And it is gone from the DB, not just from this instance's view.
    expect(await manager().getCachedUri('c1')).toBeNull();
  });
});

describe('size cap / LRU eviction against IndexedDB', () => {
  it('evicts the least-recently-used rows once the cap is exceeded', async () => {
    vi.useFakeTimers();
    try {
      const m = manager(10); // 10 bytes: three 4-byte assets do not fit
      vi.setSystemTime(1_000);
      expect(await m.downloadContent('c1', 'https://cdn/1.jpg', 'image/jpeg')).toBe('blob:mock-1');
      vi.setSystemTime(2_000);
      expect(await m.downloadContent('c2', 'https://cdn/2.jpg', 'image/jpeg')).toBe('blob:mock-2');
      vi.setSystemTime(3_000);
      expect(await m.downloadContent('c3', 'https://cdn/3.jpg', 'image/jpeg')).toBe('blob:mock-3');

      // 12 > 10, so exactly one row goes, and it is the oldest.
      const ids = fileRows().map(r => r.contentId);
      expect(ids).toEqual(['c2', 'c3']);
      expect(m.getCacheStats()).toEqual({ itemCount: 2, totalSizeMB: 0, maxSizeMB: 10 / 1024 / 1024 });
      // The evicted asset's object URL must die with it, or the DOM keeps a
      // handle to a blob the cache believes it has released.
      expect(revoked).toEqual(['blob:mock-1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rebuilds its size accounting from IndexedDB at init', async () => {
    // statsTotalBytes is seeded by listEntries() at init. If the getAll path
    // regressed, a restarted device would believe its cache was empty and
    // never evict — the cap would be enforced by QuotaExceededError instead.
    await manager().downloadContent('c1', 'https://cdn/1.jpg', 'image/jpeg');
    const restarted = manager(10);
    await restarted.init();
    expect(restarted.getCacheStats().itemCount).toBe(1);
  });
});

describe('quota + failure degradation', () => {
  it('QUOTA AT COMMIT: a write whose request succeeded but whose transaction aborts is NOT reported as cached', async () => {
    // The reason txDone() waits for `oncomplete` rather than the request's
    // `onsuccess` (tv-cache-manager.ts:60-71). On a quota-constrained TV the put
    // request succeeds and the transaction aborts at commit. Resolving on
    // success would hand the caller an object URL for content IndexedDB never
    // kept — and, worse, would leave the manager's size accounting believing
    // bytes exist that do not, so eviction never reclaims them.
    disk.abortWritesTo = FILES_STORE;
    const m = manager();
    // The bytes are in hand, so playback continues — but NOTHING may be recorded
    // as cached. The accounting assertions are the point of this test: resolving
    // on the request's onsuccess would leave the manager believing bytes exist
    // that IndexedDB never kept, and eviction would then never reclaim them.
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).not.toBeNull();
    expect(fileRows()).toHaveLength(0);
    const stats = m.getCacheStats();
    expect(stats.itemCount).toBe(0);
    expect(stats.totalSizeMB).toBe(0);
  });

  it('a quota failure degrades that ONE asset, not the playlist', async () => {
    // Contract as of the quota-eviction fix: an asset that cannot be STORED is
    // still PLAYED, from the blob already downloaded. Failing playback because
    // storage is full would turn a capacity problem into a black screen. What
    // must not happen is the failure poisoning later assets or latching the
    // asset as permanently un-cacheable.
    disk.abortWritesTo = FILES_STORE;
    const m = manager();
    expect(await m.downloadContent('c1', 'https://cdn/1.jpg', 'image/jpeg')).not.toBeNull();
    expect(fileRows()).toHaveLength(0);

    disk.abortWritesTo = null;
    expect(await m.downloadContent('c2', 'https://cdn/2.jpg', 'image/jpeg')).not.toBeNull();
    // ...and the in-flight latch released, so the quota-failed asset is retried
    // and now actually lands.
    expect(await m.downloadContent('c1', 'https://cdn/1.jpg', 'image/jpeg')).not.toBeNull();
    expect(fileRows().map((r) => r.contentId).sort()).toEqual(['c1', 'c2']);
  });

  it('QUOTA ON A CACHE HIT: a freshness-write failure must not turn a hit into a miss', async () => {
    // The regression this exists for. getCachedUri refreshes lastAccessed at most
    // once a minute; that write used to be awaited un-guarded, so on a quota-full
    // TV the rejection propagated and the caller streamed from the network — even
    // though the blob was in hand and the row was still in IDB. Every asset older
    // than the write interval silently stopped being served from cache, in exactly
    // the situation (storage full, probably offline) the cache exists for.
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/1.jpg', 'image/jpeg');
    expect(fileRows()).toHaveLength(1);

    // Age the stored row past ACCESS_WRITE_INTERVAL_MS so the refresh fires.
    const row = fileRows()[0] as Rec & { lastAccessed: number };
    row.lastAccessed = Date.now() - 10 * 60_000;

    disk.abortWritesTo = FILES_STORE; // the refresh write will now fail
    const uri = await m.getCachedUri('c1');

    expect(uri).not.toBeNull();       // still a HIT
    expect(fileRows()).toHaveLength(1); // and the row is untouched
  });

  it('QUOTA ON DOWNLOAD: evicts LRU first, retries once, and the asset lands', async () => {
    // Real system time, not a hand-edited row: eviction orders on
    // max(storedLastAccessed, lastAccessOverlay), and the overlay is written at
    // download time. Ageing only the stored row leaves the overlay fresh, so both
    // entries score equal and the ordering assertion cannot fail — which is how an
    // earlier version of this test passed with the comparator reversed.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const m = manager();
      await m.downloadContent('old', 'https://cdn/old.jpg', 'image/jpeg');

      vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
      await m.downloadContent('recent', 'https://cdn/recent.jpg', 'image/jpeg');

      // Fail only the first write of the new asset. Eviction's DELETE and the retry
      // then succeed — the shape of a real quota rejection that eviction resolves.
      vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
      disk.abortNextWriteTo = FILES_STORE;
      const uri = await m.downloadContent('new', 'https://cdn/new.jpg', 'image/jpeg');

      expect(uri).not.toBeNull();
      const ids = fileRows().map((r) => r.contentId);
      expect(ids).toContain('new');       // stored on the retry
      expect(ids).not.toContain('old');   // the LRU victim went first
      expect(ids).toContain('recent');    // the newer entry survived
    } finally {
      vi.useRealTimers();
    }
  });

  it('QUOTA ON DOWNLOAD: eviction never evicts the entry it is making room for', async () => {
    // Exercised directly, because it is not reachable through downloadContent — an
    // entry being downloaded is not yet in the store, so the guard is defensive.
    // It is still load-bearing: evicting the target would free space and then
    // immediately re-fail the retry. Asserting it through the public API would be
    // vacuous, so this calls the internal and says so.
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/1.jpg', 'image/jpeg');
    await m.downloadContent('c2', 'https://cdn/2.jpg', 'image/jpeg');

    const evict = (m as unknown as {
      evictForQuota(needBytes: number, protectId: string): Promise<number>;
    }).evictForQuota.bind(m);

    // Ask for more than the cache holds, so it would evict everything it may.
    await evict(10_000, 'c1');

    const ids = fileRows().map((r) => r.contentId);
    expect(ids).toContain('c1');     // protected
    expect(ids).not.toContain('c2'); // everything else was fair game
  });

  it('QUOTA UNRESOLVABLE: playback continues uncached rather than failing', async () => {
    // Eviction cannot always free enough. When it cannot, the downloaded blob is
    // still played and accounting is NOT inflated — the alternative is a black
    // screen caused by a storage problem.
    disk.abortWritesTo = FILES_STORE; // every write fails, eviction cannot help
    const m = manager();
    const uri = await m.downloadContent('big', 'https://cdn/big.mp4', 'video/mp4');

    expect(uri).not.toBeNull();
    expect(fileRows()).toHaveLength(0);
    expect(m.getCacheStats().itemCount).toBe(0);
  });

  it('a NON-quota write failure still degrades to null — the detector is not a catch-all', () => {
    // Guards the blast radius of isQuotaExceeded. Only a capacity signal may take
    // the evict-and-retry path; every other write failure keeps the original
    // "degrade to null, caller streams the network URL" contract.
    expect(isQuotaExceeded(new Error('QuotaExceededError'))).toBe(true);
    expect(isQuotaExceeded(Object.assign(new Error('x'), { name: 'QuotaExceededError' }))).toBe(true);
    expect(isQuotaExceeded(new Error('AbortError: transaction aborted'))).toBe(false);
    expect(isQuotaExceeded(new Error('ConstraintError'))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
  });

  it('a failing read request degrades to null instead of rejecting', async () => {
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    disk.failNextGet = true;
    await expect(m.getCachedUri('c1')).resolves.toBeNull();
  });

  it('a failed open is retried on the next call rather than poisoning the session', async () => {
    // tv-cache-manager.ts:94-96. A rejected dbPromise that stayed cached would
    // disable caching for the whole process after one transient IDB hiccup at
    // boot — which is precisely when offline resilience is being set up.
    disk.failNextOpen = true;
    const m = manager();
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBeNull();

    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBe('blob:mock-1');
    expect(fileRows()).toHaveLength(1);
  });

  it('disables itself when IndexedDB is absent from the runtime entirely', async () => {
    // Only reachable with the production default store — the guard is
    // `typeof indexedDB === 'undefined' && this.store instanceof
    // IndexedDbCacheStore`, so the injected-MemoryStore suite can never take it.
    vi.stubGlobal('indexedDB', undefined);
    const m = manager();
    expect(await m.getCachedUri('c1')).toBeNull();
    expect(await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg')).toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('clearCache REJECTS when IndexedDB refuses to clear', async () => {
    // purgeDeviceState collects this in Promise.allSettled; swallowing it here
    // would record a failed revocation purge as fulfilled and
    // `device_purge_incomplete` would never fire on a Samsung TV.
    const m = manager();
    await m.downloadContent('c1', 'https://cdn/x.jpg', 'image/jpeg');
    disk.abortWritesTo = FILES_STORE;
    await expect(m.clearCache()).rejects.toThrow();
  });
});
