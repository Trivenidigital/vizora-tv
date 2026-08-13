# TV Closure Ledger — autonomous run toward a verified 1.3.14 release candidate

Started 2026-08-13. Living document: every claim ends CLOSED, BLOCKED or STALE, and
every closure carries evidence. A claim with no evidence gets demoted, not assumed.

Terminal condition: a signed, fully verified 1.3.14 release-candidate APK exists and
is **not** published. Publication is explicitly outside this run's authorisation.

---

## Phase A — release-engineering lane (#18) — CLOSED

| Field | Evidence |
|---|---|
| Issue | vizora-tv#18 — release builds must pin the backend endpoint and prove it from the artifact |
| Claimed symptom | Production origins came from a gitignored `.env` with a fallback to a *different* environment (`api.vizora.io`), so the same commit could ship APKs pointing at different backends |
| Actual consuming path | `vite.config.ts` `define` → `DEFAULT_CONFIG` in `src/main.ts:71` → seeds runtime config |
| Root cause | `env.VITE_API_URL \|\| 'https://api.vizora.io'` — absent env silently substituted another environment; every release gate was origin-blind |
| Fix / PR | vizora-tv#19 (merged `c9b4bce`), Vizora#290 (merged `c5eb337`) |
| Negative tests | 72 release/ops tests, incl. mis-pointed APK rejected, partial pin, partial baseline, unauthorised origin move, stale transition, `apkBytes` string/absent, `versionCode` string/missing/fractional/zero/negative |
| CI | 7/7 green on head `42bc9a3f`; runs `31669080688`/`31669080690` both record that head SHA |
| Runtime verification | Suite re-run **on merged main** (`c5eb3377`): 72/72. Gate binds the real approved 1.3.13 artifact: candidate ✓, Gate A ✓, versionCode continuity ✓ |
| Status | **CLOSED** — issue closed with evidence summary; isolated worktree removed after merge verification |

### Defect shape recorded for reuse

Four bugs, all found by negative tests, all passing the full positive suite:
`if (wellFormed) { runCheck() }` — the type test gated *whether the comparison ran*.
`versionCode` was a **delayed** fail-open: a string passes the candidate binder, is
promoted into `published`, and disarms the Android downgrade check one release later.
Two survived because a test I had written codified the wrong behaviour.

**Rule:** the type test belongs in the verdict, never in the guard.

---

## Phase B — issue inventory (evidence, not memory)

Open at inventory time (2026-08-13):

| Issue | Repo | Claim | Disposition |
|---|---|---|---|
| #18 | vizora-tv | release origin provenance | **CLOSED** (above) |
| #8 | vizora-tv | ack-envelope contract (F40); backend §1.10 unanswered | investigating |
| #3 | vizora-tv | Play Store guide; records a malformed `push_content` client defect | investigating (defect only; store paperwork out of scope) |
| #256 | Vizora | TV calls `GET /api/v1/devices/me/content` which does not exist → pull/reconcile inert | investigating |
| — | field report | Updated TV shows "connection failed", keeps OLD playlist, ignores newly assigned playlist; mobile fine | investigating |

Investigation lanes running in parallel; issue bodies treated as starting claims and
re-proven against current source.

### #256 — REAL, confirmed at RUNTIME (independent of source analysis)

Probed production directly rather than trusting the issue text:

| Probe | Result |
|---|---|
| `GET /api/v1/devices/me/content` | **404**, body `{"message":"Cannot GET /api/v1/devices/me/content","error":"Not Found"}` |
| same, with a bearer token | **404** — so not an auth rejection |
| CONTROL: `POST /api/v1/devices/pairing/request` | **400** — route exists and validates its body |

The `"Cannot GET …"` body is Nest's unmatched-route 404. A route that existed but
rejected auth would answer 401. The control proves device routes are reachable, so the
404 is specifically **no handler registered**. #256 is REAL on current production.

### #256 is the leading root cause of the tester's stale-playlist symptom

The client side is fully built and correct; the server side simply never existed.

| Client fact | Evidence |
|---|---|
| `pullContent()` GETs `${apiUrl}/api/v1/devices/me/content` with the device bearer | `src/main.ts:1045-1051` |
| Called on **every (re)connect** — "T2 pull-on-connect … makes delivery resilient to any single push's fate" | `src/main.ts:1152` |
| Called again when a heartbeat **ack** carries `reconcileContent` — the server-detected drift self-heal | `src/main.ts:1028-1029` |
| In-code description | "the backstop the whole delivery model rests on" (`src/main.ts:1041-1042`) |
| Behaviour on non-2xx | `console.warn(... keeping last-known-good)` then `return` — **fails safe, never blanks** (`src/main.ts:1058-1060`) |
| Behaviour on throw | identical fail-safe (`src/main.ts:1066-1067`) |

Composing that with the runtime probe: the endpoint 404s in production, so **both**
recovery paths — pull-on-connect and heartbeat reconcile — are permanently inert, and
they fail *silently* by design (a `console.warn` nobody sees on a TV).

That reproduces the reported symptom exactly: a device that misses a push, or was
offline when the assignment changed, has **no route back to truth** and keeps rendering
the old playlist indefinitely. The fail-safe "never blank" choice is right, but it
converts a hard failure into an invisible one — the silent-failure class again.

Note the client already implements version-wins (`shouldApplyContent`) so a pull and a
push reconcile to the same decision, and it is unit-tested (`src/main.spec.ts:247`,
`src/vizora-app.spec.ts:3597`). The client is ready for the endpoint that was never built.

**Open question still to prove:** the tester also saw "connection failed", so the push
path was down too. Stale playlist = missed push **and** inert backstop. Both strands
need explaining; #256 covers the backstop.

### CRITICAL — heartbeats rejected fleet-wide since v1.3.10 (NEW, not in any issue)

Surfaced by the backend lane, then proven at runtime here.

| Link in the chain | Evidence |
|---|---|
| Player sends `contentVersion` every heartbeat, initialised `''` so always serialised | `vizora-tv/src/main.ts:994`, `:180` |
| `HeartbeatMessageDto` never whitelisted it | `realtime/src/gateways/dto/index.ts:63-100` |
| Pipe runs `forbidNonWhitelisted: true`, applied to `handleHeartbeat` | `ws-validation.pipe.ts:53`, `device.gateway.ts:1679` |
| → pipe throws before the handler; status refresh, `lastHeartbeat`, `appVersion` and the ack never run | `device.gateway.ts:1703`, `:1735-1741` |
| **RUNTIME: 0 of 24 production devices carry `metadata.appVersion`** | prod DB query |
| Only writer of that key, and it runs post-validation | `heartbeat.service.ts:115-131` |
| Why it hid for four releases | `handleConnection` writes `lastHeartbeat` on **connect** (`device.gateway.ts:1115`), so rows looked fresh while every heartbeat was being rejected |

Ambiguity resolved deliberately: recent `lastHeartbeat` values initially looked like
evidence *against* the claim. Tracing every write site showed the recency came from
connect, not from heartbeats — the `appVersion` count is the discriminating fact.

Affects v1.3.10, v1.3.11, v1.3.12, v1.3.13. **Fix: Vizora#294** — one DTO field plus
tests mirroring the shipped payload; negatives verified to fail without the fix; 349
realtime tests pass. Status: **PR open, CI running.**

Composed with #256 this fully explains the field report: the ack never returns (so
drift-reconcile can never fire) **and** the pull endpoint 404s, leaving a device with no
route back to authoritative state.

### Lane findings — triaged

| Item | Verdict | Evidence | Action |
|---|---|---|---|
| **#3** malformed `push_content` | **ALREADY FIXED** | guard present `src/main.ts:1921-1929`; every malformed shape traced to a fail-safe `resumePlaylist()` | close with evidence; delete the stale TODO at `vizora-app.spec.ts:2076-2078` that still cites the fixed line, and add the negative test it deferred |
| **#8** ack-envelope contract | **REAL, scope inverted** | both live breaks are the client *emitting/calling* what the server lacks; a server→client round-trip test as filed would have caught neither | re-scope; the shared type + round-trip test is necessary but neither sufficient nor first |
| **Token rotation de-pair** | **REAL, unfiled, time-delayed** | verified independently: 0 `token:refresh` listeners in TV client; server built it for the Electron client (`device.gateway.ts:1307`); `auth/check` returns 410 on hash mismatch modelling only re-pair/unpair (`device-auth-check.service.ts:85-94`) | **filed as vizora-tv#20** |
| **All `playlist:update` emits versionless** | **REAL** | all three emit `{playlist, timestamp}` — `device.gateway.ts:1227`, `:1955`, `:2090` | the client's versioned branch (`main.ts:1252`) never runs; `currentContentVersion` is permanently `''` |
| **`emitWithDeliveryAck` books TV pushes as delivered** | **REAL, new** | `device.gateway.ts:246-253` — a client not advertising delivery-ack support is recorded `delivered: true`; the TV handshake sends `auth:{token}` only (`main.ts:1126-1128`) | every playlist push to a TV is booked delivered whether or not it arrived, so the pending-replay backstop never engages for TVs — a **third** strand of the field report |

**Do NOT delete the "legacy versionless" branch** at `main.ts:1254-1256`, which issue #8 proposes as cleanup. In production it is the **only** branch ever taken; deleting it would break delivery outright. Reopen only after a version reaches the wire.

### #256 ROOT CAUSE — a merge-as-one-unit pair went out half-merged

The drift check found the entire T2 backend slice already written and tested on
`origin/fix/t2-contentversion-item-edits`, authored **2026-07-04 — the same day as
the client half** that shipped in v1.3.10. `tasks/pending-decisions.md:359-369`
(on main) names two branches to *"merge as ONE unit"*: the vizora resolver and the
vizora-tv client. **The vizora-tv half merged and shipped to production. The vizora
half never did.**

So #256 is not a missing feature. It is one half of a documented pair released
alone, and the client has been 404ing on every reconnect since.

The stated blocker (`:348-352`) was *"merge-ready EXCEPT increment 5 — the
completing half"*. Increment 5 is `b08e3ae`, committed the same day and tagged into
v1.3.10–v1.3.13: **the condition was satisfied within hours of being written.**

The only remaining hold is circular: field validation on hardware
(`:376-378`) that cannot happen until the server half is deployed, while the server
half is held pending that validation. Six weeks of deadlock. No PR to main was ever
opened for the resolver branch; PR #229 exists but is based on the resolver branch
rather than main, with **zero reviews and zero comments**. Nobody declined this — it
was stacked on a base that was never proposed.

**Process finding worth more than the code fix:** a "merge these together" note in a
markdown file is not a mechanism. Nothing enforced it, so half shipped, and the
gap was invisible for six weeks because the failing half fails silently.

### Two constraints inherited from the hold notes

- **Increments 4 + PD-9 must stay atomic** (`:351-352`) — increment 4 removed
  realtime's own layout resolution, so landing it without PD-9 regresses layouts.
- **"Silent-inert" precedent** (`:379-383`): `response.reconcileContent` was
  *always undefined* until the ack-`.data` fix — client wired, server wired, unit
  tests green, signal never fired. Caught only by a real client↔server round-trip.
  Same class as the heartbeat DTO bug. **Green unit tests will not establish that
  the pull/reconcile path works**; Phase C must exercise the real round-trip.

### Design constraint now owned for #256

`currentContentVersion` has exactly one writer (`main.ts:1085`, `applyPulledContent`),
reachable only from `pullContent()` (404s) and the versioned-push branch (never taken).
So the server `version` must be emitted on **both** the pull response and every
`playlist:update`, and must stay short — the intended format is an ISO timestamp
(`utils.ts:46`), comfortably inside the 128-char bound added in Vizora#294.

### Runtime baseline captured (pre-requisite for any Phase D deploy)

| Field | Value |
|---|---|
| Deployed commit | `7b8473ea` on `main` |
| Delta vs `main` (`c5eb3377`) | #290 only — build-time release tooling, no runtime component |
| Services | vizora-middleware online (18 restarts, 8.9h), vizora-web online (12, 3.2h), vizora-realtime online (8, 9.3h) |
| Pre-existing prod dirt (not mine) | `M README.md`, three `.env.bak-*`, `cookies.txt` |

### Phase C harness — no production credentials required

`scripts/mock-backend.mjs` + `--mode smoke` (`.env.smoke` → `10.0.2.2`, the emulator's
host alias) already serves the full device loop: pair → socket auth → `playlist:update`
push → asset download → heartbeat **with ack** → socket kill/recover. It is the right
instrument for reproducing client-side behaviour deterministically, and avoids touching
production customer data to drive a test. Dashboard credentials are therefore **not** a
blocker for Phase C client reproduction.

---

## Phase D — merged so far

| PR | What | Merge commit | Evidence |
|---|---|---|---|
| Vizora#294 | telemetry validation: `contentVersion` whitelisted, impression `timestamp` accepts the number both clients send, pipe `tolerateUnknown` for telemetry only | `42149be6` | 358 realtime tests; negatives verified to fail without the fix; `content_impressions` had 0 rows lifetime |
| Vizora#297 | T2 slice extracted from the six-week-old unmerged branch: resolver, `GET /devices/me/content`, shared serializer, `sendInitialState` + both push sites resolver-authoritative, PD-9 layouts, PD-7 in-place edits | `9828b53d` | 7/7 CI on `803b0094`; db 92 / realtime 350 / middleware 3367; negative controls executed, not asserted |
| vizora-tv#21 | `token:refresh` listener | open, CI green `136b5a7` | 304 TV tests |
| Vizora#229 | superseded, based on a branch never proposed to main | CLOSED | PD-7 lives in #297 |

**Verified on `origin/main` after merge:** `MaxLength(64)` present, `contentVersion`
whitelisted, and `@Controller('devices/me') @Get('content')` with the 40/60s throttle
now exists. The endpoint the shipped client has been calling since v1.3.10 is live in
the codebase.

### Tooling hazard found by the lane — worth more than one PR

The `node_modules` junction recipe I handed out **produces vacuously green results**:
`node_modules/@vizora/database` resolves to the *shared checkout*, so a worktree
compiles against another branch's stale `dist/`. A `tsc -p tsconfig.json --noEmit`
also passed vacuously because that config has `include: []`. Junctions are out of the
recipe; worktrees get a real `pnpm install` + `prisma generate`.

That is the same failure class as everything else this run — a check that reports
success about the wrong thing. My own #294 verification survives it, and not by luck:
the negative control (revert the DTO → exactly 2 tests fail; restore → pass) proves
the suite was reading the worktree's files. **The negative control is what made the
green trustworthy**, which is the whole argument for running them.

## Phase C — runtime reproduction — CORE SCENARIO PROVEN

Driven with `scripts/phase-c-harness.mjs`: a real socket, real HTTP, real signed
player on an Android TV emulator. Unit tests were explicitly not treated as
sufficient — the `reconcileContent` silent-inert precedent is the reason.

### Scenario 1 — pair, connect, initial delivery

```
device_connected
heartbeat  reported:""      authoritative:…01  drift:true   screenState:pairing
ack_reconcile
pull_served pl-a …01                    <-- pull-on-connect FIRED
initial_state_pushed pl-a …01
impression c-pl-a  tsType:number        <-- numeric ts, exactly what #294 now accepts
heartbeat  reported:…01   authoritative:…01  drift:false    screenState:playing
```

The empty first `contentVersion` is confirmed as real behaviour, not theory — the
device reports `""` before it has rendered anything. That is the value `@IsOptional`
would NOT have covered, which is why whitelisting was required.

### Scenario 2 — DROPPED push, repaired by heartbeat reconcile

The tester's exact symptom, deliberately induced:

```
assigned pl-b …02  pushDropped:true      <-- device told NOTHING
impression c-pl-a                        <-- still rendering the OLD playlist
heartbeat  reported:…01  authoritative:…02  drift:true
ack_reconcile
pull_served pl-b …02                     <-- self-heal
impression c-pl-b                        <-- NEW playlist on glass
heartbeat  reported:…02  authoritative:…02  drift:false     <-- converged
```

A stale playlist can no longer persist through a lost push.

### Scenario 3 — DROPPED push, repaired by pull-on-connect after restart

```
assigned pl-c …03  pushDropped:true
(app force-stopped and relaunched)
pull_served pl-c …03                     <-- pull-on-connect, before any push
impression c-pl-c
heartbeat  reported:…03  drift:false
```

Both recovery paths work independently: reconcile for a device that never drops its
socket, pull-on-connect for one that restarts.

### What this proves, and what it does not

**Proves:** the client's pull path fires, parses, applies via version-wins, adopts
the server version and reports it back; the ack envelope round-trips; drift is
detected and repaired; impressions leave the device as numbers.

**Does NOT prove:** the production resolver's correctness (harness serves a
scripted authority), nor real-hardware behaviour on a customer panel. Field
validation is still owed. But the silent-inert class — wired both ends, tests
green, signal never fires — is now ruled out for pull-on-connect, reconcile, and
the version round-trip, because each was observed firing against a real player.

## Phase D — merges/deploys — not started

## Phase E — 1.3.14 release candidate — not started

---

## Constraints held throughout

- 1.3.13 is settled: not reopened, retagged, rebuilt, republished; Gate A untouched.
- `C:\projects\vizora` is a SHARED checkout (11 worktrees, multiple sessions). Product
  changes go in isolated worktrees; never `git checkout` there. Push explicit refs and
  verify `local HEAD == remote branch == PR head` before trusting any CI result.
- Publication of 1.3.14 is NOT authorised in this run.
