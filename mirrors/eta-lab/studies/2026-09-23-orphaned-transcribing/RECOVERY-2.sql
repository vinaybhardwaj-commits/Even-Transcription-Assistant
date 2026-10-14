-- RECOVERY-2 -- untranscribed 'closed' windows, 22 Sep 08:00-18:59 IST (24 Sep 2026)
-- orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-2.md.  READ-ONLY investigation; Fable executes AFTER the train.
--
-- MEASURED 24 Sep ~01:15 IST: 128 windows, bench_window.state='closed', closed_at 22 Sep 08:00-18:59 IST
--   (62 closed 08:00-15:59 = SET A;  66 closed 16:00-18:59 = SET B).  No queued/running room_window job on any.
--   All 128: grid_aligned=true, room_day_id present, source_mic=primary, auto_drain_refused_reason NULL,
--   room.transcript_enabled currently TRUE (no switch-change history exists: audit_log has no switch rows).
--
-- CAUSES (see FINDINGS-2.md):
--   SET A (62): all HAD a room_window job, latest job status='failed' 'room_window_failed'; stt_subject_job
--     last_error='join_failed: join_already_running' on all 62, attempts 1 (61) or 2 (1). FALSE failures: the join
--     service's own mutex, saturated from 15:49 IST by a third drainer (admin_route, 424 serial jobs, 334 failed
--     join_already_running -- ledger, ETA-OVERNIGHT-FATALS-ROOTCAUSE). drain-join-busy (5301fd7) makes that a WAIT.
--     All 62 have a clip. state already 'closed', attempts <3: NOT stranded, only OUTSIDE auto-drain's age horizon.
--   SET B (66): no clip. 61 never had a job (never offered; nothing refused them), 4 had one join_already_running
--     failure, 1 job cancelled_for_serial_retry. state already 'closed'.
-- => NO state repair is needed (unlike RECOVERY.sql's 56 'transcribing').  What is needed: (1) refund the false
--    attempts on A/B so one more busy answer cannot park a window at DRAIN_MAX_ATTEMPTS=3, (2) submit room_window
--    jobs DIRECTLY (drainRoomWindow has no age check; only auto-drain's scan has the horizon).
--
-- PRE-CONDITIONS (do not run before all four hold):
--   a. the train with drain-join-busy (5301fd7) is deployed and /api/health serves it.  Without it every submit
--      below hits join_already_running again and burns attempts.
--   b. RECOVERY.sql (the 56 'transcribing') is run FIRST or in parallel-safe order -- it is a separate set.
--   c. STEP 0 shows 128 (+/- a few) rows and 0 live jobs.
--   d. nothing else is bulk-draining the Mini Whisper/join (DRAIN-BOOKINGS.md: one drainer at a time).

BEGIN;

-- STEP 0 -- confirm the set and that nothing is live.  Expect ~128 rows, live_job=false on every row,
-- switch_on=true on every row.  If any switch_on=false, DO NOT submit that room's windows (drainRoomWindow
-- refuses flag_off and would just record a refusal).
SELECT w.id AS window_id, s.room_id, w.closed_at, w.clip_r2_key IS NOT NULL AS has_clip,
       COALESCE(sj.attempts, 0) AS subject_attempts, sj.last_error,
       r.transcript_enabled AS switch_on,
       EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind='room_window' AND j.args->>'window_id'=w.id
                  AND j.status IN ('queued','running')) AS live_job
  FROM bench_window w
  JOIN bench_session s ON s.id = w.session_id
  JOIN room r ON r.id = s.room_id
  LEFT JOIN stt_subject_job sj ON sj.subject_type='bench_window' AND sj.subject_id=w.id AND sj.tier='asr'
 WHERE w.state = 'closed'
   AND w.closed_at >= '2026-09-22T02:30:00Z' AND w.closed_at < '2026-09-22T13:30:00Z'
   AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
 ORDER BY w.closed_at;

-- STEP 1 -- capture the exact target set (temp table: STEPS 2-3 use the identical set STEP 0 showed).
CREATE TEMP TABLE recovery2_targets ON COMMIT DROP AS
  SELECT w.id AS window_id
    FROM bench_window w
    JOIN bench_session s ON s.id = w.session_id
    JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
   WHERE w.state = 'closed'
     AND w.closed_at >= '2026-09-22T02:30:00Z' AND w.closed_at < '2026-09-22T13:30:00Z'
     AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind='room_window' AND j.args->>'window_id'=w.id
                        AND j.status IN ('queued','running'));

-- STEP 2 -- refund the FALSE attempts: only rows whose last_error is exactly the join-mutex answer, and only
-- attempts 1-2 (never touches an exhausted or a differently-failed row).  last_error is kept for the record.
UPDATE stt_subject_job
   SET attempts = 0, state = 'queued', finished_at = NULL
 WHERE subject_type = 'bench_window' AND tier = 'asr'
   AND subject_id IN (SELECT window_id FROM recovery2_targets)
   AND last_error = 'join_failed: join_already_running'
   AND attempts BETWEEN 1 AND 2
RETURNING subject_id, attempts, state;

-- STEP 3 -- audit row.
INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
VALUES ('system', 'fable-manual-recovery', 'room_window.recovery2_refund_join_busy_attempts', 'bench_window', NULL,
        jsonb_build_object('order', 'orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-2.md', 'ran_at', now(),
                           'target_windows', (SELECT count(*) FROM recovery2_targets)));

-- REVIEW STEP 2's RETURNING (expect ~67: 62 in A + 5 in B), THEN:
COMMIT;   -- or ROLLBACK;

-- ============================================================================================
-- AFTER COMMIT: SUBMIT -- SUBMIT-LIST-2.csv (same directory), 32 batches of 4, likely-speech first.
-- ============================================================================================
-- Submit room_window jobs DIRECTLY: scribe_job_submit kind='room_window', args {window_id, origin, actor, via}
-- (translate/switch_override NOT set).  The age horizon is only in auto-drain's scan, not in drainRoomWindow.
--
-- DO NOT SUBMIT ALL 128 AT ONCE.  drain-join-busy waits at most 15 min (30 attempts) per job, and the join
-- service does ONE join at a time (~1-2 min each): a job queued behind 10+ others exceeds the cap and FAILS as
-- join_failed, burning an attempt.  Keep <=4 jobs in flight: submit batch N+1 only when batch N is all
-- done/failed (poll: SELECT status, count(*) FROM scribe_job WHERE kind='room_window' AND status IN
-- ('queued','running') -> 0).  Stop and look if more than 2 of a batch fail.
--
-- EXPECTED LOAD: 128 jobs, join service is the serial bottleneck: ~1-2 min join each = 2.1-4.3 h floor; each job
-- also transcribes ~900 s on the router/Whisper (silent windows skip the engine via the E11 silence path and are
-- cheap).  Overnight-translate measured 154-185 s per window end to end at concurrency 1 -> ~5-7 h serial for all
-- 128; the ~62 likely-speech windows alone ~3 h.  Adds to RECOVERY.sql's 56 (~3 h) and to the emotion/night-drain
-- backlog on the same Whisper: take the DRAIN-BOOKINGS.md lock and book the slot before starting.
