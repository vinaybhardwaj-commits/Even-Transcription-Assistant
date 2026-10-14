-- RECOVERY-3 -- refund FALSE join-mutex failures before tonight's paced feed (24 Sep 2026)
-- orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-3.md.  READ-ONLY until Fable runs it.  SUPERSEDES RECOVERY-2 STEP 2.
--
-- WHY A NEW FILE.  RECOVERY-2's refund matched last_error = 'join_failed: join_already_running' EXACTLY, attempts 1-2.
-- Measured 24 Sep ~04:55 IST it would have missed 44 of the 56 refundable false failures: since drain-join-busy (5301fd7) a job that
-- outwaits its bound writes 'join_failed: join_already_running after N busy retries over Ns' (34 rows at attempts 1, 9 at
-- attempts 2, 1 EXHAUSTED at attempts 3).  It also cannot reach a window parked bench_window.state='failed'.
-- This file matches the PREFIX, any attempts >= 1, and reopens a parked window.
--
-- WHAT IT TOUCHES (and nothing else):
--   stt_subject_job (asr)  : attempts -> 0, state -> 'queued', finished_at -> NULL.  last_error is KEPT for the record.
--   bench_window           : state 'failed' -> 'closed', ONLY where the parking reason is the join mutex.
--   audit_log              : one row.
-- It does NOT refund whisper_unavailable / join_failed: join_failed / container_failed / cues_refused: those are real
-- faults with attempts to spare (attempts 1 of 3) or need a person's eye.
--
-- SCOPE: windows whose start is 20 Sep 00:00 IST .. 22 Sep 23:59 IST, room switch ON now, no live room_window job.
--   (Switch-OFF windows are HELD, see HELD-SWITCH-OFF-3.csv: drainRoomWindow refuses them and a direct job would burn
--    the whole engine pass before cues_refused.)
--
-- PRE-CONDITIONS (do not run before all hold):
--   a. Every STALE waiter from the 22-23 Sep bulk submit is cancelled or has finished.  Measured 04:55 IST: 20 jobs
--      sit 'running' at step 'prepare', lease NULL, untouched since ~03:52 IST, waiting for a runner, each carrying
--      join_busy_first_at_ms ~1 h old.  The moment a runner claims one it is past the 15-min bound and FAILS as
--      join_failed, burning an attempt.  Cancel them (scribe_job_cancel, needs write; their windows are still 'closed'
--      because a direct job never claims the window) and THEN run this, or run this and accept they re-burn.
--   b. STEP 0 shows live_job=false on every target.

BEGIN;

-- STEP 0 -- what would be refunded.  Read the shapes: every row here must be the join-mutex answer.
SELECT w.state AS window_state, sj.state AS subject_state, sj.attempts,
       regexp_replace(sj.last_error, '[0-9]+', 'N', 'g') AS error_shape, count(*)::int AS n
  FROM bench_window w
  JOIN bench_session s ON s.id = w.session_id
  JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
  JOIN stt_subject_job sj ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'
 WHERE w.state IN ('closed', 'failed')
   AND w.start_ms >= 1789842600000 AND w.start_ms < 1790101800000          -- 20 Sep 00:00 IST .. 23 Sep 00:00 IST
   AND sj.last_error LIKE 'join_failed: join_already_running%' AND sj.attempts >= 1
   AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id
                      AND j.status IN ('queued', 'running'))
 GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;

-- STEP 1 -- freeze the exact set (STEPS 2-4 use the identical rows).
CREATE TEMP TABLE recovery3_targets ON COMMIT DROP AS
  SELECT w.id AS window_id, w.state AS window_state
    FROM bench_window w
    JOIN bench_session s ON s.id = w.session_id
    JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
    JOIN stt_subject_job sj ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'
   WHERE w.state IN ('closed', 'failed')
     AND w.start_ms >= 1789842600000 AND w.start_ms < 1790101800000
     AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
     AND sj.last_error LIKE 'join_failed: join_already_running%' AND sj.attempts >= 1
     AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id
                        AND j.status IN ('queued', 'running'));

-- STEP 2 -- reopen windows PARKED by exhaustion (bench_window.state='failed'); drainRoomWindow / auto-drain refuse them.
UPDATE bench_window SET state = 'closed'
 WHERE id IN (SELECT window_id FROM recovery3_targets WHERE window_state = 'failed') AND state = 'failed'
RETURNING id, state;

-- STEP 3 -- refund the false attempts.
UPDATE stt_subject_job
   SET attempts = 0, state = 'queued', finished_at = NULL
 WHERE subject_type = 'bench_window' AND tier = 'asr'
   AND subject_id IN (SELECT window_id FROM recovery3_targets)
   AND last_error LIKE 'join_failed: join_already_running%'
RETURNING subject_id, attempts, state;

-- STEP 4 -- audit row.
INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
VALUES ('system', 'fable-manual-recovery', 'room_window.recovery3_refund_join_busy_attempts', 'bench_window', NULL,
        jsonb_build_object('order', 'orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-3.md', 'ran_at', now(),
                           'target_windows', (SELECT count(*) FROM recovery3_targets),
                           'reopened_parked', (SELECT count(*) FROM recovery3_targets WHERE window_state = 'failed')));

-- REVIEW: STEP 3's RETURNING count must equal STEP 1's rows (56 at 04:55 IST with 33 jobs still live; grows as those fail), THEN:
COMMIT;   -- or ROLLBACK;
