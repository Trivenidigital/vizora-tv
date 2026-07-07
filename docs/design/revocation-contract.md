# P0-2 — Device ↔ Server Revocation Contract (v1.1 — APPROVED)

**Status:** APPROVED for implementation (operator, 2026-07-02) with four binding revisions,
incorporated below: (a) confirm-before-wipe via auth-check (§1.5, §3.4), (b) explicit
unclassified-error default (§1.5a), (c) auth-check rate limiting + device backoff (§3.3),
(d) tenant-binding as load-time verification (§1.4, §2 — was already specified; reaffirmed
as the enforcement mechanism, with purge-on-unpair as optimization only).
**Replaces:** the string-match credential wipe at `src/main.ts:732-744` (finding F3) and the
stale-tenant persistence gap at `src/main.ts:944-948` + `167-186` (finding F4).
**Requires:** matching server-side work in the Vizora backend repo (§6) — the device half alone
cannot express revocation.

---

## 1. Principles (normative)

1. **Connection-layer errors carry zero trust semantics.** TLS failures, socket timeouts,
   handshake rejections, HTTP 5xx, and any error identified only by message *text* are treated
   as transient. The device NEVER deletes credentials, playlist, or cache in response to them.
2. **Revocation is an explicit, structured, authenticated signal.** Only the codes in §3 cause
   credential destruction. Unknown codes = transient (fail open for playback, closed for nothing).
3. **Playback fails open; trust fails closed.** During any auth uncertainty the device continues
   the last-known-good cached loop (`PLAYING.cached`) and retries in the background. It does not
   accept *new* content, commands, or config over an unauthenticated channel — those require a
   successfully authenticated socket.
4. **Tenant binding is structural, not procedural.** Cached playlist/assets are keyed to the
   tenant identity they were issued under and verified at *load time* — the device refuses to
   render content whose tenant does not match the current credential. Purge-on-unpair is an
   optimization; the load-time check is the enforcement (covers backend reassignment, restored
   backups, cloned device images).
5. **No credential wipe without confirmation.** Every revocation signal — regardless of
   channel — must be confirmed by the auth-check endpoint (§3.3) returning `410 DEVICE_REVOKED`
   before the purge executes (§3.4). A signal that cannot be confirmed is reported as telemetry
   and the device keeps operating. Single migration carve-out: §7.1a.
5a. **Default rule for anything unclassified (normative).** Any error, event, code, or response
   shape not explicitly enumerated in §3 is TRANSPORT-LAYER: credentials untouched, cached
   playback continues, background retry proceeds. Destroying device state requires a positive
   match on an enumerated signal — never the absence of one.

## 2. Identity material (device-side additions)

| Key | Store | New? |
|---|---|---|
| `device_token` (JWT) | SecureStorage | existing |
| `device_id` | SecureStorage | existing |
| `tenant_id` | SecureStorage | **new** — issued at pairing (§6.1) |
| `last_playlist` | Preferences, envelope `{tenantId, deviceId, savedAt, playlist}` | **changed** |
| cache manifest | + `tenantId` per entry (or per-manifest) | **changed** |

Load rule: on boot, `last_playlist.tenantId !== stored tenant_id` → discard playlist + purge
cache; enter HOLDING (if credentialed) or PAIRING (if not). A legacy envelope without `tenantId`
(pre-migration) is treated as matching once, then rewritten with the current tenant on next save.

## 3. Signals (server → device)

### 3.1 Socket handshake rejection — structured `connect_error.data`
Socket.IO middleware attaches `{ code }` to the handshake error. Message text is ignored.

| `code` | Meaning | Device action |
|---|---|---|
| `AUTH_EXPIRED` | token expired; device identity still valid | keep cached loop; background re-auth per §5; telemetry `auth_degraded` |
| `AUTH_INVALID` | token unparseable/signature mismatch (e.g. key rotation) | same as `AUTH_EXPIRED` — this is exactly the fleet-wide blast case F3 guarded against |
| `DEVICE_REVOKED` | operator removed/blocked this device | confirm via §3.4 → **purge** (token, deviceId, tenantId, last_playlist, cache, QR config) → PAIRING |
| `TENANT_SUSPENDED` | tenant entitlement lapsed | stop rendering (HOLDING with neutral branding), KEEP credentials — reversible state; poll §3.3 |
| *(absent / unknown)* | legacy or unexpected | transient — same as `AUTH_EXPIRED` path, plus telemetry `auth_unknown_code` |

### 3.2 In-session events (authenticated socket ONLY)
- `device:revoked { reason }` → confirm via §3.4 → purge → PAIRING. Honored exclusively on the
  authenticated socket (JWT handshake); a revocation arriving on any other channel is ignored
  with telemetry. (`unpair` remains as an alias with the same confirm-then-purge semantics.)
- `tenant:suspended` / `tenant:resumed` → HOLDING ⇄ PLAYING without credential changes.
- Heartbeat ack MAY carry `{ revoked: true }` — also subject to §3.4 confirmation.

### 3.3 REST disambiguation probe (new endpoint)
`GET /api/v1/devices/auth/check` with `Authorization: Bearer <deviceJWT>`
→ `200 {status:'ok'}` | `401 {code:'AUTH_EXPIRED'|'AUTH_INVALID'}` | `410 {code:'DEVICE_REVOKED'}`
| `403 {code:'TENANT_SUSPENDED'}`.

Used when the socket layer cannot deliver structured data (proxy interference), as the periodic
re-check in degraded mode, and as the mandatory confirmation step (§3.4). A device that cannot
reach this endpoint at all is *offline*, not revoked — it keeps playing cached content (bounded
by max-stale-age, §7).

**Rate limiting (server, normative):** max 1 request per device token per 30s (token-bucket,
burst 2); excess → `429` + `Retry-After`. The endpoint is cheap, but a fleet-wide auth incident
makes it a thundering-herd target.

**Device backoff (normative):** probe backoff 30s → 15min cap, ±25% jitter; `429 Retry-After`
overrides the schedule; at most ONE confirmation probe (§3.4) per 5 minutes no matter how many
revocation signals arrive.

### 3.4 Confirmation step (mandatory before any purge)
On any revocation signal (§3.1 code, §3.2 event/`unpair`, heartbeat flag), the device calls
§3.3 once:

| auth-check result | Action |
|---|---|
| `410 DEVICE_REVOKED` | purge → PAIRING |
| `404` (endpoint not deployed — legacy backend) | no purge — EXCEPT the `unpair` carve-out (§7.1a) |
| `200 ok` | signal contradicts server state — no purge; telemetry `revocation_unconfirmed` |
| anything else / unreachable | no purge; telemetry; normal backoff continues |

## 4. Device state rules (contract × state machine)

| Current state | Signal | Next |
|---|---|---|
| PLAYING.live | socket disconnect / transient error | PLAYING.cached (no visual change beyond status telemetry) |
| PLAYING.cached | `AUTH_EXPIRED`/`AUTH_INVALID`/unknown | stay; background re-auth loop |
| PLAYING.* | `DEVICE_REVOKED` | purge → PAIRING |
| PLAYING.* | `TENANT_SUSPENDED` | HOLDING (credentials kept) |
| HOLDING (suspended) | `tenant:resumed` or probe `ok` | PLAYING (fetch fresh playlist) |
| PAIRING | any auth signal | n/a (no credentials by definition) |

Bounded revocation honor time: **connected device ≤ one heartbeat interval (15s); disconnected
device ≤ first successful reconnect or probe.** A device that never reconnects is governed by the
max-stale-age policy (§7) — it cannot be remotely revoked *and* remotely reachable is a
contradiction; the bound is the stale-age degrade.

## 5. Background re-auth behavior (degraded mode)

Exponential backoff 30s → 15min cap on the §3.3 probe + socket reconnect attempts. After
**24h continuous** auth-degraded: small non-alarming overlay badge ("Check display registration —
code on dashboard") while the cached loop continues; telemetry event at entry/exit. No pairing
screen, ever, while credentials exist (state-machine guard from P0-1 enforces this).

## 6. Server-side work items (backend repo — blocking for P0-2 device merge)

1. Pairing status response gains `tenantId` (device stores it; §2).
2. Socket auth middleware: reject with structured `{code}` per §3.1 instead of message strings.
3. `device:revoked` event emitted on device deletion/block from dashboard; heartbeat-ack flag optional.
4. New `GET /api/v1/devices/auth/check` endpoint (§3.3).
5. (Recommended, pre-existing concern) pairing-code entropy/single-use/rate-limit audit — out of
   contract scope but same backend surface.

## 7. Deploy order & migration

1. **Device first (safe):** remove the string-match wipe; treat all connect_errors as transient;
   add tenant-binding with the legacy-envelope grace rule. Result: a fleet that can no longer be
   mass-de-paired by an auth blip. Temporary regression: revocation of a *disconnected* device
   waits until reconnect (today it de facto requires connectivity anyway).

   **No-op analysis against the OLD backend (verified against device code):**
   - Old backend sends `connect_error` with message strings only, no `data.code` → §1.5a
     default: transient, no wipe. (Behavior change vs today: today's string-match wipe is the
     F3 bug — its removal is the point, not a regression.)
   - Old backend pairing response has no `tenantId` → device stores none; envelope written
     without tenantId; load rule treats both-absent as matching → playback identical.
   - Old backend never emits `device:revoked`/`tenant:*` → handlers never fire.
   - Auth-check endpoint absent → probes get 404 → device stops probing, socket reconnect
     loop continues exactly as today.
   - `unpair` command: confirmation probe 404s → §7.1a carve-out honors the purge → operator
     unpair works against the old backend exactly as today.

   **7.1a Migration carve-out (the only §1.5 exception):** the `unpair` COMMAND (operator-
   initiated, authenticated socket) executes its purge when the confirmation probe returns
   `404` (endpoint not yet deployed).

   **(a) Channel authentication of `unpair` (merge-gate answer):** the command is reachable
   ONLY via the Socket.IO `command` event or the heartbeat-ack `commands` array — both exist
   solely on the socket created in `connectToRealtime()` whose handshake carries the device
   JWT (`auth.token`) and which the backend must accept before any event flows. Stale sockets
   are stripped (`removeAllListeners` + `disconnect`) before a replacement is created, so
   commands from superseded connections are not processed. Injection against a legacy backend
   would require one of: a MITM (defeated — TLS validation is enforced, no cleartext in
   release, empirically rejects untrusted certs), repointing `realtimeUrl` (only possible via
   `update_config`, which itself arrives on the authenticated channel, or local device
   access), or compromising the backend (out of device-side scope; the server must scope
   command emission per device room — restated in §6.5 audit). Conclusion: honored on the
   authenticated channel only, legacy or not.

   **(b) Mechanical removal tracking (merge-gate answer):** the carve-out is self-disabling,
   not comment-tracked. `runAuthCheck()` persists `auth_check_seen=1` the first time the
   endpoint returns any live status (200/401/403/410 — i.e. backend item §6.4 is deployed);
   the carve-out branch refuses to fire when that flag is set (a later 404 is an anomaly,
   telemetry `legacy_carveout_refused`). The flag survives purge/re-pair by design. A
   `TODO(remove with backend item §6.4 fleet-wide)` marks the branch for deletion once no
   legacy backends remain. Regression tests cover both the refusal and the arming of the gate.
2. **Backend second:** ship §6 items. Structured revocation becomes expressible end-to-end.
3. **Policy last (ties to F22/P1-3):** define max-stale-age N days offline → HOLDING. Proposed
   default: N=7, configurable per tenant via the `config` push. Not implemented in P0-2; listed
   so the contract records where the open loop closes.

## 8. Negative tests shipping with P0-2 (device side)

- connect_error with message "unauthorized" but no code → credentials intact, cached loop uninterrupted.
- connect_error `{code:'AUTH_INVALID'}` → same (no wipe), probe scheduled.
- `device:revoked` + auth-check `410` → SecureStorage empty, `last_playlist` gone, cache cleared, PAIRING shown; **did not render any further frame of tenant content after the purge**.
- `device:revoked` + auth-check `200` → NO wipe (unconfirmed signal), telemetry emitted.
- `device:revoked` + auth-check `404` → NO wipe (legacy backend, not the unpair carve-out).
- `unpair` command + auth-check `404` → purge executes (carve-out — old-backend unpair still works).
- Boot with `last_playlist.tenantId ≠ tenant_id` → old playlist not rendered (F4 regression test), cache purged.
- Boot with legacy non-envelope playlist → accepted once (migration grace).
- `TENANT_SUSPENDED` → HOLDING, credentials present, resume restores playback.
