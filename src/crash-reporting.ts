/**
 * Fleet crash reporting (F14). JS-layer coverage via @sentry/browser:
 * uncaught exceptions, unhandled promise rejections, and breadcrumbs from
 * console/fetch. Native Java/NDK crash capture requires @sentry/capacitor,
 * which adds a native module — deferred to the P0-3 hardware-verification
 * pass so the gradle change is validated on-device.
 *
 * No-op unless VITE_SENTRY_DSN is configured at build time: builds without a
 * DSN ship exactly the previous behavior (nothing initialized, nothing sent).
 */

import * as Sentry from '@sentry/browser';

declare const __APP_VERSION__: string;

let enabled = false;

/**
 * Strip a `token` query param from a URL so a device JWT never rides into a
 * breadcrumb or event payload (F51). Null-safe and no-throw: a non-parseable
 * string falls back to a regex strip and is otherwise returned unchanged.
 */
export function scrubUrl(u: string): string {
  if (!u) return u;
  try {
    const url = new URL(u);
    // Case-insensitive: strip token / Token / TOKEN alike.
    const tokenKeys = [...url.searchParams.keys()].filter(k => k.toLowerCase() === 'token');
    if (tokenKeys.length > 0) {
      for (const key of tokenKeys) url.searchParams.delete(key);
      return url.toString();
    }
    return u;
  } catch {
    return u.replace(/([?&])token=[^&#]*/gi, '$1').replace(/[?&]$/, '');
  }
}

/**
 * Scrub a breadcrumb in place (F51).
 *
 * `data.url|to|from` was never enough. Sentry's DEFAULT integrations capture
 * console output verbatim into `breadcrumb.message`, and this client logs asset and
 * pairing URLs through console.warn/console.error on failure paths — so a single
 * `console.error('… ' + urlWithToken)` shipped the device JWT while the structured
 * fields beside it were spotless.
 */
export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const data = breadcrumb.data;
  if (data) {
    // url plus navigation breadcrumbs' to/from can carry a ?token= asset URL.
    if (typeof data.url === 'string') data.url = scrubUrl(data.url);
    if (typeof data.to === 'string') data.to = scrubUrl(data.to);
    if (typeof data.from === 'string') data.from = scrubUrl(data.from);
  }
  if (typeof breadcrumb.message === 'string') breadcrumb.message = scrubUrl(breadcrumb.message);
  return breadcrumb;
}

/**
 * Scrub an outgoing event in place (F51).
 *
 * Same gap as breadcrumbs, one level up: `event.message` is the whole payload of
 * every reportEvent()/captureMessage call, and `event.exception.values[].value` is
 * the text of a thrown Error — which is exactly where a fetch or media failure puts
 * the URL it failed on, token and all.
 */
export function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  const req = event.request;
  if (req) {
    if (typeof req.url === 'string') req.url = scrubUrl(req.url);
    const headers = req.headers;
    if (headers) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'authorization') headers[key] = 'REDACTED';
      }
    }
  }
  if (typeof event.message === 'string') event.message = scrubUrl(event.message);
  const values = event.exception?.values;
  if (values) {
    for (const value of values) {
      if (typeof value.value === 'string') value.value = scrubUrl(value.value);
    }
  }
  return event;
}

/**
 * The exact options handed to Sentry.init.
 *
 * Exported so a test can assert the scrubbers ON THE OBJECT THE PRODUCTION PATH
 * BUILDS, rather than on functions it imports and hopes are the ones installed.
 * `import.meta.env.VITE_SENTRY_DSN` is replaced at build time, so a test cannot
 * make initCrashReporting() run its Sentry.init at all — binding to this factory is
 * how the assertion reaches the real construction site.
 */
export function crashReportingOptions(dsn: string): Sentry.BrowserOptions {
  return {
    dsn,
    release: typeof __APP_VERSION__ !== 'undefined' ? `vizora-tv@${__APP_VERSION__}` : undefined,
    // Signage devices are long-lived: keep the event volume bounded.
    sampleRate: 1.0,
    tracesSampleRate: 0,
    // Scrub credentials before anything leaves the device (F51): strip `token`
    // query params from URLs and redact any Authorization header/field.
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
  };
}

export function initCrashReporting(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.log('[Vizora] Crash reporting disabled (no VITE_SENTRY_DSN)');
    return;
  }

  Sentry.init(crashReportingOptions(dsn));
  enabled = true;
  console.log('[Vizora] Crash reporting initialized');
}

/**
 * Whether anything sent through reportEvent actually leaves the device.
 *
 * False in every build without a VITE_SENTRY_DSN — which, today, is every build
 * made from this repo. Callers that DESTROY state on the strength of having
 * reported it (the once-ever crash-loop marker) have to ask first.
 */
export function isCrashReportingEnabled(): boolean {
  return enabled;
}

/** Tag all subsequent events with the paired device identity. */
export function setCrashReportingDevice(deviceId: string | null): void {
  if (!enabled) return;
  Sentry.setTag('deviceId', deviceId ?? 'unpaired');
}

/** Report a handled-but-serious condition (playback halts, purge events). */
export function reportEvent(message: string, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  Sentry.captureMessage(message, { level: 'warning', extra });
}
