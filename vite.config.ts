import { defineConfig, loadEnv } from 'vite';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current directory
  const env = loadEnv(mode, process.cwd(), '');

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
      // Environment variables for production
      'import.meta.env.VITE_API_URL': JSON.stringify(env.VITE_API_URL || 'https://api.vizora.io'),
      'import.meta.env.VITE_REALTIME_URL': JSON.stringify(env.VITE_REALTIME_URL || 'wss://realtime.vizora.io'),
      'import.meta.env.VITE_DASHBOARD_URL': JSON.stringify(env.VITE_DASHBOARD_URL || 'https://dashboard.vizora.io'),
      'import.meta.env.VITE_SENTRY_DSN': JSON.stringify(env.VITE_SENTRY_DSN || ''),
    },
  };
});
