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
}

export class AndroidCacheManager {
  private cacheDir = 'content-cache';
  private manifest: CacheManifest = { entries: {}, version: 1 };
  private maxCacheSizeMB: number;
  private downloadingSet: Set<string> = new Set();
  private initialized = false;

  constructor(maxCacheSizeMB = 500) {
    this.maxCacheSizeMB = maxCacheSizeMB;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

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

  async downloadContent(id: string, url: string, mimeType: string): Promise<string | null> {
    if (this.downloadingSet.has(id)) return null;

    await this.init();

    const existing = await this.getCachedUri(id);
    if (existing) return existing;

    this.downloadingSet.add(id);

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

      await this.saveManifest();
      await this.enforceMaxCacheSize();

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
      await this.saveManifest();

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

  async clearCache(): Promise<void> {
    try {
      await Filesystem.rmdir({
        path: this.cacheDir,
        directory: Directory.Data,
        recursive: true,
      });
      this.manifest = { entries: {}, version: 1 };
      await Filesystem.mkdir({
        path: this.cacheDir,
        directory: Directory.Data,
        recursive: true,
      });
      await this.saveManifest();
      console.log('[AndroidCache] Cache cleared');
    } catch (error) {
      console.error('[AndroidCache] Failed to clear cache:', error);
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

  private getExtension(url: string, mimeType: string): string {
    try {
      const urlPath = new URL(url).pathname;
      const ext = urlPath.split('.').pop();
      if (ext && ext.length <= 5) return ext;
    } catch {}

    const mimeMap: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
      'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm',
    };
    return mimeMap[mimeType] || 'bin';
  }
}
