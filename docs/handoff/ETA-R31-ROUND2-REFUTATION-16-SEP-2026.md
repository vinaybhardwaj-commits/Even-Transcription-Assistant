# ETA-R31 round 2 — Refutation of 24fcdc2 (E18 R50/R47/R48/R49) · 16 Sep 2026 · Refuter (Builder pane)

Worktree `-e18`, branch `vinay/e18-silence-is-evidence`, HEAD `24fcdc2`, parent `0d21596`. I measured the three
defects this round fixes; scribe3 built the fixes. Everything below ran in a read-only `git clone --shared` at
`24fcdc2`. Nothing was fixed, committed, merged, pushed, promoted or deployed; migrations ran only inside ephemeral
postgres:16 containers (Docker 29.8.0), and all were removed. Rule 22 observed: every mutation restored and verified
by sha256. Per R30/R27 no Swift ran and none is cited. The e18 worktree is untouched at `24fcdc2`.

## 1. Verdict — MERGE-READY

Each of the three defects I raised is fixed and pinned by a test that fails without the fix, the R50 upgrade path
works from the previous committed blob and is idempotent, and R49 is structural rather than tested. My two survivors
are one genuine equivalent and one error-message difference; neither changes what the surface does.

## 2. W8/W9 — the equivalence claim, verified by making the copies diverge

I did not accept the claim; I made the two copies of the schema disagree, in both directions.

| Divergence | Drift test |
|---|---|
| a column in the CREATE TABLE body, **missing from the ALTER list** (D1) | **RED — 3 tests** |
| a CHECK whose ALTER copy says something different from the body's (D3) | **RED — 2 tests** |
| a new constraint added without `DROP CONSTRAINT IF EXISTS` first (D4) | **RED — suite error** |
| the legacy backfill removed (D5) | **RED — 2 tests**, the upgrade fails loudly rather than skipping the constraint |
| a column in the ALTER list, **missing from the body** (D2) | green — **and correctly so** |

**D2 is a true equivalent, not a hidden survivor.** With the column absent from the body, the ALTER adds it on the
fresh path as well as the upgrade path, so both paths end with the identical table: 25 columns, same CHECKs, same
defaults. There is no observable difference for any test to catch. The direction that can actually hurt — present in
the body, absent from the ALTER list, which is the shape that leaves an upgraded database short of a column — is
caught three ways. **The equivalence claim is true.** The report's "no equivalents" is the one word I would correct:
this family contains one, and naming it is better than a clean tally.

## 3. R50 — the upgrade path, built from the previous committed blob

Not a hand-written "earlier shape": `git show 0d21596:db/migrations/0101_...sql` applied first, then 24fcdc2's
version on top.

1. **The columns and constraints arrive.** `reopened_as_of` absent before, present after; `reopened_history` lands
   `NOT NULL DEFAULT '[]'::jsonb`; all eight CHECKs present after, including `detector_chk`, `row_kind_chk` and
   `history_chk`.
2. **A second application on the same database is still a no-op** — column list and CHECK list byte-identical
   across the second run, 25 columns.
3. **A row that the new CHECKs would refuse.** Against the ORIGINAL shape (`56320ba`, which has no
   `reopened_detector` at all) I seeded a legacy reopened row. The migration did not fail and did not skip: the
   backfill repaired it, ending `reopened_detector = 'unrecorded.pre-r31'` with the pass preserved in history as
   `{batch: legacy_batch, reason: legacy reason, detector: unrecorded.pre-r31, as_of: null}`. I then removed the
   backfill (D5) and the migration **failed loudly on the detector CHECK and named it**, so the constraint is never
   silently skipped. I could not construct a row that survives the backfill and still breaks a new CHECK: the old
   shape's own NOT NULLs make the unrepairable shapes unreachable.

**Flag, not a defect:** `unrecorded.pre-r31` is an invented token written into the ledger. It is honest in wording,
shape-valid, documented, and applied only where the fact is genuinely absent — but "every reopened row names a
detector" is now true partly by construction. It is the fork I flagged when this file was briefly in front of me;
scribe3 chose invention over dropping the entry, and that choice should be on the record rather than in a comment.

## 4. R47 — the hole, as a number

**0 rows.** A writer whose transaction began before the preview and committed after it: preview 2, moved 2, and both
moved windows were in the preview (`bw_seen`, `bw_slip`). The builder's own stated residual did not reproduce as a
divergence, because the fallback in the bound (`COALESCE(decided_at, closed_at, created_at)`) had already put that
window in the preview too.

Two other measurements, both mine, neither of which the order asked for:

- **A future `as_of` is accepted: preview 1, moved 2.** `checkedAsOf` requires a *parseable* timestamp, not one the
  system issued, and the tool checks only `Date.parse`. A caller passing tomorrow's date gets the old unbounded
  behaviour with the pin apparently satisfied. The pin is therefore advisory — cooperative callers get the
  guarantee, and nothing stops a clock-skewed or careless one. Cheap to close (clamp to `now()`, or issue a token).
- **A silent window with no evidence row is not pinned at all: preview 1, moved 2.** The bound falls back to
  `closed_at`, which precedes any later verdict, so such a window slips under any as_of. **This is latent, not live:**
  I checked the writer, and `recordSilenceVerdict` runs in the segment step (room-drain.ts:798) *before* the state
  moves in finish (room-drain.ts:1325), so a crash between them leaves a row without a silent state, never a silent
  state without a row. The population cannot grow, exactly as the builder claims; my probe manufactured one by hand.
  Worth keeping on the record because R38 exists precisely because that population is real.

## 5. as_of required — the callers that would now refuse

One production caller: `lib/mcp/tools/stt.ts:523`, and it passes `asOf`, so **nothing in the repo refuses**. No
script, no route, no cron reaches the bulk path — I grepped `lib`, `app`, `scripts`, `tests` and `docs`. The contract
change bites outside the repo: any saved operator invocation of `scribe_silence_readjudicate` with `apply: true` and
no `as_of` now returns `as_of_required`. `docs/operator-mcp/TOOL-NOTES.md` is updated. One asymmetry worth a line:
the unscoped-apply refusal still returns the preview, while the `as_of_required` refusal returns none — yet a caller
without an as_of is exactly the caller who has not previewed, so that is the refusal most improved by carrying one.

## 6. R48 — both directions, and it is a full pin

I separated the two statements rather than trusting one test. **Removing the id tiebreaker from the PREVIEW only:
RED. Removing it from the APPLY only: RED. Removing the apply's ORDER BY entirely (Z10): RED (2 tests).
`listSilentWindows` without its tiebreaker: RED.** All three statements carry `ORDER BY start_ms ASC, id ASC`, and
each is independently pinned. Z10 is dead.

## 7. R49 — can picked and moved still diverge? No, on any branch

`picked` selects `w.id` alone; `moved` is the UPDATE with `RETURNING w.id, w.session_id, w.room_day_id`; the stamp's
SELECT reads `m.id, m.session_id, m.room_day_id` from `moved`; the statement's result is `SELECT id FROM moved`.
Pointing the stamp at `picked` does not resolve — mutant Q1 fails 14 tests, not one. The conflict path acts on the
same rows the SELECT produced, and the zero-row case inserts nothing and returns nothing. **Z12 is dead
structurally, not by test.** Q2 (the UPDATE stops returning what the ledger needs) is also caught.

## 8. What had to keep holding — it does

R38 (stamp back to UPDATE-only: caught, 3 tests) · R39 (history overwritten: caught) · R31.5 (the detector regex
removed: caught) · the CHECKs on every branch (D3, D4 and the upgrade test).

## 9. My own mutation check: 17 caught of 19 run

Four suites per mutant (e18-silence-is-evidence on real postgres:16, mcp-surface-aliases, room-drain,
migrations-self-record), baseline 528 of 528.

**Caught (17):** D1 · D3 · D4 · D5 · O1 · O2 · O3 · O4 · A1 (the apply ignores the bound) · A3 (the tool stops
requiring as_of) · A4 (the ledger stops recording it) · A5 (the apply takes `now()` instead of the handed-back
bound) · Q1 · Q2 · G1 · G2 · G3.

**Survivors (2):**
- **D2 — equivalent** (§2): both paths produce the identical table, so no return value separates them.
- **A2 — a real but narrow separator.** Removing the empty-`as_of` throw in `checkedAsOf` leaves the call failing
  anyway, at the database, on `''::timestamptz`, instead of at the module with a named message. A direct module
  caller separates them by which error they get and by whether the database was touched; the tool refuses first, so
  no production path reaches it. Worth a line of test, not a rebuild.

## 10. Gate — rerun by me, Docker up, no exclusions

`npm run typecheck` exit 0 · `npm test` **`Test Files 112 passed (112)`, `Tests 2712 passed (2712)`** ·
`npm run build` exit 0 · `npm run check:silent` exit 1 with the accepted pre-existing 9. This reproduces the
builder's reported numbers exactly.

## 11. Anything unrun
- Swift: not run and not cited (R30, R27) — no Swift file is touched.
- 0101 applied only inside ephemeral containers; it remains committed and unapplied.
- The live silent-window population was not measured: no database in this pane.
- Two operators applying concurrently was not simulated; R49's answer is structural, so there is nothing left for a
  concurrency test to decide.

## 12. Scratch evidence (session scratchpad, not committed)
`r2/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`, and the probe `tests/unit/zz-refuter-r2.test.ts` (R50-a/b/c, R47 hole, R47 future as_of,
R47 no-evidence), which exists only in the clone.

## 13. Subagents
None.
