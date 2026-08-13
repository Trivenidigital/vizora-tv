import { defineConfig, loadEnv } from 'vite';
import legacy from '@vitejs/plugin-legacy';
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
const RELEASE_MODES = new Set(['production', 'tv']);

/**
 * The three backend origins compiled into the client, and the protocol each one
 * must use. Anchored to release-origins.json — see that file for why these are
 * committed rather than supplied by the environment.
 */
const RELEASE_ORIGINS = [
  { key: 'api', envVar: 'VITE_API_URL', protocol: 'https:' },
  { key: 'realtime', envVar: 'VITE_REALTIME_URL', protocol: 'wss:' },
  { key: 'dashboard', envVar: 'VITE_DASHBOARD_URL', protocol: 'https:' },
] as const;

type ResolvedOrigins = Record<'VITE_API_URL' | 'VITE_REALTIME_URL' | 'VITE_DASHBOARD_URL', string>;

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
 */
function resolveReleaseOrigins(mode: string, env: Record<string, string>): ResolvedOrigins {
  const pinPath = resolve(process.cwd(), 'release-origins.json');

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

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current directory
  const env = loadEnv(mode, process.cwd(), '');

  // Release builds take their backend from the committed pin and fail closed;
  // everything else keeps the env-driven defaults used for local work.
  const origins: ResolvedOrigins = RELEASE_MODES.has(mode)
    ? resolveReleaseOrigins(mode, env)
    : {
        VITE_API_URL: env.VITE_API_URL || 'https://api.vizora.io',
        VITE_REALTIME_URL: env.VITE_REALTIME_URL || 'wss://realtime.vizora.io',
        VITE_DASHBOARD_URL: env.VITE_DASHBOARD_URL || 'https://dashboard.vizora.io',
      };

  // TV mode: build for Samsung Tizen / LG webOS smart TVs. Their browser
  // engines are frozen per firmware generation (Tizen 4.0 ≈ Chromium 56,
  // webOS 4.x ≈ Chromium 53), so the bundle needs transpilation + core-js
  // polyfills and a SystemJS (nomodule) loader — old engines don't support
  // <script type="module">, and packaged TV apps load from file:// where
  // module scripts are unreliable anyway. Newer TVs pick the modern build.
  const isTvBuild = mode === 'tv';

  return {
    root: '.',
    // Packaged TV apps load index.html from file:// — asset URLs must be
    // relative, root-absolute /assets/... resolves to the filesystem root.
    base: isTvBuild ? './' : '/',
    plugins: isTvBuild
      ? [
          legacy({
            targets: ['chrome >= 53'],
            // Legacy-only output: <script type="module"> is blocked from a
            // file:// origin on Chromium (opaque-origin CORS), so a modern
            // TV would skip the nomodule path AND fail the module path —
            // nothing would run. Classic-script SystemJS works everywhere.
            renderModernChunks: false,
          }),
        ]
      : [],
    test: {
      environment: 'node',
      include: ['src/**/*.spec.ts'],
    },
    build: {
      outDir: isTvBuild ? 'dist-tv' : 'dist',
      assetsDir: 'assets',
      // Generate single file for Capacitor
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
      // Strip console.log/warn in production builds (keep console.error).
      // TV builds keep console output — field debugging on TVs happens over
      // remote web inspector where the console is the primary signal.
      minify: 'terser',
      terserOptions: {
        compress: {
          drop_console: mode === 'production',
          pure_funcs: mode === 'production' ? ['console.log', 'console.warn'] : [],
        },
      },
    },
    server: {
      port: 3003,
      host: true,
    },
    preview: {
      port: 3003,
      host: true,
    },
    define: {
      // App version from package.json (avoids hardcoding)
      '__APP_VERSION__': JSON.stringify(process.env.npm_package_version || '1.0.0'),
      // Backend origins. In release modes these come from release-origins.json and
      // the build has already failed if anything disagreed; in dev/test they are
      // env-driven. Deliberately NOT `env.X || fallback` here any more: that
      // fallback pointed at a different environment (api.vizora.io) than the one we
      // ship (vizora.cloud), so an absent .env silently produced a working-looking
      // APK aimed at the wrong backend.
      'import.meta.env.VITE_API_URL': JSON.stringify(origins.VITE_API_URL),
      'import.meta.env.VITE_REALTIME_URL': JSON.stringify(origins.VITE_REALTIME_URL),
      'import.meta.env.VITE_DASHBOARD_URL': JSON.stringify(origins.VITE_DASHBOARD_URL),
      // Self-describing artifact: the compiled origins as a JSON *string*, stamped
      // into the bundle so the publish-side gate can read them back out of the APK.
      // Double-stringified deliberately — the inner JSON is the value, the outer
      // quoting is what makes it a single string literal after minification.
      // See the __RELEASE_ORIGINS_JSON__ comment in src/main.ts.
      '__RELEASE_ORIGINS_JSON__': JSON.stringify(
        JSON.stringify({
          api: origins.VITE_API_URL,
          realtime: origins.VITE_REALTIME_URL,
          dashboard: origins.VITE_DASHBOARD_URL,
        }),
      ),
      'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(env.VITE_SENTRY_DSN || ''),
    },
  };
});
