# ETA-E25 — Deploy order for E24 (branch `vinay/e16-emotion-speech-fraction`)

## 0099 MUST be applied before this code deploys.

Apply `db/migrations/0099_room_diarize_segments_run_id.sql` to the production database **first**. Deploy the code that
reads and writes it **after**. Never the other way round.

## What breaks if the order is reversed

With E24 code live and 0099 not applied, these statements name columns or states that do not exist yet:

| Statement | Where | What fails |
|---|---|---|
| The diarize INSERT … ON CONFLICT, which names `segments_run_id` | `lib/stt/diarize-window.ts`, `recordDiarizeWindow` | **Every diarize INSERT.** Every `diarize_window` job that reaches its window-row write fails: ok, no_speakers, or a non-retryable failure. Only a "service unavailable" run, which writes no row, is unaffected. No window row is recorded. The run's turn rows are written before this INSERT, so they are left behind with no window row naming their run. |
| The emotion prepare SELECT, which reads `d.segments_run_id` | `lib/jobs/kinds/emotion-window.ts`, `prepare` | **Every emotion prepare SELECT.** Every `emotion_window` job fails at its first step, and no window is scored. |
| The emotion window upsert, which names `stale_segments_run_id` | `lib/emotion/store.ts`, `recordEmotionWindow` | Every emotion window row write: stale, no_segments and failed. |
| The emotion finish upsert, which sets `stale_segments_run_id` | `lib/emotion/store.ts`, `finishEmotionWindow` | Every emotion window finish. |
| The repair UPDATE, which names `segments_run_id` and `stale_segments_run_id` | `lib/stt/diarize-window.ts`, `repairStaleDiarizeSegments` | Would fail, but is never reached, because the diarize INSERT before it has already failed. |
| A `diarize_stale` state written to `room_emotion_window` | `recordStaleWindow` | Would be refused by the pre-0099 state CHECK, but is never reached, because the prepare SELECT has already failed. |

In short, both the diarize pipeline and the emotion pipeline stop. The failures are column-does-not-exist errors, not
wrong numbers.

## The other direction is safe

With 0099 applied and code older than E24 still running:
- The added columns are nullable.
- The widened CHECKs still accept every state and error the old code writes.
- The old code keeps working, and writes NULL `segments_run_id`.

Once E24 deploys, it treats those NULL rows as having **no recorded writer run** and marks the window `diarize_stale`
(ruling R17). The next ok diarize run cures it. That is the intended, named behaviour, not a breakage. Today's backlog
count for it is 0 (§9 query, read-only, 15 Sep 2026). Backfill is on hold under R18.

## Same branch, same rule for 0097

This branch also carries E16. The E16 span writes in `lib/emotion/store.ts` name `speech_ms`, `service_speech_ms` and
`speech_basis`, which `db/migrations/0097_room_span_emotion_speech.sql` adds. On 15 Sep 2026 the production database
recorded neither 0097 nor 0099; its highest recorded migration was 93. **Apply 0097 and 0099, then deploy.** The 0099
header says 0099 does not depend on 0097, so the two may be applied in either order relative to each other.

## Checks before the deploy (read-only)

```sql
SELECT version FROM schema_migrations WHERE version IN (97, 99) ORDER BY version;   -- expect 97 and 99
SELECT column_name FROM information_schema.columns
 WHERE (table_name, column_name) IN (('room_diarize_window','segments_run_id'), ('room_emotion_window','stale_segments_run_id'));  -- expect 2 rows
```
