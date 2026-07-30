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

  private async tx(storeName: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.openDb();
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  async getEntry(id: string): Promise<TvCacheEntry | null> {
    const store = await this.tx(FILES_STORE, 'readonly');
    return (await req(store.get(id))) ?? null;
  }

  async putEntry(entry: TvCacheEntry): Promise<void> {
    const store = await this.tx(FILES_STORE, 'readwrite');
    await req(store.put(entry));
  }

  async deleteEntry(id: string): Promise<void> {
    const store = await this.tx(FILES_STORE, 'readwrite');
    await req(store.delete(id));
  }

  async listEntries(): Promise<Array<Omit<TvCacheEntry, 'blob'>>> {
    const store = await this.tx(FILES_STORE, 'readonly');
    const all: TvCacheEntry[] = await req(store.getAll());
    // Strip blobs so eviction scans don't hold every asset in memory.
    return all.map(({ contentId, size, mimeType, lastAccessed, downloadedAt }) => ({
      contentId, size, mimeType, lastAccessed, downloadedAt,
    }));
  }

  async getMeta(): Promise<TvCacheMeta | null> {
    const store = await this.tx(META_STORE, 'readonly');
    return (await req(store.get(META_KEY))) ?? null;
  }

  async putMeta(meta: TvCacheMeta): Promise<void> {
    const store = await this.tx(META_STORE, 'readwrite');
    await req(store.put(meta, META_KEY));
  }

  async clearAll(): Promise<void> {
    const files = await this.tx(FILES_STORE, 'readwrite');
    await req(files.clear());
    const meta = await this.tx(META_STORE, 'readwrite');
    await req(meta.clear());
  }
}

export class TvCacheManager {
  private static readonly ACCESS_WRITE_INTERVAL_MS = 60_000;

  private store: TvCacheStore;
  private maxCacheSizeMB: number;
  private downloadingSet = new Set<string>();
  private initialized = false;
  private initFailed = false;
  private expectedTenant: string | null = null;
  /** id → live object URL, revoked on eviction/clear to avoid leaking blobs. */
  private objectUrls = new Map<string, string>();

  constructor(maxCacheSizeMB = 500, store?: TvCacheStore) {
    this.maxCacheSizeMB = maxCacheSizeMB;
    this.store = store ?? new IndexedDbCacheStore();
  }

  /** Tenant binding — same contract as AndroidCacheManager.setExpectedTenant. */
  setExpectedTenant(tenantId: string | null): void {
    this.expectedTenant = tenantId;
  }

  async init(): Promise<void> {
    if (this.initialized || this.initFailed) return;

    if (typeof indexedDB === 'undefined' && this.store instanceof IndexedDbCacheStore) {
      console.warn('[TvCache] IndexedDB unavailable — cache disabled, streaming direct');
      this.initFailed = true;
      return;
    }

    try {
      const meta = await this.store.getMeta();
      if (meta?.tenantId && this.expectedTenant && meta.tenantId !== this.expectedTenant) {
        console.warn('[TvCache] Cache belongs to a different tenant — clearing');
        await this.store.clearAll();
      }
      this.initialized = true;
    } catch (err) {
      console.warn('[TvCache] init failed — cache disabled, streaming direct:', err);
      this.initFailed = true;
    }
  }

  async downloadContent(id: string, url: string, mimeType: string): Promise<string | null> {
    if (this.downloadingSet.has(id)) return null;

    await this.init();
    if (!this.initialized) return null;

    const existing = await this.getCachedUri(id);
    if (existing) return existing;

    this.downloadingSet.add(id);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const blob = await response.blob();

      const entry: TvCacheEntry = {
        contentId: id,
        blob,
        size: blob.size,
        mimeType: blob.type || mimeType,
        lastAccessed: Date.now(),
        downloadedAt: Date.now(),
      };
      await this.store.putEntry(entry);
      if (this.expectedTenant) {
        await this.store.putMeta({ tenantId: this.expectedTenant });
      }
      await this.enforceMaxCacheSize();

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

    // A live object URL is already backed by an in-memory blob — reuse it.
    const live = this.objectUrls.get(id);

    try {
      const entry = await this.store.getEntry(id);
      if (!entry) {
        this.revokeObjectUrl(id);
        return null;
      }
      // Persist lastAccessed at most once a minute — an IDB put rewrites the
      // whole record (blob included, via structured clone), which is too heavy
      // to pay on every playlist rotation past a large video.
      if (Date.now() - entry.lastAccessed > TvCacheManager.ACCESS_WRITE_INTERVAL_MS) {
        entry.lastAccessed = Date.now();
        await this.store.putEntry(entry);
      }
      return live ?? this.trackObjectUrl(id, entry.blob);
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
      if (totalSize <= maxBytes) return;

      const byOldest = entries.slice().sort((a, b) => a.lastAccessed - b.lastAccessed);
      for (const entry of byOldest) {
        if (totalSize <= maxBytes) break;
        await this.store.deleteEntry(entry.contentId);
        this.revokeObjectUrl(entry.contentId);
        totalSize -= entry.size;
        console.log(`[TvCache] Evicted ${entry.contentId}`);
      }
    } catch (err) {
      console.warn('[TvCache] eviction failed:', err);
    }
  }

  async clearCache(): Promise<void> {
    try {
      await this.store.clearAll();
      for (const id of Array.from(this.objectUrls.keys())) {
        this.revokeObjectUrl(id);
      }
      console.log('[TvCache] Cache cleared');
    } catch (err) {
      console.error('[TvCache] Failed to clear cache:', err);
    }
  }

  getCacheStats(): { itemCount: number; totalSizeMB: number; maxSizeMB: number } {
    // Synchronous signature is part of the shared interface; the async store
    // can't be consulted here. Report live object-URL count as the item count
    // (what is actually usable this session) — the authoritative accounting
    // lives in enforceMaxCacheSize.
    return {
      itemCount: this.objectUrls.size,
      totalSizeMB: 0,
      maxSizeMB: this.maxCacheSizeMB,
    };
  }

  private trackObjectUrl(id: string, blob: Blob): string {
    this.revokeObjectUrl(id);
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
