/**
 * Pure decision logic for build provenance, extracted from vite.config.ts so it is
 * unit-testable without running a build — same idiom as RendererRecoveryGuard /
 * CrashLoopGuard on the Android side, which exist because a decision embedded in
 * framework wiring is a decision nothing can assert on.
 *
 * BUILD-TIME ONLY. This module runs in Node, inside the vite config, and is never
 * imported by app code — `node:fs` must not reach the browser bundle. It lives under
 * src/ so `tsc --noEmit` (which only covers src/) actually typechecks it; vite.config.ts
 * itself is outside the typecheck.
 *
 * What is here is exactly what decides whether a shipped artifact can be trusted to
 * describe itself: which version it reports on every heartbeat, and whether it claims
 * crash reporting is live. Both are read back out of the built artifact by the
 * publish-side verifier, so a wrong answer here is confirmed rather than caught.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Modes that produce a bundle a customer actually runs.
 *
 * Both are release surfaces: `production` becomes the Android APK via `cap sync`,
 * and `tv` becomes the packaged Tizen/webOS app. Guarding only `production` would
 * leave the Samsung/LG builds free to pick up whatever `.env` happened to be on
 * the build machine — the exact hole this guard exists to close, just on the
 * platform nobody was looking at.
 *
 * Dev, test and any ad-hoc mode stay env-driven and unguarded, which is what makes
 * it possible to point a local build at localhost or a staging box.
 */
export const RELEASE_MODES = new Set(['production', 'tv']);

/** Whether `mode` produces an artifact handed to a customer. */
export function isReleaseMode(mode: string): boolean {
  return RELEASE_MODES.has(mode);
}

/**
 * The three backend origins compiled into the client, and the protocol each one
 * must use. Anchored to release-origins.json — see that file for why these are
 * committed rather than supplied by the environment.
 */
export const RELEASE_ORIGINS = [
  { key: 'api', envVar: 'VITE_API_URL', protocol: 'https:' },
  { key: 'realtime', envVar: 'VITE_REALTIME_URL', protocol: 'wss:' },
  { key: 'dashboard', envVar: 'VITE_DASHBOARD_URL', protocol: 'https:' },
] as const;

export type ResolvedOrigins = Record<
  'VITE_API_URL' | 'VITE_REALTIME_URL' | 'VITE_DASHBOARD_URL',
  string
>;

/**
 * Resolve the backend origins for a release build, or throw.
 *
 * Fails closed on every path that could otherwise ship an artifact pointing
 * somewhere unintended: a missing or malformed pin file, an origin that is not a
 * well-formed URL of the expected protocol, or an environment variable that
 * disagrees with the pin.
 *
 * The disagreement case throws rather than silently preferring the pin. Ignoring a
 * developer's `.env` without saying so would be deterministic but baffling — the
 * build would quietly not do what the file in front of them says. A build that
 * stops and names both values is the one that gets understood.
 *
 * @param cwd directory holding release-origins.json. Same seam, same reason, as
 *   resolveAppVersion's: it exists so the decision can be exercised against real pin
 *   files without a build.
 */
export function resolveReleaseOrigins(
  mode: string,
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): ResolvedOrigins {
  const pinPath = resolve(cwd, 'release-origins.json');

  let pin: Record<string, unknown>;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `[release-origins] cannot build mode "${mode}": ${pinPath} is missing or not valid JSON ` +
        `(${(err as Error).message}). This file pins the backend origins compiled into every ` +
        `customer build; a release cannot proceed without it.`,
    );
  }

  const resolved = {} as ResolvedOrigins;

  for (const { key, envVar, protocol } of RELEASE_ORIGINS) {
    const pinned = pin[key];

    if (typeof pinned !== 'string' || pinned.length === 0) {
      throw new Error(
        `[release-origins] cannot build mode "${mode}": "${key}" is missing from ${pinPath}. ` +
          `All of ${RELEASE_ORIGINS.map(o => o.key).join(', ')} must be pinned.`,
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(pinned);
    } catch {
      throw new Error(`[release-origins] "${key}" in ${pinPath} is not a valid URL: "${pinned}"`);
    }

    if (parsed.protocol !== protocol) {
      throw new Error(
        `[release-origins] "${key}" in ${pinPath} must use ${protocol}// — got "${pinned}". ` +
          `Shipping ${parsed.protocol}// would downgrade or break the client's transport.`,
      );
    }

    // A local .env must never be able to redirect a release build. It is allowed to
    // agree with the pin — that is the normal state on a machine set up for dev —
    // but any disagreement stops the build instead of silently going one way.
    const fromEnv = env[envVar];
    if (fromEnv && fromEnv !== pinned) {
      throw new Error(
        `[release-origins] cannot build mode "${mode}": ${envVar} is set to "${fromEnv}" but ` +
          `release-origins.json pins "${key}" to "${pinned}".\n` +
          `  A release build must not take its backend from a local environment file.\n` +
          `  Either unset ${envVar} (or align it with the pin) to build a release, or use a ` +
          `non-release mode — e.g. \`vite build --mode staging\` — to build against something else.`,
      );
    }

    resolved[envVar] = pinned;
  }

  return resolved;
}

/** What a non-release build reports when package.json cannot supply a version. */
export const DEV_VERSION_FALLBACK = '0.0.0-dev';

/**
 * The app version compiled into the bundle, read from package.json.
 *
 * NOT `process.env.npm_package_version`: that variable exists only when the build
 * was launched through an npm script. `npx vite build` (or any CI runner that calls
 * vite directly) silently fell back to '1.0.0', producing an artifact that is signed,
 * passes the origin verifier, and makes every device report `appVersion: "1.0.0"`
 * forever — while the release gate "heartbeat records a non-zero appVersion" passes
 * on the wrong value. Reading the file removes the dependency on how the build was
 * invoked; the same file is already the source of truth for release-origins.json.
 *
 * Release modes THROW rather than fall back. A customer artifact that cannot say
 * which version it is has no way to be recalled, and a wrong version is worse than a
 * failed build.
 *
 * @param cwd directory holding package.json. Defaults to the build's working
 *   directory — the parameter exists so the decision can be exercised against real
 *   files without a build, not so callers can retarget it.
 */
export function resolveAppVersion(mode: string, cwd: string = process.cwd()): string {
  const pkgPath = resolve(cwd, 'package.json');
  let version: unknown;
  try {
    version = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }).version;
  } catch (err) {
    if (RELEASE_MODES.has(mode)) {
      throw new Error(
        `[app-version] cannot build mode "${mode}": ${pkgPath} is missing or not valid JSON ` +
          `(${(err as Error).message}). The compiled-in __APP_VERSION__ is what every device ` +
          `reports on its heartbeat; a release cannot ship without it.`,
      );
    }
    return DEV_VERSION_FALLBACK;
  }

  if (typeof version !== 'string' || version.length === 0) {
    if (RELEASE_MODES.has(mode)) {
      throw new Error(
        `[app-version] cannot build mode "${mode}": "version" is missing or empty in ${pkgPath}. ` +
          `Shipping a build that reports a placeholder version would pass the release gate on the ` +
          `wrong value.`,
      );
    }
    return DEV_VERSION_FALLBACK;
  }

  return version;
}

/**
 * The crash-reporting DSN compiled into the bundle — TRIMMED, or '' when there is none.
 *
 * The trim is not cosmetic. Surrounding whitespace makes a DSN dead on arrival:
 * @sentry/core matches it against `^(?:(\w+):)\/\/…`, so a leading space fails the
 * regex, makeDsn returns undefined, `client._dsn` stays unset, no transport is ever
 * constructed and every event is dropped. Verified against the installed
 * @sentry/core — it does NOT throw, so the app boots normally and looks healthy.
 *
 * Field-diagnosis note, because this is what makes it expensive to find: the ONLY
 * runtime clue is a single `console.error('Invalid Sentry Dsn: …')` from
 * dsnFromString. That line is not DEBUG_BUILD-gated and terser does not strip it
 * (the production build drops console.log/warn and keeps console.error), so one
 * logcat line is the entire signal that telemetry is dead.
 *
 * Trimming is safe in one direction only, which is the good direction: a padded DSN
 * does not work today, so trimming can only turn broken telemetry into working
 * telemetry, and trimming an unpadded DSN is a no-op. There is no input this
 * converts from working to broken.
 */
export function resolveSentryDsn(env: Record<string, string | undefined>): string {
  return env.VITE_SENTRY_DSN?.trim() ?? '';
}

/**
 * Whether this artifact was built with a crash-reporting DSN.
 *
 * Stamped into the bundle as __RELEASE_SENTRY_CONFIGURED__ and read back out by the
 * publish-side verifier, so this is an assertion the artifact makes about itself. The
 * DSN itself is a credential and is never what gets checked — only whether one was
 * present.
 *
 * Defined in terms of resolveSentryDsn ON PURPOSE: the stamp is true exactly when the
 * DSN compiled into the same bundle is non-empty, so the claim and the thing it claims
 * about cannot drift apart. `Boolean(env.VITE_SENTRY_DSN)` could not make that
 * promise — `Boolean('   ')` is true, so a typo in a CI secret stamped `true` over
 * dead telemetry, and the verifier would then read the stamp and CONFIRM the lie. A
 * verifier defeated by a false positive is not a weakened check; it is no check at
 * all, and it is the only one guarding this.
 */
export function isSentryConfigured(env: Record<string, string | undefined>): boolean {
  return resolveSentryDsn(env).length > 0;
}

/**
 * The warning a release build prints when it is being built with no DSN, or null when
 * there is nothing to say.
 *
 * Crash reporting is DSN-gated at runtime (src/crash-reporting.ts returns early
 * without one), so an absent DSN silently turns reportEvent into a total no-op —
 * and every safety argument that rests on telemetry (command_dedupe_*,
 * device_purge_incomplete, crash_loop_capped, …) becomes void with no signal.
 *
 * Deliberately NOT fail-closed: a DSN is a credential, and blocking a release on
 * one we may not have would be worse than shipping without telemetry knowingly.
 * Instead the artifact SELF-DESCRIBES (see __VIZORA_SENTRY_CONFIGURED__ in
 * src/main.ts) and the build says so out loud.
 */
export function releaseSentryWarning(mode: string, sentryConfigured: boolean): string | null {
  if (!RELEASE_MODES.has(mode) || sentryConfigured) return null;

  return (
    `\n[sentry] WARNING: building release mode "${mode}" with NO VITE_SENTRY_DSN.\n` +
    `  Crash reporting will be a no-op in this artifact: reportEvent() returns without\n` +
    `  sending, so command_dedupe_*, device_purge_incomplete, crash_loop_capped and every\n` +
    `  other safety signal this release depends on will be silently unobservable.\n` +
    `  The bundle records this as __VIZORA_SENTRY_CONFIGURED__ = false — the publish-side\n` +
    `  verifier reads it back out of the artifact.\n`
  );
}
