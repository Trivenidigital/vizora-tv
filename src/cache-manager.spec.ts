/**
 * Android TV Display Client - Cache Manager Smoke Tests
 *
 * Basic test stubs to establish the test framework.
 * Full display testing requires Android emulator/hardware QA.
 */

// Mock Capacitor plugins
jest.mock('@capacitor/filesystem', () => ({
  Filesystem: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    deleteFile: jest.fn(),
    readdir: jest.fn(),
    mkdir: jest.fn(),
    stat: jest.fn(),
  },
  Directory: {
    Data: 'DATA',
    Cache: 'CACHE',
  },
  Encoding: {
    UTF8: 'utf8',
  },
}));

jest.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    get: jest.fn(),
    request: jest.fn(),
  },
}));

import { AndroidCacheManager } from './cache-manager';

describe('AndroidCacheManager', () => {
  let cacheManager: AndroidCacheManager;

  beforeEach(() => {
    jest.clearAllMocks();
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
