# Vizora TV - Smart TV Display App

## What This Is

Standalone TV app that displays digital signage content pushed from the Vizora web dashboard. Extracted from the Vizora monorepo — builds and runs independently. Runs on Android TV (Capacitor native), Samsung Smart TV (Tizen 4.0+), and LG Smart TV (webOS 4.0+) from one codebase — see `docs/SAMSUNG_LG_TV.md`.

## Architecture

Capacitor 6 + Vite + TypeScript. The app is a web app (TypeScript): on Android it renders in a WebView via Capacitor (native Java handles boot auto-start, secure storage, crash recovery); on Samsung/LG it ships as a packaged TV web app where Capacitor plugin calls fall through to their web implementations and `src/platform.ts` handles the platform-specific pieces.

**Source files (TypeScript + 4 Java)**:
- `src/main.ts` — All app logic: pairing, WebSocket, content rendering, heartbeat, caching
- `src/platform.ts` — Platform detection (capacitor/tizen/webos/web) + TV bootstrap (keep-awake, remote back keys, device identity)
- `src/cache-manager.ts` — Capacitor Filesystem-based content cache (Android)
- `src/tv-cache-manager.ts` — IndexedDB blob content cache (Tizen/webOS/web)
- `src/secure-storage.ts` — Encrypted storage for device tokens (native on Android; localStorage fallback on TV web runtimes)
- `android/app/src/main/java/com/vizora/display/` — 4 Java files (MainActivity, BootReceiver, SecureStoragePlugin, CrashRecoveryHandler)
- `tizen/` + `webos/` — TV packaging manifests and icons; assembled by `scripts/package-tv.mjs`

## Communication with Backend

The app talks to two Vizora backend services:

**REST API** (`VITE_API_URL`):
- `POST /api/v1/devices/pairing/request` — Request pairing code
- `GET /api/v1/devices/pairing/status/{code}` — Poll pairing status

**WebSocket** (`VITE_REALTIME_URL`, Socket.IO):
- Emits: `heartbeat`, `content:impression`
- Listens: `playlist:update`, `command`, `config`, `qr-overlay:update`
- Auth: Device JWT token in Socket.IO handshake (`auth.token`)

## Configuration

**Release builds** (`production` → Android APK, `tv` → Tizen/webOS) take their three
backend origins from the committed `release-origins.json` and **fail closed** — a
missing/malformed pin, a wrong protocol, or a `VITE_*` env var that disagrees with
the pin all stop the build. A local `.env` cannot redirect a customer artifact.

```
api        https://vizora.cloud
realtime   wss://vizora.cloud
dashboard  https://vizora.cloud
```

**Local development** still uses `.env` (see `.env.example`); the `VITE_*` vars apply
in non-release modes only. To build against another backend, use a non-release mode:
`vite build --mode staging`.

`VITE_SENTRY_DSN` is not an origin and stays env-driven in every mode. All three
origins can still be overridden at runtime via URL params or stored Capacitor
Preferences — that is a paired-device support path, not a build input.

## Build

```bash
npm install
npm run build          # Vite builds to dist/
npx cap sync android   # Syncs to Android project
npx cap open android   # Opens in Android Studio
```

Or combined: `npm run android:build`

Samsung/LG TV builds (legacy-transpiled for frozen TV Chromium engines):

```bash
npm run tizen:build    # dist-tv/ + build/tizen/ (package with Tizen Studio CLI)
npm run webos:build    # dist-tv/ + build/webos/ (package with ares-package)
```

## Key Patterns

- **Device JWT auth**: Token received during pairing, stored in SecureStorage (native encrypted), sent with all API/WebSocket calls
- **Content caching**: AndroidCacheManager caches content assets to Capacitor Filesystem for offline display
- **Auto-reconnect**: WebSocket reconnects with exponential backoff on disconnect
- **Boot persistence**: BootReceiver.java auto-launches app on device boot
- **Zone rendering**: Templates support multi-zone layouts rendered in the WebView

## Testing

```bash
npm test  # Jest unit tests (cache-manager)
```

No E2E test suite — manual testing on Android TV emulator or physical device.

## Package ID

`com.vizora.display` — do not change (breaks existing paired devices).
