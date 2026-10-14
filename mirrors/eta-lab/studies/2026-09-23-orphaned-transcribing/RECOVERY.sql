-- Orphaned "transcribing" room_window windows — one-off recovery (23 Sep 2026)
-- orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain.md
--
-- ROOT CAUSE (read-only investigation, production): 56 of 56 orphaned windows' LATEST
-- room_window job (scribe_job) has status='cancelled' -- 50 with error
-- 'cancelled_for_serial_retry', 2 'cancelled_for_serial_force_drain', 4 cancelled with no/other
-- detail. cancelJob() (lib/jobs/store.ts) is a generic job-system primitive: it sets
-- scribe_job.status='cancelled' and touches NOTHING else. Every ordinary room_window failure
-- path runs through room-drain.ts's own recordFailure, which is what actually moves
-- bench_window back to 'closed' (or parks it 'failed'). A job cancelled from OUTSIDE that path
-- -- here, someone/something enforcing one-drainer-at-a-time serial concurrency -- leaves
-- bench_window stuck at 'transcribing' forever: not 'closed' (auto-drain's scan only offers
-- state='closed', so it is never re-offered) and not 'failed' either (nothing flags it). This is
-- a GENERIC gap (any cancelled or bookkeeping-bypassed-failed room_window job produces the same
-- stranding), not specific to the serial-retry cancellations found here -- see the new reaper
-- (lib/room-window-reaper-core.ts, branch vinay/room-window-reaper) for the permanent fix, for
-- the train. THIS SCRIPT is the immediate one-off recovery, independent of that branch landing.
--
-- Confirmed NOT the cause: router_job_lost (already fixed, merged into production 6fef31d,
-- unrelated timing -- none of these 56 carry that error), attempt exhaustion (all 56 have
-- stt_subject_job.attempts 0-2, DRAIN_MAX_ATTEMPTS=3, none at the bound), a missing clip (46/56
-- already have one; the other 10 re-join fine on the next prepare() -- clip_r2_key is not a
-- precondition there), lease expiry (no evidence of a job stuck 'running' past its lease; these
-- are all cleanly terminal).
--
-- MEASURED, 23 Sep ~22:35 IST (stable across two checks ~30 min apart -- 56 both times):
--   56 transcribing windows, latest room_window job status='cancelled', attempts<3 on all 56.
--   23 OTHER transcribing windows have a live (queued/running) job -- NOT touched by this script.
--
-- SAFETY: every UPDATE re-checks bench_window.state='transcribing' so a window a live drain
-- claims between STEP 0 and STEP 2 is never touched (RETURNING proves what actually moved).
-- Run STEP 0 first and confirm the count/shape before running STEPS 1-3. Transactional --
-- ROLLBACK is safe at any point before COMMIT.

BEGIN;

-- STEP 0 -- CONFIRM THE SET. Expect ~56 rows, job_status='cancelled', attempts 0-2 on every row.
-- If this does not match (count far off, any job_status other than 'cancelled'/'failed', any
-- attempts>=3), STOP and re-derive rather than proceeding on stale numbers.
SELECT w.id AS window_id, w.closed_at, w.clip_r2_key IS NOT NULL AS has_clip,
       j.status AS job_status, j.error AS job_error, j.finished_at AS job_finished_at,
       COALESCE(sj.attempts, 0) AS subject_attempts
  FROM bench_window w
  LEFT JOIN LATERAL (
    SELECT status, error, finished_at FROM scribe_job
     WHERE kind = 'room_window' AND args->>'window_id' = w.id
     ORDER BY created_at DESC LIMIT 1
  ) j ON true
  LEFT JOIN stt_subject_job sj
    ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'
 WHERE w.state = 'transcribing'
   AND j.status IN ('cancelled', 'failed')
 ORDER BY w.closed_at;

-- STEP 1 -- capture the exact target set as of THIS transaction (temp table so steps 2-3
-- operate on the identical set STEP 0 showed, not a re-derived one that could race).
CREATE TEMP TABLE orphan_recovery_targets ON COMMIT DROP AS
  SELECT w.id AS window_id, COALESCE(sj.attempts, 0) AS subject_attempts
    FROM bench_window w
    LEFT JOIN LATERAL (
      SELECT status FROM scribe_job
       WHERE kind = 'room_window' AND args->>'window_id' = w.id
       ORDER BY created_at DESC LIMIT 1
    ) j ON true
    LEFT JOIN stt_subject_job sj
      ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'
   WHERE w.state = 'transcribing'
     AND j.status IN ('cancelled', 'failed')
     AND COALESCE(sj.attempts, 0) < 3;   -- exhausted rows (none measured) are left alone here --
                                          -- park them 'failed' by hand if STEP 0 ever shows one.

-- STEP 2 -- bench_window: 'transcribing' -> 'closed' (mirrors recordFailure's non-exhausted
-- branch exactly). Re-checks state so a window a live drain claims meanwhile is skipped.
UPDATE bench_window SET state = 'closed'
 WHERE id IN (SELECT window_id FROM orphan_recovery_targets) AND state = 'transcribing'
RETURNING id;

-- STEP 3 -- stt_subject_job: 'running' -> 'queued' (mirrors recordFailure's non-exhausted
-- branch). attempts is intentionally NOT incremented: a cancelled-for-serial-retry job never
-- made and lost a real transcription attempt, so counting it as one would burn the retry budget
-- for a failure that never happened.
UPDATE stt_subject_job SET state = 'queued', finished_at = NULL
 WHERE subject_type = 'bench_window' AND tier = 'asr'
   AND subject_id IN (SELECT window_id FROM orphan_recovery_targets)
RETURNING subject_id, state, attempts;

-- STEP 4 -- one audit row naming exactly what this ran against.
INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
VALUES ('system', 'fable-manual-recovery', 'room_window.reap_orphaned_transcribing_manual', 'bench_window', NULL,
        jsonb_build_object(
          'order', 'orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain.md',
          'ran_at', now(),
          'window_count', (SELECT count(*) FROM orphan_recovery_targets)
        ));

-- REVIEW STEP 2/3's RETURNING output, THEN:
COMMIT;
-- (or ROLLBACK; if STEP 0's count/shape looked wrong, or the RETURNING rows are not what STEP 0 showed)


-- ============================================================================================
-- AFTER COMMIT: draining them despite the closed_at horizon
-- ============================================================================================
-- These windows are now 'closed' again, but auto-drain's automatic cron scan
-- (lib/stt/auto-drain.ts) still will not re-offer them: it filters
-- `w.closed_at >= NOW() - AUTO_DRAIN_MAX_AGE_HOURS hours`, and every one of these closed_at
-- 22 Sep 09:00-14:02 UTC -- 30+ hours old by the time this runs, far outside any reasonable
-- horizon (default 6h; even the order's own "16h" does not reach them).
--
-- drainRoomWindow() itself (the function auto-drain calls per offered window) has NO age check
-- at all -- the horizon lives ONLY in auto-drain's own SELECT, not in the claim/submit path. So
-- submitting a room_window job DIRECTLY for each window id (bypassing the age-gated scan
-- entirely, exactly as the order's "room-drain finish guard admits 'closed' for directly
-- submitted room_window jobs" says) is the correct bypass -- not a workaround, the normal
-- direct-submit path every MCP/admin room_window call already uses.
--
-- EXPECTED JOB COUNT: up to 56 (however many STEP 2 actually returned -- some may have been
-- reclaimed by a live drain meanwhile and are excluded automatically).
--
-- EXPECTED LOAD ON STT: 56 sequential room_window jobs, same per-window cost as the ordinary
-- overnight drain -- one join (~1-2 min under the drain-join-busy fix's own measurement) plus
-- one Whisper/router transcription of a 900s window (12-640s on the router, per the
-- router_job_lost commit's own bake-off measurement; whisper.cpp is comparable). These compete
-- for the SAME single Whisper/join/router capacity as tonight's already-running backlog push
-- (night-drain, overnight-translate, emotion backlog) -- this is ADDITIONAL load on top of that,
-- not free capacity, even with the Mini otherwise idle tonight. At roughly 1-3 min/window
-- end-to-end, 56 windows is very roughly 1-3 hours of drainer time if run back-to-back and
-- uncontended; real wall-clock depends on what else is queued on the shared join/Whisper path
-- at the same time.
--
-- HOW: for each window id STEP 2 returned, submit a room_window job the same way
-- drainRoomWindow() does (lib/jobs/submit.ts submitJob, kind='room_window',
-- args={window_id, origin, actor, via}) -- via the admin room_window MCP tool/route, or a small
-- one-off script that loops the id list. Not run here (read-only investigation) and not
-- automated by this script -- Fable's call on which submission path to use tonight.
