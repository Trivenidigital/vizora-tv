# Vizora TV - Android TV Display App

## What This Is

Standalone Android TV app that displays digital signage content pushed from the Vizora web dashboard. Extracted from the Vizora monorepo — builds and runs independently.

## Architecture

Capacitor 6 + Vite + TypeScript. The app is a web app (TypeScript) rendered in an Android WebView via Capacitor. Native Java code handles boot auto-start, secure storage, and crash recovery.

**Source files (6 TypeScript + 4 Java)**:
- `src/main.ts` — All app logic (~1300 lines): pairing, WebSocket, content rendering, heartbeat, caching
- `src/cache-manager.ts` — Capacitor Filesystem-based content cache
- `src/secure-storage.ts` — Encrypted storage for device tokens
- `android/app/src/main/java/com/vizora/display/` — 4 Java files (MainActivity, BootReceiver, SecureStoragePlugin, CrashRecoveryHandler)

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

Three Vite env vars in `.env`:
```
VITE_API_URL=https://api.vizora.io
VITE_REALTIME_URL=wss://realtime.vizora.io
VITE_DASHBOARD_URL=https://dashboard.vizora.io
```

Can also be overridden at runtime via URL params or stored Capacitor Preferences.

## Build

```bash
npm install
npm run build          # Vite builds to dist/
npx cap sync android   # Syncs to Android project
npx cap open android   # Opens in Android Studio
```

Or combined: `npm run android:build`

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
