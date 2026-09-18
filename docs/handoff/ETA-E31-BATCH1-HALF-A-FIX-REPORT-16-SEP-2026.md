# ETA-E31 batch 1, half A — FIX ROUND · Builder report · 16 Sep 2026 · worktree `-e31a`

Answering `ETA-E31-BATCH1-HALF-A-REFUTATION-16-SEP-2026.md` §4 and §6 (R60, R61). Tests only.

## 1. Commit

`18594fc` on `vinay/e31-atomicity-a`, parent `de50dd9`. Not pushed. Tree clean. **One file changed:**
`tests/unit/e31-atomicity-a.test.ts` (+175 −4). No cure changed, no production code, no migration.
`-e31b` and `-e31c` were not entered. Container `eta-c2-e2e-ec41e47576` belongs to another worktree and was
left alone.

## 2. Gate — Docker up, no exclusions

```
npm run typecheck    exit 0
npm test             Test Files 116 passed (116) · Tests 2784 passed (2784)   (2780 at de50dd9 + 4 drift tests)
npm run build        exit 0
npm run check:silent Found 9 — the accepted 9, unchanged
```
Per R30/R27 no Swift ran and none is cited.

## 3. R60 — the assertion now pins the run, and the bite is measured

`emotionRow()` reads `diarize_run_id`. The failure side asserts `run_old`; the success side asserts `run_new`.
The pair is what makes the first non-vacuous — had the row read `run_new` all along, "still the earlier run"
would have been true of nothing.

**The injection had to change for the bite to be provable.** It was `CHECK (state <> 'ok')`, which refuses
**any** update of that row, because Postgres re-checks a constraint on every updated row. A mutant moving only
`diarize_run_id` therefore died on the injection before the assertion was reached, and the only way past was to
change `state` too — which the **old** `state` assertion then caught instead, so the new field was never shown
to bite. It is now `CHECK (calls IS NULL)`: the seeded row has `calls` NULL and the finishing write sets it, so
it refuses exactly that write and nothing else. The assertions it guards are unchanged.

**Measured:**

| R60 mutant: `diarize_run_id` written by a separate statement before the CTE, touching nothing else | result |
|---|---|
| against the **new** assertion | **RED** — diff is exactly `run_old` → `run_new` |
| against the **`de50dd9`** assertion | **GREEN** — survives |

The bite belongs to this change. **R60b** (the finishing write no longer moving the row to the new run) is RED
on the success side.

## 4. R61 — the three copies, pinned by a rule read off the statements

**Not "the tuples must be identical."** They must not be, and correctly — each compares what its own statement
writes. `finishEmotionWindow` nulls `stale_segments_run_id` unconditionally; `writeNoSegmentsWindow` writes
`segments_planned/scored/failed` as the literal `0`, so comparing them would compare a constant with itself.
A sameness test would assert something false.

**Not a hand-written field list.** That is a fourth copy, and it drifts like the other three.

**The rule:** a `segments_*` column is in a copy's comparison tuple **if and only if** its value in that
statement is not a literal constant. A computed value can contradict what is stored, so it must be compared; a
literal `0` cannot, so comparing it is noise. Verified to hold for all three today before it was written:

| copy | `segments_*` values | compared |
|---|---|---|
| `recordEmotionWindow` | planned = param; scored/skipped/failed/unscorable = `CASE … seg.X …` | all 5 |
| `finishEmotionWindow` | planned = param; the rest = `v.X` | all 5 |
| `writeNoSegmentsWindow` | planned/scored/failed = `0`; skipped/unscorable = `counted.X` | skipped, unscorable |

The test parses each copy's INSERT column list, pairs it positionally with the value list (asserting the
counts line up: 19/19, 18/18, 13/13), reads the tuple off both sides of `IS DISTINCT FROM`, and checks **both
directions**. Three more assertions: both sides of every tuple name the same fields in the same order; all
three open with the same two escape hatches (a stored `failed` row, another diarize run); and there are exactly
**four** writers of the table, so a new copy cannot appear without this test learning of it.

## 5. The three drop-a-field mutants — reproduced as they survived

**Both sides dropped, arity intact.** A one-sided drop mismatches the tuple's arity and Postgres throws at
runtime — caught by accident, and saying nothing about drift. **My first pass made exactly that mistake**: all
my R61 mutants were one-sided, and R61a went red on the A2 *database* test, not the drift test. Re-run
both-sided, each anchor the whole two-sided tuple and asserted unique:

| mutant | Refuter | now | caught by |
|---|---|---|---|
| `finishEmotionWindow` loses `segments_unscorable` | SURVIVED | **RED** | the new rule |
| `writeNoSegmentsWindow` loses `segments_unscorable` | SURVIVED | **RED** | the new rule |
| `recordEmotionWindow` loses `stale_segments_run_id` | CAUGHT | **RED** | E26 R32 (see §6.1) |

## 6. Flagged, not decided

1. **`stale_segments_run_id` is not governed by the new rule, only by E26 R32's behavioural test.** The rule
   covers the segment counts. Extending it to every column would need a list of the fields each copy
   deliberately leaves out (`calls`, `warmup_json`, `timing_json`) — a hand-written list, which the order
   forbade. That field stays caught, but by a different test; if the Orchestrator wants it under the drift
   test too, that is a decision about accepting an exclusion list.
2. **The A2 injection changed shape** (`state <> 'ok'` → `calls IS NULL`), for the reason in §3 and no other.
   Named because a refuter comparing against `de50dd9` will see it.
3. **The Refuter's §1 (A12 against D-5) and §2 (the narrow write dying on a `diarize_stale` row) are
   untouched.** Both are cure changes, which this order put out of scope, and §11 of the refutation puts both
   before the Orchestrator. Nothing here pre-empts either ruling.

## 7. Mutation check

**7 caught of 7 run. No survivors. No equivalents.** Six suites, baseline **132**.

R60 the new run's id landing alone · R60b the finish not moving the row · R61A/R61B the Refuter's two
survivors · R61C the Refuter's caught one · R61D `recordEmotionWindow` loses `segments_unscorable` ·
R61E `writeNoSegmentsWindow` **gains** a literal constant on both sides, the "only if" direction.

Rule 22: every anchor asserted to match exactly once — one that matched twice (an 11-space line that is a
substring of a 13-space one) was reported **VOID** and re-anchored rather than counted; sha256 before and
after; every file verified restored; no container of mine left.

## 8. SQL and schema assumptions

None new. The only SQL added is test DDL against an ephemeral container:
```sql
ALTER TABLE room_emotion_window ADD CONSTRAINT e31_refuse_ok CHECK (calls IS NULL) NOT VALID;
```

## 9. Manual steps for V

None.

## 10. Subagents

None.
