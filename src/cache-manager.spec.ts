/**
 * AndroidCacheManager — Behavioral Unit Tests
 *
 * Full coverage of cache initialization, download, lookup, manifest
 * persistence, eviction, clearing, stats, and extension parsing.
 *
 * Mock strategy:
 *   - @capacitor/filesystem  -> in-memory file tree fake
 *   - @capacitor/core        -> CapacitorHttp with configurable responses,
 *                               Capacitor.convertFileSrc as identity stub
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory filesystem fake — defined inside mock factories (hoisted)
// ---------------------------------------------------------------------------

vi.mock('@capacitor/filesystem', () => {
  // Shared mutable state attached to the mock functions so tests can access it
  const _state = { fsTree: {} as Record<string, { type: string; data?: string; size?: number }> };

  const fk = (path: string, directory?: string) =>
    directory ? `${directory}/${path}` : path;

  const Filesystem = {
    _state,
    mkdir: vi.fn(async (opts: any) => {
      _state.fsTree[fk(opts.path, opts.directory)] = { type: 'directory' };
    }),
    readFile: vi.fn(async (opts: any) => {
      const p = fk(opts.path, opts.directory);
      const node = _state.fsTree[p];
      if (!node || node.type !== 'file') throw new Error(`File not found: ${p}`);
      return { data: node.data ?? '' };
    }),
    writeFile: vi.fn(async (opts: any) => {
      const p = fk(opts.path, opts.directory);
      _state.fsTree[p] = { type: 'file', data: opts.data, size: (opts.data as string).length };
    }),
    deleteFile: vi.fn(async (opts: any) => {
      const p = fk(opts.path, opts.directory);
      if (!_state.fsTree[p]) throw new Error(`File not found: ${p}`);
      delete _state.fsTree[p];
    }),
    stat: vi.fn(async (opts: any) => {
      const p = fk(opts.path, opts.directory);
      const node = _state.fsTree[p];
      if (!node) throw new Error(`Not found: ${p}`);
      return { size: node.size ?? 0, type: node.type, uri: `file://${p}` };
    }),
    getUri: vi.fn(async (opts: any) => {
      const p = fk(opts.path, opts.directory);
      return { uri: `file://${p}` };
    }),
    rmdir: vi.fn(async (opts: any) => {
      const prefix = fk(opts.path, opts.directory);
      for (const key of Object.keys(_state.fsTree)) {
        if (key === prefix || key.startsWith(prefix + '/')) {
          delete _state.fsTree[key];
        }
      }
    }),
  };

  return {
    Filesystem,
    Directory: { Data: 'DATA', Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
  };
});

vi.mock('@capacitor/core', () => {
  const _state = {
    httpFactory: (_url: string) => ({ status: 200, data: 'binary-blob' }),
  };

  return {
    CapacitorHttp: {
      _state,
      get: vi.fn(async (opts: any) => _state.httpFactory(opts.url)),
    },
    Capacitor: {
      convertFileSrc: (uri: string) => uri,
    },
  };
});

// ---------------------------------------------------------------------------
// Import SUT and mocked modules
// ---------------------------------------------------------------------------

import { AndroidCacheManager } from './cache-manager';
import { Filesystem } from '@capacitor/filesystem';
import { CapacitorHttp } from '@capacitor/core';

// Type-cast to access internal state
const fs = Filesystem as any;
const http = CapacitorHttp as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFsTree(): Record<string, any> {
  return fs._state.fsTree;
}

function setFsTree(tree: Record<string, any>): void {
  fs._state.fsTree = tree;
}

function setHttpFactory(factory: (url: string) => { status: number; data: any }): void {
  http._state.httpFactory = factory;
}

function seedManifest(entries: Record<string, any>): void {
  const manifest = { entries, version: 1 };
  const p = 'DATA/content-cache/manifest.json';
  getFsTree()[p] = { type: 'file', data: JSON.stringify(manifest), size: 100 };
}

/** Seed a manifest carrying a tenant stamp (used by the tenant-binding and clear tests). */
function seedTenantManifest(tenantId: string, entries: Record<string, any>): void {
  getFsTree()['DATA/content-cache/manifest.json'] = {
    type: 'file',
    data: JSON.stringify({ entries, version: 1, tenantId }),
    size: 100,
  };
}

function seedFile(fileName: string, size: number): void {
  const p = `DATA/content-cache/${fileName}`;
  getFsTree()[p] = { type: 'file', data: 'x'.repeat(size), size };
}

function makeEntry(
  id: string,
  fileName: string,
  size: number,
  lastAccessed = 1000,
  mimeType = 'image/png',
) {
  return {
    contentId: id,
    fileName,
    size,
    mimeType,
    lastAccessed,
    downloadedAt: lastAccessed,
  };
}

function manifestWriteCount(): number {
  return (fs.writeFile as Mock).mock.calls.filter(
    (call: any[]) => call[0]?.path === 'content-cache/manifest.json',
  ).length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AndroidCacheManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFsTree({});
    setHttpFactory(() => ({ status: 200, data: 'binary-blob' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1. Initialization
  // -----------------------------------------------------------------------
  describe('Initialization', () => {
    it('creates cache directory via Filesystem.mkdir', async () => {
      const cm = new AndroidCacheManager();
      await cm.init();
      expect(fs.mkdir).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache', recursive: true }),
      );
    });

    it('loads existing manifest from disk', async () => {
      const entry = makeEntry('abc', 'abc.png', 500);
      seedManifest({ abc: entry });

      const cm = new AndroidCacheManager();
      await cm.init();

      expect(cm.getCacheStats().itemCount).toBe(1);
    });

    it('handles missing manifest gracefully (fresh start)', async () => {
      const cm = new AndroidCacheManager();
      await cm.init();

      expect(cm.getCacheStats().itemCount).toBe(0);
    });

    it('is idempotent — calling twice does not recreate directory or reload manifest', async () => {
      const cm = new AndroidCacheManager();
      await cm.init();
      await cm.init();

      expect(fs.mkdir).toHaveBeenCalledTimes(1);
      expect(fs.readFile).toHaveBeenCalledTimes(1);
    });

    it('serializes CONCURRENT init() calls — the boot render/preload race loads the manifest once', async () => {
      // The idempotency test above only covers sequential calls. Concurrently, every
      // caller passed the `initialized` guard, so each ran its own loadManifest() and
      // the last one to land overwrote this.manifest — clobbering entries an earlier
      // one had already recorded. TvCacheManager already serializes via initPromise.
      seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });

      const cm = new AndroidCacheManager();
      await Promise.all([cm.init(), cm.init(), cm.init()]);

      expect(fs.readFile).toHaveBeenCalledTimes(1);
      expect(cm.getCacheStats().itemCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 1b. Tenant binding (P0-2 — docs/design/revocation-contract.md §2)
  // -----------------------------------------------------------------------
  describe('Tenant Binding', () => {
    it('purges the whole cache when the manifest belongs to a different tenant', async () => {
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-B');
      await cm.init();

      expect(cm.getCacheStats().itemCount).toBe(0);
      // NEGATIVE: the other tenant's asset is not servable
      expect(await cm.getCachedUri('abc')).toBeNull();
    });

    it('keeps the cache when the tenant matches', async () => {
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      expect(cm.getCacheStats().itemCount).toBe(1);
    });

    it('keeps a legacy cache when no expected tenant is set (pre-migration grace)', async () => {
      seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      await cm.init();

      expect(cm.getCacheStats().itemCount).toBe(1);
    });

    it('stamps the expected tenant into the manifest on download', async () => {
      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.downloadContent('vid1', 'https://cdn/x.png', 'image/png');

      const manifestFile = getFsTree()['DATA/content-cache/manifest.json'];
      expect(manifestFile).toBeDefined();
      expect(JSON.parse(manifestFile.data!).tenantId).toBe('tenant-A');
    });

    it('setExpectedTenant RE-ARMS the purge — re-pairing to a new tenant in the same process purges', async () => {
      // The purge lives inside init(), which early-returns once initialized. So
      // setExpectedTenant() after first use was a silent no-op for purge purposes:
      // a device re-paired to a different tenant kept serving the previous tenant's
      // assets for the life of the process.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();
      expect(cm.getCacheStats().itemCount).toBe(1); // baseline: tenant-A's cache is live

      cm.setExpectedTenant('tenant-B'); // re-pair, same process

      // Through a real public entry point, not by re-calling init() by hand.
      expect(await cm.getCachedUri('abc')).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
    });

    it('NEGATIVE CONTROL: re-setting the SAME tenant does not re-arm the purge', async () => {
      // Proves the purge above came from the tenant CHANGING, not from
      // setExpectedTenant blindly discarding the cache on every call.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      cm.setExpectedTenant('tenant-A');

      expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png');
      expect(cm.getCacheStats().itemCount).toBe(1);
      expect(fs.readFile).toHaveBeenCalledTimes(1); // init did not re-run
    });
  });

  // -----------------------------------------------------------------------
  // 2. Download & Cache
  // -----------------------------------------------------------------------
  describe('Download & Cache', () => {
    it('downloads via CapacitorHttp, writes file, updates manifest, returns WebView URL', async () => {
      setHttpFactory(() => ({ status: 200, data: 'image-data' }));

      const cm = new AndroidCacheManager();
      const result = await cm.downloadContent('img1', 'https://cdn.example.com/photo.jpg', 'image/jpeg');

      expect(http.get).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://cdn.example.com/photo.jpg' }),
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/img1.jpg' }),
      );
      expect(result).toContain('img1.jpg');
      expect(cm.getCacheStats().itemCount).toBe(1);
    });

    it('returns null on HTTP error (non-200)', async () => {
      setHttpFactory(() => ({ status: 500, data: null }));

      const cm = new AndroidCacheManager();
      const result = await cm.downloadContent('img2', 'https://cdn.example.com/fail.jpg', 'image/jpeg');

      expect(result).toBeNull();
    });

    it('returns null on write failure', async () => {
      setHttpFactory(() => ({ status: 200, data: 'data' }));
      (fs.writeFile as Mock).mockRejectedValueOnce(new Error('Disk full'));

      const cm = new AndroidCacheManager();
      const result = await cm.downloadContent('img3', 'https://cdn.example.com/pic.png', 'image/png');

      expect(result).toBeNull();
    });

    it('skips download if content already cached (returns cached URI)', async () => {
      const entry = makeEntry('cached1', 'cached1.png', 100);
      seedManifest({ cached1: entry });
      seedFile('cached1.png', 100);

      const cm = new AndroidCacheManager();
      const result = await cm.downloadContent('cached1', 'https://cdn.example.com/cached1.png', 'image/png');

      expect(http.get).not.toHaveBeenCalled();
      expect(result).toContain('cached1.png');
    });

    it('guards against concurrent downloads of same ID (returns null if in-flight)', async () => {
      // Make HTTP slow so the first download is still in-flight when the second starts.
      // We need the first call to pass downloadingSet.add(id) before the second call
      // checks the set. Use a deferred HTTP response to keep the first call in-flight.
      let resolveHttp!: (v: any) => void;
      const slowHttp = new Promise<any>((r) => { resolveHttp = r; });
      (http.get as Mock).mockImplementation(() => slowHttp);

      const cm = new AndroidCacheManager();
      await cm.init();

      // Start first download — it will proceed through init/getCachedUri then block on HTTP
      const first = cm.downloadContent('dup1', 'https://cdn.example.com/dup.mp4', 'video/mp4');

      // Yield microtasks so the first call progresses past downloadingSet.add(id)
      await new Promise((r) => setTimeout(r, 0));

      // Second call — same ID is now in the downloading set
      const second = await cm.downloadContent('dup1', 'https://cdn.example.com/dup.mp4', 'video/mp4');
      expect(second).toBeNull();

      // Let the first complete
      resolveHttp({ status: 200, data: 'video-data' });
      const r1 = await first;
      expect(r1).toContain('dup1.mp4');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Cache Lookup
  // -----------------------------------------------------------------------
  describe('Cache Lookup', () => {
    it('returns WebView URL for cached content', async () => {
      const entry = makeEntry('look1', 'look1.png', 200);
      seedManifest({ look1: entry });
      seedFile('look1.png', 200);

      const cm = new AndroidCacheManager();
      await cm.init();

      const uri = await cm.getCachedUri('look1');
      expect(uri).toContain('look1.png');
    });

    it('returns null for uncached content', async () => {
      const cm = new AndroidCacheManager();
      await cm.init();

      const uri = await cm.getCachedUri('nonexistent');
      expect(uri).toBeNull();
    });

    it('removes manifest entry if file is missing on disk (self-healing)', async () => {
      const entry = makeEntry('gone1', 'gone1.png', 300);
      seedManifest({ gone1: entry });
      // File NOT seeded — simulates missing on disk

      const cm = new AndroidCacheManager();
      await cm.init();

      const uri = await cm.getCachedUri('gone1');
      expect(uri).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
      // saveManifest was called to persist the cleanup
      expect(manifestWriteCount()).toBeGreaterThanOrEqual(1);
    });

    it('updates lastAccessed timestamp on cache hit', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));

      const entry = makeEntry('ts1', 'ts1.png', 100, 500); // lastAccessed = 500
      seedManifest({ ts1: entry });
      seedFile('ts1.png', 100);

      const cm = new AndroidCacheManager();
      await cm.init();

      await cm.getCachedUri('ts1');

      // Advance past the debounce window so the manifest is saved
      await vi.advanceTimersByTimeAsync(60000);

      // The saved manifest should have an updated lastAccessed (much > 500)
      const savedCalls = (fs.writeFile as Mock).mock.calls.filter(
        (call: any[]) => call[0]?.path === 'content-cache/manifest.json',
      );
      expect(savedCalls.length).toBeGreaterThanOrEqual(1);

      const lastSave = savedCalls[savedCalls.length - 1][0];
      const savedManifest = JSON.parse(lastSave.data);
      expect(savedManifest.entries.ts1.lastAccessed).toBeGreaterThan(500);
    });
  });

  // -----------------------------------------------------------------------
  // 4. Manifest Persistence
  // -----------------------------------------------------------------------
  describe('Manifest Persistence', () => {
    it('saves manifest immediately after download', async () => {
      setHttpFactory(() => ({ status: 200, data: 'img-data' }));

      const cm = new AndroidCacheManager();
      await cm.downloadContent('dl1', 'https://cdn.example.com/a.png', 'image/png');

      expect(manifestWriteCount()).toBeGreaterThanOrEqual(1);
    });

    it('debounces manifest saves on getCachedUri (does not write on every access)', async () => {
      vi.useFakeTimers();

      const entry = makeEntry('deb1', 'deb1.png', 100);
      seedManifest({ deb1: entry });
      seedFile('deb1.png', 100);

      const cm = new AndroidCacheManager();
      await cm.init();

      (fs.writeFile as Mock).mockClear();

      await cm.getCachedUri('deb1');
      await cm.getCachedUri('deb1');
      await cm.getCachedUri('deb1');

      // No immediate writes — all debounced
      expect(manifestWriteCount()).toBe(0);
    });

    it('debounced save fires after 60s interval', async () => {
      vi.useFakeTimers();

      const entry = makeEntry('deb2', 'deb2.png', 100);
      seedManifest({ deb2: entry });
      seedFile('deb2.png', 100);

      const cm = new AndroidCacheManager();
      await cm.init();

      (fs.writeFile as Mock).mockClear();

      await cm.getCachedUri('deb2');

      await vi.advanceTimersByTimeAsync(60000);

      expect(manifestWriteCount()).toBe(1);
    });

    it('rapid sequential getCachedUri calls within debounce window trigger only one save', async () => {
      vi.useFakeTimers();

      const entry = makeEntry('deb3', 'deb3.png', 100);
      seedManifest({ deb3: entry });
      seedFile('deb3.png', 100);

      const cm = new AndroidCacheManager();
      await cm.init();

      (fs.writeFile as Mock).mockClear();

      for (let i = 0; i < 10; i++) {
        await cm.getCachedUri('deb3');
      }

      await vi.advanceTimersByTimeAsync(60000);

      expect(manifestWriteCount()).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 5. Cache Eviction
  // -----------------------------------------------------------------------
  describe('Cache Eviction', () => {
    it('is a no-op when total cache size is under limit', async () => {
      const entry = makeEntry('small1', 'small1.png', 100);
      seedManifest({ small1: entry });
      seedFile('small1.png', 100);

      const cm = new AndroidCacheManager(1); // 1 MB limit
      await cm.init();

      (fs.deleteFile as Mock).mockClear();
      await cm.enforceMaxCacheSize();

      expect(fs.deleteFile).not.toHaveBeenCalled();
      expect(cm.getCacheStats().itemCount).toBe(1);
    });

    it('evicts least-recently-accessed entries first (LRU)', async () => {
      const entries = {
        old: makeEntry('old', 'old.png', 400000, 1000),
        mid: makeEntry('mid', 'mid.png', 400000, 2000),
        fresh: makeEntry('fresh', 'fresh.png', 400000, 3000),
      };
      seedManifest(entries);
      seedFile('old.png', 400000);
      seedFile('mid.png', 400000);
      seedFile('fresh.png', 400000);

      // Total = 1,200,000 > 1 MB (1,048,576). Need to evict ~151,424.
      const cm = new AndroidCacheManager(1);
      await cm.init();

      await cm.enforceMaxCacheSize();

      // 'old' evicted first (lastAccessed = 1000)
      expect(fs.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/old.png' }),
      );
      // After evicting 'old': 800,000 < 1,048,576 — stops
      expect(cm.getCacheStats().itemCount).toBe(2);
    });

    it('stops evicting once under limit', async () => {
      const entries = {
        a: makeEntry('a', 'a.png', 600000, 1000),
        b: makeEntry('b', 'b.png', 600000, 2000),
      };
      seedManifest(entries);
      seedFile('a.png', 600000);
      seedFile('b.png', 600000);

      // Total = 1,200,000 > 1 MB
      const cm = new AndroidCacheManager(1);
      await cm.init();

      await cm.enforceMaxCacheSize();

      // Only 'a' evicted, total drops to 600,000 < 1,048,576
      expect(fs.deleteFile).toHaveBeenCalledTimes(1);
      expect(cm.getCacheStats().itemCount).toBe(1);
    });

    it('handles file deletion errors gracefully (continues evicting)', async () => {
      const entries = {
        err: makeEntry('err', 'err.png', 600000, 1000),
        ok: makeEntry('ok', 'ok.png', 600000, 2000),
        keep: makeEntry('keep', 'keep.png', 100000, 3000),
      };
      seedManifest(entries);
      // Do NOT seed 'err.png' — deleteFile will throw for it
      seedFile('ok.png', 600000);
      seedFile('keep.png', 100000);

      // Total = 1,300,000, limit = 1 MB
      const cm = new AndroidCacheManager(1);
      await cm.init();

      await cm.enforceMaxCacheSize();

      // Both 'err' and 'ok' attempted (sorted by lastAccessed)
      expect(fs.deleteFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/err.png' }),
      );
      // 'err' deletion failed but eviction continued
      // After evicting 'ok': err(600,000) + keep(100,000) = 700,000 < 1,048,576
      expect(cm.getCacheStats().itemCount).toBe(2); // 'err' entry persists, 'keep' survives
    });

    it('with orphaned manifest entries (file missing): entry persists in manifest', async () => {
      const entries = {
        orphan: makeEntry('orphan', 'orphan.png', 100, 1000),
      };
      seedManifest(entries);
      // File NOT seeded

      const cm = new AndroidCacheManager(500);
      await cm.init();

      // Under limit — no-op
      await cm.enforceMaxCacheSize();

      // Orphan entry still in manifest (enforceMaxCacheSize does NOT self-heal)
      expect(cm.getCacheStats().itemCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 6. Cache Clear
  // -----------------------------------------------------------------------
  describe('Cache Clear', () => {
    it('removes directory, resets manifest, recreates directory', async () => {
      const entry = makeEntry('clr1', 'clr1.png', 500);
      seedManifest({ clr1: entry });
      seedFile('clr1.png', 500);

      const cm = new AndroidCacheManager();
      await cm.init();
      expect(cm.getCacheStats().itemCount).toBe(1);

      await cm.clearCache();

      expect(fs.rmdir).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache', recursive: true }),
      );
      expect(cm.getCacheStats().itemCount).toBe(0);
      // init mkdir + clearCache mkdir = 2
      expect(fs.mkdir).toHaveBeenCalledTimes(2);
      expect(manifestWriteCount()).toBeGreaterThanOrEqual(1);
    });

    it('REJECTS on rmdir failure and logs the error', async () => {
      // Was `resolves.toBeUndefined()`. Swallowing here is what defeated
      // purgeDeviceState's Promise.allSettled telemetry: a failed cache clear was
      // recorded as fulfilled, so `device_purge_incomplete` never fired for it.
      (fs.rmdir as Mock).mockRejectedValueOnce(new Error('Permission denied'));
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      await cm.init();

      await expect(cm.clearCache()).rejects.toThrow('Permission denied');
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clear cache'),
        expect.any(Error),
      );
      errorSpy.mockRestore();
    });

    it('a FAILED purge still empties the manifest — no entry stays servable', async () => {
      // The manifest was reset INSIDE the try, AFTER the rmdir, so a failing rmdir
      // left every entry in place and still servable through getCachedUri.
      seedManifest({ clr1: makeEntry('clr1', 'clr1.png', 500) });
      seedFile('clr1.png', 500);
      (fs.rmdir as Mock).mockRejectedValueOnce(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      await cm.init();
      expect(cm.getCacheStats().itemCount).toBe(1); // baseline: there is something to purge

      await expect(cm.clearCache()).rejects.toThrow('Permission denied');

      expect(cm.getCacheStats().itemCount).toBe(0);
      // Through a real public entry point, not by reading internal state.
      expect(await cm.getCachedUri('clr1')).toBeNull();
    });

    it('a PERSISTENTLY failing purge still refuses to serve the purged tenant after re-pairing', async () => {
      // The consequence that reaches glass. rmdir fails on EVERY attempt, so the
      // on-disk residue survives and the next init reloads it from disk — the only
      // thing standing between the purged tenant's assets and the new tenant's
      // screen is clearCache emptying the manifest in memory. Resetting it AFTER
      // the rmdir (the defect) left the entry loaded, stamped and servable.
      seedTenantManifest('tenant-A', { clr1: makeEntry('clr1', 'clr1.png', 500) });
      seedFile('clr1.png', 500);
      (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();
      expect(await cm.getCachedUri('clr1')).toBe('file://DATA/content-cache/clr1.png'); // baseline

      await expect(cm.clearCache()).rejects.toThrow('Permission denied');

      // Re-pair to a different tenant, then read through a real public entry point.
      cm.setExpectedTenant('tenant-B');
      expect(await cm.getCachedUri('clr1')).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
    });

    it('NEGATIVE CONTROL: a healthy purge resolves', async () => {
      // Same layer, same entry point, filesystem healthy. Proves the rejections
      // above come from the rmdir failure and not from clearCache now rejecting
      // unconditionally.
      seedManifest({ clr1: makeEntry('clr1', 'clr1.png', 500) });
      seedFile('clr1.png', 500);

      const cm = new AndroidCacheManager();
      await cm.init();

      await expect(cm.clearCache()).resolves.toBeUndefined();
      expect(cm.getCacheStats().itemCount).toBe(0);
    });

    it('a failing tenant purge at init does NOT reject init() — reads still degrade to null', async () => {
      // getCachedUri/downloadContent await init() OUTSIDE their try blocks, so if
      // doInit let clearCache's rejection escape, a failed disk purge would become a
      // rendering failure (an unhandled rejection out of the render path) instead of
      // a cache miss.
      seedTenantManifest('tenant-A', { clr1: makeEntry('clr1', 'clr1.png', 500) });
      seedFile('clr1.png', 500);
      (fs.rmdir as Mock).mockRejectedValueOnce(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-B'); // mismatch -> init purges

      await expect(cm.init()).resolves.toBeUndefined();
      expect(await cm.getCachedUri('clr1')).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // 6b. Purge race (clear-generation guard — mirrors TvCacheManager)
  // -----------------------------------------------------------------------
  describe('Purge Race', () => {
    /**
     * Park a download inside the HTTP call. `entered` resolves once the request is
     * in flight — i.e. once downloadContent has already captured its generation —
     * so the clearCache() below genuinely lands MID-download rather than before it.
     */
    const gatedDownload = () => {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const inFlight = new Promise<void>(r => { entered = r; });
      setHttpFactory((() => {
        entered();
        return gate.then(() => ({ status: 200, data: 'binary-blob' }));
      }) as unknown as (url: string) => { status: number; data: any });
      return { inFlight, release };
    };

    it('an in-flight download across clearCache never resurrects purged content', async () => {
      // clearCache() is the confirmed-revocation purge path (purgeDeviceState §3.4).
      // Without the generation guard the download completed AFTERWARDS, re-created
      // the directory, wrote the asset and re-stamped the manifest with the tenant
      // that had just been purged.
      const { inFlight, release } = gatedDownload();

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const pending = cm.downloadContent('c1', 'https://cdn/x.png', 'image/png');
      await inFlight;
      await cm.clearCache(); // revocation purge lands mid-download
      release();

      expect(await pending).toBeNull();
      // NEGATIVE: nothing written back, and the manifest was not re-stamped.
      expect(getFsTree()['DATA/content-cache/c1.png']).toBeUndefined();
      expect(JSON.parse(getFsTree()['DATA/content-cache/manifest.json'].data!).tenantId)
        .toBeUndefined();
      expect(cm.getCacheStats().itemCount).toBe(0);
      expect(await cm.getCachedUri('c1')).toBeNull();
    });

    it('NEGATIVE CONTROL: the same gated download completes normally with no purge', async () => {
      // Same harness, same gate, no clearCache. Proves the nulls above come from the
      // generation guard and not from the gate breaking the download outright.
      const { inFlight, release } = gatedDownload();

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const pending = cm.downloadContent('c1', 'https://cdn/x.png', 'image/png');
      await inFlight;
      release();

      expect(await pending).toBe('file://DATA/content-cache/c1.png');
      expect(getFsTree()['DATA/content-cache/c1.png']).toBeDefined();
      expect(JSON.parse(getFsTree()['DATA/content-cache/manifest.json'].data!).tenantId)
        .toBe('tenant-A');
      expect(cm.getCacheStats().itemCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // 7. Cache Stats
  // -----------------------------------------------------------------------
  describe('Cache Stats', () => {
    it('returns correct itemCount, totalSizeMB, and maxSizeMB', async () => {
      const oneMB = 1024 * 1024;
      const entries = {
        s1: makeEntry('s1', 's1.png', oneMB, 1000),
        s2: makeEntry('s2', 's2.png', oneMB * 2, 2000),
      };
      seedManifest(entries);

      const cm = new AndroidCacheManager(100);
      await cm.init();

      const stats = cm.getCacheStats();
      expect(stats.itemCount).toBe(2);
      expect(stats.totalSizeMB).toBe(3);
      expect(stats.maxSizeMB).toBe(100);
    });
  });

  // -----------------------------------------------------------------------
  // 8. Extension Parsing (tested indirectly via downloadContent)
  // -----------------------------------------------------------------------
  describe('Extension Parsing', () => {
    beforeEach(() => {
      setHttpFactory(() => ({ status: 200, data: 'data' }));
    });

    it('extracts extension from URL path', async () => {
      const cm = new AndroidCacheManager();
      await cm.downloadContent('ext1', 'https://cdn.example.com/images/photo.jpg', 'image/jpeg');

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/ext1.jpg' }),
      );
    });

    it('falls back to MIME type mapping when URL has no valid extension', async () => {
      const cm = new AndroidCacheManager();
      await cm.downloadContent('ext2', 'https://cdn.example.com/serve?id=123', 'image/webp');

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/ext2.webp' }),
      );
    });

    it('returns bin for unknown MIME types', async () => {
      const cm = new AndroidCacheManager();
      await cm.downloadContent('ext3', 'https://cdn.example.com/blob', 'application/octet-stream');

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/ext3.bin' }),
      );
    });

    it('rejects extensions not in allowlist and falls back to MIME', async () => {
      const cm = new AndroidCacheManager();
      await cm.downloadContent('ext4', 'https://cdn.example.com/file.exe', 'video/mp4');

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'content-cache/ext4.mp4' }),
      );
    });
  });
});
