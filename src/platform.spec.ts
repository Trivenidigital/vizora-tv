/**
 * Platform detection + TV bootstrap unit tests (src/platform.ts).
 * Node environment: window/navigator are stubbed per-test.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  detectPlatform,
  resetPlatformCache,
  isNativeCapacitor,
  platformDeviceType,
  platformIdentifierPrefix,
  initTvPlatform,
  isTvBackKey,
  TIZEN_BACK_KEYCODE,
  WEBOS_BACK_KEYCODE,
} from './platform';

function stubEnv(win: Record<string, unknown> | undefined, userAgent = '') {
  if (win === undefined) {
    vi.stubGlobal('window', undefined);
  } else {
    vi.stubGlobal('window', win);
  }
  vi.stubGlobal('navigator', { userAgent });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPlatformCache();
});

describe('detectPlatform', () => {
  it('defaults to capacitor when no window exists (test/SSR baseline)', () => {
    stubEnv(undefined);
    expect(detectPlatform()).toBe('capacitor');
    expect(isNativeCapacitor()).toBe(true);
  });

  it('detects Tizen via the injected tizen global', () => {
    stubEnv({ tizen: {} });
    expect(detectPlatform()).toBe('tizen');
    expect(platformDeviceType()).toBe('tizen_tv');
    expect(platformIdentifierPrefix()).toBe('tizen');
  });

  it('detects Tizen via user agent when the global is absent', () => {
    stubEnv({}, 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36');
    expect(detectPlatform()).toBe('tizen');
  });

  it('detects webOS via PalmSystem global', () => {
    stubEnv({ PalmSystem: {} });
    expect(detectPlatform()).toBe('webos');
    expect(platformDeviceType()).toBe('webos_tv');
    expect(platformIdentifierPrefix()).toBe('webos');
  });

  it('detects webOS via user agent', () => {
    stubEnv({}, 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36');
    expect(detectPlatform()).toBe('webos');
  });

  it('detects native Capacitor runtime via the Capacitor bridge global', () => {
    stubEnv({ Capacitor: { isNativePlatform: () => true } });
    expect(detectPlatform()).toBe('capacitor');
    expect(platformDeviceType()).toBe('android_tv');
    expect(platformIdentifierPrefix()).toBe('android');
  });

  it('falls back to plain web when nothing TV/native is present', () => {
    stubEnv({}, 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120');
    expect(detectPlatform()).toBe('web');
    expect(isNativeCapacitor()).toBe(false);
    expect(platformDeviceType()).toBe('web');
  });

  it('prefers the TV runtime over a Capacitor bridge global', () => {
    // The bundled JS can define window.Capacitor anywhere; the injected TV
    // globals are authoritative.
    stubEnv({ tizen: {}, Capacitor: { isNativePlatform: () => true } });
    expect(detectPlatform()).toBe('tizen');
  });

  it('memoizes until resetPlatformCache()', () => {
    stubEnv({ tizen: {} });
    expect(detectPlatform()).toBe('tizen');
    stubEnv({ PalmSystem: {} });
    expect(detectPlatform()).toBe('tizen'); // still cached
    resetPlatformCache();
    expect(detectPlatform()).toBe('webos');
  });
});

describe('initTvPlatform', () => {
  it('requests Tizen screen keep-awake with the power API', () => {
    const request = vi.fn();
    stubEnv({ tizen: { power: { request } } });
    initTvPlatform();
    expect(request).toHaveBeenCalledWith('SCREEN', 'SCREEN_NORMAL');
  });

  it('survives a throwing Tizen power API', () => {
    stubEnv({ tizen: { power: { request: () => { throw new Error('denied'); } } } });
    expect(() => initTvPlatform()).not.toThrow();
  });

  it('requests webOS screensaver-off via the raw PalmServiceBridge (the runtime-injected API)', () => {
    const call = vi.fn();
    class BridgeStub {
      onservicecallback: ((msg: string) => void) | null = null;
      call = call;
    }
    stubEnv({ PalmSystem: {}, PalmServiceBridge: BridgeStub });
    initTvPlatform();
    expect(call).toHaveBeenCalledWith(
      'luna://com.webos.service.tvpower/power/setScreenSaverOff',
      JSON.stringify({ screenSaverOff: true }),
    );
  });

  it('falls back to webOSTV.js service.request when PalmServiceBridge is absent', () => {
    const request = vi.fn();
    stubEnv({ PalmSystem: {}, webOS: { service: { request } } });
    initTvPlatform();
    expect(request).toHaveBeenCalledWith(
      'luna://com.webos.service.tvpower/power/setScreenSaverOff',
      expect.objectContaining({ parameters: { screenSaverOff: true } }),
    );
  });

  it('is a no-op on webOS without any service bridge', () => {
    stubEnv({ PalmSystem: {} });
    expect(() => initTvPlatform()).not.toThrow();
  });

  it('survives a throwing PalmServiceBridge', () => {
    class ThrowingBridge {
      constructor() { throw new Error('luna denied'); }
    }
    stubEnv({ PalmSystem: {}, PalmServiceBridge: ThrowingBridge });
    expect(() => initTvPlatform()).not.toThrow();
  });

  it('is a no-op on capacitor/web', () => {
    stubEnv(undefined);
    expect(() => initTvPlatform()).not.toThrow();
  });
});

describe('isTvBackKey', () => {
  it('matches the Tizen and webOS back keycodes and nothing else', () => {
    expect(isTvBackKey({ keyCode: TIZEN_BACK_KEYCODE } as KeyboardEvent)).toBe(true);
    expect(isTvBackKey({ keyCode: WEBOS_BACK_KEYCODE } as KeyboardEvent)).toBe(true);
    expect(isTvBackKey({ keyCode: 27 } as KeyboardEvent)).toBe(false);
    expect(isTvBackKey({ keyCode: 13 } as KeyboardEvent)).toBe(false);
  });
});
