/**
 * Content cache for the TV web runtimes (Samsung Tizen / LG webOS) and plain
 * browsers, where Capacitor Filesystem URIs are not resolvable by the page.
 *
 * Same public surface as AndroidCacheManager (main.ts treats them
 * interchangeably): init, setExpectedTenant, downloadContent, getCachedUri,
 * enforceMaxCacheSize, clearCache, getCacheStats.
 *
 * Storage: IndexedDB holding raw Blobs (no base64 inflation), served to the
 * DOM via object URLs. Every failure degrades to `null`, which makes the
 * caller fall back to streaming the original network URL — the cache is an
 * offline-resilience layer, never a playback gate.
 *
 * The tenant-binding contract matches AndroidCacheManager (P0-2 §1.4/§2):
 * a cache written under a different tenant is purged wholesale at init.
 */

interface TvCacheEntry {
  contentId: string;
  blob: Blob;
  size: number;
  mimeType: string;
  lastAccessed: number;
  downloadedAt: number;
}

interface TvCacheMeta {
  tenantId?: string;
}

/**
 * Minimal async KV surface the manager runs on. The IndexedDB implementation
 * is the production path; tests inject an in-memory implementation so the
 * eviction/tenant/dedup logic is exercised without an IDB shim.
 */
export interface TvCacheStore {
  getEntry(id: string): Promise<TvCacheEntry | null>;
  putEntry(entry: TvCacheEntry): Promise<void>;
  deleteEntry(id: string): Promise<void>;
  listEntries(): Promise<Array<Omit<TvCacheEntry, 'blob'>>>;
  getMeta(): Promise<TvCacheMeta | null>;
  putMeta(meta: TvCacheMeta): Promise<void>;
  clearAll(): Promise<void>;
}

const DB_NAME = 'vizora-content-cache';
const DB_VERSION = 1;
const FILES_STORE = 'files';
const META_STORE = 'meta';
const META_KEY = 'cache-meta';

/** Promisify an IDBRequest. */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/**
 * Resolve when the transaction COMMITS (not when the request succeeds): on
 * quota-constrained TV storage a write request can "succeed" and the
 * transaction still abort at commit (QuotaExceededError) — reporting success
 * then would leave the manager believing an entry is persisted when it isn't.
 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

class IndexedDbCacheStore implements TvCacheStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(FILES_STORE)) {
            db.createObjectStore(FILES_STORE, { keyPath: 'contentId' });
          }
          if (!db.objectStoreNames.contains(META_STORE)) {
            db.createObjectStore(META_STORE);
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
        open.onblocked = () => reject(new Error('IndexedDB open blocked'));
      });
      // A failed open must not poison every later call with the same
      // rejected promise — allow a retry on the next operation.
      this.dbPromise.catch(() => { this.dbPromise = null; });
    }
    return this.dbPromise;
  }

  async getEntry(id: string): Promise<TvCacheEntry | null> {
    const db = await this.openDb();
    const store = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE);
    return (await req(store.get(id))) ?? null;
  }

  async putEntry(entry: TvCacheEntry): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(FILES_STORE, 'readwrite');
    tx.objectStore(FILES_STORE).put(entry);
    await txDone(tx);
  }

  async deleteEntry(id: string): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(FILES_STORE, 'readwrite');
    tx.objectStore(FILES_STORE).delete(id);
    await txDone(tx);
  }

  async listEntries(): Promise<Array<Omit<TvCacheEntry, 'blob'>>> {
    const db = await this.openDb();
    const store = db.transaction(FILES_STORE, 'readonly').objectStore(FILES_STORE);
    const all: TvCacheEntry[] = await req(store.getAll());
    // Strip blobs so eviction scans don't hold every asset in memory.
    return all.map(({ contentId, size, mimeType, lastAccessed, downloadedAt }) => ({
      contentId, size, mimeType, lastAccessed, downloadedAt,
    }));
  }

  async getMeta(): Promise<TvCacheMeta | null> {
    const db = await this.openDb();
    const store = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
    return (await req(store.get(META_KEY))) ?? null;
  }

  async putMeta(meta: TvCacheMeta): Promise<void> {
    const db = await this.openDb();
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(meta, META_KEY);
    await txDone(tx);
  }

  async clearAll(): Promise<void> {
    const db = await this.openDb();
    // Files first: a partial failure must err toward "stamp survives, blobs
    // gone", never the reverse (an unstamped populated cache would dodge the
    // tenant purge at the next init).
    const filesTx = db.transaction(FILES_STORE, 'readwrite');
    filesTx.objectStore(FILES_STORE).clear();
    await txDone(filesTx);
    const metaTx = db.transaction(META_STORE, 'readwrite');
    metaTx.objectStore(META_STORE).clear();
    await txDone(metaTx);
  }
}

export class TvCacheManager {
  private static readonly ACCESS_WRITE_INTERVAL_MS = 60_000;

  private store: TvCacheStore;
  private maxCacheSizeMB: number;
  private downloadingSet = new Set<string>();
  private initialized = false;
  /** Latched only for a structurally absent IndexedDB — transient init
   *  failures leave this false so the next call retries. */
  private cacheUnavailable = false;
  private initPromise: Promise<void> | null = null;
  private expectedTenant: string | null = null;
  /** id → live object URL. Minted once per id and reused — see trackObjectUrl. */
  private objectUrls = new Map<string, string>();
  /**
   * In-memory freshness overlay: the persisted lastAccessed is throttled to
   * one write a minute, so eviction consults max(persisted, overlay) — the
   * asset currently on glass must never be the LRU victim just because its
   * access timestamp hasn't been flushed yet.
   */
  private lastAccessOverlay = new Map<string, number>();
  // Persisted-cache accounting for getCacheStats (refreshed at init,
  // maintained on put/evict/clear).
  private statsItemCount = 0;
  private statsTotalBytes = 0;
  /**
   * Bumped by clearCache. An async cache operation that was in flight when a
   * clear ran (revocation purge §3.4) must NOT write its entry back or mint a
   * fresh object URL afterward — that would resurrect purged-tenant content
   * into a cleared, unstamped store.
   */
  private clearGeneration = 0;

  // Default is lower than AndroidCacheManager's 500 MB: real TV IndexedDB
  // quotas are typically well under that, and it's better for the LRU
  // eviction to own the ceiling than for QuotaExceededError to.
  constructor(maxCacheSizeMB = 200, store?: TvCacheStore) {
    this.maxCacheSizeMB = maxCacheSizeMB;
    this.store = store ?? new IndexedDbCacheStore();
  }

  /** Tenant binding — same contract as AndroidCacheManager.setExpectedTenant. */
  setExpectedTenant(tenantId: string | null): void {
    if (tenantId === this.expectedTenant) return; // no-op call must not re-run doInit
    this.expectedTenant = tenantId;
    // Re-arm the tenant-mismatch purge. It lives inside doInit(), which init()
    // early-returns past once initialized, so re-pairing to a DIFFERENT tenant in the
    // same process left the previous tenant's blobs in IndexedDB and servable. That
    // is reachable today: a confirmed revocation calls startPairing() WITHOUT a
    // reload, so tenant A → tenant B happens in one process.
    this.initialized = false;
  }

  async init(): Promise<void> {
    if (this.initialized || this.cacheUnavailable) return;
    // Serialize concurrent initializers (render + preload race at boot).
    if (!this.initPromise) {
      this.initPromise = this.doInit().finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    if (typeof indexedDB === 'undefined' && this.store instanceof IndexedDbCacheStore) {
      console.warn('[TvCache] IndexedDB unavailable — cache disabled, streaming direct');
      this.cacheUnavailable = true;
      return;
    }

    try {
      const meta = await this.store.getMeta();
      if (meta?.tenantId && this.expectedTenant && meta.tenantId !== this.expectedTenant) {
        console.warn('[TvCache] Cache belongs to a different tenant — clearing');
        await this.store.clearAll();
      }
      const entries = await this.store.listEntries();
      this.statsItemCount = entries.length;
      this.statsTotalBytes = entries.reduce((sum, e) => sum + e.size, 0);
      this.initialized = true;
    } catch (err) {
      // NOT latched: a transient IndexedDB hiccup at boot must not disable
      // caching for the whole session (offline resilience depends on it) —
      // the next cache call retries init.
      console.warn('[TvCache] init failed — will retry on next cache access:', err);
    }
  }

  async downloadContent(id: string, url: string, mimeType: string): Promise<string | null> {
    if (this.downloadingSet.has(id)) return null;

    await this.init();
    if (!this.initialized) return null;

    const existing = await this.getCachedUri(id);
    if (existing) return existing;

    // Re-check after the async gap above: a concurrent caller may have begun
    // this download while we awaited init/getCachedUri.
    if (this.downloadingSet.has(id)) return null;
    this.downloadingSet.add(id);
    const gen = this.clearGeneration;
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();
      if (gen !== this.clearGeneration) return null; // cache was purged mid-download

      const entry: TvCacheEntry = {
        contentId: id,
        blob,
        size: blob.size,
        mimeType: blob.type || mimeType,
        lastAccessed: Date.now(),
        downloadedAt: Date.now(),
      };
      // Stamp the tenant BEFORE persisting the entry: a crash between the two
      // IDB transactions must not leave tenant-bound blobs in a cache with no
      // tenant stamp — an unstamped-but-populated cache would slip through the
      // init purge via the legacy-grace path (contract §1.4/§2). Stamp-first
      // fails in the safe direction (stamp with no entries).
      if (this.expectedTenant) {
        await this.store.putMeta({ tenantId: this.expectedTenant });
      }
      await this.store.putEntry(entry);
      this.statsItemCount += 1;
      this.statsTotalBytes += entry.size;
      this.lastAccessOverlay.set(id, entry.lastAccessed);
      await this.enforceMaxCacheSize();
      // Re-check after the persist awaits: IDB transaction ordering means a
      // concurrent clear wipes the rows we just wrote, but we must not hand
      // out a live URL for purged content either.
      if (gen !== this.clearGeneration) return null;

      const objectUrl = this.trackObjectUrl(id, blob);
      console.log(`[TvCache] Cached: ${id} (${blob.size} bytes)`);
      return objectUrl;
    } catch (err) {
      console.error(`[TvCache] Failed to cache ${id}:`, err);
      return null;
    } finally {
      this.downloadingSet.delete(id);
    }
  }

  async getCachedUri(id: string): Promise<string | null> {
    await this.init();
    if (!this.initialized) return null;

    const gen = this.clearGeneration;
    try {
      const entry = await this.store.getEntry(id);
      if (gen !== this.clearGeneration) return null; // cache was purged mid-read
      if (!entry) {
        this.revokeObjectUrl(id);
        return null;
      }
      this.lastAccessOverlay.set(id, Date.now());
      // Persist lastAccessed at most once a minute — an IDB put rewrites the
      // whole record (blob included, via structured clone), which is too heavy
      // to pay on every playlist rotation past a large video. Eviction reads
      // the in-memory overlay, so freshness is never lost, only deferred.
      if (Date.now() - entry.lastAccessed > TvCacheManager.ACCESS_WRITE_INTERVAL_MS) {
        entry.lastAccessed = Date.now();
        await this.store.putEntry(entry);
        if (gen !== this.clearGeneration) return null; // purged during the write
      }
      return this.trackObjectUrl(id, entry.blob);
    } catch (err) {
      console.warn(`[TvCache] getCachedUri(${id}) failed:`, err);
      return null;
    }
  }

  async enforceMaxCacheSize(): Promise<void> {
    const maxBytes = this.maxCacheSizeMB * 1024 * 1024;
    try {
      const entries = await this.store.listEntries();
      let totalSize = entries.reduce((sum, e) => sum + e.size, 0);
      this.statsItemCount = entries.length;
      this.statsTotalBytes = totalSize;
      if (totalSize <= maxBytes) return;

      const effectiveAccess = (e: { contentId: string; lastAccessed: number }) =>
        Math.max(e.lastAccessed, this.lastAccessOverlay.get(e.contentId) ?? 0);
      const byOldest = entries.slice().sort((a, b) => effectiveAccess(a) - effectiveAccess(b));
      for (const entry of byOldest) {
        if (totalSize <= maxBytes) break;
        await this.store.deleteEntry(entry.contentId);
        this.revokeObjectUrl(entry.contentId);
        this.lastAccessOverlay.delete(entry.contentId);
        totalSize -= entry.size;
        this.statsItemCount -= 1;
        this.statsTotalBytes -= entry.size;
        console.log(`[TvCache] Evicted ${entry.contentId}`);
      }
    } catch (err) {
      console.warn('[TvCache] eviction failed:', err);
    }
  }

  async clearCache(): Promise<void> {
    this.clearGeneration++;
    // Revoke first: clearCache is on the confirmed-revocation purge path
    // (purgeDeviceState §3.4) — live blob: URLs of the purged tenant's content
    // must die even if the IDB clear below throws.
    for (const id of Array.from(this.objectUrls.keys())) {
      this.revokeObjectUrl(id);
    }
    this.lastAccessOverlay.clear();
    this.statsItemCount = 0;
    this.statsTotalBytes = 0;
    try {
      await this.store.clearAll();
      console.log('[TvCache] Cache cleared');
    } catch (err) {
      // REJECT, matching AndroidCacheManager: purgeDeviceState collects this call in
      // a Promise.allSettled, so swallowing here recorded a failed cache clear as
      // fulfilled and `device_purge_incomplete` never fired on Tizen/webOS. The two
      // managers are used interchangeably by main.ts, so their failure contracts
      // have to match or the telemetry is only honest on Android.
      console.error('[TvCache] Failed to clear cache:', err);
      throw err;
    }
  }

  getCacheStats(): { itemCount: number; totalSizeMB: number; maxSizeMB: number } {
    return {
      itemCount: this.statsItemCount,
      totalSizeMB: Math.round(this.statsTotalBytes / 1024 / 1024 * 100) / 100,
      maxSizeMB: this.maxCacheSizeMB,
    };
  }

  /**
   * Mint (or reuse) the object URL for an id. REUSE is load-bearing: two
   * concurrent cache calls for the same id (render path + preload race on a
   * playlist update) must not revoke-and-replace each other's URL — the first
   * caller would be handed a URL that is dead by the time it reaches img.src.
   * An id's blob only changes after eviction, which removes the id from this
   * map, so a live mapping is always backed by the current blob.
   */
  private trackObjectUrl(id: string, blob: Blob): string {
    const existing = this.objectUrls.get(id);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    this.objectUrls.set(id, url);
    return url;
  }

  private revokeObjectUrl(id: string): void {
    const url = this.objectUrls.get(id);
    if (url) {
      try { URL.revokeObjectURL(url); } catch { /* already gone */ }
      this.objectUrls.delete(id);
    }
  }
}
