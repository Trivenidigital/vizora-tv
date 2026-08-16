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

/** Read the manifest as it exists ON DISK (not the manager's in-memory copy). */
function diskManifest(): { entries: Record<string, any>; tenantId?: string } | undefined {
  const node = getFsTree()['DATA/content-cache/manifest.json'];
  return node ? JSON.parse(node.data!) : undefined;
}

// ---------------------------------------------------------------------------
// Canonical filesystem-fake behaviours, re-installed before EVERY test.
//
// The mock factory's own implementations are not retrievable via
// getMockImplementation() (afterEach's restoreAllMocks drops them back to the
// vi.fn originals, which that accessor does not report), so a gate that wrapped
// "whatever is installed" silently delegated to `undefined` and turned every
// filesystem call into a throw — which loadManifest swallows into an empty
// manifest. Pinning the behaviours here makes both the fake and the gates
// deterministic, and makes a leaked gate impossible.
// ---------------------------------------------------------------------------

const fk = (opts: any) => (opts.directory ? `${opts.directory}/${opts.path}` : opts.path);

const FS_FAKE: Record<string, (opts: any) => Promise<any>> = {
  mkdir: async (opts) => { getFsTree()[fk(opts)] = { type: 'directory' }; },
  readFile: async (opts) => {
    const node = getFsTree()[fk(opts)];
    if (!node || node.type !== 'file') throw new Error(`File not found: ${fk(opts)}`);
    return { data: node.data ?? '' };
  },
  writeFile: async (opts) => {
    getFsTree()[fk(opts)] = { type: 'file', data: opts.data, size: String(opts.data).length };
  },
  deleteFile: async (opts) => {
    if (!getFsTree()[fk(opts)]) throw new Error(`File not found: ${fk(opts)}`);
    delete getFsTree()[fk(opts)];
  },
  stat: async (opts) => {
    const node = getFsTree()[fk(opts)];
    if (!node) throw new Error(`Not found: ${fk(opts)}`);
    return { size: node.size ?? 0, type: node.type, uri: `file://${fk(opts)}` };
  },
  getUri: async (opts) => ({ uri: `file://${fk(opts)}` }),
  rmdir: async (opts) => {
    const prefix = fk(opts);
    for (const key of Object.keys(getFsTree())) {
      if (key === prefix || key.startsWith(prefix + '/')) delete getFsTree()[key];
    }
  },
};

function installFsFake(): void {
  for (const method of Object.keys(FS_FAKE)) {
    (fs[method] as Mock).mockImplementation(FS_FAKE[method]);
  }
}

/**
 * Park the SUT inside a specific Filesystem call so a purge can be made to land in
 * that exact window. Reset by the global beforeEach's installFsFake().
 */
function gateFilesystem(
  method: 'writeFile' | 'stat' | 'readFile',
  shouldGate: (opts: any) => boolean,
) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const inCall = new Promise<void>((r) => { entered = r; });
  (fs[method] as Mock).mockImplementation(async (opts: any) => {
    if (shouldGate(opts)) {
      entered();
      await gate;
    }
    return FS_FAKE[method](opts);
  });
  return { entered: inCall, release };
}

/**
 * Park a download inside the ASSET write — i.e. AFTER downloadContent's pre-write
 * generation check has already passed. This is the window that carries the asset
 * write, the manifest entry, the tenant re-stamp and saveManifest(); parking inside
 * the HTTP call instead only ever lets a purge land BEFORE the first check, which is
 * why the earlier Purge Race tests could not see the resurrection.
 */
const gateAssetWrite = () =>
  gateFilesystem('writeFile', (opts) => !String(opts.path).endsWith('manifest.json'));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AndroidCacheManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFsFake();
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

    it('a tenant change landing INSIDE an in-flight init is not absorbed by it', async () => {
      // setExpectedTenant re-arms the purge by clearing `initialized`, but an init
      // already in flight sets it straight back to true at the end — so the change is
      // swallowed and the init that the new tenant needs never runs. Park inside
      // loadManifest and move the tenant while init is in there.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');

      const { entered, release } = gateFilesystem('readFile', () => true);
      const pending = cm.init();
      await entered;
      cm.setExpectedTenant(null);   // lands inside the in-flight init
      release();
      await pending;

      // Observable: the init the NEW tenant needs actually ran, rather than the
      // in-flight one declaring itself done on the old tenant's behalf.
      await cm.getCachedUri('abc');
      expect(fs.readFile).toHaveBeenCalledTimes(2);
    });

    it('NEGATIVE CONTROL: with no tenant change, the in-flight init still completes once', async () => {
      // Same gate, same parking point, tenant untouched. Proves the second init above
      // comes from the tenant moving, not from the gate defeating init entirely.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');

      const { entered, release } = gateFilesystem('readFile', () => true);
      const pending = cm.init();
      await entered;
      release();
      await pending;

      expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png');
      expect(fs.readFile).toHaveBeenCalledTimes(1);
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

    it('a PERSISTENTLY failing purge stays purged when re-pairing to a DIFFERENT tenant', async () => {
      // NOTE ON SCOPE — this test was previously titled as though it covered the
      // failed-purge invariant generally. It does not: re-pairing to tenant-B is a
      // tenant MISMATCH, which re-arms init and triggers a SECOND purge attempt that
      // empties the manifest all over again. It is green whether or not the emptied
      // manifest was ever persisted. The sequence production actually performs is
      // purge → unbind → not yet re-paired, where there is no mismatch to save it;
      // that is covered by the `tenant is UNBOUND` tests below.
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

    // ---------------------------------------------------------------------
    // The failed purge in the sequence purgeDeviceState actually performs.
    // "The manifest is empty in memory, so nothing can name the residual
    // files" held only while `initialized` stayed true for the process
    // lifetime. setExpectedTenant now re-arms init, and purgeDeviceState calls
    // setExpectedTenant(null) — so doInit re-runs, loadManifest re-reads the
    // manifest that survived on disk, and every purged entry comes back under
    // expectedTenant === null, where the mismatch guard can never fire.
    // ---------------------------------------------------------------------

    it('a failed purge stays purged after the tenant is UNBOUND (purgeDeviceState order)', async () => {
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);
      (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();
      expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png'); // baseline

      cm.setExpectedTenant(null);   // §3.4: the cache is unbound BEFORE the purge
      await expect(cm.clearCache()).rejects.toThrow('Permission denied');

      // No re-pair yet — nothing will produce a tenant mismatch to save us.
      expect(await cm.getCachedUri('abc')).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
      // …and the reason it is null: disk agrees with memory.
      expect(diskManifest()!.entries).toEqual({});
      expect(diskManifest()!.tenantId).toBeUndefined();
    });

    it('a failed purge whose manifest write ALSO fails still refuses to serve, then heals', async () => {
      // Both directions of the disk are broken, so persisting the emptied manifest
      // cannot help — the `purgeFailed` latch has to make loadManifest discard what
      // it reads instead. Phase 2 proves the latch RELEASES, so a device that
      // re-pairs and re-caches after a bad purge is not stuck cacheless.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);
      (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));
      (fs.writeFile as Mock).mockRejectedValue(new Error('Read-only filesystem'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();
      expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png'); // baseline

      cm.setExpectedTenant(null);
      await expect(cm.clearCache()).rejects.toThrow('Permission denied');

      expect(await cm.getCachedUri('abc')).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
      // The residue really is still on disk — the refusal is the manager's doing.
      expect(getFsTree()['DATA/content-cache/abc.png']).toBeDefined();
      expect(diskManifest()!.entries.abc).toBeDefined();

      // Phase 2: the filesystem recovers and the device re-pairs.
      (fs.writeFile as Mock).mockImplementation(async (opts: any) => {
        getFsTree()[`${opts.directory}/${opts.path}`] =
          { type: 'file', data: opts.data, size: String(opts.data).length };
      });
      cm.setExpectedTenant('tenant-B');
      expect(await cm.downloadContent('new1', 'https://cdn/n.png', 'image/png'))
        .toBe('file://DATA/content-cache/new1.png');
      cm.setExpectedTenant(null);   // force another init re-arm
      expect(await cm.getCachedUri('new1')).toBe('file://DATA/content-cache/new1.png');
      expect(await cm.getCachedUri('abc')).toBeNull(); // …and the purged one stays gone
    });

    it('a failed purge survives a RESTART — a fresh manager over the same disk serves nothing', async () => {
      // The in-process latch cannot help here: a revoked device reboots, the app comes
      // up with a brand-new manager and no expected tenant (not re-paired yet), and
      // loadManifest reads whatever is on disk. Only the emptied manifest having been
      // WRITTEN before the rmdir makes the purge durable.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);
      (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const before = new AndroidCacheManager();
      before.setExpectedTenant('tenant-A');
      await before.init();
      before.setExpectedTenant(null);
      await expect(before.clearCache()).rejects.toThrow('Permission denied');

      // Reboot: new process, new manager, same disk, no tenant expectation yet.
      const after = new AndroidCacheManager();
      expect(await after.getCachedUri('abc')).toBeNull();
      expect(after.getCacheStats().itemCount).toBe(0);
      // The asset itself is still there (rmdir never succeeded) — the manifest is
      // what keeps it unnameable.
      expect(getFsTree()['DATA/content-cache/abc.png']).toBeDefined();
    });

    it('NEGATIVE CONTROL: a HEALTHY purge does not latch — the cache works after it', async () => {
      // Same layer, same unbind sequence, filesystem healthy. Proves the refusals
      // above come from the purge having failed, not from clearCache/loadManifest
      // now discarding unconditionally.
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      cm.setExpectedTenant(null);
      await expect(cm.clearCache()).resolves.toBeUndefined();

      cm.setExpectedTenant('tenant-B');
      expect(await cm.downloadContent('new1', 'https://cdn/n.png', 'image/png'))
        .toBe('file://DATA/content-cache/new1.png');
      cm.setExpectedTenant(null);   // re-arm init: the fresh entry must survive it
      expect(await cm.getCachedUri('new1')).toBe('file://DATA/content-cache/new1.png');
      expect(cm.getCacheStats().itemCount).toBe(1);
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

    // ---------------------------------------------------------------------
    // The window the two tests above do NOT reach. Parking inside the HTTP
    // call means the purge always lands BEFORE downloadContent's first
    // generation check, so the check is never actually asked to do anything.
    // Park inside the asset write instead: everything that commits the
    // download — the file, the manifest entry, the tenant stamp, saveManifest
    // — sits AFTER that point, and the trailing check gates only the return
    // value, which undoes nothing.
    // ---------------------------------------------------------------------

    it('a purge landing in the WRITE window does not resurrect the asset', async () => {
      const { entered, release } = gateAssetWrite();

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const pending = cm.downloadContent('c1', 'https://cdn/x.png', 'image/png');
      await entered;                 // parked INSIDE Filesystem.writeFile
      await cm.clearCache();         // revocation purge lands here
      release();

      expect(await pending).toBeNull();
      // The four observables. Only the first was asserted before, and it is the
      // one thing the trailing check already delivered.
      expect(getFsTree()['DATA/content-cache/c1.png']).toBeUndefined();
      expect(diskManifest()!.entries).toEqual({});
      expect(diskManifest()!.tenantId).toBeUndefined();
      expect(await cm.getCachedUri('c1')).toBeNull();
      expect(cm.getCacheStats().itemCount).toBe(0);
    });

    it('a purge in the WRITE window stays purged in purgeDeviceState ORDER (tenant unbound first)', async () => {
      // The real §3.4 sequence: setExpectedTenant(null) runs BEFORE clearCache().
      // The resurrected entry is then never re-stamped, so it lands under
      // expectedTenant === null — where the tenant-mismatch guard can never fire and
      // nothing downstream will ever remove it.
      const { entered, release } = gateAssetWrite();

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const pending = cm.downloadContent('c1', 'https://cdn/x.png', 'image/png');
      await entered;
      cm.setExpectedTenant(null);    // purgeDeviceState unbinds the cache first…
      await cm.clearCache();         // …then purges
      release();

      expect(await pending).toBeNull();
      expect(getFsTree()['DATA/content-cache/c1.png']).toBeUndefined();
      expect(await cm.getCachedUri('c1')).toBeNull();
      expect(diskManifest()!.entries).toEqual({});
    });

    it('a purge landing in the MANIFEST-WRITE window neither serves nor persists the entry', async () => {
      // The last window: the commit has been made in memory and saveManifest() is
      // mid-flight. Its JSON snapshot was taken BEFORE the await, entries and tenant
      // stamp included, so it lands on disk AFTER the purge's own writes and clobbers
      // them — a reboot then resurrects the purged entry. The trailing return-value
      // check covers the other half (never hand out a URI for purged content).
      let manifestWrites = 0;
      const { entered, release } = gateFilesystem('writeFile', (opts) =>
        String(opts.path).endsWith('manifest.json') && manifestWrites++ === 0);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const pending = cm.downloadContent('c1', 'https://cdn/x.png', 'image/png');
      await entered;            // parked INSIDE saveManifest's write
      await cm.clearCache();    // purge runs to completion around it
      release();

      expect(await pending).toBeNull();
      expect(diskManifest()!.entries).toEqual({});
      expect(diskManifest()!.tenantId).toBeUndefined();
      expect(await cm.getCachedUri('c1')).toBeNull();
    });

    it('NEGATIVE CONTROL: the same write-window gate completes normally with no purge', async () => {
      // Same gate, same parking point, no clearCache. Proves the nulls above come
      // from the generation guard and not from the gate breaking the write.
      const { entered, release } = gateAssetWrite();

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const pending = cm.downloadContent('c1', 'https://cdn/x.png', 'image/png');
      await entered;
      release();

      expect(await pending).toBe('file://DATA/content-cache/c1.png');
      expect(getFsTree()['DATA/content-cache/c1.png']).toBeDefined();
      expect(diskManifest()!.entries.c1).toBeDefined();
      expect(diskManifest()!.tenantId).toBe('tenant-A');
      expect(await cm.getCachedUri('c1')).toBe('file://DATA/content-cache/c1.png');
    });

    // ---------------------------------------------------------------------
    // getCachedUri's own guards (AndroidCacheManager had none; TvCacheManager
    // has three). `entry` is captured before two awaits, and on a purge whose
    // rmdir failed the file is genuinely still on disk to be served.
    // ---------------------------------------------------------------------

    it('getCachedUri across a purge never hands out a live URI for purged content', async () => {
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);
      // rmdir fails, so the asset SURVIVES the purge — a live URI would resolve.
      (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const { entered, release } = gateFilesystem('stat', (opts) =>
        String(opts.path).endsWith('abc.png'));

      const pending = cm.getCachedUri('abc');
      await entered;                                              // parked mid-lookup
      await expect(cm.clearCache()).rejects.toThrow('Permission denied');
      release();

      expect(await pending).toBeNull();
      expect(getFsTree()['DATA/content-cache/abc.png']).toBeDefined(); // it really did survive
    });

    it('NEGATIVE CONTROL: the same gated getCachedUri returns the URI with no purge', async () => {
      seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
      seedFile('abc.png', 500);

      const cm = new AndroidCacheManager();
      cm.setExpectedTenant('tenant-A');
      await cm.init();

      const { entered, release } = gateFilesystem('stat', (opts) =>
        String(opts.path).endsWith('abc.png'));

      const pending = cm.getCachedUri('abc');
      await entered;
      release();

      expect(await pending).toBe('file://DATA/content-cache/abc.png');
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

// ===========================================================================
// Release-review wave: C4 (the purgeFailed latch) + T6 (the getCachedUri guards)
// ===========================================================================

describe('AndroidCacheManager — purge latch & lookup guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installFsFake();
    setFsTree({});
    setHttpFactory(() => ({ status: 200, data: 'binary-blob' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Park the Nth manifest write and fail every manifest write after it.
   *
   * Asset writes are untouched. This is the only shape that can express the C4
   * race: a saveManifest already in flight when clearCache lands, whose PRE-clear
   * snapshot (captured at call time by JSON.stringify) reaches disk afterwards.
   */
  function gateManifestWrites(parkOn: number) {
    let n = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inCall = new Promise<void>((r) => { entered = r; });
    (fs.writeFile as Mock).mockImplementation(async (opts: any) => {
      if (!String(opts.path).endsWith('manifest.json')) return FS_FAKE.writeFile(opts);
      n += 1;
      if (n === parkOn) {
        entered();
        await gate;
        return FS_FAKE.writeFile(opts);
      }
      if (n > parkOn) throw new Error('Read-only filesystem');
      return FS_FAKE.writeFile(opts);
    });
    return { entered: inCall, release };
  }

  // -----------------------------------------------------------------------
  // C4: the latch must not be cleared by a write that is already stale
  // -----------------------------------------------------------------------
  //
  // saveManifest cleared `purgeFailed` on the strength of the write it had just
  // completed, and only THEN noticed the clear generation had moved and recursed.
  // But what that write put on disk is the PRE-clear manifest — populated, stamped
  // with the tenant that was just purged. If the healing rewrite also fails, disk
  // holds the purged tenant's manifest with purgeFailed === false, so loadManifest
  // will NOT discard it — defeating the exact property the latch was added for.

  it('C4: a stale manifest write that lands after a purge does not release the latch', async () => {
    seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
    seedFile('abc.png', 500);
    (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));

    const cm = new AndroidCacheManager();
    cm.setExpectedTenant('tenant-A');
    await cm.init();
    expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png'); // baseline

    // Park the manifest write that commits a download; every manifest write after it
    // fails, which is the state in which the latch is the only remaining defence.
    const { entered, release } = gateManifestWrites(1);
    const pending = cm.downloadContent('new1', 'https://cdn/n.png', 'image/png');
    await entered;

    // The revocation purge lands while that write is in flight.
    await expect(cm.clearCache()).rejects.toThrow('Permission denied');

    release();
    expect(await pending).toBeNull(); // superseded, correctly

    // The residue really is on disk: the parked write put the PRE-clear snapshot back.
    expect(diskManifest()!.entries.abc).toBeDefined();
    expect(diskManifest()!.tenantId).toBe('tenant-A');

    // …and the latch is still latched, so a re-armed init discards what it reads.
    // (setExpectedTenant(null) is exactly what purgeDeviceState does.)
    cm.setExpectedTenant(null);
    expect(await cm.getCachedUri('abc')).toBeNull();
    expect(cm.getCacheStats().itemCount).toBe(0);
    // The asset itself survived the failed rmdir — the manifest is what makes it
    // unnameable, which is the whole point.
    expect(getFsTree()['DATA/content-cache/abc.png']).toBeDefined();
  });

  it('C4 NEGATIVE CONTROL: with NO purge the same parked write releases the latch normally', async () => {
    // Same gate, same parked write, no clearCache. Proves the refusal above belongs to
    // the purge and that the latch is not now stuck on — a permanently latched manager
    // would refuse to serve any cache at all, which is worse than the bug.
    seedTenantManifest('tenant-A', { abc: makeEntry('abc', 'abc.png', 500) });
    seedFile('abc.png', 500);

    const cm = new AndroidCacheManager();
    cm.setExpectedTenant('tenant-A');
    await cm.init();

    const { entered, release } = gateManifestWrites(1);
    const pending = cm.downloadContent('new1', 'https://cdn/n.png', 'image/png');
    await entered;
    release();
    expect(await pending).toBe('file://DATA/content-cache/new1.png');

    cm.setExpectedTenant(null); // re-arm init: loadManifest must NOT discard
    expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png');
    expect(await cm.getCachedUri('new1')).toBe('file://DATA/content-cache/new1.png');
  });

  // -----------------------------------------------------------------------
  // T6: each of getCachedUri's three clear-generation guards, pinned alone
  // -----------------------------------------------------------------------
  //
  // The three guards were mutually redundant against a return-value assertion: a
  // purge landing in the stat window is caught by the getUri guard too, so removing
  // either one alone still produced null. Each test below lands the purge in exactly
  // one window and asserts that guard's OWN observable.

  it('T6/G1: a purge landing in the STAT window leaves no debounced write behind', async () => {
    // G1's own effect is upstream of the return value: it stops
    // `entry.lastAccessed = Date.now(); debouncedSaveManifest()` from running against
    // an entry the purge has already dropped. Without it the return is still null
    // (the getUri guard catches that), but a debounce timer is armed and fires 60s
    // later against the post-purge manifest — churn on a manifest the device has
    // deliberately emptied.
    vi.useFakeTimers();
    seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });
    seedFile('abc.png', 500);
    // The rmdir must FAIL, or the purge deletes abc.png and the parked stat throws on
    // release — which lands in the CATCH and never reaches G1's line at all. A failed
    // disk purge is also the realistic case: it is precisely when the file is still
    // there to be re-touched that the guard matters.
    (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));

    const cm = new AndroidCacheManager();
    await cm.init();

    const { entered, release } = gateFilesystem('stat', (opts) =>
      String(opts.path).endsWith('abc.png'));
    const pending = cm.getCachedUri('abc');
    await entered;                       // parked INSIDE Filesystem.stat
    await expect(cm.clearCache()).rejects.toThrow('Permission denied');
    release();
    expect(await pending).toBeNull();

    const writesAfterPurge = manifestWriteCount();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(manifestWriteCount()).toBe(writesAfterPurge);
  });

  it('T6/G1 NEGATIVE CONTROL: with no purge the same lookup DOES arm the debounced write', async () => {
    // Proves the observation window can see a debounced write, so the equality above
    // is not vacuous.
    vi.useFakeTimers();
    seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });
    seedFile('abc.png', 500);

    const cm = new AndroidCacheManager();
    await cm.init();
    expect(await cm.getCachedUri('abc')).toBe('file://DATA/content-cache/abc.png');

    const before = manifestWriteCount();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(manifestWriteCount()).toBe(before + 1);
  });

  it('T6/G2: a purge landing in the getUri window is not served a live URI', async () => {
    // G1 has already passed here (the generations still agreed when stat returned), so
    // G2 is the only guard that can act. Without it, purged content is handed out as a
    // playable file:// URI — and on a purge whose rmdir failed the file is genuinely
    // still there to play.
    seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });
    seedFile('abc.png', 500);
    (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));

    const cm = new AndroidCacheManager();
    await cm.init();

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inCall = new Promise<void>((r) => { entered = r; });
    (fs.getUri as Mock).mockImplementation(async (opts: any) => {
      if (String(opts.path).endsWith('abc.png')) { entered(); await gate; }
      return FS_FAKE.getUri(opts);
    });

    const pending = cm.getCachedUri('abc');
    await inCall;                                   // parked INSIDE Filesystem.getUri
    await expect(cm.clearCache()).rejects.toThrow('Permission denied');
    release();

    expect(await pending).toBeNull();
    // Direction: the asset really is still on disk, so this is a refusal to name it
    // rather than the file having gone away.
    expect(getFsTree()['DATA/content-cache/abc.png']).toBeDefined();
  });

  it('T6/G2 NEGATIVE CONTROL: the same gated lookup returns the URI with no purge', async () => {
    seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });
    seedFile('abc.png', 500);

    const cm = new AndroidCacheManager();
    await cm.init();

    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const inCall = new Promise<void>((r) => { entered = r; });
    (fs.getUri as Mock).mockImplementation(async (opts: any) => {
      if (String(opts.path).endsWith('abc.png')) { entered(); await gate; }
      return FS_FAKE.getUri(opts);
    });

    const pending = cm.getCachedUri('abc');
    await inCall;
    release();
    expect(await pending).toBe('file://DATA/content-cache/abc.png');
  });

  it('T6/G3: a purge landing in a FAILING stat does not churn the purged manifest', async () => {
    // Neither of the other two guards is reachable here — stat threw, so the catch is
    // the only code that runs. Its guard stops `delete this.manifest.entries[id]` +
    // saveManifest() from self-healing against a manifest that is already a new, empty
    // object: an extra write against state the purge has deliberately reset.
    seedManifest({ abc: makeEntry('abc', 'abc.png', 500) }); // entry with NO file → stat throws
    (fs.rmdir as Mock).mockRejectedValue(new Error('Permission denied'));

    const cm = new AndroidCacheManager();
    await cm.init();

    const { entered, release } = gateFilesystem('stat', (opts) =>
      String(opts.path).endsWith('abc.png'));
    const pending = cm.getCachedUri('abc');
    await entered;
    await expect(cm.clearCache()).rejects.toThrow('Permission denied');
    const writesAfterPurge = manifestWriteCount();
    release();

    expect(await pending).toBeNull();
    expect(manifestWriteCount()).toBe(writesAfterPurge);
  });

  it('T6/G3 NEGATIVE CONTROL: with no purge the failing stat DOES self-heal the manifest', async () => {
    // Proves the catch's self-heal is alive — the guard scopes it, it does not delete
    // it. A manager that stopped pruning entries whose files vanished would leak
    // unservable entries forever.
    seedManifest({ abc: makeEntry('abc', 'abc.png', 500) });

    const cm = new AndroidCacheManager();
    await cm.init();
    const before = manifestWriteCount();

    expect(await cm.getCachedUri('abc')).toBeNull();

    expect(manifestWriteCount()).toBe(before + 1);
    expect(diskManifest()!.entries.abc).toBeUndefined();
  });
});
