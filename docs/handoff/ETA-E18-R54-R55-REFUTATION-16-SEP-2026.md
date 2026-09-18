# ETA-E18 R54/R55 — Refutation of ab5cb44 · 16 Sep 2026 · Refuter (Builder pane)

Delta only: `25d640f..ab5cb44`. R47, R48, R49, R50, R52, R53 and D2 were cleared in my earlier rounds and were not
re-attacked. Work ran in a read-only `git clone --shared` at `ab5cb44`. The `-e18` worktree is untouched at
`ab5cb44` and I left no scratch file in it; the one file I mutated was restored and checked by sha256
(`lib/stt/silence.ts: OK`). Containers all removed. I read the builder's uncommitted report in the main worktree
without touching its git state. Per R30/R27 no Swift ran and none is cited.

## 1. Verdict — MERGE-READY

The fix is one line (`rows[0]?.future === true` → `!== false`), it does what it claims, and the ordinary path is
untouched — which is the thing a fail-closed change usually breaks.

## 2. The no-rows probe: **1 before the fix, 0 after**

Same injection as round 3 — the future-check round trip answers with no rows, everything else live. Before
(`25d640f`): a fabricated *tomorrow* as_of **moved 1**. After (`ab5cb44`): **moved 0**, refused `as_of_in_future`,
the window still `silent`. An absent answer is now a refusal rather than a permission.

## 3. The regression risk — the ordinary path still moves exactly what it should

This is where a fail-closed change earns its keep or destroys the feature, so I measured it three ways, all on a
real postgres:16:

| Path | Expected | Moved |
|---|---|---|
| module: honest preview, then apply with the bound it minted | 3 | **3** (0 left silent) |
| the tool end to end: dry run, then `apply:true` with `would.as_of` | 2 | **2**, `ok:true`, no error |
| mutant N3, the check refusing EVERY bound | — | **21 tests fail** |

The driver really returns `{"future": false}` — a JS boolean — which is what makes `!== false` safe; I captured it
rather than assuming it. One dependency worth naming: the guard now rests on the driver returning a boolean, so a
driver that answered `'f'` as a string would refuse every legitimate apply. VERIFIED for the psql-backed test
harness; INFERRED for Neon HTTP in production, which types booleans natively. N3 shows the suite would catch that
class loudly (21 failures), so it cannot ship silently.

## 4. R55 is honest — it dies for the claimed reason

Under the `Date.now()` mutant two tests fail, and I read their messages rather than their names:
- **R55**: *"the database's clock decides, so the legitimate bound is honoured: expected { ok: false, …"* — the
  legitimate bound was thrown away, which is exactly what the test exists to pin.
- **R54**: *"the check did run — this is an empty answer, not a skipped guard: expected 0 to be greater"* — a
  correct collateral catch, because a `Date.now()` comparison stops asking the database at all.

**No leakage from the frozen clock.** The fixture seeds its own room and session (`room_r55`), the freeze is
`vi.useFakeTimers({ toFake: ["Date"] })` inside a `try/finally` that restores real timers even on failure, and every
other timestamp in that file comes from Postgres `NOW()`, not from `Date`. Nothing else in the file passes or fails
because of it.

## 5. R51-c — your ruling is OVERTURNED, and the survivor is still acceptable

You ruled strict `>` must stay because an apply run straight after its own dry run would refuse itself under `>=`.
I made it `>=` and ran exactly that sequence: **preview 1, moved 1, no refusal.** The reason is that `now()` has
already advanced by the time the apply's check runs, so the bound is strictly in the past and equality never holds.

**Your stated reason is wrong.** The survivor is nevertheless acceptable, for a stronger reason than the one it was
given: a caller cannot produce an as_of equal to the `now()` evaluated *inside the check's own statement*, so `>`
and `>=` are indistinguishable across two round trips. R51-c is a **true equivalent**, not a risk being tolerated —
and it cannot be killed by a test, because no reachable input separates the two.

## 6. Scope — exactly two files

`lib/stt/silence.ts` (+9/−1) and `tests/unit/e18-silence-is-evidence.test.ts` (+72). Nothing else in the tree moved;
the worktree is clean at `ab5cb44`.

## 7. My own mutation run on the delta: 3 caught of 4, one equivalent

Two suites per mutant (e18-silence-is-evidence on real postgres:16, mcp-surface-aliases), baseline 397 of 397.
**Caught:** N1 (R54 reverted to `=== true`) · N3 (the check refuses every bound — the regression direction) ·
N4 (judged by this process's clock). **Survivor:** N5 (`>` → `>=`), the accepted R51-c, and §5 shows it is an
equivalent rather than a hole.

## 8. Gate — rerun by me, Docker up, no exclusions

`npm run typecheck` exit 0 · `npm test` **`Test Files 112 passed (112)`, `Tests 2720 passed (2720)`** ·
`npm run build` exit 0 · `npm run check:silent` exit 1 with the accepted pre-existing 9.

## 9. The whole question — `vinay/e18-silence-is-evidence` at `ab5cb44`

**Merge-ready into `vinay/s1-auto-drain`.** Across three rounds every defect I measured has been closed and pinned:
the preview's bound (250/100), the ledger hole for no-evidence windows, the overwritten pass, the untotal order, the
picked/moved divergence, the migration that would have succeeded and done nothing, the fabricated future bound, and
now the fail-open default. Each fix fails its own test when reverted; I killed every one myself rather than reading
the tally.

**Nothing blocking. One thing I would have you rule on consciously before 0101 is applied**, not fixed in code:
0101's upgrade backfill writes `unrecorded.pre-r31` into `reopened_detector` for any legacy reopened row. It is
honest in wording, shape-valid and documented, and it is the only place in this line where the ledger asserts a
value the system does not actually know. It is unreachable today — 0101 has never been applied anywhere, so no such
row exists — which is exactly why it should be a decision taken on purpose now rather than discovered later.

## 10. Anything unrun
- Swift: not run, not cited (R30/R27) — no Swift file is touched.
- 0101 applied only inside ephemeral containers; it remains committed and unapplied.
- Neon HTTP's boolean deserialisation (§3) is INFERRED, not measured: this pane has no live database.

## 11. Scratch evidence (session scratchpad, not committed)
`r4/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`. The probe files `zz-refuter-r4.test.ts` and `zz-refuter-r51c.test.ts` ran in the clone and
were deleted after.

## 12. Subagents
None.
