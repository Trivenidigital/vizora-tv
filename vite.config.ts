import { defineConfig, loadEnv, type Plugin } from 'vite';
import legacy from '@vitejs/plugin-legacy';
import {
  isReleaseMode,
  isSentryConfigured,
  releaseSentryWarning,
  resolveAppVersion,
  resolveReleaseOrigins,
  type ResolvedOrigins,
} from './src/build-provenance';

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
 *
 * WHAT THIS DOES NOT CATCH, so nobody reads it as covering the class:
 *  - A PARTIAL SDK regression. The token check keys on sentry_key/sentry_client, which
 *    live in the DSN/envelope code. A regression that retained, say, captureMessage
 *    while eliminating init() and its integrations would carry neither token and could
 *    fit inside the size headroom. The two arms overlap for the whole-SDK case only.
 *  - The TV budget under CI: `build:tv` is not run there, so only the modern budget is
 *    exercised automatically. The TV numbers are checked when someone builds TV.
 */
function artifactAssertions(opts: { isTvBuild: boolean; sentryConfigured: boolean }): Plugin {
  // Headroom over today's output (~148 kB modern, ~282 kB TV incl. polyfills), sized so
  // ordinary growth does not trip it but a whole vendored SDK does. Raise deliberately
  // and say why — a budget quietly raised to make a build pass is not a budget.
  //
  // GATED ON THE DSN, because the SDK is ~90 kB and a build WITH a DSN is supposed to
  // carry it. Ungated, this would have failed the first build that supplied one —
  // punishing the exact action the telemetry argument asks for, with a message telling
  // them to find what grew. The no-DSN budget is the one that catches the regression
  // this instrument exists for; the with-DSN budget just keeps an upper bound.
  const sdkAllowance = opts.sentryConfigured ? 120_000 : 0;
  const budgetBytes = (opts.isTvBuild ? 340_000 : 200_000) + sdkAllowance;
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
  const origins: ResolvedOrigins = isReleaseMode(mode)
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

  // Whether the artifact gets to claim crash reporting is live, and the build-time
  // warning when it does not — see isSentryConfigured/releaseSentryWarning in
  // src/build-provenance.ts for why this is not fail-closed.
  const sentryConfigured = isSentryConfigured(env);
  const sentryWarning = releaseSentryWarning(mode, sentryConfigured);
  if (sentryWarning) {
    console.warn(sentryWarning);
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
