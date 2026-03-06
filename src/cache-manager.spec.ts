/**
 * Android TV Display Client - Cache Manager Smoke Tests
 *
 * Basic test stubs to establish the test framework.
 * Full display testing requires Android emulator/hardware QA.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock Capacitor plugins
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
  Directory: {
    Data: 'DATA',
    Cache: 'CACHE',
  },
  Encoding: {
    UTF8: 'utf8',
  },
}));

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    get: vi.fn(),
    request: vi.fn(),
  },
}));

import { AndroidCacheManager } from './cache-manager';

describe('AndroidCacheManager', () => {
  let cacheManager: AndroidCacheManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cacheManager = new AndroidCacheManager(500);
  });

  it('should instantiate with default cache size', () => {
    const manager = new AndroidCacheManager();
    expect(manager).toBeDefined();
  });

  it('should instantiate with custom cache size', () => {
    const manager = new AndroidCacheManager(1024);
    expect(manager).toBeDefined();
  });

  it('should have init method', () => {
    expect(typeof cacheManager.init).toBe('function');
  });
});
