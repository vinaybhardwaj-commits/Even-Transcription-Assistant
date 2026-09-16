# ETA-E16 tip fix — Refutation of 3c896c3 (E26) and 445aec1 (E26 R35) · 16 Sep 2026 · Refuter (Builder pane)

Worktree `-e16`, branch `vinay/e16-emotion-speech-fraction`, HEAD `445aec1`, parent `3c896c3`. I raised T4 and M1 on
this line; I did not build the fixes and I reran everything. Work was done in a read-only `git clone --shared` of the
worktree at `445aec1`; per R40/R33 this report is on the bus in the main worktree. Nothing was fixed, committed,
pushed, merged or promoted; migrations ran only in ephemeral postgres:16 containers (Docker 29.8.0 — it was upgraded
from 29.7.2 during this session). Per R30/R27 no Swift ran and no Swift build is cited.

## 1. Verdicts

| Commit | Verdict |
|---|---|
| **3c896c3** — the NULL mark is curable, the mark-only rewrite lands, the deploy order proven one migration at a time | **MERGE-READY** |
| **445aec1** — assertions for the repair's last two guards | **MERGE-READY** |

**The branch is clear to merge into `vinay/s1-auto-drain`**, with R20's condition binding at the merge: **0097 and
0099 must both be applied before this code deploys**, and §2 is why that is not a preference.

## 2. The invisible break — verified independently, and it is TRUE

I reproduced it with my own probe rather than reading the Builder's test: a 0099-applied, **0097-withheld** schema, a
healthy window whose one span falls under `min_speech_s`, driven through `emotionWindowKind.run`. The two database
errors, in order, and the aftermath:

```
REFUTER E26-ERROR-ORDER ["ERROR:  column \"speech_ms\" of relation \"room_span_emotion\" does not exist",
                         "ERROR:  column \"segments_unscorable\" of relation \"room_emotion_window\" does not exist"]
REFUTER E26-INVISIBLE {"escaped_error":"…segments_unscorable…","kind_outcome":null,
                       "emotion_window_rows":0,"span_rows":0,"bench_window_state":"transcribed"}
```

The span write dies on `speech_ms`; the window write the job then attempts as failure bookkeeping dies on 0097's
**other** column and escapes the kind; no emotion window row is written, no span row, and the window is left exactly
as it was. **In a reversed deploy the job cannot record its own failure, and the window looks untouched rather than
broken.** The Builder's load-bearing sentence stands as written. It is stronger than "the order must be right": the
failure is silent, so a reversed deploy would present as an idle emotion pipeline, not a failing one.

## 3. Findings

- **T4 is dead.** The `=` mutant now fails, and it fails **exactly one test** — the new fixture — which is precisely
  the Builder's claim that nothing else in the suite sees it. Both E26-4 (`d.state = 'ok'` dropped) and E26-6
  (`segments_run_id IS DISTINCT FROM runId` dropped) are caught too; those were equivalents in my last pass.
- **The T4 fixture is a real chain, with one simulated step, and the Builder's three qualifications are accurate.**
  Score, mark and rescore all run through the emotion kind; only the provenance-losing re-diarize is an `UPDATE`
  (no current writer produces NULL provenance, and the pre-E24 statement that does is executed in the straddle test
  on another window). The cure calls `recordDiarizeWindow` and `repairStaleDiarizeSegments` directly.
- **The residual I would record for the next round:** the NULL-mark cure is never exercised through the
  `diarize_window` job. c2's job-level cure seeds `segmentsRunId: "run_older_bw_emo_once"` — a non-NULL mark — so the
  composition "job → record → repair" is proven only for marks that are not NULL, while the population that matters
  for R18's no-backfill ruling is exactly the NULL-marked one. Not a defect; a gap in where the proof sits.
- **The four deploy-order tests each prove their own break, by a distinct column name.** 0099-withheld asserts three
  different messages (`room_diarize_window.segments_run_id` on the INSERT, `d.segments_run_id` on the prepare SELECT,
  `room_emotion_window.stale_segments_run_id` on the window write) and that 0099 **alone** fixes all three;
  0097-withheld asserts `speech_ms` then `segments_unscorable` and that 0097 **alone** fixes it; the straddle asserts
  NULL provenance and R17's text. No two pass for the same reason.
- **The fixture replacing the git reach-back is faithful.** I compared
  `tests/fixtures/pre-e24-diarize-window-insert.sql` with `a05d750:lib/stt/diarize-window.ts` mechanically: after
  normalising `${…}` interpolations and `:placeholders`, the two statements are **identical**. T2's clone-depth
  dependency is gone, and the fixture is executed rather than grepped, which is the stronger proof.
- **Nothing will detect future drift of that fixture** — the whole point of removing the reach-back. My drift mutant
  is caught only because it makes the SQL invalid; a drift that stays valid and still lands NULL would pass. The
  header's "DO NOT UPDATE THIS FILE" is the only guard, and that is the right trade for clone-independence, but it
  should be a known one.
- **R32's extra write is safe.** A mark-only rewrite now lands. Its only observable effects are the mark itself and
  `scored_at`; `attempts` does not move (E24 R8's `diarize_stale` arm precedes the run-id arm), `failure_history`
  appends only over a stored `failed` row, and `room_emotion_window.scored_at` has no reader anywhere in `lib` or
  `app` outside `store.ts` (the `scored_at` hits elsewhere are `transcription_run.metrics_json`). I could not
  construct a case where the extra write is wrong.
- **Gate reproduces the claim exactly:** typecheck 0, `Tests 2680 passed (2680)` across 112 files with Docker up and
  no skip variable, build 0, check:silent the accepted 9.

## 4. Mutation check: 12 caught of 12 run

Four suites per mutant (s1-emotion-zero-scored, e25-deploy-order, e16-emotion-speech-fraction, c2-e2e-runner — the
last two on real Postgres), baseline 115 of 115. Each mutation was applied by an exact string matched once and
restored under a sha256 check.

**Caught (12):** E1 R32 reverted (the mark leaves the tuple) · E2 an asymmetric tuple (24) · **T4 the mark matched
with `=`** · E4 the mark clause dropped (2) · **E26-4** `d.state = 'ok'` dropped · **E26-6** the IS DISTINCT guard
dropped · K1 the repair adopts a non-ok run (2) · E8 the mark never recorded (5) · E9 the finish stops clearing it ·
E10 0099's CHECK dropped · E11 the job marks against `last_run_id` (6) · E12 the pre-E24 fixture drifts.

**No survivors. No equivalents.** The three that survived my previous pass on this line — T4, E26-4 and E26-6 — are
all dead, and I killed each myself rather than taking the commit message's word.

## 5. Anything unrun
- Swift: not run, not cited (R30, R27). No Swift file is touched.
- 0097 and 0099 applied only inside ephemeral containers; both remain committed and unapplied.
- R18's backfill counts and R24 were not re-measured: this pane has no live database.
- I did not look at 0d21596 (scribe's R31 fix in -e18), as the brief directs.

## 6. Scratch evidence (session scratchpad, not committed)
`e16fix2/test-full.log`, `typecheck.log`, `silent.log`, `build.log`, `baseline.log`, `mutate.mjs`,
`mutation-results.json`, and the probe `tests/unit/zz-refuter-e26.test.ts` (the invisible break), which exists only
in the clone.

## 7. Subagents
None.
