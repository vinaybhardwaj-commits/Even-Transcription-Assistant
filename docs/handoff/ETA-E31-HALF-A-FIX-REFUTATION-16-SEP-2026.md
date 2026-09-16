# ETA-E31 — Batch 1, half A FIX ROUND (R60, R61) · REFUTATION · 16 Sep 2026 · Opus Refuter

Target `-e31a`, branch `vinay/e31-atomicity-a`, HEAD **`18594fc`**, parent `de50dd9`. Tree clean at start and end.
Delta `de50dd9..18594fc`: one file, `tests/unit/e31-atomicity-a.test.ts` (+175 −4). `lib/`, `app/`, `db/` are
byte-identical to `de50dd9` (checked with `git diff --quiet`), so the A1/A2/A12 cures I cleared are the code
under test. I fixed nothing, committed nothing, pushed nothing, applied no migration outside an ephemeral
container. `-e31b` and `-e31c` were only read (`git log`, `git show`, `git status`). No Swift.

## VERDICT

| item | verdict |
|---|---|
| **R60** — A2 asserts `diarize_run_id`; the injection changed | **PASS.** The changed injection is honest and measured. It trades one blind spot for another, and neither blocks the merge. |
| **R61** — the drift test | **PARTIAL.** It pins the `segments_*` columns and nothing else. Two whole-tuple drifts outside that class **survive all 2784 tests**. The rule's stated reason is false. A stronger single rule exists and I measured that it holds today. |
| `stale_segments_run_id` (my finding) | **Still caught** at `18594fc`, by E26 R32 only. |

Nothing in this delta must be fixed before the merge. R61's gap is a test gap on code that is correct today. It
is the same class as my `de50dd9` §6 finding, now smaller.

---

## 1. THE CHANGED INJECTION — `CHECK (state <> 'ok')` → `CHECK (calls IS NULL)`

**It fires at the same moment, against the same write.** I changed the test's `rejects.toThrow()` to
`rejects.toThrow(/e31_refuse_ok/)`. It stays GREEN under the new injection (I2) and under the old one (I3). So in
both cases the real code is refused by the injected constraint itself, not by some other error, and the refusal
lands on the finishing statement. That statement is the only write to `room_emotion_window` while the
constraint exists: it is added after both `writeSpans` calls and dropped before the success half.

**It does not weaken what the original was testing.** The real code under the OLD injection with the NEW
assertions is GREEN (I1). The S2 split (the delete moved to its own statement before the CTE) is **RED under
both** injections, and it fails on the same assertion, `expected ['run_new'] to deeply equal ['run_new','run_old']`
(P1). **No other assertion depends on the old constraint.** `e31_refuse_ok` appears only in A2, and it is added
and dropped inside that one test. A1's injection is a separate one, on `room_span_emotion`.

**The builder's two claims reproduce exactly:**

| R60 mutant: a separate `UPDATE … SET diarize_run_id` before the CTE | result |
|---|---|
| new injection, new assertion | **RED** — `expected {… state:'ok' …} to match { … diarize_run_id:'run_old' }` |
| **old** injection, new assertion | **GREEN.** The old CHECK refused the pre-write, so the assertion never saw it. |
| new injection, **`de50dd9`** assertion | **GREEN.** The bite belongs to the new assertion. |

**Where the new injection is weaker, measured.** Any CHECK keyed on a value is blind to a split pre-write that
sets the column it keys on. The old CHECK keyed on `state`; the new one keys on `calls`.

| P6: a separate pre-write setting `calls`, `state='failed'`, `error` before the CTE | result |
|---|---|
| **old** injection | **RED** |
| **new** injection | **GREEN — survives** |

So the new injection catches pre-writes that move the run, the state or the counts without telemetry. Those are
the realistic splits, and the old injection missed them. It misses a pre-write that carries `calls`, which the
old one caught. That is a trade, not a weakening of the realistic case.

**A gap the change did not create, and neither injection closes (P3).** Reverse the split: write the window row
first and delete the other run's spans in a second statement after it. That is **GREEN under both
injections**. Both injections refuse only the *row* half, so the order where the row lands and then the delete
dies is never exercised. Its outcome is lingering old-run spans under a correct row. That is garbage, not a lie,
because every count filters by `diarize_run_id`. Closing it would take a second injection on the delete side
(a `BEFORE DELETE` trigger on `room_span_emotion`). This is a batch-2 test item, not a blocker.

## 2. THE DRIFT RULE, NOT THE DRIFT TEST

**Is it the property?** No. It is the `segments_*` projection of the property. The property is: *every column
the upsert sets from `EXCLUDED` that is not per-run telemetry or write bookkeeping is compared.* The rule
governs 5 columns of `recordEmotionWindow`'s 13-column tuple. Of the other 8, it asserts only that `state` comes
first. `error`, `model`, `model_key`, `subfolder`, `cap_s`, `room_day_id` and `stale_segments_run_id` are
ungoverned. It pins the class of mutants the Refuter happened to choose (`segments_unscorable`), not the property.

**Its stated reason is false.** "A literal cannot contradict what is stored, so comparing it is noise." A
literal is constant for *this writer*, but the stored row may have come from *another* writer. The proof is in
the code: `writeNoSegmentsWindow` writes `state` as the literal `'no_segments'` and **correctly compares it**. A
literal `segments_planned = 0` is safe to leave out only because `state` is compared and today only this writer
produces `no_segments`. `recordEmotionWindow` is called only with `failed` (`lib/jobs/kinds/emotion-window.ts:98`)
and `diarize_stale` (`store.ts:368`). The rule is right for the wrong reason, and its scoping to `segments_*` is
what keeps it from tripping over `state`.

**Breaks, every one both-sided with the arity intact. Six suites, baseline 132. Survivors re-run against the
full suite:**

| mutant | result | caught by |
|---|---|---|
| `finishEmotionWindow` drops `segments_skipped` (control) | RED | the rule |
| **computes and does not compare:** `writeNoSegmentsWindow` computes `segments_failed` (was literal `0`), tuple unchanged | RED | the rule |
| **compares a literal:** `writeNoSegmentsWindow` compares `segments_failed` (literal `0`) | RED | the rule |
| `finishEmotionWindow` drops `subfolder` | RED | S1 C16 behavioural test, not the rule |
| `finishEmotionWindow` drops `room_day_id` | RED | S1 C16 behavioural test, not the rule |
| **`writeNoSegmentsWindow` drops `cap_s`** | **GREEN — 2784/2784** | nothing |
| **`recordEmotionWindow` drops `error`** | **GREEN — 2784/2784** | nothing |
| compares a non-segments literal: `writeNoSegmentsWindow` compares `calls` (`0`) | GREEN — 2784/2784 | nothing (harmless: comparing telemetry) |
| lexical hole: `0` → `0::int` for `segments_planned`, not compared (same SQL meaning) | RED | the rule — a **false alarm** on a no-op edit |
| lexical hole: `0::int` **and** compared | GREEN | nothing — a literal the rule reads as computed |

Both of the order's breaks, inside `segments_*`, are caught. **Outside `segments_*`, two copies can still drift
with the whole suite green.** `writeNoSegmentsWindow` is one of them again. The literal test is lexical: it
reads `0`, `NULL`, `NULL::type` and quoted strings as literals, and nothing else.

**The stronger rule exists and holds today — measured, not asserted.** I read each copy off the committed blob:
`SET col = EXCLUDED.col`, minus one fixed policy set `{calls, warmup_json, timing_json, scored_at, diarize_run_id}`,
minus literal-valued columns other than `state`. That yields **exactly** each tuple:

- `recordEmotionWindow`: 13 = 13, including `stale_segments_run_id`
- `finishEmotionWindow`: 12 = 12
- `writeNoSegmentsWindow`: 4 + `state` = 5

The builder refused an exclusion list as "a fourth copy". That conflates two lists. A list of fields *to compare*
is per-copy, and it drifts. A list of fields *never compared* is one policy shared by all three copies. It is
already written verbatim at `store.ts:333-338` ("NOT COMPARED, each on purpose"), and it changes only when the
policy does. That rule would catch both surviving mutants and would govern `stale_segments_run_id` (§3). This is
a decision for the Orchestrator, named and not chosen.

## 3. `stale_segments_run_id` — STILL CAUGHT, BY ONE TEST

At `18594fc`, drop it from `recordEmotionWindow`'s tuple on both sides: **RED**, 1 failure. The failure is
`s1-emotion-zero-scored.test.ts` → "E26 R32 on Postgres — a MARK-ONLY rewrite lands: same run, same state, a
different judged segments_run_id". Its message is "the mark is the only thing that changed, and it is the thing
that must be right". The drift test does not see it. If that one test goes, nothing replaces it. The §2 policy
rule would.

## 4. THE TWO CARRIED CURE FINDINGS — RE-STATED, NOT FIXED

Code is byte-identical to `de50dd9`, so my measurements there stand.

1. **A12 against D-5:** close and enqueue in one CTE means a refused enqueue rolls back the close. The window
   stays `open`, `countRoomWaitingWindows` reads 0, and the admin run-waiting recovery cannot see it, where the
   old shape left it `closed`, counted and one click from recovery. **Confidence: high** (measured). Addendum 1
   says a site that fails D-5 "does not get a CTE", so as built A12 contradicts the PRD's own rule.
2. **The narrow failure write dies on a `diarize_stale` row:** it sets `state='failed'` and leaves
   `stale_segments_run_id` set, so 0099's `room_emotion_window_stale_segments_chk` refuses it, the attempt is not
   counted, and `emotion_bookkeeping_failed` is thrown. **Confidence: high** (measured verbatim at `de50dd9`). It
   is **not a regression** against `64ce357`, which had no fallback and lost the attempt the same way. It is an
   incomplete cure, and the fat write must also fail on a stale row for it to trigger.

## 5. MUTATION RUN — MINE

Harness: each anchor asserted to match exactly once (VOID otherwise), sha256 before and after, files restored
and verified after every mutant, `git status` clean at the end. Six suites (`e31-atomicity-a`,
`e31-a1-bookkeeping-survives`, `s1-emotion-zero-scored`, `e16-emotion-speech-fraction`, `c3-emotion`,
`bench-window`), **baseline 132/132**, matching the builder.

**20 mutants run, 11 RED, 9 GREEN.** Three validity checks (I1–I3) are extra, all GREEN as intended.

- **RED (11):** P1, P1+old-injection, P2 (R60), P6+old-injection, subfolder, room_day_id, segments_skipped,
  computes-not-compares, compares-literal, `0::int`-only (a false alarm on a no-op), R32.
- **GREEN, confirming claims (2):** P2+old-injection (the old injection masked it) and P2+`de50dd9`-assertion
  (the bite belongs to the new assertion).
- **GREEN, real gaps (6):** P3 under both injections, P6 under the new injection, `cap_s` drift, `error` drift,
  `0::int`+compared.
- **GREEN, harmless (1):** comparing literal `calls`.

**Equivalents:** the `0::int` pair is semantically a no-op in SQL. Named, not counted as a defect.

**One VOID, re-run:** my first P6 pre-write set `state='failed'` without `error`. 0099's error CHECK refused it,
so it went RED by a psql crash, not an assertion. It was discarded and re-run with `error` set.

## 6. GATE — RUN MYSELF AT `18594fc`, DOCKER UP, NO EXCLUSIONS

```
npm run typecheck        exit 0
npm run typecheck:tests  exit 0
npx vitest run           Test Files 116 passed (116) · Tests 2784 passed (2784)
npm run build            exit 0
npm run check:silent     Found 9 — the accepted 9, all outside the contract (app/[slug]/api/encounters/…, NoteComposerClient.tsx)
```

This reproduces the builder's gate exactly. No containers of mine are left running.

## 7. THE WHOLE-BATCH ANSWER

**Merge mechanics: clean.** The three branches touch disjoint files. `git merge-tree --write-tree` of `-a`, then
`-b`, then the harness onto `vinay/s1-auto-drain` (`64ce357`) has no conflicts, final tree `defb94c`. To chain
the probe I created two unreferenced commit objects with `git commit-tree`. No ref moved, nothing is reachable
from any branch, and `gc` will drop them.

**Merged tree gated, in a non-git export under my scratchpad:** typecheck 0, tests typecheck 0, build 0,
check:silent the accepted 9. vitest: 2784 passed, 10 failed. **All 10 are export artifacts.** The identical 10
tests (tree sweeps, identity guards, the git-top-level check) fail in a non-git export of `18594fc` alone, which
is 2784/2784 in its real worktree. The merged run adds **zero** failures, and both exports lose the same 18
git-dependent tests. Every E31 DB test passes through the new harness chooser: A1, A2, A12, A4, D3/R58. The
Orchestrator's planned `--no-ff` merge-commit gate in a real checkout is still the proof. This is a preview of it.

**What must be settled before the merge:**

1. **A12 (`-a`) — fix or explicitly except.** By Addendum 1's own words, a site that fails D-5 does not get a
   CTE. Merging it as-is is a knowing exception to D-5 that the Orchestrator must own in writing. Otherwise A12
   goes back to two statements with a loud log before the merge. It is not data loss, and it self-heals on the
   next chunk. The PRD, not I, makes it a rule question.
2. **`2cfbbe7` (`-b` fix round) is not covered by any refutation of mine.** My half-B refutation was of
   `b04d213`. `2cfbbe7` changes access behaviour at `app/api/auth/pin/route.ts`: a correct pin is now **refused**
   (PIPELINE_FAILED) whenever the clinician reset cannot be written, so nobody signs in while clinician writes
   fail. That fails closed, as I asked, but it is an availability change at the one site the PRD calls a security
   outcome. Reading the diff, I found nothing wrong: the attempt INSERT is its own statement again,
   `not_recorded` on both a throw and zero rows, the reset refused before `signDoctorJwt`, the R59 guard checks
   `!row`, and the intent line carries `visit_id`, `action` and `post_close` only. A read is not a refutation. It
   should be refuted, or its route change confirmed as ordered, before it merges.
3. **`b29d9af` (harness) is not covered by any refutation of mine either.** It is test infrastructure only, and
   the merged-tree run above is evidence that it does not break A's or B's DB suites. It is not a refutation of
   the chooser itself.

**Not blocking:** R61's non-segments drift gap (§2), the P3/P6 injection blind spots (§1), and the narrow write
on `diarize_stale` (§4.2, not a regression). All three are batch-2 items.

## 8. SQL AND EXTERNAL-SCHEMA ASSUMPTIONS — INFERRED, VERBATIM

None new. Test-only DDL and DML, all against ephemeral postgres:16:
```sql
ALTER TABLE room_emotion_window ADD CONSTRAINT e31_refuse_ok CHECK (state <> 'ok') NOT VALID;   -- I1/I3 and "+old" mutants
UPDATE room_emotion_window SET diarize_run_id = ${f.diarizeRunId}::text WHERE window_id = ${f.windowId}::text;   -- P2
UPDATE room_emotion_window SET calls = ${f.calls}::int, state = 'failed', error = 'mutant' WHERE window_id = ${f.windowId}::text;   -- P6
```
Relied on, from the migrations: `room_emotion_window_error_chk` as 0099 rewrites it,
`CHECK ((state IN ('failed','diarize_stale')) = (error IS NOT NULL))`, which is what voided my first P6; and
`room_emotion_window_stale_segments_chk` (0099:60-61), which §4.2 turns on.

## 9. WHAT I DID NOT DO

- I did not re-attack the A1/A2/A12 cures (out of scope). I did not refute `2cfbbe7` or `b29d9af` (not ordered;
  §7 says so).
- I did not run the merged gate in a real git checkout, because that would need a worktree or a merge. The
  artifact explanation is measured, not assumed.
- No Swift (R30/R27). No subagents.
