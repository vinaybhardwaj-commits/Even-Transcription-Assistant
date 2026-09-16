# ETA-E26 — the mutation and gate report owed from the E26 round · 16 Sep 2026 · Builder (Mac Mini)

This is the report owed from the E26 round (commits `3c896c3` and `445aec1`, now on `vinay/s1-auto-drain`
under the E16 merge `d861abf`). It is written late and from a NEW session: the session that did that round is
gone, so this document separates two kinds of statement and never mixes them.

- **MEASURED (this session, 16 Sep, main worktree at `d861abf`)** — the gate, re-run just now. Real numbers.
- **TRANSCRIBED (from the commit record)** — everything else. Quoted from `3c896c3` and `445aec1`, which are
  the only surviving record of that round. Not re-measured.

Nothing was fixed, committed, pushed, merged, promoted or applied here. No migration was applied. Per R30/R27
no Swift ran and none is cited.

## 1. Gate — MEASURED, this session, `d861abf`, Docker up, no exclusions

```
npm run typecheck    tsc --noEmit                      exit 0
npm test             Test Files 113 passed (113)
                     Tests     2726 passed (2726)      exit 0
npm run build        next build                        exit 0
npm run check:silent Found 9 silent-failure handler(s) exit 0   — the accepted 9, unchanged
```

The counts are HIGHER than the E26 commits record (2679, then 2680) because E16 merged on top of that line
this morning. They are the gate for the line as it stands, not for E26 in isolation; an E26-only gate would
need a checkout at `445aec1`, which no order names.

## 2. Mutation — TRANSCRIBED, and one number is NOT recoverable

**The caught-of-run tally for the E26 mutation run is not in the commit record and I will not invent one.**
`445aec1` refers to "the E26 mutation run" and reports two of its survivors; neither commit states how many
mutants were run or how many were caught. That session's scratch is gone. What the record DOES hold, verbatim
in substance:

| Mutant | Where | Outcome as recorded |
|---|---|---|
| `IS NOT DISTINCT FROM` → `=` in `repairStaleDiarizeSegments` | T4 | Survived the round's suite until pinned. "Nothing else in the suite failed under that change." Now caught: "under the `=` mutant it FAILS (expected false to be true, at the repair); on real code it PASSES." |
| `stale_segments_run_id` absent from the comparison tuple | R32 / M1 | "against this commit's parent's `store.ts` it FAILS (seg_A stays); with the fix it PASSES." |
| `AND d.state = 'ok'` dropped | R35 | "Both survived the E26 mutation run, each because no fixture reached it." Now caught: "under the `d.state = 'ok'` mutant the first assertion FAILS and passes on real code." |
| `AND d.segments_run_id IS DISTINCT FROM ${row.runId}` dropped | R35 | Survived for the same reason. Now caught: "under the IS DISTINCT FROM mutant the second FAILS and passes on real code." |

So four mutants are individually accounted for, two of them survivors that were subsequently killed by
`445aec1` rather than excused. The denominator is unknown. If the Orchestrator wants a real tally for E26,
the mutation set has to be rebuilt and re-run against `445aec1`; that is an order, not something to reconstruct
from prose.

## 3. What E26 proved, as its commits state it

- **T4** — a stale window whose mark is NULL is curable. `=` instead of `IS NOT DISTINCT FROM` makes every
  NULL-marked window permanently incurable, which is the straddle population E25 creates and the population
  R18's NO BACKFILL ruling depends on being curable.
- **R32 / M1** — a mark-only rewrite (same run, same state, same counts, different judged
  `segments_run_id`) used to write nothing, leaving the older mark. One mark permits exactly one repair
  (E25 R15), so a stale mark aims a cure at the wrong run.
- **T1** — `e25-deploy-order` applied 0097 and 0099 in one runner call and could therefore only prove "some
  migration is missing". Split into three, each withholding one migration against a schema holding the other.
- **T2** — the straddle test no longer shells out to `git show`; the pre-E24 upsert is committed as
  `tests/fixtures/pre-e24-diarize-window-insert.sql` and executed against the post-0099 schema.
- **R35's larger finding, quoted:** in a reversed deploy "the job cannot record its own failure: no failed
  row, no attempt counted, no error text ... The window looks untouched rather than broken."

## 4. Rule 21 — the limit E26 stated and did not resolve

The T4 chain runs score, re-diarize, mark, cure, rescore in one fixture. Three things it does not reach, as
recorded: the re-diarize step is an UPDATE clearing `segments_run_id` because no current code writes NULL
provenance; the cure calls `recordDiarizeWindow` and `repairStaleDiarizeSegments` directly, not through the
`diarize_window` JOB that calls them in production; and the emotion service is faked in both suites.

## 5. SQL and external-schema assumptions

None new here. This document runs no statement and asserts no schema; the assumptions of the E26 round are in
its own commits.

## 6. Anything V must run

Nothing. No migration, no manual step.

## 7. Subagents

None.
