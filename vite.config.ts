import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current directory
  const env = loadEnv(mode, process.cwd(), '');

  return {
    root: '.',
    test: {
      globals: true,
      environment: 'node',
      include: ['src/**/*.spec.ts'],
    },
    build: {
      outDir: 'dist',
      assetsDir: 'assets',
      // Generate single file for Capacitor
      rollupOptions: {
        output: {
          manualChunks: undefined,
        },
      },
      // Strip console.log/warn in production builds (keep console.error)
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
    },
  };
});
