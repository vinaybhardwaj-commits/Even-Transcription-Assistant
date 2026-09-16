# ETA — FIX2 REFUTER BRIEF
**14 September 2026 · Session: `ETA-Refuter` · Opus · pinned `8ac9e24` · read-only.**
**Start only after `scribe` reports FIX3 — see §Timing.**

## The ask

Refute FIX2: commit **`8ac9e24`** on `vinay/s1-auto-drain`, parent `d852127`, base `vinay/release-b1` at
`14a4f38`. Contract: `docs/handoff/ETA-S1-FIX2-CC-KICKOFF-14-SEP-2026.md` and the rulings it implements in
`ETA-S1-ROUND2-RULINGS-14-SEP-2026.md`. Builder's report: `ETA-S1-FIX2-REPORT-14-SEP-2026.md`.

## Timing — this is not optional

**Wait until `scribe` has reported FIX3.** The repo's Postgres test helper uses a fixed Docker container
name and vitest runs files in parallel; two suites running at once delete each other's database mid-run.
Also **do not probe the Mini services at all** during this review — `scribe3` is measuring the router and
M1 made queue wait visible inside the router's own reported timing, so any request you send corrupts that
measurement. Your review needs neither.

## Rules

- Do not trust the report's gate lines. Clone at depth into your own scratch, rerun `npx tsc --noEmit` and
  the full suite yourself, quote what you saw.
- Check the FIX2 contract item by item — C1, C2, C3, C4, C5, C6, C7, the bus-document commit list, and the
  untouched list — with a `file:line` proof each.
- Pin to `8ac9e24`. `scribe` is committing FIX3 on this branch; ignore anything after your pin.
- Read-only: no edits, no pushes, no env changes, no migrations run.

## Already ruled — do not re-litigate

G1, G2 and G3 are being fixed in FIX3. G4, G5, G6, G7, G8 and G10 are accepted as built, with reasons, in
the round-3 rulings. G11 is an open watch. **Tell me what those flags missed.**

## Where I most want you looking

1. **The two migrations.** 0091 and 0092 were applied twice each against postgres:16 by the Builder. Check
   idempotency the way a re-run in production would hit it, the `schema_migrations` self-record rows (91
   and 92), and whether 0092's new columns have a default or constraint that could bite a `bench_window`
   insert on the hot chunk path.
2. **C5's single statement.** It deletes segment rows, counts them, applies the zero-scored rule and writes
   the window. Prove the count and the ok/failed state cannot disagree, and find any path where the delete
   runs but the write does not.
3. **C6's cooldown.** Prove a refused window is genuinely skipped for the cooldown and genuinely returns
   afterwards — both halves (rule 7). Check the clamp at 5 and at 1440, and what happens to a window
   refused while the cooldown env var is garbage.
4. **C2's auth.** The POST is now cookie-only and refuses a `MIGRATION_SECRET`-only call. Prove the refusal
   is not universal — a real admin cookie must succeed — and that the actor reaching `actorProblem` is the
   admin id, not a label.
5. **C7's harness.** Bind parameters exposed a Neon array-literal difference. Look for any remaining place
   where the tests and the shipped driver disagree about how a value travels.
6. **Anything inert.** Is there a path here that cannot execute with default env — a flag read that throws,
   a selector clause that can never match, a test exercising a fake rather than the real function?

## Report

`docs/handoff/ETA-S1-FIX2-REFUTER-VERDICT-14-SEP-2026.md`, at most 500 words: overall PASS/FAIL · per
contract item · your quoted `tsc` and test output · every new finding with a `file:line` proof · what you
did not check.
