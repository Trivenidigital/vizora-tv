# Samsung (Tizen) & LG (webOS) Smart TV Support

The Vizora display client runs on three TV families from one codebase:

| Platform | Runtime | Package | Support floor |
|---|---|---|---|
| Android TV / Google TV | Capacitor (native WebView) | `.apk` / `.aab` | Android 7+ (unchanged) |
| Samsung Smart TV | Tizen web runtime | `.wgt` | Tizen 4.0+ (2018 models, Chromium 56) |
| LG Smart TV | webOS web runtime | `.ipk` | webOS 4.0+ (2018 models, Chromium 53) |

## How it works

The app is a web app either way. On Android it runs inside Capacitor's native
WebView with native plugins; on Samsung/LG it runs as a packaged TV web app and
the same Capacitor plugin calls fall through to their **web implementations**:

| Capability | Android (Capacitor native) | Samsung / LG (web runtime) |
|---|---|---|
| HTTP (pairing, auth, pull) | `CapacitorHttp` native | `fetch` (Capacitor web impl) |
| Preferences | SharedPreferences | `localStorage` (Capacitor web impl) |
| Network status | ConnectivityManager | `navigator.onLine` + events |
| App lifecycle | Activity lifecycle | `visibilitychange` |
| Splash screen | Native splash | no-op |
| Device credentials | Keystore-encrypted storage | `localStorage` fallback (see Security) |
| Content cache | Capacitor Filesystem (`src/cache-manager.ts`) | IndexedDB blob cache (`src/tv-cache-manager.ts`) |
| Keep screen awake | Activity flags | `tizen.power` / Luna `setScreenSaverOff` (best-effort) |
| Back key | `App.addListener('backButton')` | keyCodes 10009 (Tizen) / 461 (webOS), swallowed |

Platform detection and all TV-specific bootstrap live in `src/platform.ts`.
Detection order: `window.tizen`/UA → Tizen; `window.PalmSystem`/`webOS`/UA →
webOS; Capacitor native bridge → Android; otherwise plain web (dev browser).

Devices report `platform: tizen_tv | webos_tv` in pairing metadata and generate
`tizen-…` / `webos-…` device identifiers (Android keeps `android-…`).

## Building

```bash
npm run build:tv      # Vite build with @vitejs/plugin-legacy -> dist-tv/
npm run tizen:build   # build:tv + assemble build/tizen/
npm run webos:build   # build:tv + assemble build/webos/
npm run tv:build      # both
```

The TV build transpiles + polyfills down to Chromium 53 and emits a SystemJS
(`nomodule`) loader — the frozen TV engines predate `<script type="module">`.
Newer TVs automatically use the modern build in the same bundle.

### Packaging for Samsung (Tizen Studio required)

1. Install [Tizen Studio](https://developer.tizen.org/development/tizen-studio/download)
   with the TV extension, create a **Samsung certificate profile**
   (Tools → Certificate Manager; a Samsung account is required for device deploys).
2. Enable **Developer Mode** on the TV: Apps panel → type `12345` on the remote,
   set the host machine's IP, reboot the TV.
3. ```bash
   npm run tizen:build
   tizen package -t wgt -s <security-profile> -- build/tizen
   tizen connect <tv-ip>
   tizen install -n <generated>.wgt -t <tv-id>
   ```

The manifest is `tizen/config.xml` (app id `VizoraDsp0.VizoraDisplay`,
privileges: `internet`, `power`; `<access origin="*">` for cross-origin API
calls from the packaged origin).

### Packaging for LG (webOS TV SDK required)

1. Install the [webOS TV SDK / CLI](https://webostv.developer.lge.com/develop/tools/cli-installation)
   (`ares-*` tools).
2. Enable **Developer Mode** on the TV via the Developer Mode app
   (LG developer account required), then `ares-setup-device`.
3. ```bash
   npm run webos:build
   ares-package build/webos -o build
   ares-install --device <tv> build/com.vizora.display_1.0.1_all.ipk
   ```

The manifest is `webos/appinfo.json` (app id `com.vizora.display`,
`disableBackHistoryAPI: true` so the remote's Back key never navigates history).

Icons for both platforms are committed (`tizen/icon.png`, `webos/icon.png`,
`webos/largeIcon.png`) and regenerated from `store-listing/icons/app-icon.svg`
with `npm run tv:icons`.

## Backend / operations notes

- **CORS**: packaged TV apps run from a `file://` origin, so API requests may
  carry `Origin: null` (or no Origin). The API and Socket.IO realtime gateway
  must not reject null-origin requests from device endpoints. Tizen's
  `<access origin="*">` grants the client side; the server side must allow it.
- **Pairing metadata**: expect `platform: "tizen_tv" | "webos_tv"` and
  `tizen-`/`webos-` prefixed device identifiers from these devices.
- **Auto-start on boot**: Android auto-starts via `BootReceiver`. Consumer
  Samsung/LG TVs have no unconditional web-app autostart; use the TV's
  "run last app on power-on" behavior, retailer/hotel mode, or the signage
  firmware lines (Samsung SSSP / LG webOS Signage) for true kiosk deployments.

## Security

TV web runtimes expose no hardware keystore to web apps, so on Samsung/LG the
device JWT persists in `localStorage` inside the app's OS-level sandbox
(`src/secure-storage.ts` web fallback). This is the standard boundary for TV
web apps; it is deliberately NOT wrapped in bundled-key "encryption", which
would be obfuscation rather than security. Android keeps Keystore-encrypted
storage. Revocation (contract §3.4) behaves identically on all platforms.

## Known limitations on TV

- **Multi-zone layouts** use CSS Grid (Chromium 57+): rendered correctly on
  Tizen 5.0+ (2019) and webOS 5.0+ (2020); on the 2018 floor models zones
  stack instead of forming a grid. Single-content playlists are unaffected.
- **Keep-awake on webOS** is best-effort (Luna service availability varies by
  firmware); continuous video playback inhibits the screensaver on most models.
- **Heartbeat memory metrics** (`performance.memory`) are Chrome-only and
  report the default value on some TV engines.
- The Tizen/webOS **emulators/simulators** don't implement every TV API
  (`webapis`, some Luna services); on-device testing is authoritative.
