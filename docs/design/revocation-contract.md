# P0-2 Gate — Device ↔ Server Revocation Contract (v1 draft)

**Status:** DRAFT — awaiting operator approval before any P0-2 implementation.
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
   tenant identity they were issued under and verified at *load time*. Purge-on-unpair is an
   optimization; the load-time check is the enforcement (covers backend reassignment, restored
   backups, cloned device images).

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
| `DEVICE_REVOKED` | operator removed/blocked this device | **purge** (token, deviceId, tenantId, last_playlist, cache, QR config) → PAIRING |
| `TENANT_SUSPENDED` | tenant entitlement lapsed | stop rendering (HOLDING with neutral branding), KEEP credentials — reversible state; poll §3.3 |
| *(absent / unknown)* | legacy or unexpected | transient — same as `AUTH_EXPIRED` path, plus telemetry `auth_unknown_code` |

### 3.2 In-session events (authenticated socket)
- `device:revoked { reason }` → purge → PAIRING. (Supersedes today's `unpair` command; `unpair`
  remains as an alias but gains the full purge.)
- `tenant:suspended` / `tenant:resumed` → HOLDING ⇄ PLAYING without credential changes.
- Heartbeat ack MAY carry `{ revoked: true }` as a belt-and-braces path.

### 3.3 REST disambiguation probe (new endpoint)
`GET /api/v1/devices/auth/check` with `Authorization: Bearer <deviceJWT>`
→ `200 {status:'ok'}` | `401 {code:'AUTH_EXPIRED'|'AUTH_INVALID'}` | `410 {code:'DEVICE_REVOKED'}`
| `403 {code:'TENANT_SUSPENDED'}`.

Used when the socket layer cannot deliver structured data (proxy interference) and as the
periodic re-check while in the degraded state. A device that cannot reach this endpoint at all is
*offline*, not revoked — it keeps playing cached content (bounded by max-stale-age, §7).

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
2. **Backend second:** ship §6 items. Structured revocation becomes expressible end-to-end.
3. **Policy last (ties to F22/P1-3):** define max-stale-age N days offline → HOLDING. Proposed
   default: N=7, configurable per tenant via the `config` push. Not implemented in P0-2; listed
   so the contract records where the open loop closes.

## 8. Negative tests shipping with P0-2 (device side)

- connect_error with message "unauthorized" but no code → credentials intact, cached loop uninterrupted.
- connect_error `{code:'AUTH_INVALID'}` → same (no wipe), probe scheduled.
- `{code:'DEVICE_REVOKED'}` → SecureStorage empty, `last_playlist` gone, cache manifest empty, PAIRING shown; **did not render any further frame of tenant content after the purge**.
- Boot with `last_playlist.tenantId ≠ tenant_id` → old playlist not rendered (F4 regression test), cache purged.
- `TENANT_SUSPENDED` → HOLDING, credentials present, resume restores playback.
