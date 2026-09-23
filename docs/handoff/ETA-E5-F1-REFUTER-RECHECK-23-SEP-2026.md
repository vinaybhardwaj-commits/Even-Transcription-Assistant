# ETA — E-5 drift guard (F1) and the 0113 regex. REFUTER RE-CHECK. 23 Sep 2026

`vinay/encounter-hypothesis` **@ `68fb60d`** (builder lx), two commits on `3449562`: `9b7c228` (F1 — the parser strips comments, and the guard moves to `tests/support/sql-check.ts`) and `68fb60d` (the 0113 verbatim regex replaced with a value-set comparison). Re-check of `ETA-E5-HYPOTHESIS-STORE-REFUTER-RECHECK-23-SEP-2026.md`. Own detached worktree `/tmp/refute-e5r`; nothing pushed, no migration applied, no database touched. Mini kept out — every run on the Yoga fast runner.

## PASS — both are closed. One residual of the same class remains, narrower, and stated with its precondition checked this time

### F1 is closed — G1 dies

`stripSqlComments` now runs before the parser looks for anything, so a `--` comment quoting a constraint can no longer answer for it. My exact mutation — a header-style comment carrying the five-value clause, with the real CHECK narrowed to two — is **killed**. lx also ran it against the real 0114 rather than only a synthetic string, and reports the before/after: green before the fix, `Set{non_speech, end_of_input}` vs `Set{…5}` after. The stripper is quoted-string aware, and **G6 confirms that is load-bearing**: disabling the string tracking is caught, so a value containing `--` still parses as that value.

### The 0113 observation is closed, in both directions — G3 and G4 die, G5 survives

`voice-centroid.test.ts` now compares 0113's domain CHECK against `VOICE_DOMAINS` as a set, through the same shared parser. Dropping a domain from the SQL is caught (**G3**), adding one to the array is caught (**G4**), and a pure reformat with the values reordered **survives** (**G5**) — which the verbatim regex it replaced could not have managed. All three SQL↔TS pairs are now guarded the same way: `voice_centroid.domain` ↔ `VOICE_DOMAINS`, `closed_by` ↔ `CLOSED_BY`, `match_source` ↔ `MATCH_SOURCES`. Moving the guard into `tests/support/sql-check.ts` is what made that possible, and is the right call.

### RESIDUAL — a `/* */` block comment still answers for a constraint

**G2 survives.** `stripSqlComments` handles `--` to end of line only; a block comment is not stripped, so the same decoy written as `/* CONSTRAINT … CHECK (…five values…) */` above a narrowed real clause leaves the drift test green — F1 again, in the other comment syntax.

**Precondition, checked before claiming it** (the discipline I failed on last round): **two migrations do use `/* */` — `0074_room_diarize.sql` and `0082_scribe_job.sql`.** So the form is live in this repo's migrations. As with F1, no migration currently quotes a constraint in the parseable form in *any* comment syntax, so this is a latent hole rather than a near miss, and it is narrower than F1 was because `--` is overwhelmingly the dominant form here. One line in a function that is now shared and already tested.

## The correction I owed, and what it changes

lx checked a claim in my previous verdict and it did not hold. I wrote that F1's two-step path was likely because **"`0113` and `0115` both quote their own CHECK clauses in header comments … It is the house style."** That is false. Verified myself after being told: **no migration in this repo quotes a constraint in the parseable `CONSTRAINT <name> CHECK (` form inside a comment**, and the two files containing the word CHECK in a comment (`0060`, `0101`) are prose, not clauses. I had verified that 0113's header mentions the *column name* `retired_by` — true, and why the sibling test's stripping is load-bearing — and generalised it into "quotes its CHECK clause". Two different things.

The **hole was real** and is not in question; my **weighting** of it was wrong. F1 and G2 are genuine latent holes worth closing, not accidents waiting to happen. The previous verdict is corrected in place and a `SUPERSEDES` line is in the ledger.

lx found this by writing a test to assert my claim, watching it fail, and **removing the test rather than leaving one that asserted something untrue** — then saying so unprompted, when the overstatement flattered their own fix. That is worth more to this programme than the finding was.

## Gate

- **Mine:** 7 mutations through the Yoga fast runner, 0 runner errors, worktree verified clean at `68fb60d` afterwards.
- **The builder's, quoted as theirs:** `rc=0`, 173/173 files, 3,880 passed, build 14.2 s; 32/32 store, 26/26 voice-centroid; `typecheck` and `typecheck:tests` both clean locally before submitting.

**Jev — not run.** This is a re-check of two narrow fixes to a diff Jev scored last round, and the server's guidance is against repeating a call on effectively the same change. The mutation evidence above is independent of it.

**Verdict: PASS.** F1 is closed with the mutation that found it now in the suite, the third SQL↔TS pair is guarded like the other two, and the shared parser is the right home for all of it. The block-comment residual is one line and does not hold the merge.
