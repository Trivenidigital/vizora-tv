/**
 * Runtime platform detection + TV-specific bootstrap for the Vizora display client.
 *
 * The app runs on three device families from one codebase:
 *  - Android TV: Capacitor native runtime (WebView + native plugins)
 *  - Samsung Smart TV: Tizen web runtime (packaged .wgt, no Capacitor native layer)
 *  - LG Smart TV: webOS web runtime (packaged .ipk, no Capacitor native layer)
 *
 * On the TV web runtimes, Capacitor plugin calls fall through to their web
 * implementations (Preferences→localStorage, CapacitorHttp→fetch,
 * Network→navigator.onLine, App→visibilitychange, SplashScreen→no-op), so the
 * app logic stays identical; this module owns only what genuinely differs:
 * detection, screen keep-awake, remote-control key codes, and device identity.
 *
 * Deliberately dependency-free: unit tests stub globals, nothing else.
 */

export type Platform = 'capacitor' | 'tizen' | 'webos' | 'web';

/** Tizen remote "Back/Return" key (delivered without registration). */
export const TIZEN_BACK_KEYCODE = 10009;
/** webOS remote "Back" key. */
export const WEBOS_BACK_KEYCODE = 461;

interface TizenGlobal {
  power?: {
    request?: (resource: string, state: string) => void;
  };
}

interface WebOSServiceGlobal {
  service?: {
    request?: (
      uri: string,
      params: {
        method?: string;
        parameters?: Record<string, unknown>;
        onSuccess?: (res: unknown) => void;
        onFailure?: (res: unknown) => void;
      },
    ) => void;
  };
}

declare global {
  interface Window {
    tizen?: TizenGlobal;
    webOS?: WebOSServiceGlobal;
    PalmSystem?: unknown;
    Capacitor?: { isNativePlatform?: () => boolean };
  }
}

let cachedPlatform: Platform | null = null;

/**
 * Detect the runtime platform. Order matters: the TV runtimes are checked
 * before Capacitor because a `window.Capacitor` global (from the bundled JS)
 * can exist anywhere, while `window.tizen` / `window.PalmSystem` are injected
 * only by the respective TV runtimes. Defaults to 'capacitor' when no window
 * exists (unit tests / SSR) so existing Android behavior is the baseline.
 */
export function detectPlatform(): Platform {
  if (cachedPlatform) return cachedPlatform;
  if (typeof window === 'undefined') return 'capacitor';

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';

  if (window.tizen || /Tizen/i.test(ua)) {
    cachedPlatform = 'tizen';
  } else if (window.PalmSystem || window.webOS || /Web0S|webOS/i.test(ua)) {
    cachedPlatform = 'webos';
  } else if (window.Capacitor?.isNativePlatform?.()) {
    cachedPlatform = 'capacitor';
  } else {
    cachedPlatform = 'web';
  }
  return cachedPlatform;
}

/** Test hook: reset the memoized platform (detection reads live globals again). */
export function resetPlatformCache(): void {
  cachedPlatform = null;
}

/** True when running inside the Capacitor native (Android) runtime. */
export function isNativeCapacitor(): boolean {
  return detectPlatform() === 'capacitor';
}

/** Device-type string reported to the backend in pairing metadata/heartbeats. */
export function platformDeviceType(): string {
  switch (detectPlatform()) {
    case 'tizen': return 'tizen_tv';
    case 'webos': return 'webos_tv';
    case 'web': return 'web';
    default: return 'android_tv';
  }
}

/**
 * Prefix for the generated pairing deviceIdentifier. Android keeps its
 * historical 'android' prefix — existing backend fleets key device rows on
 * identifiers that start with it, and re-pairing is not an option.
 */
export function platformIdentifierPrefix(): string {
  switch (detectPlatform()) {
    case 'tizen': return 'tizen';
    case 'webos': return 'webos';
    case 'web': return 'web';
    default: return 'android';
  }
}

/**
 * One-time TV runtime bootstrap. Every call is best-effort: a missing or
 * failing TV API must never break app init (signage devices in the field run
 * wildly different firmware revisions), so everything is guarded.
 */
export function initTvPlatform(): void {
  const platform = detectPlatform();
  if (platform === 'tizen') {
    keepScreenAwakeTizen();
  } else if (platform === 'webos') {
    keepScreenAwakeWebOS();
  }
}

/**
 * Tizen: hold the screen at normal brightness so the TV never blanks over
 * signage content. Requires http://tizen.org/privilege/power in config.xml.
 */
function keepScreenAwakeTizen(): void {
  try {
    window.tizen?.power?.request?.('SCREEN', 'SCREEN_NORMAL');
    console.log('[Platform] Tizen screen keep-awake requested');
  } catch (err) {
    console.warn('[Platform] Tizen power request failed (non-fatal):', err);
  }
}

/**
 * webOS: best-effort screensaver suppression via the Luna bus. Consumer
 * firmwares differ in which service is exposed; a failure is logged and
 * ignored — continuous <video> playback already inhibits the screensaver on
 * most models, so this is defense in depth, not a hard requirement.
 */
function keepScreenAwakeWebOS(): void {
  try {
    window.webOS?.service?.request?.('luna://com.webos.service.tvpower/power/setScreenSaverOff', {
      parameters: { screenSaverOff: true },
      onFailure: (res: unknown) => {
        console.warn('[Platform] webOS screensaver-off request rejected (non-fatal):', res);
      },
    });
  } catch (err) {
    console.warn('[Platform] webOS screensaver-off request failed (non-fatal):', err);
  }
}

/**
 * True for remote-control "back" keys on TV runtimes. These arrive as raw
 * keyCodes (the `key` value differs per firmware: 'XF86Back', 'GoBack', …),
 * so match on keyCode. A signage app must swallow them — back must never
 * exit to the TV home screen from the display loop.
 */
export function isTvBackKey(event: KeyboardEvent): boolean {
  return event.keyCode === TIZEN_BACK_KEYCODE || event.keyCode === WEBOS_BACK_KEYCODE;
}
