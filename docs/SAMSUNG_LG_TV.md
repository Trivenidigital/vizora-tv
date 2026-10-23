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
npm run webos:package # webos:build + ares-package -> build/com.vizora.display_<version>_all.ipk
npm run tv:build      # both
```

The TV build transpiles + polyfills down to Chromium 53, uses a relative
`base` (packaged apps load from `file://`, where root-absolute `/assets/…`
resolves to the filesystem root), and emits ONLY the legacy SystemJS bundle
(`renderModernChunks: false`): `<script type="module">` is blocked from a
`file://` origin on Chromium regardless of engine age, so shipping module
scripts at all would strand newer TVs. `scripts/package-tv.mjs` additionally
strips `crossorigin` attributes, which put script fetches into (blocked)
CORS mode on `file://`.

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

### Packaging for LG

Packaging needs **no TV, Developer Mode or LG account**. LG's official CLI
(`@webos-tools/cli`, which provides `ares-package`) is an exact-pinned
devDependency, so `npm ci` installs it:

```bash
npm run webos:package
# = npm run webos:build && ares-package --no-minify build/webos -o build
# -> build/com.vizora.display_<version>_all.ipk   (<version> = package.json "version")
```

`--no-minify` matters. By default `ares-package` runs terser over every `.js`
file again, so the shipped bundle would not be the one Vite emitted and the
artifact assertions in `vite.config.ts` checked. With the flag the packaged
payload is byte-identical to `build/webos/`.

`ares-package` warns that `requiredACG` is not defined. That warning is
deliberately left in place for now: see "Known limitations".

Installing onto a TV is the only step that needs hardware:

1. Enable **Developer Mode** on the TV via the Developer Mode app
   (LG developer account required), then `npx ares-setup-device`.
2. ```bash
   npx ares-install --device <tv> build/com.vizora.display_<version>_all.ipk
   ```

The manifest is `webos/appinfo.json` (app id `com.vizora.display`,
`disableBackHistoryAPI: true` so the app receives the remote's Back key itself
and swallows it, instead of the platform navigating history). `version` is
stamped from `package.json` at assembly time. `splashBackground` is absent on
purpose: LG defines it as the path to a 1920x1080 PNG, not a colour, and
`ares-package` rejects a colour value there.

### file:// origin check (no TV needed)

```bash
npm run webos:package          # or webos:build
npx playwright-core install chromium-headless-shell   # once per machine
node scripts/webos-file-origin-check.mjs [--app-dir build/webos]
```

The check opens the packaged `index.html` from `file://` in headless Chromium,
points the app at a loopback stub API through the app's `?api_url=` override
(so the artifact under test is the real release build), and runs pairing twice.
In MODE A the preflight answers like prod does today (204 with no
`Access-Control-Allow-Origin`). In MODE B it answers `Access-Control-Allow-Origin: null`
with no credentials. It fails unless A is blocked **and** B pairs.

**What it proves, on a modern desktop Chromium:** the legacy SystemJS bundle
boots from `file://` with relative asset paths; a packaged page sends the
literal `Origin: null`; the pairing POST is CORS-preflighted and blocked by
prod's current preflight answer; `ACAO: null` without credentials is enough to
unblock it. Pointed at an unstripped `dist-tv/` it fails to boot, because the
`crossorigin` script fetch is blocked on `file://`. That is the defect
`package-tv.mjs` strips the attribute for.

**What it does not prove:** anything about the webOS runtime. The engine is
not webOS's Chromium 53–120. `PalmSystem` is an empty stub, and there are no
Luna services, no LG app security policy and no TV TLS trust store. It does not
cover the `Authorization`-header requests after pairing, or Socket.IO. Every
item in the on-device checklist below still stands.

Icons for both platforms are committed (`tizen/icon.png`, `webos/icon.png`,
`webos/largeIcon.png`) and regenerated from `store-listing/icons/app-icon.svg`
with `npm run tv:icons`.

## Backend / operations notes

- **CORS**: packaged TV apps run from a `file://` origin, so API requests may
  carry `Origin: null` (or no Origin). Unlike Android's native CapacitorHttp
  (which bypasses CORS), the TV path is a real browser `fetch`: the JSON
  pairing POST and every `Authorization`-header GET trigger an OPTIONS
  preflight. The API **and** the Socket.IO realtime gateway (including its
  polling transport) must answer preflights and allow null-origin requests on
  device endpoints. Tizen's `<access origin="*">` grants the client side; the
  server side must allow it.
- **HTTP timeouts**: the web fetch path has no native connect/read timeouts;
  the app enforces wall-clock bounds itself (`httpWithTimeout` in main.ts) so
  a black-holed connection can't stall the pairing or auth-probe loops.
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
- **Keep-awake on webOS** is best-effort: the app calls the Luna power
  service through the runtime-injected `PalmServiceBridge` (falling back to
  `webOS.service` if webOSTV.js is bundled), but which power methods exist
  varies by firmware; continuous video playback inhibits the screensaver on
  most models.
- **Content cache size** defaults to 200 MB on TV (vs 500 MB on Android) —
  real TV IndexedDB quotas are limited, and a quota error just degrades that
  asset to direct streaming.
- **Heartbeat memory metrics** (`performance.memory`) are Chrome-only and
  report the default value on some TV engines.
- **`requiredACG` is not declared** in `webos/appinfo.json`. LG's
  [ACG guide](https://webostv.developer.lge.com/develop/guides/acg-guide)
  makes it mandatory from webOS TV 27, and enforceable but optional on 26. It
  is unsupported on 25 and lower. The app calls one Luna API
  (`luna://com.webos.service.tvpower/power/setScreenSaverOff`). An empty array
  would therefore likely deny that call where ACG is enforced. LG's guide does
  not list the group name for `tvpower`, so the field stays out until the right
  group is confirmed. Older TVs are unaffected.
- The Tizen/webOS **emulators/simulators** don't implement every TV API
  (`webapis`, some Luna services); on-device testing is authoritative.

## On-device verification checklist

Code-level review can't cover everything; verify on real hardware (one 2018
floor model + one recent model per brand):

1. App boots from the installed package (SystemJS bundle loads from `file://`).
2. Pairing round-trip against production API — watch for CORS preflight
   rejections (`Origin: null`) in the remote web inspector.
3. Socket.IO connects (websocket first, then force polling) and heartbeats ack.
4. TLS: 2018-era TV trust stores may lack newer roots (e.g. ISRG Root X1 /
   Let's Encrypt) — confirm the production cert chain is accepted.
5. Offline resilience: pull power, reboot without network, cached playlist
   plays from IndexedDB.
6. IndexedDB quota behavior with a video-heavy playlist (eviction vs quota
   errors).
7. Screensaver stays off through a long image-only playlist (Tizen `power`
   privilege / webOS Luna call).
8. Remote-control Back key does not exit the app; app survives Home + relaunch.
9. If `VITE_SENTRY_DSN` is set: @sentry/browser 10.x officially targets newer
   engines than Chromium 53 — verify init doesn't throw, or ship TV builds
   with the DSN empty.
