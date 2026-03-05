# Vizora TV - Android TV Display App

Standalone Android TV app for the [Vizora](https://vizora.cloud) digital signage platform. Displays content pushed from the Vizora web dashboard in real time.

## Architecture

- **Capacitor 6** wrapping a **Vite + TypeScript** web app
- Renders HTML templates in a fullscreen WebView
- Connects to the Vizora backend via **Socket.IO** for real-time content updates
- **REST API** for device pairing and status
- Auto-starts on boot via `BootReceiver`

## Prerequisites

- Node.js 18+
- Android Studio (latest)
- JDK 17
- Android SDK Platform 34

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your server URLs

# Build web assets + sync to Android
npm run android:build

# Open in Android Studio
npm run cap:open
```

## Build Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server (browser testing) |
| `npm run build` | Build web assets to `dist/` |
| `npm run cap:sync` | Sync web assets to Android project |
| `npm run android:build` | Build + sync (one step) |
| `npm run android:run` | Build + sync + launch on connected device |
| `npm run cap:open` | Open Android project in Android Studio |

## Configuration

Copy `.env.example` to `.env` and set:

```env
VITE_API_URL=https://api.vizora.io
VITE_REALTIME_URL=wss://realtime.vizora.io
VITE_DASHBOARD_URL=https://dashboard.vizora.io
```

For local development:
```env
VITE_API_URL=http://10.0.2.2:3000
VITE_REALTIME_URL=http://10.0.2.2:3002
VITE_DASHBOARD_URL=http://10.0.2.2:3001
```

> `10.0.2.2` is the Android emulator's alias for the host machine's `localhost`.

## Key Flows

1. **Pairing**: Device shows a 6-digit code on screen. User enters the code in the Vizora dashboard. Device receives an auth token and is linked to the organization.
2. **Content**: Dashboard pushes playlists via WebSocket. Device renders HTML templates in a fullscreen WebView with zone-based layout support.
3. **Heartbeat**: Device sends status every 30 seconds (online, current content, system info).
4. **Boot**: App auto-starts when the TV powers on via Android `RECEIVE_BOOT_COMPLETED`.

## Project Structure

```
src/
  main.ts              # App entry point (~1300 lines, all client logic)
  cache-manager.ts     # Content caching via Capacitor Filesystem
  secure-storage.ts    # Encrypted device token storage
android/
  app/src/main/java/com/vizora/display/
    MainActivity.java         # Capacitor activity
    BootReceiver.java          # Auto-start on boot
    SecureStoragePlugin.java   # Native secure storage bridge
    CrashRecoveryHandler.java  # Crash recovery
store-listing/                 # Play Store assets (icons, screenshots)
```

## Deployment

See [BUILD_INSTRUCTIONS.md](./BUILD_INSTRUCTIONS.md) for detailed build and deployment steps.

See [GOOGLE_PLAY_PUBLISHING.md](./GOOGLE_PLAY_PUBLISHING.md) for Play Store submission.

## Related

- **Vizora Backend**: [github.com/Trivenidigital/Vizora](https://github.com/Trivenidigital/Vizora) (middleware API, realtime gateway, web dashboard)
