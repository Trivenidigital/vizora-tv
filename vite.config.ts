import { defineConfig, loadEnv, type Plugin } from 'vite';
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
 */
function resolveAppVersion(mode: string): string {
  const pkgPath = resolve(process.cwd(), 'package.json');
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
    return '0.0.0-dev';
  }

  if (typeof version !== 'string' || version.length === 0) {
    if (RELEASE_MODES.has(mode)) {
      throw new Error(
        `[app-version] cannot build mode "${mode}": "version" is missing or empty in ${pkgPath}. ` +
          `Shipping a build that reports a placeholder version would pass the release gate on the ` +
          `wrong value.`,
      );
    }
    return '0.0.0-dev';
  }

  return version;
}

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

/**
 * Post-build artifact assertions. These run on the EMITTED bundle, because the defect
 * they exist for was invisible to every other instrument: it type-checked, it passed
 * 595 unit tests, and it shipped green.
 *
 * What happened: `initCrashReporting` read the DSN as
 * `import.meta.env.VITE_SENTRY_DSN?.trim()`. Vite statically REPLACES
 * `import.meta.env.VITE_SENTRY_DSN` with a literal, so with no DSN the guard below it
 * reads `if (!undefined) return;` and the whole Sentry path is dead code that gets
 * tree-shaken away. Put ANY transform on that expression — an optional chain, a
 * `.trim()`, a destructure, storing it via a helper — and the substitution no longer
 * feeds a statically-decidable branch, the minifier can no longer prove the branch is
 * dead, and the ENTIRE @sentry/browser SDK lands in the artifact. It cost +90.4 kB
 * uncompressed in a build that cannot send a single event, on TV devices whose engines
 * are frozen and whose storage and parse budgets are not generous.
 *
 * So: read `import.meta.env.X` raw, on its own line, and transform the RESULT.
 *
 * Both assertions THROW. A silent warning is what we already had — the build printed
 * nothing and CI was green.
 */
function artifactAssertions(opts: { isTvBuild: boolean; sentryConfigured: boolean }): Plugin {
  // Headroom over today's output (~148 kB modern, ~282 kB TV incl. polyfills), sized so
  // ordinary growth does not trip it but a whole vendored SDK does. Raise deliberately
  // and say why — a budget quietly raised to make a build pass is not a budget.
  const budgetBytes = opts.isTvBuild ? 340_000 : 200_000;
  return {
    name: 'vizora-artifact-assertions',
    writeBundle(_options, bundle) {
      let totalJs = 0;
      const sentryChunks: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (!fileName.endsWith('.js')) continue;
        const code = (output as { code?: string }).code ?? '';
        totalJs += Buffer.byteLength(code, 'utf8');
        // Matched on SDK-internal tokens, not on /sentry/i: our own log strings mention
        // VITE_SENTRY_DSN, so a naive match flags every healthy build. `sentry_key` and
        // `sentry_client` are DSN/envelope internals that appear ONLY when the transport
        // code is bundled — verified against both a lean and a regressed artifact.
        if (!opts.sentryConfigured && /sentry_key|sentry_client/.test(code)) sentryChunks.push(fileName);
      }

      if (sentryChunks.length > 0) {
        throw new Error(
          `[artifact] @sentry is present in a build with NO VITE_SENTRY_DSN ` +
            `(${sentryChunks.join(', ')}).
` +
            `  The SDK cannot send anything without a DSN, so this is pure weight on a
` +
            `  frozen-engine TV device. The usual cause is a transform applied directly to
` +
            `  import.meta.env.VITE_SENTRY_DSN, which defeats Vite's static replacement and
` +
            `  stops the no-DSN branch being eliminated. Read the env var raw on its own
` +
            `  line, then transform the result.`,
        );
      }

      if (totalJs > budgetBytes) {
        throw new Error(
          `[artifact] JS bundle is ${totalJs} bytes, over the ${budgetBytes} byte budget ` +
            `for mode "${opts.isTvBuild ? 'tv' : 'default'}".
` +
            `  This budget exists because a +90 kB regression once shipped CI-green: the
` +
            `  entire Sentry SDK was pulled into an artifact that could not use it.
` +
            `  Find what grew before raising this number.`,
        );
      }

      console.log(`[artifact] JS ${totalJs} bytes (budget ${budgetBytes}), sentry ${opts.sentryConfigured ? 'configured' : 'absent as expected'}`);
    },
  };
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

  const appVersion = resolveAppVersion(mode);

  // Crash reporting is DSN-gated at runtime (src/crash-reporting.ts returns early
  // without one), so an absent DSN silently turns reportEvent into a total no-op —
  // and every safety argument that rests on telemetry (command_dedupe_*,
  // device_purge_incomplete, crash_loop_capped, …) becomes void with no signal.
  //
  // Deliberately NOT fail-closed: a DSN is a credential, and blocking a release on
  // one we may not have would be worse than shipping without telemetry knowingly.
  // Instead the artifact SELF-DESCRIBES (see __VIZORA_SENTRY_CONFIGURED__ in
  // src/main.ts) and the build says so out loud.
  const sentryConfigured = Boolean(env.VITE_SENTRY_DSN);
  if (RELEASE_MODES.has(mode) && !sentryConfigured) {
    console.warn(
      `\n[sentry] WARNING: building release mode "${mode}" with NO VITE_SENTRY_DSN.\n` +
        `  Crash reporting will be a no-op in this artifact: reportEvent() returns without\n` +
        `  sending, so command_dedupe_*, device_purge_incomplete, crash_loop_capped and every\n` +
        `  other safety signal this release depends on will be silently unobservable.\n` +
        `  The bundle records this as __VIZORA_SENTRY_CONFIGURED__ = false — the publish-side\n` +
        `  verifier reads it back out of the artifact.\n`,
    );
  }

  return {
    root: '.',
    // Packaged TV apps load index.html from file:// — asset URLs must be
    // relative, root-absolute /assets/... resolves to the filesystem root.
    base: isTvBuild ? './' : '/',
    plugins: isTvBuild
      ? [
          artifactAssertions({ isTvBuild, sentryConfigured }),
          legacy({
            targets: ['chrome >= 53'],
            // Legacy-only output: <script type="module"> is blocked from a
            // file:// origin on Chromium (opaque-origin CORS), so a modern
            // TV would skip the nomodule path AND fail the module path —
            // nothing would run. Classic-script SystemJS works everywhere.
            renderModernChunks: false,
          }),
        ]
      : [artifactAssertions({ isTvBuild, sentryConfigured })],
    test: {
      environment: 'node',
      include: ['src/**/*.spec.ts'],
      // Raised from vitest's 5s default because delivery-ack-boundary.spec.ts drives a
      // REAL Socket.IO server over a real loopback socket, on real time — the one suite
      // whose duration tracks machine load rather than fake-clock advancement. At 5s it
      // had ~2s of slack over its own 3s waitFor budget, and a slow run (23.8s vs 16.5s
      // for its neighbour) is exactly the regime that eats 2s, which is how a loaded
      // machine manufactures a red build out of correct code.
      //
      // The two budgets are a PAIR: every helper deadline in that suite must stay
      // comfortably under this, so a failure reports what never happened instead of an
      // anonymous "Test timed out". 30s also keeps nextConnection's 20s bound — which
      // used to exceed the 5s test timeout and could never have reported its own
      // message — genuinely reachable.
      testTimeout: 30_000,
      hookTimeout: 30_000,
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
      // App version read from package.json — see resolveAppVersion() for why this is
      // no longer process.env.npm_package_version.
      '__APP_VERSION__': JSON.stringify(appVersion),
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
      // Whether this artifact was built with a crash-reporting DSN. Stamped as a
      // literal so the publish-side verifier can read it back out of the built
      // bundle (see the __VIZORA_SENTRY_CONFIGURED__ comment in src/main.ts). The
      // DSN itself is a credential and is NOT what gets checked — only whether one
      // was present at build time.
      '__RELEASE_SENTRY_CONFIGURED__': JSON.stringify(sentryConfigured),
    },
  };
});
