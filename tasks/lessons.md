# Lessons

Standing rules for this repo, written from mistakes and near-misses that actually
happened here. Each one exists because a green test suite failed to report something.

---

## L1 — An assertion that something threw is not an assertion that the right thing threw

**Rule:** when a test asserts a failure path, match the MESSAGE (or error type), never a
bare `toThrow()` / `rejects.toThrow()`.

**Why, with numbers:** mutation-testing the release-origins guard
(`src/build-provenance.ts`) ran nine mutations. **Three of the nine would have passed a
suite that only asserted "it threw"**, because each mutant still threw — from somewhere
else:

| Mutation | What still threw |
|---|---|
| delete the pin-file read throw (`catch { pin = {} }`) | the *adjacent* missing-key branch, one loop iteration later |
| delete the missing/empty-key throw | `new URL(undefined)`, as a raw `TypeError` |
| delete the URL-parse throw | Node's bare `TypeError: Invalid URL` |

Every one of these is a real fail-closed guard being deleted, and every one leaves a
suite that says "throws when the pin file is missing" fully green. The failure is not
that the guard stopped working — it is that a *different* guard downstream absorbed the
case and the test could not tell the difference.

**In practice:** `expect(fn).toThrow(/\[release-origins\].*is missing or not valid JSON/s)`,
not `expect(fn).toThrow()`. If the message is not stable enough to match on, that is a
signal the error needs a stable identity (a code, a class), not a signal to loosen the
assertion.

---

## L2 — A test count derived from production data can silently become zero

**Rule:** whenever the NUMBER of test cases or assertions comes from data rather than
from the spec file, pin the cardinality separately. Two shapes, both real:

**Shape A — generated cases.** `it.each(SOME_IMPORTED_CONST)` or
`for (const x of PRODUCTION_ARRAY) { it(...) }`. If the array empties, zero tests are
generated and the run is green. Nothing reports that the suite became vacuous — the
totals just get smaller, and nobody reads totals.

Defence: a cardinality meta-guard beside the generated block.

```ts
it('pins exactly api, realtime and dashboard', () => {
  expect(RELEASE_ORIGINS.map(o => o.key)).toEqual(['api', 'realtime', 'dashboard']);
});
```

Proven: emptying `RELEASE_ORIGINS` turns 7 tests red, of which this meta-guard is the
one that names the actual cause.

**Shape B — assertion loops over production output.** `for (const v of out.values)
expect(...)`. If the production call returns an empty array, the loop body never runs
and the test passes having asserted nothing. This one was live in this repo:
`src/main.spec.ts` iterated `scrubEvent`'s returned `exception.values` with no count
assertion. A mutant that made `scrubEvent` destroy the array (`values = []`) **passed
green**. Adding `expect(out.exception.values).toHaveLength(2)` above the loop turns the
same mutant red.

**In practice:** if a loop carries the assertions, assert the loop will run first.
Positive control before the property check, always in that order.

---

## L3 — Verify a guard by deleting it, not by reading it

Both rules above were found by mutation testing, not by review. A guard that looks
correct and a guard that fires are different claims, and only one of them is testable.
When a change adds or touches a fail-closed path: delete the guard, watch a test go red,
restore, watch it go green. Paste the output.

Two mechanics that make this trustworthy on this repo:

- **Fail loudly when a mutation does not apply.** Working-tree files here are CRLF
  (`core.autocrlf=true`) while newly written files are LF. A `sed`-style find/replace
  that silently matches nothing reports the mutation as "survived" when in fact nothing
  was mutated. Use a helper that exits non-zero when the needle is not found — this
  caught a real no-op mid-run.
- **Verify restores by content, not by `git diff --quiet`.** In a worktree with expected
  modifications (an intentional edit, a pre-existing `package-lock.json` change) that
  command can never return 0, so it reports nothing useful. Compare a sha256 against a
  pristine copy taken before the run.
