# P0-1 Merge Gate — Finding → Regression-Test Map (F5–F9)

Every S1 never-black finding maps to at least one committed test that fails if the
defect is reintroduced. All tests live in `src/vizora-app.spec.ts` (suite
**"Never-Black State Machine"** unless noted) and run in CI-mode via `npx vitest run`
(219 passing, verified stable across 12 consecutive runs).

| Finding | Defect (evidence at time of audit) | Regression test(s) | What the test asserts the app did NOT do |
|---|---|---|---|
| **F5** — empty `playlist:update` cleared the container and left a permanent black screen (`main.ts:787-800` pre-fix) | Publishing an empty playlist blacked out every assigned screen | `empty playlist push lands in branded HOLDING — exactly one screen visible, never a bare content screen` · `empty playlist replacing a playing one switches to HOLDING (did not leave a cleared black container on screen)` | Did not show a bare content screen; exactly one screen visible (screen-visibility invariant helper); holding message rendered |
| **F6** — malformed `playlist:update` threw after clearing the container → black until next valid push (no payload validation) | One bad push = fleet blackout | `malformed playlist pushes are inert — current content stays committed and playing` (fuzzes `undefined`, `null`, `{}`, `{playlist:null}`, `{playlist:42}`, `{playlist:{items:'not-an-array'}}`) | Did not remove any committed DOM node; did not change the visible screen; no exception escaped (vitest fails on unhandled rejection) |
| **F7** — all-null-content playlist caused unbounded synchronous recursion `playContent↔nextContent` → stack overflow, engine halt (`main.ts:814-817` + `899-910` pre-fix) | Playback engine died silently | `playlist with 100% null-content items lands in HOLDING with no stack overflow` | No `RangeError`/unhandled rejection; bounded scan terminated with the terminal warning; landed on branded HOLDING, not a frozen/black screen |
| **F8** — layout items scheduled no advance timer (terminal state); invalid layout metadata returned after the container was already cleared → permanent black (`main.ts:842-845`, `1148-1149` pre-fix) | Any playlist containing a layout stuck forever; a bad layout blacked the screen | `layout items advance after their duration (no terminal layout state)` · `layout with invalid metadata is skipped without touching the screen` · (adjacent leak F12: `layout zone timers are cleaned up when the playlist moves on (no ghost zone loops)`) | Playlist advanced past the layout item; invalid metadata produced **no** `layout-grid` in the DOM and the next item rendered with the screen never emptied |
| **F9** — container was emptied *before* the next asset was awaited → black gap for the full download on slow networks, flash on every rotation (`main.ts:834-857` pre-fix) | Every transition risked visible black | `item transitions append the replacement BEFORE removing the old frame` (asserts `removeChild` invocation order strictly after the newer `appendChild`, and container child-count ≥ 1) · `the old frame stays on screen while the next item is still preparing (slow asset)` | Container never passed through an empty state during a swap; the previous frame remained the visible child while the successor was still preparing |

**Structural backstop beyond the per-finding tests:** `src/screen-state.spec.ts`
verifies the machine refuses guarded transitions (PAIRING with credentials,
PLAYING without renderable content) and that refusals leave state and screens
untouched — the property that makes the F5–F9 class unrepresentable rather than
merely patched.

Related first-boot/black-adjacent coverage in the same suite: F11
(`paired device with no playlist shows HOLDING on connect`), F19
(`init failure enters RECOVERING and retries… error screen never shown`),
F35 (`stops at end when loopPlaylist === false` retains the last frame —
"Playlist Playback" suite), F13-partial (`heartbeat stops reporting
currentContent when the machine leaves PLAYING`).
