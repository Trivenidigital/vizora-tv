import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

interface CacheManifestEntry {
  contentId: string;
  fileName: string;
  size: number;
  mimeType: string;
  lastAccessed: number;
  downloadedAt: number;
}

interface CacheManifest {
  entries: Record<string, CacheManifestEntry>;
  version: number;
  /** Tenant the cached assets were downloaded under (P0-2 tenant binding). */
  tenantId?: string;
}

export class AndroidCacheManager {
  private cacheDir = 'content-cache';
  private manifest: CacheManifest = { entries: {}, version: 1 };
  private maxCacheSizeMB: number;
  private downloadingSet: Set<string> = new Set();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private manifestDirty = false;
  private debounceSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly DEBOUNCE_INTERVAL = 60000;

  private expectedTenant: string | null = null;
  /**
   * Bumped by clearCache(). An operation that started before the bump must not
   * write, nor hand out a URI, after it — same contract as TvCacheManager.
   */
  private clearGeneration = 0;
  /**
   * Bumped by setExpectedTenant(). doInit() captures it on entry and refuses to
   * declare itself initialized if it moved underneath — otherwise a tenant change
   * landing inside an in-flight init is absorbed by that init's final
   * `initialized = true` and the mismatch purge never runs at all.
   */
  private tenantGeneration = 0;
  /**
   * Latched when the emptied manifest could NOT be written to disk, i.e. the purge
   * left a populated manifest.json behind. While latched, whatever loadManifest()
   * reads is discarded — see loadManifest(). Cleared by the first save that lands.
   */
  private purgeFailed = false;

  constructor(maxCacheSizeMB = 500) {
    this.maxCacheSizeMB = maxCacheSizeMB;
  }

  /**
   * Tenant binding (P0-2, contract §1.4/§2): set before first cache use.
   * A cache written under a different tenant is never served — it is purged
   * wholesale at load time, regardless of how it got here.
   */
  setExpectedTenant(tenantId: string | null): void {
    if (tenantId === this.expectedTenant) return;
    this.expectedTenant = tenantId;
    this.tenantGeneration++;
    // Re-arm the tenant-mismatch purge. It lives inside init(), which early-returns
    // once initialized, so re-pairing to a DIFFERENT tenant in the same process left
    // the previous tenant's assets in place and servable.
    this.initialized = false;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    // Serialize concurrent initializers (render + preload race at boot): two callers
    // both running loadManifest() would each overwrite this.manifest, and whichever
    // landed second could clobber entries the first had already recorded.
    if (!this.initPromise) {
      this.initPromise = this.doInit().finally(() => { this.initPromise = null; });
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    // Snapshot the tenant this init is running FOR. setExpectedTenant() re-arms the
    // purge by clearing `initialized`, but an init already past its tenant comparison
    // would still set it back to true at the end — silently swallowing the change, so
    // the mismatch purge never runs for the life of the process. Anything that lands
    // after this point leaves init incomplete, and the next cache call retries it.
    const tenantGen = this.tenantGeneration;

    try {
      await Filesystem.mkdir({
        path: this.cacheDir,
        directory: Directory.Data,
        recursive: true,
      });
    } catch (e) {
      // Directory may already exist
    }

    await this.loadManifest();

    if (this.manifest.tenantId && this.expectedTenant && this.manifest.tenantId !== this.expectedTenant) {
      console.warn('[AndroidCache] Cache belongs to a different tenant — clearing');
      this.initialized = true; // clearCache() re-enters via public API paths
      try {
        await this.clearCache();
      } catch (err) {
        // clearCache REJECTS on a failed disk purge so purgeDeviceState's telemetry
        // is honest — but that rejection must not escape init(): getCachedUri and
        // downloadContent await init() OUTSIDE their try blocks, so propagating here
        // would turn a failed disk purge into a rendering failure. The in-memory
        // manifest is already empty (clearCache resets it before touching the
        // filesystem), so the tenant purge has still failed closed: nothing can name
        // the residual files.
        console.error('[AndroidCache] Tenant purge left residue on disk (cache is empty in memory):', err);
      }
      // No tenantGeneration re-check needed here: setExpectedTenant() clears
      // `initialized` itself, and this branch does not set it again after the await.
      return;
    }

    if (tenantGen !== this.tenantGeneration) return;

    this.initialized = true;
  }

  private async loadManifest(): Promise<void> {
    try {
      const result = await Filesystem.readFile({
        path: `${this.cacheDir}/manifest.json`,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      this.manifest = JSON.parse(result.data as string);
    } catch (e) {
      this.manifest = { entries: {}, version: 1 };
      return;
    }

    // A purge whose emptied manifest could not be persisted stays authoritative over
    // whatever survived on disk. Without this, re-arming init (setExpectedTenant, e.g.
    // purgeDeviceState's setExpectedTenant(null)) re-reads the survivor in the SAME
    // process and hands every purged entry back — under expectedTenant === null, where
    // the tenant-mismatch guard above can never fire. Retry the write while we are here.
    if (this.purgeFailed) {
      console.warn('[AndroidCache] Discarding a manifest that survived a failed purge');
      this.manifest = { entries: {}, version: 1 };
      await this.saveManifest();
    }
  }

  private async saveManifest(): Promise<void> {
    this.manifestDirty = false;
    // Snapshot taken synchronously, before the await — see the re-check below.
    const gen = this.clearGeneration;
    try {
      await Filesystem.writeFile({
        path: `${this.cacheDir}/manifest.json`,
        directory: Directory.Data,
        data: JSON.stringify(this.manifest, null, 2),
        encoding: Encoding.UTF8,
      });
      // Disk now agrees with memory, so a previously unpersistable purge is healed.
      this.purgeFailed = false;
    } catch (error) {
      console.error('[AndroidCache] Failed to save manifest:', error);
      return;
    }

    // A clearCache() that landed while this write was in flight may already have run
    // its own saveManifest(); ours would then resolve last and put the pre-clear
    // snapshot (entries AND tenant stamp) back on disk. Rewrite from current state.
    if (gen !== this.clearGeneration) {
      await this.saveManifest();
    }
  }

  private debouncedSaveManifest(): void {
    this.manifestDirty = true;
    if (!this.debounceSaveTimer) {
      this.debounceSaveTimer = setTimeout(() => {
        this.debounceSaveTimer = null;
        if (this.manifestDirty) {
          this.saveManifest();
        }
      }, AndroidCacheManager.DEBOUNCE_INTERVAL);
    }
  }

  async downloadContent(id: string, url: string, mimeType: string): Promise<string | null> {
    if (this.downloadingSet.has(id)) return null;

    await this.init();

    const existing = await this.getCachedUri(id);
    if (existing) return existing;

    this.downloadingSet.add(id);
    const gen = this.clearGeneration;

    try {
      const ext = this.getExtension(url, mimeType);
      const fileName = `${id}.${ext}`;

      // Download via CapacitorHttp
      const response = await CapacitorHttp.get({
        url,
        responseType: 'blob',
      });

      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }

      // A clearCache() — i.e. the confirmed-revocation purge (purgeDeviceState §3.4) —
      // that landed while this download was in flight must win. Writing now would
      // re-create the directory, write the asset back and re-stamp the manifest with
      // the tenant that was just purged.
      if (gen !== this.clearGeneration) return null;

      // Write to filesystem
      await Filesystem.writeFile({
        path: `${this.cacheDir}/${fileName}`,
        directory: Directory.Data,
        data: response.data,
      });

      // Get file stats
      const stat = await Filesystem.stat({
        path: `${this.cacheDir}/${fileName}`,
        directory: Directory.Data,
      });

      // The pre-write check above is NOT sufficient on its own. clearCache() empties
      // the manifest and rmdirs FIRST, so a purge landing inside the writeFile/stat
      // window is followed by our asset write, our manifest entry, our tenant re-stamp
      // and our saveManifest() — the purged asset lands back on disk named by a
      // manifest that was just emptied, and getCachedUri serves it. Under
      // purgeDeviceState the tenant is unbound first, so the resurrected entry is not
      // even re-stamped: it sits at expectedTenant === null where the mismatch purge
      // can never reach it. Re-check before ANYTHING is committed, and take the file
      // we just wrote back out — the second check further down only gates the RETURN
      // VALUE and undoes nothing.
      if (gen !== this.clearGeneration) {
        await this.deleteQuietly(fileName);
        return null;
      }

      this.manifest.entries[id] = {
        contentId: id,
        fileName,
        size: stat.size || 0,
        mimeType,
        lastAccessed: Date.now(),
        downloadedAt: Date.now(),
      };
      if (this.expectedTenant) {
        this.manifest.tenantId = this.expectedTenant;
      }

      await this.saveManifest();
      await this.enforceMaxCacheSize();

      // Re-check after the persist awaits. By here the clear has already emptied the
      // manifest we wrote into and rmdir'd the asset, so there is nothing left to
      // undo — this guard exists only so a purged id is never handed out as a live
      // URI. (The guard that actually prevents the resurrection is the one above.)
      if (gen !== this.clearGeneration) return null;

      // Get the URI for the cached file and convert for WebView access
      const uriResult = await Filesystem.getUri({
        path: `${this.cacheDir}/${fileName}`,
        directory: Directory.Data,
      });
      const webViewUrl = Capacitor.convertFileSrc(uriResult.uri);

      console.log(`[AndroidCache] Cached: ${id} -> ${webViewUrl}`);
      return webViewUrl;
    } catch (error) {
      console.error(`[AndroidCache] Failed to cache ${id}:`, error);
      return null;
    } finally {
      this.downloadingSet.delete(id);
    }
  }

  async getCachedUri(id: string): Promise<string | null> {
    await this.init();

    // `entry` is captured here but consumed after two awaits, so a clearCache()
    // landing in between would otherwise still yield a live URI for purged content —
    // on a purge whose rmdir failed the file is genuinely still there to serve. Same
    // three guards TvCacheManager.getCachedUri carries; the two managers are used
    // interchangeably by main.ts, so their guard sets have to match.
    const gen = this.clearGeneration;
    const entry = this.manifest.entries[id];
    if (!entry) return null;

    try {
      // Verify file exists
      await Filesystem.stat({
        path: `${this.cacheDir}/${entry.fileName}`,
        directory: Directory.Data,
      });
      if (gen !== this.clearGeneration) return null; // purged mid-lookup

      entry.lastAccessed = Date.now();
      this.debouncedSaveManifest();

      const uriResult = await Filesystem.getUri({
        path: `${this.cacheDir}/${entry.fileName}`,
        directory: Directory.Data,
      });
      if (gen !== this.clearGeneration) return null; // purged during the URI resolve
      return Capacitor.convertFileSrc(uriResult.uri);
    } catch (e) {
      // Self-heal only what is still ours: after a purge the manifest is a NEW,
      // empty object and this delete+save would just churn it.
      if (gen !== this.clearGeneration) return null;
      delete this.manifest.entries[id];
      await this.saveManifest();
      return null;
    }
  }

  /** Best-effort unlink used to undo a write the clear generation invalidated. */
  private async deleteQuietly(fileName: string): Promise<void> {
    try {
      await Filesystem.deleteFile({
        path: `${this.cacheDir}/${fileName}`,
        directory: Directory.Data,
      });
    } catch (e) {
      // The purge's rmdir most likely already removed it; nothing names it either way.
    }
  }

  async enforceMaxCacheSize(): Promise<void> {
    const maxBytes = this.maxCacheSizeMB * 1024 * 1024;
    let totalSize = this.getTotalSize();

    if (totalSize <= maxBytes) return;

    const entries = Object.values(this.manifest.entries)
      .sort((a, b) => a.lastAccessed - b.lastAccessed);

    for (const entry of entries) {
      if (totalSize <= maxBytes) break;

      try {
        await Filesystem.deleteFile({
          path: `${this.cacheDir}/${entry.fileName}`,
          directory: Directory.Data,
        });
        totalSize -= entry.size;
        delete this.manifest.entries[entry.contentId];
        console.log(`[AndroidCache] Evicted ${entry.contentId}`);
      } catch (e) {
        // Continue
      }
    }

    await this.saveManifest();
  }

  /**
   * Purge the cache. Two properties, both load-bearing on the confirmed-revocation
   * path (purgeDeviceState §3.4) that is the only reason this method exists:
   *
   *  - The in-memory manifest is reset BEFORE the filesystem is touched, so a
   *    failure fails in the SAFE direction — the same shape as TvCacheManager.
   *    clearCache revoking its object URLs before its try. Resetting it AFTER the
   *    rmdir meant a failing rmdir left the manifest populated AND still stamped
   *    with the tenant that was just purged: the entries stayed servable, and the
   *    surviving stamp also dodged the next init's tenant-mismatch purge. Once the
   *    manifest is empty nothing can name the residual files, so the cache is
   *    fail-closed even when the disk purge does not complete — but ONLY for as long
   *    as that in-memory manifest survives, which is no longer the process lifetime:
   *    setExpectedTenant() re-arms init(), so loadManifest() re-reads whatever is on
   *    disk. Hence the emptied manifest is written BEFORE the rmdir (durable, and it
   *    also drops the purged tenant stamp), with `purgeFailed` latching the case where
   *    even that write fails so loadManifest() discards the survivor in-process.
   *  - It REJECTS on failure. purgeDeviceState collects this call in a
   *    Promise.allSettled, so swallowing the error recorded a failed cache clear as
   *    fulfilled and `device_purge_incomplete` never fired for it. Every caller is
   *    rejection-safe on purpose — see doInit() below (init() is awaited by
   *    getCachedUri/downloadContent OUTSIDE their try blocks) and
   *    handleCommand('clear_cache') in main.ts.
   */
  async clearCache(): Promise<void> {
    this.clearGeneration++;
    this.manifest = { entries: {}, version: 1 };
    // Persist the emptied manifest BEFORE the rmdir. If the rmdir rejects we never
    // reach the save at the end of the try, so manifest.json survived on disk holding
    // every purged entry and the purged tenant stamp — and any later init (re-armed by
    // setExpectedTenant, which purgeDeviceState now calls with null) read it straight
    // back in. Pessimistically latch first: saveManifest clears it iff the write lands.
    this.purgeFailed = true;
    await this.saveManifest();
    try {
      await Filesystem.rmdir({
        path: this.cacheDir,
        directory: Directory.Data,
        recursive: true,
      });
      await Filesystem.mkdir({
        path: this.cacheDir,
        directory: Directory.Data,
        recursive: true,
      });
      await this.saveManifest();
      console.log('[AndroidCache] Cache cleared');
    } catch (error) {
      console.error('[AndroidCache] Failed to clear cache:', error);
      throw error;
    }
  }

  getCacheStats(): { itemCount: number; totalSizeMB: number; maxSizeMB: number } {
    return {
      itemCount: Object.keys(this.manifest.entries).length,
      totalSizeMB: Math.round(this.getTotalSize() / 1024 / 1024 * 100) / 100,
      maxSizeMB: this.maxCacheSizeMB,
    };
  }

  private getTotalSize(): number {
    return Object.values(this.manifest.entries).reduce((sum, e) => sum + e.size, 0);
  }

  private static readonly ALLOWED_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'mp4', 'webm', 'ogg',
  ]);

  private getExtension(url: string, mimeType: string): string {
    try {
      const urlPath = new URL(url).pathname;
      const ext = urlPath.split('.').pop()?.toLowerCase();
      if (ext && AndroidCacheManager.ALLOWED_EXTENSIONS.has(ext)) return ext;
    } catch {}

    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
      'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm',
    };
    return mimeMap[mimeType] || 'bin';
  }
}
