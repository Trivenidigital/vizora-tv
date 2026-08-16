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

## The CI failure that was not a flake

Recorded separately because of how it was found, not only what it was.

`#39` and `#40` both went red on one assertion — `Pairing — Request > starts
polling for pairing status`. Master was green at all three merged commits, so it
was introduced or exposed by that work. It would have been cheap to call it a
flake and re-run. This repo has already been burned by exactly that (PR #30, "the
'pre-existing flake' was a real product defect"), so it was treated as evidence.

| Finding | Disposition | Consuming-path evidence |
|---|---|---|
| **A cosmetic QR render gated the functional pairing poll** | **REAL_FIXED — customer-visible, unattended-device bricking** | `main.ts` — `startPairingCheck()` was sequenced *after* `await this.generateQRCode()`, which awaits a real dynamic `import('qrcode')`. A **rejecting** import was always survivable: `generateQRCode` catches both the import and `toCanvas` and does not rethrow. An import that never **settles** was not — the await never returns, the poll is never armed, and because the **only** thing that replaces an expired pairing code is that poll's own 404 branch (`main.ts:1245-1248`), the device sits forever displaying a dead code. Unattended, that is a truck roll. Fixed by arming the poll ahead of the QR block, so a hung render costs a missing QR image and nothing else. Verified it cannot double-arm (`startPairingCheck` clears any existing interval) and cannot poll before a code exists. |
| The same CI failure, considered as a **product race** | **FALSE_ALARM** | `main.ts:1212-1221` — polling starting a few hundred ms later is meaningless against a 2s cadence and a five-minute code |
| The same CI failure, considered as a **harness defect** | **REAL_FIXED** | `vizora-app.spec.ts` — a fixed 2000ms advance against a real dynamic import; reproduced two ways (starve the settle budget; settle the gate partway through the advance so the interval arms with under one period left), both yielding CI's exact `expected false to be true` |
| The same fixed-budget shape elsewhere | **REAL_FIXED** | 7 further instances, found by a **discriminating probe** — inject latency at each `import('qrcode')` await site and see which tests fail — rather than by grep. That named exactly 8 tests across 2 gate sites and proved the other 531 insensitive; grep would have found the shape but not which instances depended on it |

**The process point:** the product defect was reachable only through the failing
test. Dismissing it as flaky would have shipped 1.3.16 with an unattended-device
bricking path intact. This finding alone plausibly justifies the release.

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

---

## Independent mutation-integrity audit

Commissioned because a coder's mutation-revert silently no-op'd mid-session (an
ambiguous replacement string matched nothing), so the next mutation ran on a
still-mutated tree. The trust boundary was every result after that point, not the
one repaired result — so coverage was **re-derived from scratch** rather than
replayed: 176 mutations, 176 restores, every restore verified clean, zero
failures. 122 killed.

Well pinned, and stated because it is evidence the wave's core work holds: the
dedupe ring (17/19), ack behaviour (16/16), cache managers (28/31), pairing
(7/8), crash-reporting scrubbers (6/6), screen-state (2/2).

| Finding | Disposition | Evidence |
|---|---|---|
| `purgeDeviceState`'s in-memory half almost entirely unguarded | **REAL_FIXED** (verification) | Deleting `this.deviceToken = null` ships **green** — the credential survives revocation in memory. So does deleting the whole socket teardown, both `clearTimeout` blocks, and each of `deviceId`/`tenantId`/`temporaryContent`/`savedPlaylistState`. Only `deviceToken`+`deviceId` **as a pair** was caught. The revocation suites assert on mock stores and `visibleScreens()`, and the `pairing-screen` result comes from `startPairing()`, not from the field clears |
| `vite.config.ts` had **zero** coverage | **REAL_FIXED** | No spec referenced it. Reverting `__APP_VERSION__` to `npm_package_version \|\| '1.0.0'` — **the exact bug this wave fixed** — left the suite green, as did stamping `__RELEASE_SENTRY_CONFIGURED__` `true` unconditionally, which would make every artifact assert a lie the publish-side verifier then confirms. Pure decision logic extracted to `src/build-provenance.ts` and unit-tested; the wiring is bound by calling the real vite factory and reading the `define` object it compiles in |
| Whitespace-only DSN stamps "configured" | **REAL_FIXED** | `Boolean('   ')` is `true`. Same failure as the unconditional stamp, but reachable by a plausible typo rather than a code edit |
| Suspension-latch **clears** unpinned on both paths | **REAL_FIXED** (verification) | A resumed tenant would re-enter `holding` on every future boot, forever. The write and the boot read were pinned; only the clears were not |
| `isRenderableFrameUrl` failure semantics unpinned | **REAL_FIXED** (verification) | Flipping its `catch` to `return true` frames an unparseable URL; dropping the base-URL argument stops relative URLs resolving against the app document — together, a relative URL is framed **at app origin**, reopening the same-origin hole |
| `if (!store) return false` → `true` | **REAL_FIXED** (verification) | On a runtime without `localStorage` this reports the record durable and **disarms the fail-closed refusal** |
| PD-1 signature consumer never reached | **REAL_FIXED** (verification) | 8 tests against the exported pure function; nothing bound them to the single production line that consumes it. Deleting that consumer left 539 green — the negative-control blind spot exactly |
| Vacuous assertion at `spec:4485` | **REAL_FIXED** | `expect(secureStorageStore.has('tenant_id')).toBe(false)` in a suite that never seeds `tenant_id`. Proven vacuous by replacing the production removal with `Promise.resolve()` and watching it pass |
| Push-path purge-generation read | **REAL_FIXED** (verification) | Production correct; the pull equivalent was pinned and the push was not |
| 1 non-deterministic full-suite failure in 33 runs | **REAL_FIXED** (headroom) | Unreproduced across 30 further runs, 6 loaded runs and 25 targeted runs; only correlate is duration (23.78s vs 16.51s). Prime suspect is real-time headroom — a 3000ms `waitFor` against a real Socket.IO server under vitest's 5s per-test timeout leaves ~2s of slack, and a slow run is the regime that eats it |
| 41 fixed-count microtask drains in the spec | **NOT_WORTH_CHANGING** (this wave) | Deterministic today because I/O is mocked, but they encode an assumed promise-chain depth, and several are followed by `.not.toContain(...)` assertions that would go vacuous rather than red. Recorded as the next verification-hygiene unit of work |
| `resolveReleaseOrigins()` zero coverage | **REAL_FIXED** | The load-bearing fail-closed provenance mechanism, exercised by the new wiring tests but asserted about not at all |

---

## Deferred at the tail, deliberately — with the fix shape named

Four items were declined **late in the wave, on purpose**. The wave's signature
failure is a behaviour change made at the tail, on an instinct that looked
correct, producing a new defect — five times. So the stopping rule became: take
additions that add *coverage*, decline additions that add *behaviour*.

Each is recorded with its fix shape, because the shape is the part that
evaporates.

| Item | Why deferred | Fix shape, named |
|---|---|---|
| **CI's `tsc --noEmit` has never typechecked a single spec file** | `tsconfig.json:19` excludes `src/**/*.spec.ts`. ~91 diagnostics surface when enabled — a real cleanup, not a drive-by. Found the hard way: a test written with an undeclared variable passed tsc and failed at runtime looking like a product bug | Remove the exclusion, fix the diagnostics. **Durable-record correction: every "tsc clean" claim in this wave means production `src/` only, which is narrower than it reads** |
| **`tenantReadFailed` is never re-tested within a process** | One transient `tenant_id` decrypt failure disables the `last_playlist` snapshot for the whole boot, so a 24/7 screen carries a weeks-stale cache into its next reboot. The permanence is deliberate, unstated and unpinned. Fixing it means re-testing the flag — a behaviour change | Re-test `tenantReadFailed` at a defined later point, or state the permanence at the site and pin it |
| **The crash-loop storm marker is muted for the life of a no-DSN device** | The web layer keeps the marker forever when reporting is disabled, so the native no-clobber rule refuses every storm marker behind it. **A fix I believe is correct, declined anyway** — it is a behaviour change on the telemetry path, at the tail. Cost of deferring is telemetry blindness, not a device defect | A retention **bound**, not a rule change: the marker already carries a timestamp, so when reporting is disabled and the marker is older than one window, remove it anyway. A few lines in `reportCrashLoopMarker`, no native change. Converts "blocked forever" into "blocked for one window". **Moot if the DSN question is settled before release** |
| **`http://` webpage frames unpinned** | Taken, not deferred — the one item that adds coverage without behaviour | — |

---

## Deliberate deferrals whose fix lives in another repository

| Finding | Disposition | Owner / evidence |
|---|---|---|
| **A TV reboot still fail-opens on tenant suspension** | **NOT_WORTH_CHANGING client-side — deliberate deferral, not an oversight.** Filed as `Trivenidigital/Vizora#362` | The realtime gateway handshake at deployed `d323434e` has **no** suspension check — only the outbound emitter. `403 TENANT_SUSPENDED` is produced solely by the REST `auth/check`, and an expired token returns **401 before that check is reached**. Since 14 of 24 production devices are past the 90-day expiry, the client's only authority cannot answer for most of the fleet. **Three client-side attempts, all reverted** (see below). The client now carries the in-memory latch plus revalidate-on-reconnect, with the durable fix named at `enterTenantSuspended` |

### Why there is no fourth client-side attempt

Recorded because the reasoning is the deliverable, and because a future reader
will otherwise see an obvious-looking gap and re-add the latch.

1. **In-memory latch** (shipped in 1.3.15) — cleared on any reconnect, lost on
   reboot. A suspended tenant resumes.
2. **Durable latch, fail-closed** — stranded **healthy** devices permanently on
   "Display paused — contact your administrator". Every exit demanded HTTP 200
   and three ordinary states cannot produce one: expired token → 401, legacy
   backend → 404 which *stops* the probe loop, outage → null. The trigger
   population was strictly larger than the fail-open it replaced.
3. **Provisional/confirmed split** — worse, and the most serious defect this wave
   produced in its own work. The release path called `exitTenantSuspended`, which
   unconditionally removes the persisted key — so a hold entered *because the
   latch could not be read* went on to **delete** it. On a genuinely suspended
   tenant with an expired token, two probes erase the latch and no later boot can
   re-latch: **the tenant becomes permanently unsuspendable on that device.** An
   entitlement bypass produced by a fix intended to close a fail-open.

The implementer's own diagnosis is the clearest statement of the class: *"I wrote
the release path and never followed it into the function it calls."*

All three were reverted in full rather than partially, and the nine associated
tests were **deleted rather than skipped** — a skipped test is a claim left in
suspension.

---

## Corrections to this wave's own durable records

Claims this wave asserted and later disproved. Recorded with the retraction
quoted, because a claim that reads as a green check while describing the
mechanism of a bug is worse than no claim — the next reader stops there. Commit
messages on pushed branches are immutable, so the correction lives here and is
the authority over anything earlier that contradicts it.

**1. "The `CrashLoopGuard` prune rule is sound, and `WINDOW_MS (90m) >
CAPPED_RETRY_MS (60m)` genuinely holds."**
Asserted by the guard-predicate audit as a reassurance. **Wrong — that inequality
was the *cause* of the defect, not evidence against it.** A chain window must
outlast the 60-minute capped rung, and therefore necessarily also compounds
crashes 45 minutes apart: a box OOMing ~25 minutes after each start climbed to
the hourly rung and pinned there, ~29% uptime where the previous rule gave ~100%.
Both constants have since been removed. The property to check now is the general
form — *the reset threshold always exceeds the delay it just imposed* — pinned
for every rung rather than asserted for one.

**2. "It is reported, not merely logged."**
Asserted in this wave's commit messages and code comments as the justification
for several safety mechanisms. **Void as written at the time it was made.**
`initCrashReporting` set `enabled = true` merely because `Sentry.init()` had been
*called*, but an invalid or whitespace DSN makes Sentry construct **no transport**
and silently discard every event. Worse, `reportCrashLoopMarker` deleted the
once-ever crash-loop marker *only when that flag was true* — so a bad DSN
destroyed the sole record of a degrading device without ever reporting it. The
flag now asks `Sentry.getClient()?.getTransport()`. **Any earlier statement in
this wave that a mechanism is "surfaced, not swallowed" should be read as
conditional on a validly-configured DSN, which this repo still does not have.**

**3. "The legacy backend never sends `tenantId`."**
Asserted as the justification for tolerating its absence at pairing. **Wrong.**
The deployed backend at `d323434e` emits it — `pairing.service.ts:511`,
`tenantId: display?.organizationId`, with the comment at `:507-510` stating the
Device Revocation Contract v1.1 requires the device to bind cache and playlist to
it. The decision to tolerate absence stands, but on the correct premise: the
field is emitted as `display?.organizationId`, so a degenerate response where
`display` is null yields `undefined` while still reporting `paired`, and making
that fatal would convert a backend defect into a **fleet-wide pairing outage**.
Consequence for telemetry: `pairing_without_tenant` is **not** a benign legacy
path — it is an anomaly indicating a server-side defect and must be read that way.

---

## Convergence metric

The wave's own defect rate, per implementation round, as evidence rather than
judgement. "Self-inflicted" means a defect introduced by *this wave's* earlier
work, found by a later round.

| Round | New production defects found | **Self-inflicted** | False alarm / already-fixed |
|---|---|---|---|
| Discovery (Agents A–E) | 13 REAL in shipped 1.3.15 | 0 (nothing built yet) | ~34 ALREADY_FIXED, 4 FALSE_ALARM |
| Review wave 1 (6 reviewers) | 9 | **2** — terminal crash HOLD; cache fix that made a failed purge fail-open | 3 |
| Mutation-integrity audit | 10 unguarded lines | **1** — `slice(-0)` unbounding the ring at zero budget | 1 |
| Pre-merge reviews | 5 | **1** — the `pairing → holding` guard stranding every freshly-paired device | 2 |
| Guard-predicate audit | 11 | **1** — the frozen marker count, claim living only in a javadoc | 3 (incl. the stale audit verdict above) |
| Convergence round | 4 | **2** — the suspension fail-closed stranding healthy devices; a 90 kB shipped-artifact regression that **passed CI** | 1 |

### A fourth category: disclosed residual risk

One item does not belong in any of the three columns, and flattening it into the
defect count would misrepresent it — in the direction of harshness, which is as
inaccurate as flattering it.

| Item | Category | Why it is neither a defect nor a false alarm |
|---|---|---|
| `Process.getStartElapsedRealtime()` may be stubbed to `0` on an OEM build, turning measured uptime into time-since-boot and **silently disabling loop containment while every test stays green** | **DISCLOSED RESIDUAL RISK, introduced by this wave's own change** | It shipped in no artifact and reached no device. It was found by the implementer *while classifying its own work*, disclosed unprompted, deliberately left unguarded with the reasoning stated, and made cheap to settle — a one-line uptime log means a 30-second logcat check resolves it at the hardware sitting. "We added a risk, saw it, and made it cheap to settle" is a different outcome from both "we shipped a bug" and "nothing happened" |

**Self-inflicted rate has NOT reached zero.** Four distinct defects have been
introduced into this wave's own work: the pairing-stranding guard, the frozen
marker count, the stale audit verdict, and the bundle regression. The last is the
most serious class, because it reached a **pushed, green commit** — no test in
this repo could have caught it, and it was found only because a build number
looked wrong and someone stopped to explain it rather than shipping it.

**Convergence criterion for the final round:** a full round, with reviewers
actively hunting, that produces **zero** self-inflicted defects. Until that
happens, another loop is warranted and no release identity is settled. The native
head reached CONVERGED; the client head has not.

---

## The vanishing-tests sweep, and what it found

A suite whose **test count is derived from production data** can silently become
vacuous the moment that data shrinks, and nothing in a green run reports it. The
trap has two shapes: cases *generated* from a production array (empty array →
zero tests → green), and a loop that *carries* the assertions (empty iterable →
no assertions → green).

| Finding | Disposition | Evidence |
|---|---|---|
| **`src/main.spec.ts:97` — the test asserting no device token leaks into crash reports was vacuous** | **REAL_FIXED — test-quality defect, NOT a live token leak** | It iterated `scrubEvent`'s returned `exception.values` with no count assertion, and the count is *production output*. Proven both ways: with `scrubEvent` mutated to return an empty array the test **passed having asserted nothing**; with a `toHaveLength(2)` added it goes red on the same mutant. **The scrubbing itself was and is correct** — the fixed test passes against unmutated production code. This matters for anyone reading the security row later: the *verifier* was broken, the *product* was not |
| Origins-derived test generation | **REAL_FIXED** | Cases generated from `RELEASE_ORIGINS` meant emptying the array yields zero generated tests and a green suite. Guarded with cardinality meta-assertions; emptying the array now goes red |
| Rest of the repo swept | **FALSE_ALARM** (clean, with reasons) | Every `it.each` table is an inline literal, so its cardinality lives in the spec and cannot shrink without a visible diff; the three derived loops already carry cardinality guards. One of them carries a comment naming this exact vacuity risk — someone reached the rule independently in that file, which is the argument for `tasks/lessons.md` existing |

Both rules are now in `tasks/lessons.md` rather than only in a review thread,
along with the two mutation-tooling mechanics that stopped this batch producing a
false survivor.

---

## Mutation-result trust boundary

There were **three independent tooling failures** in this wave, each capable of
silently invalidating a mutation result. Any of them can produce a *surviving
mutation that was never actually applied* — which reads as "the test is weak"
when it means "the tool did nothing" — or a *killed mutation on a contaminated
file*, which reads as strong evidence and is not. So mutation totals are reported
per-provenance, never as one undifferentiated number.

| Failure | How it was caught | What it invalidates |
|---|---|---|
| A revert's replacement string became ambiguous (2 occurrences) and silently no-op'd; the next mutation ran on a still-mutated tree | Noticed when a later result contradicted a fix already applied | **Every result after it in that session**, not just the one repaired |
| Two restores failed mid-batch; one had already reported a **survivor that was contaminated** | The byte-snapshot guard, which recovered from the snapshot and flagged the run untrustworthy | Both runs; re-run with unique anchors |
| Git-Bash/MSYS silently swallowed the file-path argument, so the tool opened the needle **text** as a filename | A mutation reported `NEEDLE NOT FOUND` instead of passing silently | Any run where a mutation "survived" without being applied |

**Provenance of the results quoted in this document:**

- The **independent mutation-integrity audit (176 mutations, 122 killed)** was
  re-derived from scratch on a confirmed-clean tree *after* all three tooling
  failures, using `git checkout --` restores with a verified-clean check between
  every one. **176 of 176 restores verified; zero failures.** This is the
  highest-trust dataset in the wave and is the basis for the "unguarded lines"
  findings.
- The **build-provenance mutations (9 of 9 red)** were run after the fix, with
  sha256-verified byte-identical restores.
- **Per-batch implementer mutations** run before the tooling was hardened are
  reported only where a later independent run agrees with them. Where they are
  the sole evidence, they are marked as such rather than folded into a total.

**The guard that made this recoverable:** `git diff --quiet` was proposed first
and is *useless here* — these worktrees legitimately carry uncommitted work, so
it can never pass, making it a guard incapable of firing. That is the same defect
class this wave found three times in the product. It was replaced with a
byte-for-byte `cmp` against a pre-mutation snapshot, with auto-recovery and a
non-zero exit. It caught two live failures. **Committing per round makes both
guards available**, which is why committing is now treated as part of finishing a
slice rather than a follow-up step.

---

## Honestly unverified — recorded so the verified parts are believable

These are **not** closed. Each was attempted or considered and left open, with the
reason. A reader must be able to see exactly what is unverified.

| Item | Status | Why |
|---|---|---|
| `purgeDeviceState`'s two `clearTimeout` blocks | **NOT PINNED — no honest observable exists** | Three attempts. With `currentPlaylist` already null, a surviving timer wakes, finds nothing, renders nothing, and its attempt to take the screen is refused by the pairing guard. The second attempt asserted on the refusal log line and *also* survived, because the timer is not reliably armed at purge time. The probe was **deleted rather than shipped green**. These two lines are genuine defence in depth behind two other guards |
| Six further `purgeDeviceState` field clears (`deviceId`, `tenantId`, `temporaryContent`, `savedPlaylistState`, `currentContentPlaylistId`, `playbackGeneration++`) | **STILL UNPINNED — not attempted** | Each needs its own observable; ran out of runway. Flagged rather than implied covered |
| `scheduleAuthProbe()` after a non-200 revalidate | **NOT DONE** | Out of runway. Still open |
| `applyContentQueue`'s `.catch` | **NOT PINNABLE TODAY** | The queue cannot hold a rejection — `applyContentExclusive` catches its only throwing site internally and returns normally. The test pins the *property* (a malformed playlist does not stop the next one) and says in its own comment that it does not pin the `.catch` |
| Push-path purge-generation read | **CONFIRMED UNPINNED; production CONFIRMED correct** | The read is synchronous at the delivery site, so the window is zero. The mutation opens a one-microtask window that cannot be hit deterministically through a real entry point without building a scheduling race — which would be a flaky test. Left deliberately |
| `anyHomeAccepted`'s rejection arm | **FIXED, NOT PINNABLE** | Exercising it would require breaking production: both inner functions catch internally |
| The `shouldApplyContent` re-check in `applyContentExclusive` | **UNREACHABLE — verified, not excused** | The independent auditor confirmed the author's comment is accurate rather than an excuse |

## Claims that did NOT survive checking

Recorded because writing a test, watching it fail, and reporting the failure **as
the finding** is the behaviour this process exists to produce.

| Claim | Outcome |
|---|---|
| "A relative URL throws and then gets framed at app origin" | **Unreachable.** By the time `isRenderableFrameUrl` runs, `transformContentUrl` has already absolutized against `config.apiUrl`. The test was written, it failed, and the failure was the finding |
| "The purge's suspension-latch removal is an unguarded line" | **Wrong framing — redundant by design.** `purgeDeviceState` calls `exitTenantSuspended` first, which clears the same key while the latch is still on. Deleting *both* turns two tests red, so the pair is covered. Kept as defence in depth |
| An implementer's own first frame-URL test, named "the catch fails CLOSED" | **Was pinning the wrong line.** `'ht!tp://%%%not a url%%%'` does not throw — with a base supplied it parses as relative and is refused by the same-origin rule, so the catch-flip mutation survived a green test. Fixed with a host containing a space, which genuinely throws. Self-caught |
| An implementer's own first F1 negative control | **Was vacuous.** Post-purge the socket is torn down, so the triggered event never reached the app and the assertion held on nothing. Deleted and replaced with a unit-layer test at the real production ordering, where credentials arrive mid-sequence. Self-caught |

---

## Two findings the implementer surfaced in their own work

Both were caught by mutations that **failed to go red when they should have** —
i.e. by the verification process doing its job on the verifier.

| Finding | Disposition | Evidence |
|---|---|---|
| `slice(-0)` returns the WHOLE array | **REAL_FIXED**, and swept as a class | `-0 === 0`, so a zero reserve budget silently became an **unbounded** one — in a ring that is JSON-stringified into three stores per command. Replaced with an explicit `newest(xs, n) = n > 0 ? xs.slice(-n) : []`. **Class sweep completed:** the only remaining variable-argument slice in `src/` is inside that guarded helper; every other `.slice()` in non-spec source uses a constant (`-2` on a split hostname, `0`, or positive) or no argument, and the cache managers have none. The pre-existing `seenCommandKeys.slice(-COMMAND_DEDUPE_MAX)` path now routes through the helper. |
| `Promise.all` made an independent store hostage to a wedged one | **REAL_FIXED** | An early draft awaited BOTH the Preferences and IndexedDB writes, so a bridge that never settles would burn the whole 2s budget and refuse a command whose record IndexedDB had **already accepted** — defeating the point of adding an independent home. Now first-acceptance-wins. |

## Latent-reachable, not dead

| Finding | Disposition | Evidence |
|---|---|---|
| The polling-transport branch in the ack-flush reasoning | **NOT_WORTH_CHANGING**, but labelled **latent-reachable** | An earlier claim that the branch is unreachable "because transports are `['websocket']`" was **wrong** — `main.ts:1713` is `transports: ['websocket', 'polling']`. The branch is unreachable for a different reason: `tryAllTransports` defaults false (engine.io-client `socket.js:512`) and is never set, so a failed websocket open reconnects on websocket rather than shifting to polling. This matters because polling **is** in the config: flipping that option or reordering the list makes the XHR path live again. The comment cites the option rather than the transport list, and this is latent-reachable code, not dead code. |
