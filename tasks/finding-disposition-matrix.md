# Finding disposition matrix — 2026-08-15 development wave

Every candidate improvement surfaced by discovery Agents A–E, plus the final
review wave, with exactly one disposition each and the consuming-path evidence
that justifies it.

**Dispositions:** `REAL_FIXED` · `ALREADY_FIXED` · `NOT_WORTH_CHANGING` ·
`HARDWARE_BLOCKED` · `FALSE_ALARM`

Baseline: tag `v1.3.15` (`9ec5a71`). `master` was only docs-ahead of it, so every
"already fixed" below is fixed **in the shipped bytes**, not merely on a branch.

Line references are to the audited tree unless a fix moved them; where a fix
moved code, the evidence cites the shipped location that was audited.

---

## Agent A — current-state archaeology (~50 historical findings reconciled)

### A.1 Still real, and fixed in this wave

| Finding | Disposition | Consuming-path evidence |
|---|---|---|
| F2 crash restart had no counter/backoff/give-up | **REAL_FIXED** | `CrashRecoveryHandler.java:20,45` — fixed 3s, unconditional; no counter anywhere in `android/app/src/main/java/`. Now a capped ladder via `CrashLoopGuard` |
| F18 no `MY_PACKAGE_REPLACED` receiver | **REAL_FIXED** | `AndroidManifest.xml:56-69` declared only `BootReceiver`; grep `PACKAGE_REPLACED` → no matches. Receiver added (relaunch itself HARDWARE_BLOCKED — see D.3) |
| F26 `webpage`/`url` iframe unsandboxed | **REAL_FIXED** | `main.ts:2381-2389` set `src`/`allow`/`style` only, vs `:2394` which does `iframe.sandbox.add('allow-scripts')` |
| F43 residual — allowlist applied write-side only | **REAL_FIXED** | `main.ts:1974` gated `update_config`, but `:171` `private config: Config = DEFAULT_CONFIG` **aliased** the anchor `isAllowedConfigUrl` reads at `:451-453`, and `:407-426` mutates it |
| NEW — `purgeDeviceState` non-atomic | **REAL_FIXED** | `main.ts:1570-1574` — five sequential awaits, no try/catch; `SecureStoragePlugin.java:118-125,204-207` prove `remove` rejects; callers use `void this.confirmRevocation(...)` at `:1021,:1260,:1277` so the rejection was an unhandled rejection |
| NEW — version committed before playlist applied | **REAL_FIXED** | `main.ts:1122-1126` set `currentContentVersion` before `updatePlaylist`; `utils.ts:34` throws on a malformed item, leaving the device reporting content it is not rendering — and `device.gateway.ts:1269` then sees agreement, so reconcile never self-heals |
| F16 partial — no evict-on-render-error | **REAL_FIXED** (evict path) | `main.ts:1798-1807` advanced past a broken item without evicting, so the corrupt asset was retried every loop |
| F34 cache orphan/manifest ordering | **REAL_FIXED** (ordering) | `cache-manager.ts:134-158` wrote file then manifest with no reconciliation in `init():45-68` |

### A.2 Already fixed in shipped 1.3.15 — no action
`F3` auth fail-open (`main.ts:1253-1273`, only 410 purges) · `F4` cross-tenant
stale (`:360-379`) · `F5-F9/F11/F35` never-black (`:1694-1743` bounded scan,
`:1814-1827` append-then-remove, `:1901-1919` holding self-heal) · `F10`
targetSDK 35 (`variables.gradle:3-4`) · `F10b` USE_EXACT_ALARM removed
(`AndroidManifest.xml:8-11`) · `F12` zone-timer leak (`:2224-2231`) · `F15`
idempotent updates (`:1625-1634` + `utils.ts:22-37`) · `F17` video watchdog
(`:1851-1860`) · `F19` init dead-end (`:249-258`) · `F21` status pill
(`:2463-2475`) · `F29` TV banner · `F32` version drift · `F36` renderer recovery
(`MainActivity.java:69-100`) · `F37` keystore-read brick (`:288-321`) · `F39`
plaintext downgrade (`SecureStoragePlugin.java:107-111`) · `F40` ack envelope
(`:1017-1030`) · `F41` suspend latch · `F42` tenant_id read · `F44/F53`
main-thread keystore · `F45` QR innerHTML (`:864` textContent) · `F46` unpair
rate-limit · `F47` push clobber · `F48` handler chain · `F49` apply→commit ·
`F50` push suspend bypass · `F51` Sentry scrubbing · `F52` migration atomicity ·
`F54` WAKE_LOCK absent · `F55` quick-boot actions · `F56` entry-level self-heal ·
`#28/#31` entitlement race · `#20` token rotation · `#18` release origins · `#3`
push_content guard. **All ALREADY_FIXED.**

### A.3 Deliberately not changed

| Finding | Disposition | Why |
|---|---|---|
| F38 401 → re-pair | **NOT_WORTH_CHANGING** | Rejected by design; `main.ts:1467-1481` fails open deliberately and a locked test pins it. Re-pairing on a 401 is the fleet-wide brick this was written to avoid |
| F27 template CSP breadth (`img-src https:`) | **NOT_WORTH_CHANGING** | `utils.ts:66` — retained by design; the frame is opaque-origin with no `allow-same-origin`, so it knows nothing worth exfiltrating |
| F30 identity churn per pairing attempt | **NOT_WORTH_CHANGING** | `main.ts:718` — cosmetic churn; no customer-visible effect, and changing identity derivation risks the pairing path for no gain |
| F23 pairing generation guard | **NOT_WORTH_CHANGING** | `screen-state.ts:69-73` is idempotent-true, so overlapping retry loops can stack — but `:799-801`/`:870-872` clear each interval individually, so the outcome is code churn, not a blackout |
| F28 FileProvider declared, no consumer | **NOT_WORTH_CHANGING** | `AndroidManifest.xml:71-79`; hygiene only. Removing a declared provider on a fielded package is more risk than the tidiness is worth |
| F31 vestigial `jest.config.js` | **NOT_WORTH_CHANGING** | Runner is vitest (`package.json:26`); dead config, zero runtime effect |
| F24 device JWT as `?token=` on media URLs | **NOT_WORTH_CHANGING** (client) | `utils.ts:107-116`. `<img>`/`<video>` cannot send headers, so the client cannot close this. **Frame navigations were fixed** (see D.4). Durable fix is short-lived per-asset tokens — backend |
| F22 no max-stale-age on cached content | **NOT_WORTH_CHANGING** (client) | No TTL exists on either side — `device-content-payload.ts:76-81` carries no `validUntil`. Inventing a client-only bound would dark screens the backend never asked to stop |
| F25 impressions dropped offline | **NOT_WORTH_CHANGING** (this wave) | `main.ts:1839,1867,2101` gate on `socket.connected`; no queue. Real gap, but it is a feature (durable queue + replay semantics), not a correctness fix, and `content_impressions` has 0 rows lifetime so nothing regresses |
| F33 keystore in working tree | **HARDWARE_BLOCKED** (environment) | Gitignored — **cannot be settled from any git checkout**. A clean-worktree grep must NOT be read as closure |
| F14 crash reporting activation unverifiable | **REAL_FIXED** (partially) | `crash-reporting.ts:40-44` hard-returns on empty DSN and `vite.config.ts:201` has no release gate. Now self-describing via `__VIZORA_SENTRY_CONFIGURED__`; **the DSN decision itself is an open operator item** |
| F13 heartbeat enrichment partial | **NOT_WORTH_CHANGING** | `main.ts:987-1008`; the stale-contentId half is genuinely fixed at `:233-235`. Remaining fields are a P1 feature, self-declared at `:1002` |

### A.4 Claim/reality drift (documentation, not code)
`CLAUDE.md` describes Jest and 4 Java files (actually vitest, 9 TS + 5 Java);
`docs/play-submission-checklist.md` line cites predate ~14 releases; §1.10 Q#3
describes a bug fixed at `main.ts:1017-1030`. **Disposition: NOT_WORTH_CHANGING
in this wave** — recorded here so the next reader treats those documents as
unverified rather than as evidence. The one drift that *was* corrected is the
version drift in `tizen/config.xml` and `webos/appinfo.json` (see the release cut).

---

## Agent B — runtime/contract tracing

| Finding | Disposition | Consuming-path evidence |
|---|---|---|
| Client never advertises `deliveryAck`; whole server layer inert | **REAL_FIXED** | Emitter `main.ts:1162-1171` sent `auth:{token}` only; consumer `device.gateway.ts:263` reads `auth.capabilities`, `:264-268` accepts array-or-object. Legacy path `:276-279` returns `{delivered:true,legacy:true}`; `:2292` then **deletes** the pending entry |
| `handleTokenRefresh` overwrites `socket.auth` wholesale | **REAL_FIXED** | `main.ts:1075` — would have silently dropped capabilities on first rotation, reverting to legacy with no signal |
| `reload`/`clear_cache` reload synchronously inside `handleCommand` | **REAL_FIXED** | `main.ts:1946,:1951` — acking after dispatch would time out at `device.gateway.ts:283`, requeue, and loop |
| `clear_override` unhandled | **REAL_FIXED** | Sender `fleet.service.ts:506-510`; client fell to `default:` at `main.ts:2004`. Emergency push stayed on glass up to 240 min after cancel |
| `restart` unhandled | **REAL_FIXED** | `fleet/dto/send-command.dto.ts:50-51` exposes it; no client case |
| `reboot`/`update`/`screenshot` unhandled | **NOT_WORTH_CHANGING** (client) | Genuinely not implementable — reboot needs device-owner, update is the store's job, screenshot needs native capture. Now acked + reported rather than silently dropped. **Correct fix is server-side**: a `not_supported` outcome distinct from `delivered` |
| Heartbeat error acks silently discarded | **REAL_FIXED** | `main.ts:1017` `response.data ?? response`; server error envelope `:1795,:1919` carries no `data`, so all reads were `undefined` |
| `ack.revoked` / `ack.commands` are client-side fictions | **NOT_WORTH_CHANGING** | Server returns `commands: []` unconditionally (`device.gateway.ts:1808,:1900`) and never sets `revoked`. Inert but harmless; removing them is a separate decision and the revocation contract names the ack as a channel |
| No `socket.on('error')` handler | **NOT_WORTH_CHANGING** | Server emits `rate_limited`/`device_disabled`/`device_token_stale` at `:444,:664,:899`. Invisible to the device, but each is followed by a disconnect the client already handles; adding a handler risks new de-pair paths for observability only |
| `qr-overlay:update` has zero production callers | **FALSE_ALARM** (as a client gap) | `sendQrOverlayUpdate` at `device.gateway.ts:2577-2588`; grep finds only `device.gateway.spec.ts`. **Test-only shape** — the client handler is correct and unreachable. Real latency issue is server-side (DB write only, no push) |
| `update_config`/`unpair`/`qr-overlay-update` client handlers | **FALSE_ALARM** (as gaps) | No server path constructs them; `@IsEnum(DeviceCommandType)` at `internal-api.dto.ts:30` rejects `unpair`. Dead branches, not defects |
| Config `heartbeatInterval`/`cacheSize`/`autoUpdate` ignored | **NOT_WORTH_CHANGING** | `main.ts:1295-1300` reads `qrOverlay` only; server sends hard-coded constants matching the client's own values. No live divergence |
| Malformed `playlist:update` version poisoning | **REAL_FIXED** | See A.1 |
| `enable` command has no client handler | **FALSE_ALARM** | Sender exists (`displays.service.ts:864`) but is unreachable: `disableDevice` now emits `device:revoked`, so the device has already purged and cannot receive a later `enable` |

---

## Agent C — Android fleet survivability

| Finding | Disposition | Evidence / why |
|---|---|---|
| Boot receiver registered and fires | **ALREADY_FIXED** | `AndroidManifest.xml:56-69`; `BootReceiver.java:24-33` |
| Boot receiver actually **launches** on Android 10+/Google TV | **HARDWARE_BLOCKED** | `BootReceiver.java:32` `context.startActivity()` from a receiver = background activity launch; `variables.gradle:4` targetSdk 35. No SAW/device-owner/launcher anywhere. **Cannot be settled from source or emulator** |
| Crash-loop containment | **REAL_FIXED** | See A.1 (F2) |
| Alarm-fired relaunch actually starting an Activity | **HARDWARE_BLOCKED** | Same BAL restriction, from a **dead** process. The entire ladder rests on it. Code comments now say so instead of asserting otherwise |
| Poison-pill re-restore on every crash restart | **NOT_WORTH_CHANGING** (this wave) | `main.ts:354-379` restores `last_playlist` unconditionally. Needs a Java→JS coordination channel; the capped ladder plus the marker covers the acute case |
| `onRenderProcessGone` recovery | **ALREADY_FIXED** | `MainActivity.java:69-100`, `RendererRecoveryGuard.java` |
| Rapid re-death surrenders into the BAL-blocked path | **REAL_FIXED** | Now schedules the relaunch directly rather than deferring to a handler a framework process-kill never invokes |
| Native (NDK) crash reporting | **NOT_WORTH_CHANGING** (this wave) | `crash-reporting.ts:1-10` defers it explicitly; adding an NDK layer is a build-surface change, and the JS DSN question (§ open item) must be settled first |
| Kiosk posture / SAW / lock-task / HOME | **HARDWARE_BLOCKED** | Grep across `android/` → zero occurrences. Posture B was approved 2026-07-02 against an analysis that predates targetSdk 35; **whether SAW still exempts at API 34/35 must be measured, not reasoned** |
| HOME-button resilience | **HARDWARE_BLOCKED** | No service/JobScheduler/watchdog exists; correct behaviour cannot be chosen without knowing launcher behaviour on the certified box |
| Wakefulness | **ALREADY_FIXED** | `MainActivity.java:43,126-128` FLAG_KEEP_SCREEN_ON; no WAKE_LOCK needed |
| OEM eco/no-signal panel power | **HARDWARE_BLOCKED** | Below the app layer; `MainActivity.java:123-124` already says so |
| Cache growth bounded | **ALREADY_FIXED** | LRU `cache-manager.ts:207-231`, 500 MB at `:32` |
| JS/renderer **wedge** (alive but frozen) | **NOT_WORTH_CHANGING** (this wave) | No detector exists. Real and uncovered, but a native liveness watchdog with a false-positive reload risk is a design change beyond this brief's scope. **Recorded as the top residual 24/7 hazard** |
| Capacitor 6.2.1 teardown after renderer death | **FALSE_ALARM** | Raised as an unknown; the recovery path returns `true` and rebuilds in-process, and the reviewer confirmed `BridgeWebViewClient` ORs listener returns safely |

---

## Agent D — adversarial security/reliability

| Finding | Disposition | Evidence |
|---|---|---|
| P1-1 `purgeDeviceState` aborts mid-purge | **REAL_FIXED** | See A.1 |
| P1-2 `SecureStoragePlugin.get()` deletes on ANY exception | **REAL_FIXED** | `SecureStoragePlugin.java:167-184` `catch (Exception)` → `remove(key).commit()`. Made the JS retry budget at `main.ts:288-321` decorative. **Reviewer later proved the stated mechanism was wrong** (no keystore op in `getString`); the fix stands, the rationale was corrected |
| P1-3 device JWT in query string | **REAL_FIXED** (frame path) / **NOT_WORTH_CHANGING** (media) | `utils.ts:107-116`. Frames no longer carry it; `<img>`/`<video>` cannot send headers |
| P2-1 `DEFAULT_CONFIG` aliasing | **REAL_FIXED** | See A.1 |
| P2-2 suspension/revocation in-memory only | **REAL_FIXED** | `main.ts:206,:1510` never persisted; `init()` restored the playlist and called `advance()` at `:389` before `connectToRealtime()` at `:396`. **Confirmed against production**: the deployed gateway handshake has no suspension check at all |
| P2-3 un-assigning a playlist never clears the screen | **NOT_WORTH_CHANGING** (escalated as a product decision) | `utils.ts:53` returns false when `incoming.playlistId == null`; push path treats `{playlist:null}` as malformed at `main.ts:1304-1309`. The backend calls this "by design" (`device.gateway.ts:1255-1260`). **There is no client "stop showing this" primitive** — a takedown or single-screen offboarding leaves content on glass indefinitely. Changing it trades against the never-black invariant and needs a product call, not a patch |
| P2-4 Android cache resurrect / tenant no-op | **REAL_FIXED** | `cache-manager.ts:109-176` had no clear-generation guard (vs `tv-cache-manager.ts:251,258,284`); `init()` early-return at `:45-46` made `setExpectedTenant` a no-op |
| P2-5 unsandboxed webpage iframe | **REAL_FIXED** | See A.1 |
| P3 CSS injection via QR `size` | **REAL_FIXED** | `main.ts:2174` concatenated a server-supplied value into `cssText` |
| P3 unhandled rejections from bare async calls | **REAL_FIXED** | `main.ts:1024,:1323,:1021,:1260,:1277` |
| P3 429 fail-open on auth/check | **NOT_WORTH_CHANGING** | `main.ts:1413` keeps state on a 429; bounded by retry, and treating a throttle as revocation is the more dangerous direction |
| Theoretical `token:refresh` vs purge race | **REAL_FIXED** | Reported as sub-millisecond/theoretical; fixed anyway with a purge-generation guard because the outcome (a resurrected credential on a de-paired device) is severe |
| Sentry scrubbing holds for all call sites | **ALREADY_FIXED**, with a residual **REAL_FIXED** | `crash-reporting.ts:23-76` was sound for URLs; free-text paths (`breadcrumb.message`, `event.message`, exception values) were not covered |
| No DOM XSS in the parent document | **FALSE_ALARM** | Every `innerHTML` write is the literal `''` (`main.ts:836,855,861,2142`); QR fallback uses `textContent` at `:864` |
| Registrable-domain allowlist bypasses | **FALSE_ALARM** | `vizora.cloud@evil.com`, `vizora.cloud.evil.com`, trailing-dot and `ws://` downgrade all correctly rejected (`main.ts:469-471`) |
| `release-origins.json` enforcement | **ALREADY_FIXED** | `vite.config.ts:46-104` genuinely fails closed for `production` and `tv` |
| Playback engine never-black construction | **ALREADY_FIXED** | `main.ts:1694-1743`, `:1823-1827`, `:1901-1919` |

---

## Agent E — test-gap review

| Finding | Disposition | Evidence |
|---|---|---|
| Pairing-success tenant write untested (#331 shape) | **REAL_FIXED** | `vizora-app.spec.ts:932` was `it.skip`; nothing asserted `tenant_id` (`main.ts:925-928`) or `setExpectedTenant` (`:929`). Deleting those lines left the suite green while every new device ran `tenantId = null` |
| Versioned `playlist:update` branch never exercised | **REAL_FIXED** | Every test payload omitted `version`, so all took the legacy fallback at `main.ts:1317` |
| `contentVersion` in the heartbeat asserted by nothing | **REAL_FIXED** | grep returned zero hits |
| Wrong-run assertion at `:3871` | **REAL_FIXED** | `ackWith` clears the reload mock at `:3792`, so the superseded-ack claim was evaluated against the active-socket run |
| Vacuous/self-computed assertions (`:1056-1057`, `:1471-1480`, `:682-689`) | **REAL_FIXED** | Assert on values the test constructed, or on keys an object literal always contains |
| Impression-counting tests satisfied by the commit impression (`:1602`, `:1633`, `:2239`) | **REAL_FIXED** | Clear at t≈50ms then count, while the commit emits at t≈1500ms — they pass with the advance timer deleted |
| Global `clearTimeout`/`clearInterval` spies (`:2195`, `:1143`) | **REAL_FIXED** | Nothing binds the assertion to the intended timer |
| Wrong-direction retry caps (`:1060-1070`, `:1090-1096`) | **REAL_FIXED** | Pass if retries stop after attempt 1, i.e. cannot fail on the dangerous regression |
| `tv-cache-manager.spec.ts:224-232` spreads a class instance | **REAL_FIXED** | Prototype methods not copied, so the fixture is structurally broken regardless of the logic under test |
| Tizen/webOS runtime never exercised through `main.ts` | **NOT_WORTH_CHANGING** (this wave) | `vizora-app.spec.ts:191` forces `isNativePlatform() => true` globally. Real coverage gap; restructuring the harness is a larger change than this brief warrants |
| `IndexedDbCacheStore` 0% covered | **NOT_WORTH_CHANGING** (this wave) | `tv-cache-manager.ts:74-156`; production default never constructed under test. Same reason |
| `secure-storage.ts` zero tests | **NOT_WORTH_CHANGING** (this wave) | Wholly mocked at `vizora-app.spec.ts:271`. Same reason |
| Ack-contract prior art binds response only, not request | **REAL_FIXED** (differently) | The gap was real; closed by binding the contract across a **real process boundary** rather than by adding more fixtures |
| Fixture copies kept in sync only by human discipline | **NOT_WORTH_CHANGING** (client-side) | Correct diagnosis; the durable fix is a truth-table test in the **Vizora** repo so a server change reddens *its* CI. Recorded as a backend follow-up |

---

## Final review wave (six reviewers + mutation audit)

| Finding | Disposition | Evidence |
|---|---|---|
| Dedupe ring not durable enough → unterminated reload loop | **REAL_FIXED** | Persist rejection was swallowed and the timeout dispatched anyway; ack frame can be stranded in engine.io's `writeBuffer` (`socket.js:342-346`, verified against the installed version) and discarded by the reload |
| Unkeyable context-destroying command → same loop, no key | **REAL_FIXED** | 60s time-windowed synthetic record |
| `allow-same-origin` iframe exploitable | **REAL_FIXED** | `capacitor.config.ts` `androidScheme: 'https'` with no hostname ⇒ app origin `https://localhost`; `WebViewLocalServer` serves `index.html` **with the bridge injected** to any frame; backend `PATCH /content/:id` skips the `validateUrl` that `POST` runs |
| Tenant suspension cleared on any reconnect | **REAL_FIXED** | Verified against production `d323434e`: gateway handshake has no suspension check; only the outbound emitter |
| `VITE_SENTRY_DSN` env-driven, no gate | **REAL_FIXED** (self-describing) + **open operator decision** | No DSN configured anywhere in this repo, so a release today ships blind. Not made fail-closed because that would block a release on a credential this session cannot supply |
| `__APP_VERSION__` from `npm_package_version` | **REAL_FIXED** | Absent under `npx vite build`; produced a signed artifact reporting `1.0.0` while the "non-zero appVersion" gate passed on the wrong value |
| Terminal crash HOLD = permanent dark screen | **REAL_FIXED** | Ladder capped, never terminal |
| `setWindow` fallback is Doze-deferrable and is the only live branch on API 33+ | **REAL_FIXED** | Manifest caps `SCHEDULE_EXACT_ALARM` at API 32, `USE_EXACT_ALARM` absent |
| 60-min cap unreachable (prune window 10 min) | **REAL_FIXED** | Ladder restarted from the bottom every cycle; widening the window alone does not fix it — prune is now chain-relative |
| Native call sites completely unguarded | **REAL_FIXED** | Four mutations, incl. deleting the call that restores the screen after renderer loss, left all 65 Java tests green |
| Suite flaky ~1 run in 6 | **REAL_FIXED** | Fixed-count waiters against a real dynamic `import('qrcode')`; a helper returned silently on exhaustion |
| Pairing poll gated on the QR render | **REAL_FIXED** | A never-settling `import('qrcode')` stalls `startPairingCheck()`; expiry-refresh lives in the poll's own 404 branch, so the screen shows an expired code forever |
| 410 treated as revocation for a rotated token | **FALSE_ALARM** | Production `device-auth-check.service.ts:19-23` — an expired token returns **401, never 410**, with an explicit mid-rotation grace path. **No change made; acting on this reviewer would have been wrong** |
| Robolectric/`android-all-instrumented` could reach the APK | **FALSE_ALARM** | Proven strictly test-scoped: standalone configuration with no `extendsFrom`; `android/app/libs/` does not exist; `assembleRelease` does not depend on any `Test` task |
| Ack phantom for non-local sockets | **NOT_WORTH_CHANGING** (client) — **backend follow-up** | `fetchSockets()` returns a `RemoteSocket` when scaled; its ack fires ~1ms with a timeout error `getAckError` reads as success. Latent behind `ecosystem.config.js:63` `instances: 1`. **File before realtime is ever scaled horizontally** |
| `canPlay()` should refuse `playing` while in `pairing` | **NOT_WORTH_CHANGING** | Would strand every newly paired device — the machine is still in `pairing` when the first frame commits |
| `commit()`-vs-`apply()` durability unobservable | **HARDWARE_BLOCKED** | Robolectric applies both synchronously; held by code review only |
| Install-over preserving pairing | **HARDWARE_BLOCKED** | Source proves format compatibility on every persisted store; only a device proves the update survives |
| Downgrade 1.3.16 → 1.3.15 as rollback | **FALSE_ALARM** (as an available path) | Android refuses a lower versionCode on retail `user` builds; uninstall-to-downgrade destroys pairing. Rollback is **roll-forward to 1.3.17** |
