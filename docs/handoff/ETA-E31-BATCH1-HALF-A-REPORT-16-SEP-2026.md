# ETA-E31 batch 1, half A — Builder report · 16 Sep 2026 · worktree `-e31a`

Sites A1, A2, A12 from `ETA-E31-ATOMICITY-PRD-16-SEP-2026.md`. All three built.

## 1. Commit

`de50dd9` on `vinay/e31-atomicity-a`, parent `64ce357`. Not pushed. `main` untouched. Tree clean, no
containers left. No migration added; none applied outside ephemeral `postgres:16`.

## 2. Gate, at the committed tree state, Docker up, no exclusions

```
npm run typecheck    tsc --noEmit                       exit 0
npm test             Test Files 116 passed (116)
                     Tests     2780 passed (2780)       exit 0   (2774 at 64ce357 + 6 new)
npm run build        next build                         exit 0
npm run check:silent Found 9 silent-failure handler(s)  exit 0   — the accepted 9, unchanged
```

Per R30/R27 no Swift ran and none is cited. R44 observed.

## 3. Files changed

```
 lib/bench-window.ts                            |  72 +++--
 lib/emotion/store.ts                           | 391 +++++++++++++++++++++----
 lib/jobs/kinds/emotion-window.ts               | 104 +++++--
 tests/unit/e16-emotion-speech-fraction.test.ts |  51 +++-
 tests/unit/e31-a1-bookkeeping-survives.test.ts | 153 ++++++++++ (new)
 tests/unit/e31-atomicity-a.test.ts             | 255 ++++++++++++++++ (new)
 tests/unit/s1-emotion-zero-scored.test.ts      |  11 +-
```

Nothing outside the file list moved. No file belonging to the other half of this batch was touched.

## 4. Cure shape per site

| site | shape | one statement? |
|---|---|---|
| **A1** spans | `writeSpans` — ONE multi-row insert, rows carried as a single jsonb array through `jsonb_to_recordset`, so the statement text does not vary with batch size | yes |
| **A1** `no_segments` | one CTE: delete other runs → insert the spans → write the window row, its counts taken FROM the rows just inserted | yes |
| **A1** `fail()` | one statement (`recordEmotionWindow`), and on throw a strictly NARROWER one (`recordEmotionFailureNarrow`) | **see §7.1** |
| **A2** | the delete moves into `finishEmotionWindow`'s existing CTE, scoped to other runs | yes |
| **A12** | one CTE: guarded close → `stt_subject_job` insert SELECTing FROM the close's RETURNING | yes |

**The one thing that is NOT one statement, and why.** The PRD's A1 says the span insert and the
`room_emotion_window` row become one CTE. That is done on the `no_segments` path, which is terminal and whose
two writes are adjacent. It is **not possible on the scoring path**: the spans are written in the `score`
step, once per service call, and the window row is written in `finish` after every batch has been scored.
`SEGMENTS_PER_CALL` is 16, so a real window is several batches, and between them the job makes an HTTP call
to the emotion service and branches on the answer. That is `[interleaved]` in the PRD's own terms — the
driver's transaction form allows no application logic between statements, and collapsing the steps would
change the job machine's observable shape (step names, persisted progress, the lease budget). Per PRD §5 that
is a design decision and not the builder's, so **it is flagged here, not decided**. What IS delivered on that
path: each batch lands whole or not at all, and the window row is written by a statement that counts the rows
rather than trusting a remembered number.

## 5. The split-the-CTE mutant, per site

The PRD's bar: if splitting the statement keeps the suite green, nothing has been pinned.

| mutant | result |
|---|---|
| **S1** A1 — the span batch split back into one statement per row | **RED** |
| **S2** A2 — the delete pulled out of the finishing statement into its own | **RED** |
| **S3** A12 — the close and the enqueue split back into two statements | **RED** |

## 6. Failure injection, per site

Failure is injected with a CHECK constraint or a foreign key, never by mocking the driver: Postgres refuses
the statement mid-flight, which is what a missing column or a bad value does in production. A mocked
rejection would prove only that the mock rejected.

- **A1** — one row in a batch of four names a window that does not exist. The insert is refused and the
  database keeps **none** of the three good rows. The same batch without the bad row lands whole, so the
  assertion is about atomicity and not about the rows being unwritable.
- **A1 double failure** — a database with **0097 withheld**, which is the deploy that happened. Measured:
  the span write dies on `speech_ms`, the fat record dies on `segments_unscorable`, and the narrow write
  records the failure and counts the attempt anyway. `attempts` goes 1 then 2 across two runs, so
  `EMOTION_MAX_ATTEMPTS` is reachable instead of infinite. Both causes are on the row.
- **A2** — the window-row half of the finishing statement is refused. The earlier run's spans **survive**,
  and the window still reads as that earlier run. Lift the refusal and the same call deletes the old run and
  records the new one together (`spans_removed: 1`).
- **A12** — the enqueue is refused. `closed` is 0 and every window is still `open` — closed-and-unqueued is
  unreachable. Lift the refusal and the same tape closes and queues together.

## 7. Flagged, not decided

1. **`fail()` is one statement plus a narrower retry of the same effect, not one statement alone.** The PRD
   says one statement; the order adds "test that exact double failure and assert the attempt is still
   counted". Those two cannot both hold with a single statement: a bookkeeping write that shares the primary
   write's column surface dies of the primary write's cause — that is not bad luck, it is the same statement
   wearing a different name, and it is precisely what happened under 0097. So the fat write is tried first
   (full fidelity: counts, model, cap, warm-up) and, only if it throws, a narrow one touching **only columns
   0089 created with the table**. They are alternatives, not a sequence; each is atomic; nothing is left half
   written by choosing between them. Mutant S7 (widening the narrow write back to the fat surface) is RED.
   **If the Orchestrator wants strictly one statement, the attempt cannot be counted in the proven case.**
2. **A2 forced `ON CONFLICT DO NOTHING` → `DO UPDATE` on the span insert.** Not a choice: with the delete
   moved to finish, a retry of the same diarize run now meets its own previous attempt on the same key, and
   `DO NOTHING` would drop the new answer and count the stale one — the exact defect S1 FIX2 introduced the
   delete to fix. Mutant S8 is RED. Flagged because it is an observable behaviour change the PRD did not
   name.
3. **The `no_segments` path also carries the delete.** It is terminal and never reaches finish, so without it
   a window could end there still holding another run's spans — which the old `prepare` delete prevented.
   This preserves existing behaviour rather than changing it, but the PRD named only `finishEmotionWindow`.
4. **A third copy of the window-row conflict rule now exists** (`recordEmotionWindow`, `finishEmotionWindow`,
   `writeNoSegmentsWindow`). The module already carries a "keep the two in step" note; it is now three. Not a
   defect today, and a real drift risk. Named for batch 2.
5. **Residual A2 edge, not closed.** The finish delete is scoped to *other* diarize runs. If a retry of the
   SAME run plans a different chunking — only reachable if `cap_s` changed between attempts — rows of that
   run written by the earlier attempt under the old chunking are not removed by key and would be counted.
   Closing it needs a per-attempt marker on the row, which is a new column, which the order forbids. The old
   `prepare` delete removed them; this is the one thing the move gives up. **Flagged rather than fixed.**
6. **DEFERRED AND ACCEPTED, as the order states:** the enqueue scan still cannot detect an `ok` row over a
   disagreeing span count. Not fixed here.

## 8. Mutation check

**10 caught of 10 run. No survivors. No equivalents.** Six suites (`e31-atomicity-a`,
`e31-a1-bookkeeping-survives`, `s1-emotion-zero-scored`, `e16-emotion-speech-fraction`, `c3-emotion`,
`bench-window`), baseline **128 of 128**. Rule 22: each mutation an exact string matched once, sha256 before
and after, every file verified restored, no container left.

S1/S2/S3 the three mandated splits · S4 the enqueue no longer fed by the close · S5 the narrow fallback
removed · S6 the narrow write not counting the attempt · S7 the narrow write widened to the fat surface ·
S8 the conflict back to `DO NOTHING` · S9 the finish delete widened to every run · S10 the `state = 'open'`
guard dropped.

## 9. Tests whose assertions changed, and why

Two, both because A2 changed what is true. **No assertion was weakened.**

- `s1-emotion-zero-scored` **C9**: a re-run that fails at `warm` used to leave the window with nothing,
  because `prepare` had already deleted every span for a run that then produced none. It now leaves the
  settled run's rows in place with the row saying `failed` over them, and the counts describe the rows that
  are actually there. The new assertion states that and says why.
- `e16-emotion-speech-fraction`: the spy moves from the single-row writers to the **row builders**, which
  take exactly the arguments the old writers took and are called once per span exactly as they were; the db
  mock unpacks a batched insert into **one entry per row**, because what those cases assert is rows, and the
  one-statement-per-row shape was incidental. The `no_segments` write is recorded in the same shape it had.

## 10. Two harness hazards found in passing, both worth the record

- **An apostrophe in a SQL comment breaks `tests/support/pg-harness.ts`.** Its literal scanner does not skip
  `--` comments, so one apostrophe puts it inside a string for the rest of the statement, it cannot find the
  final SELECT, and it wraps a data-modifying CTE inside another `WITH` — which Postgres refuses outright.
  The existing SQL comments in `store.ts` avoid apostrophes; I introduced three and the `c2-e2e-runner`
  suite went red with `WITH clause containing a data-modifying statement must be at the top level`. Removed,
  and a comment at the statement says why. **Any future one-statement cure in this repo will hit this.** The
  harness itself is outside my file list and was not touched.
- **`check:silent` reads comments.** A comment quoting the old `try { } catch { }` counted as a tenth silent
  handler. Reworded.

## 11. SQL and external-schema assumptions — VERBATIM, all INFERRED (no live database here)

**a. The span insert (A1)** — one bound jsonb array, unpacked:
```sql
INSERT INTO room_span_emotion (window_id, …, speech_ms, service_speech_ms, speech_basis, scored_at)
SELECT r.window_id, …, ARRAY(SELECT jsonb_array_elements_text(r.source_refs)), …, NOW()
  FROM jsonb_to_recordset($1::jsonb) AS r(window_id text, …, speech_basis text)
ON CONFLICT (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx) DO UPDATE SET …
RETURNING window_id
```
**b. The finish delete (A2)**, first CTE of the existing finishing statement:
```sql
gone AS (
  DELETE FROM room_span_emotion
   WHERE window_id = $1::text AND diarize_run_id IS DISTINCT FROM $2::text
  RETURNING 1
)
```
and the final SELECT gains `(SELECT count(*)::int FROM gone) AS spans_removed`.

**c. The narrow failure write (A1)** — only columns 0089 created:
```sql
INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id, error, scored_at)
VALUES ($1::text, $2::text, 'failed', $3::text, $4::text, NOW())
ON CONFLICT (window_id) DO UPDATE SET
  room_day_id = EXCLUDED.room_day_id, state = EXCLUDED.state, error = EXCLUDED.error,
  scored_at = EXCLUDED.scored_at,
  attempts = CASE WHEN room_emotion_window.diarize_run_id = EXCLUDED.diarize_run_id
                  THEN room_emotion_window.attempts + 1 ELSE 1 END,
  failure_history = CASE WHEN room_emotion_window.state = 'failed' THEN … ELSE … END,
  diarize_run_id = EXCLUDED.diarize_run_id
RETURNING attempts
```
**d. The close and the enqueue (A12)**:
```sql
WITH closed AS (
  UPDATE bench_window SET state = 'closed', closed_at = NOW()
   WHERE session_id = $1 AND start_ms = $2 AND end_ms = $3 AND source_mic = $4 AND state = 'open'
  RETURNING id
),
queued AS (
  INSERT INTO stt_subject_job (subject_type, subject_id, tier, state)
  SELECT 'bench_window', closed.id, 'asr', 'queued' FROM closed WHERE $5::boolean
  ON CONFLICT (subject_type, subject_id, tier) DO NOTHING
  RETURNING subject_id
)
SELECT (SELECT count(*)::int FROM closed) AS closed, (SELECT count(*)::int FROM queued) AS queued
```
`enqueueSubject` is no longer imported by `lib/bench-window.ts`; its four-line INSERT is inlined above
because the CTE needs it in the same statement. `lib/stt/fanout.ts` is untouched and every other caller of
`enqueueSubject` is unaffected.

## 12. Migrations and manual steps for V

**None.** No migration is added and none was applied. No manual step.

## 13. Subagents

None. Every edit, run and measurement in this round is mine.
