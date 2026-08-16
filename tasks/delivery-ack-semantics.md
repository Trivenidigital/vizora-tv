# Delivery-acknowledgement semantics — what "delivered" means, per event class

## Release-critical precondition, verified against the deployed backend

Advertising `deliveryAck` takes the server **off** its legacy delivery path. If
the server-side handling were not actually deployed, shipping this client would
be dangerous — the device would stop getting best-effort delivery and get nothing
in its place. **It is deployed.**

Verified in the Vizora repo at the deployed commit **`d323434e`**, file
`realtime/src/gateways/device.gateway.ts` (exact path — note the repo also
contains copies of this file under `.claude/worktrees/agent-*`, which must
**never** be used to verify a cross-repo contract; only a named SHA counts):

| Symbol | Line at `d323434e` |
|---|---|
| `getAckError` | `:254` |
| `supportsDeliveryAck` | `:258` |
| `deliveryAckCapable` | `:259`, `:960`, `:1036` |
| `if (!this.supportsDeliveryAck(socket))` legacy branch | `:276` |

Also confirmed at that SHA: `fleet.service.ts:91` is
`const commandId = crypto.randomUUID();`, which is what makes `commandId` a
usable primary dedupe key for fleet-originated commands.

**This is the precondition that makes the client's capability advertisement
safe.** If a future backend rollback removed these symbols, the client would need
to stop advertising the capability in the same change.



The TV client advertises `capabilities: ['deliveryAck']` and acknowledges
`playlist:update` and `command`. This file states, for each event class, **which
of received / validated / accepted / applied / executed the ack truthfully
asserts**, and why a retry is safe under that meaning.

It exists because "the backend went green" is not a design. An ack that means
less than the dashboard implies is a silent failure with a green light on it.

---

## The three rules, and the evidence forcing each

**Rule 1 — the client NEVER sends a negative ack.**

Not a style preference. The deployed gateway has no terminator for a nacked
payload, and the one bound it does have is on the wrong path:

- No attempt counter. `DeviceCommand` carries no `attempts` field, and
  `addDeviceCommand` is a bare `rpush` (`redis.service.ts:169-173`) — the
  requeued object is byte-identical to the original.
- No dead-letter queue, no give-up, anywhere in `realtime/src`.
- The Redis TTL is **refreshed on every requeue** (`redis.service.ts:172`), so at
  a 3–5s loop period the entry never ages out.
- The circuit breaker (`device.gateway.ts:481-502`, 5 failures) is consulted
  **only** from the heartbeat path (`:2166`). `sendInitialState` calls
  `deliverPendingCommands` **directly at `:1354`** with no gate, and discards the
  result so connect-path failures do not even increment the counter.

That last point is decisive: every `reload` produces a fresh connection, so a
replayed context-destroying command travels the *ungated* path by construction.
**A nack on `reload` is a permanent fleet-wide loop the server cannot stop.**

Two further reasons, both verified: playlist and command replay share **one**
counter (`:2170-2189`), so nacking content would consume the budget gating this
device's *command* delivery; and even where nacking is breaker-bounded, the entry
stays in Redis with a refreshed TTL and is re-nacked on every future reconnect —
permanent garbage, permanently red.

*This rule is a consequence of a backend gap, not a client preference.* Once the
backend grows per-command attempt counting and a dead-letter, nacking becomes
safe and the client should start reporting real failure. Until then the client
must not move first.

**Rule 2 — the ack is a DELIVERY receipt, not an APPLY receipt.** Nothing
server-side reads an "applied" status; `getAckError` (`:254-256`) inspects only
`ok`. Apply failures go to telemetry and to `content:error`, never to the ack.

**Rule 3 — the ack is emitted BEFORE dispatch.** `reload`/`clear_cache`/`restart`
call `window.location.reload()` synchronously. An ack emitted afterwards would
never leave the device; the server would time out at 10s (`:283`), requeue, and
the device would reload → reconnect → replay → reload forever.

Ordering alone is best-effort, and the code says so. The ack does reach
`ws.send()` synchronously — verified through the installed client: transports are
`['websocket']` with `tryAllTransports` never set, `encodePacket` invokes its
callback synchronously for a string payload, and the transport is writable at
that moment. What is *not* guaranteed by spec is that bytes already handed to
`WebSocket.send()` survive navigation teardown. **The persisted dedupe ring, not
the ordering, is the actual loop terminator** — which is why the ring must never
be deleted as redundant.

---

## Per-class table

| Event | The ack asserts | Retry safe under that meaning? |
|---|---|---|
| **`reload`**, **`restart`** | **Received**, and parsed far enough to enter the handler. NOT validated, accepted, applied or executed — the ack is the first statement of the handler, before the type is even inspected. | **Yes.** The persisted `(type, timestamp)` ring suppresses the replay. Durable *before* the reload: the synchronous `localStorage` write precedes the first `await`, so the reload cannot beat it. |
| **`clear_cache`** | Received; the purge is attempted and the reload is unconditional. | **Yes.** Verified it cannot erase its own terminator: `AndroidCacheManager.clearCache` touches Filesystem only, `TvCacheManager.clearCache` touches IndexedDB only. Neither touches `localStorage`. |
| **`playlist:update`** | **Received only** — acked before validation, and acked even when the payload is malformed. | **Yes, and retry is free.** Content is re-derivable: the connect-time resolver push (`device.gateway.ts:1326-1341`) and the T2 heartbeat reconcile (`:1896`) both converge a device that missed it. No dedupe needed; the version-wins gate absorbs re-delivery. This is also why nacking content buys nothing. |
| **`push_content`** | Received. May be suppressed at apply time by the tenant-suspension gate — so *delivered* genuinely does not imply *shown*. | **Yes** — keyed and recorded. |
| **`clear_override`** | Received; a no-op when no push is active. | **Yes** — idempotent by construction; a replay costs one wasted resume. |
| **`unpair`** | Received; the purge is conditional on a 410 from auth-check. | **Yes.** Note a *failed* confirm is still recorded and suppresses the replay; the operator recovers by re-issuing, which gets a fresh timestamp. |
| **`update_config`** | Received; the reload happens only if a field was both allowlisted and actually changed. | **Yes** — a replay is a no-op. |
| **`reboot`, `update`, `screenshot`** | Received — **and nothing else, ever.** These are not implementable in this client: reboot needs device-owner privileges, update is the store's job, screenshot needs native capture. | Retry is trivially safe (nothing happens), but the **semantics were wrong**: the operator saw the same green "delivered" as a working reload, forever, for an action that will never occur. Now acked `{ok:true, status:'unsupported'}` — wire-safe because the server rejects only `ok === false` and ignores extra fields. Nacking is forbidden by Rule 1. |
| **unknown type** | Received. | Safe; now reports `command_unknown` so a server-side command rolled out ahead of the fleet is visible to us rather than silently dropped. |

---

## The honest gap, stated plainly

For `reload`, the client asserts **received**; the fleet dashboard renders
**"delivered to N devices"**. That is a defensible rendering of "received and
entered the handler" — nothing in the UI claims *executed*, and the durable audit
row carries no delivery field at all. But the gap is real in one direction: if
the ack lands and the reload then fails to complete (renderer OOM-kill, or the
reload boots into pairing), the server has `{ok:true}`, drops the command, and
nothing retries. A screen sits wrong until a human looks at it.

**Closing that properly requires the backend**, not the client. The client can
report a genuine "executed" fact on the next page load — the ring already
persists the key — but a signal no backend consumes does not change what the
operator sees. Recorded as a cross-repo follow-up rather than papered over with a
client-side change that would look like a fix without being one.

## Backend follow-ups this analysis produced

1. **Per-command attempt counting + dead-letter + give-up.** This is the gap that
   forces Rule 1. It also unlocks safe nacking, which is what would let the
   client report real failure instead of a uniform green.
2. **Distinguish `ack_timeout` from `no_sockets` in the command response.** Today
   an ack timeout is rendered as "queued for 1 offline device" for a device that
   is online and has already acted.
3. **A `not_supported` outcome distinct from `delivered`,** so the three
   unimplementable commands stop reading as successes. The client now sends
   `status: 'unsupported'` for the backend to read when it is ready.
4. **The ack is a phantom for non-local sockets.** `fetchSockets()` returns a
   `RemoteSocket` once realtime is scaled past one instance, and its ack callback
   fires almost immediately with a timeout error that `getAckError` reads as
   success — silently converting both live-push ack paths into always-success.
   Latent behind `ecosystem.config.js:63` `instances: 1`. **Must be fixed before
   realtime is ever scaled horizontally.**
