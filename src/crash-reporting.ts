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

export function initCrashReporting(): void {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) {
    console.log('[Vizora] Crash reporting disabled (no VITE_SENTRY_DSN)');
    return;
  }

  Sentry.init({
    dsn,
    release: typeof __APP_VERSION__ !== 'undefined' ? `vizora-tv@${__APP_VERSION__}` : undefined,
    // Signage devices are long-lived: keep the event volume bounded.
    sampleRate: 1.0,
    tracesSampleRate: 0,
  });
  enabled = true;
  console.log('[Vizora] Crash reporting initialized');
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
