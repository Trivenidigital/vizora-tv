# P0-1 Design — Playback State Machine & Never-Black Enforcement

**Status:** Approved slice; this document is the implementation spec.
**Fixes:** F5, F6, F7, F8, F9, F11, F12, F19, F35 (register: `tasks/vizora-tv-review.md` §2)
**Design bar (per review):** the fallback hierarchy — live → cached → holding — must exist as *states with transitions*, not a try/catch chain, and "black" must be unrepresentable in the model.

---

## 1. Why a state machine and not guards

Every S1 in the F5–F9 family is a path where screen ownership was ambiguous: a handler cleared the content container assuming a successor would render, and no successor came. Adding null-checks per handler reproduces the bug class. Instead:

1. **One owner.** A `ScreenStateMachine` is the only code allowed to change which screen is visible and the only code allowed to remove content from the content container.
2. **Total render function.** Every state maps to a guaranteed-non-empty DOM. There is no state whose renderer can produce an empty screen, so "black" has no representation.
3. **Removal requires replacement.** The single DOM-mutation primitive is `commitSwap(ready)`: it appends the *already-ready* new element, then removes the old one. There is no "clear" primitive exposed. F9's clear-then-await ordering becomes impossible to write.

## 2. States

```
                ┌───────────────────────────────────────────┐
                │                 BOOT                      │ splash/loading
                └───┬───────────────────────────────┬───────┘
        no credentials                     credentials found
                    ▼                               ▼
              ┌──────────┐   paired ok      ┌───────────────┐
              │ PAIRING  ├─────────────────▶│    PLAYING    │◀────┐
              └──────────┘                  │  live|cached  │     │ renderable
                    ▲                       │  |hold-last   │     │ playlist
   credentials removed                      └───────┬───────┘     │ arrives
   (P0-2: structured                no renderable   │             │
    revocation only)                content         ▼             │
                    │                       ┌───────────────┐     │
                    └───────────────────────┤    HOLDING    ├─────┘
                                            │ (branded)     │
                                            └───────────────┘
              ┌────────────┐  retry backoff, then re-init
              │ RECOVERING │  (entered only from BOOT failure)
              └────────────┘
```

| State | Screen | Entry guard | Guaranteed DOM |
|---|---|---|---|
| `BOOT` | loading-screen | initial only | logo + spinner |
| `PAIRING` | pairing-screen | `deviceToken == null` — a credentialed device can NEVER enter PAIRING (structural half of F3; the wipe policy itself is P0-2) | QR + code card |
| `PLAYING` | content-screen | validated playlist with ≥1 renderable item | last committed item (see §4) |
| `HOLDING` | holding-screen (new) | always allowed — universal fallback | branded "waiting for content" + status line |
| `RECOVERING` | recovering variant of holding-screen | init failure | branded + "reconnecting" + retry countdown |

`PLAYING` carries a **source tag**, not sub-states that change rendering: `live` (socket-delivered playlist), `cached` (restored from Preferences), `hold-last` (non-looping playlist finished; engine parked on final item — F35 made explicit). The tag is telemetry-visible (feeds P1-1 heartbeat enrichment) and controls nothing else.

Transitions go through exactly one function:

```ts
transition(to: ScreenState, reason: string): boolean
```

which checks the guard table, logs, records `{from, to, reason, at}` for telemetry, and toggles screens. Illegal transitions (e.g., `PLAYING → PAIRING` while a token exists) are refused and reported — never silently performed. `showScreen()` becomes private to the machine; all existing call sites route through `transition()`.

## 3. Playback engine (inside PLAYING)

The recursive `playContent()`/`nextContent()` pair (F7) is replaced by an iterative engine:

```
advance():
  for step in 0..items.length-1:            # bounded — recursion impossible
    item = items[(index + step) % len]      # respects loopPlaylist at wrap
    if !renderable(item): continue          # null content, unknown type
    prepared = await prepare(item)          # off-DOM, old frame still visible
    if prepared == null: continue           # decode/download failure → skip
    commitSwap(prepared)                    # append new, THEN remove old
    schedule advance: duration timer (all types incl. layout — F8)
                      + video onended for early advance
    return
  # full pass, nothing renderable:
  transition(HOLDING, 'no_renderable_content')   # F5/F7 terminal fix
```

- **`prepare(item)`** builds the element detached from the DOM and awaits readiness with a per-type deadline: image `onload`, video `loadeddata`, iframe `onload` (existing 10s srcdoc timeout retained). Cache resolution/download happens here — the previous frame stays on screen for the entire download (F9).
- **`commitSwap`** is the only removal site. It also runs the *previous* item's `cleanup()` closure after the swap — layout zone timers register their teardown there, so leaving a layout item always clears its timers (F12), no matter which path caused the departure.
- **Layout items** get a duration timer like every other type (F8). `renderLayout` with invalid metadata returns `null` from `prepare` → item skipped, screen untouched (fixes the clear-then-return black).
- **Content errors** (img/video `onerror` post-commit): telemetry event + immediate `advance()`. The "Unable to load: …" error card is deleted — an error surface must never appear while other renderable content exists; if nothing is renderable the machine lands in branded HOLDING.

## 4. Message hardening

`playlist:update` payloads pass `validatePlaylist(data)` before touching any state (F6):
- not an object / missing `items` array → **ignore**, keep current playback, emit telemetry error. A malformed push can no longer black a screen.
- valid but zero renderable items → `HOLDING` via transition (F5) — deliberate branded screen, never a bare cleared container.
- valid with content → replace playlist and `advance()`.

Socket `connect` no longer force-shows the content screen (F11): it transitions to `PLAYING` only if a renderable playlist exists, else `HOLDING`.

## 5. Init resilience (F19)

`init()` failure no longer dead-ends in the error screen. `RECOVERING` retries `init()` with exponential backoff (5s → 5min cap), showing the branded holding UI with a status line. The raw error screen remains only for the unreachable-by-design case (DOM itself missing).

## 6. Where "black" became unrepresentable — checklist

| Old black branch | Why it cannot recur |
|---|---|
| Empty playlist cleared container (F5) | no clear primitive; empty → HOLDING state renders branded DOM |
| Malformed push threw after clear (F6) | validation precedes any mutation; invalid input is inert |
| All-null recursion (F7) | bounded for-loop; exhaustion → HOLDING |
| Layout terminal / invalid metadata (F8) | uniform duration timer; prepare-null skips without touching DOM |
| Clear-then-download gap (F9) | prepare is off-DOM; commitSwap appends before removing |
| Paired-no-playlist black (F11) | connect guard routes to HOLDING |
| Init dead-end (F19) | RECOVERING state with retry loop |
| Non-loop end (F35) | explicit `hold-last` tag; final frame retained by design |

## 7. Negative test plan (ships with the slice)

1. Empty `playlist:update` → holding screen visible, content screen hidden; **no state where all screens are hidden** (asserted by a helper that checks screen-visibility invariant after every scenario).
2. Garbage payloads (`undefined`, `{}`, `{playlist:{items:'x'}}`, `{playlist:null}`) → previously-committed content still in the DOM; no exception escapes.
3. Playlist with 100% `content: null` items → HOLDING; no `RangeError`; completes under fake timers (no unbounded loop).
4. Layout item in a mixed playlist → advances after `duration`; zone timers empty after advance (leak assertion on `zoneTimers.size`).
5. Layout item with missing metadata → skipped; next item rendered; container never empty.
6. Image→image advance: container child count never reaches 0 across the swap (removal spy ordered strictly after append).
7. Slow asset (prepare pending): old item remains in DOM until new resolves.
8. `loopPlaylist:false` end → last item still in DOM, engine parked, no timers pending.
9. Fresh boot no creds → PAIRING; boot with creds + no playlist → HOLDING (not content-screen black).
10. Init throws → RECOVERING; timer-advanced retry succeeds → normal flow. Error screen never shown.
11. Guard test: `transition(PAIRING)` while token present → refused, state unchanged.

## 8. Explicitly out of scope (deferred to their slices)

Credential-wipe policy & tenant binding (P0-2), video stall watchdog (F17/P1-2), playlist idempotency (F15/P1-2), heartbeat state enum (P1-1 — though `PLAYING.source` and `currentContentId` clearing land here because the machine owns them).
