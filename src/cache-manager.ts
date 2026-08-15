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
      return;
    }

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
    }
  }

  private async saveManifest(): Promise<void> {
    this.manifestDirty = false;
    try {
      await Filesystem.writeFile({
        path: `${this.cacheDir}/manifest.json`,
        directory: Directory.Data,
        data: JSON.stringify(this.manifest, null, 2),
        encoding: Encoding.UTF8,
      });
    } catch (error) {
      console.error('[AndroidCache] Failed to save manifest:', error);
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

      // Re-check after the persist awaits: a concurrent clear wipes what we just
      // wrote, and we must not hand out a live URI for purged content either.
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

    const entry = this.manifest.entries[id];
    if (!entry) return null;

    try {
      // Verify file exists
      await Filesystem.stat({
        path: `${this.cacheDir}/${entry.fileName}`,
        directory: Directory.Data,
      });

      entry.lastAccessed = Date.now();
      this.debouncedSaveManifest();

      const uriResult = await Filesystem.getUri({
        path: `${this.cacheDir}/${entry.fileName}`,
        directory: Directory.Data,
      });
      return Capacitor.convertFileSrc(uriResult.uri);
    } catch (e) {
      delete this.manifest.entries[id];
      await this.saveManifest();
      return null;
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
   *    fail-closed even when the disk purge does not complete.
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
