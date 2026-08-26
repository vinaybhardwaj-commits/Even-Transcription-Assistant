-- =====================================================================
-- Migration 0069 — Build 3 corrective successor.
--
-- 0068 re-bound sixteen windows correctly, then inserted queued jobs for them. The Build 3
-- "run this room's waiting audio" control intentionally selects closed windows with NO job,
-- because it exists for finished tape nobody has chosen to run. The inserted jobs therefore
-- made the repaired windows invisible to the control that was meant to run exactly four first.
--
-- Delete only a queue row that is provably untouched: still queued, zero attempts, no start,
-- finish, error, or transcription run. Any evidence that work began preserves the row and its
-- history. No bench_window, bench_chunk, R2 object, cue, or transcription row is changed.
--
-- 0068's upsert names a deterministic new ID, but one slot already had a primary row. PostgreSQL
-- keeps that existing row's ID on the natural-key conflict while 0068's following INSERT names
-- the deterministic ID, which can leave one untouched orphan job. Match both the winning row ID
-- and 0068's deterministic candidate so that orphan is released too; both remain under every
-- untouched-work guard below.
-- Running this after 0068, whether 0068 was applied earlier or in the same migration sweep,
-- leaves the repaired closed windows in the control's normal no-job state.
-- =====================================================================

DELETE FROM stt_subject_job j
 USING bench_window w
 WHERE j.subject_type = 'bench_window'
   AND j.subject_id IN (
         w.id,
         'bw_' || substr(w.session_id, 4) || '_' || w.start_ms || '_primary'
       )
   AND j.tier = 'asr'
   AND j.state = 'queued'
   AND j.attempts = 0
   AND j.started_at IS NULL
   AND j.finished_at IS NULL
   AND j.last_error IS NULL
   AND w.session_id = 'bs_z3gpbh6e'
   AND w.source_mic = 'primary'
   AND w.state = 'closed'
   AND w.rebound_from = 'backup'
   AND w.rebind_reason LIKE 'D34 re-bind:%'
   AND NOT EXISTS (
         SELECT 1
          FROM transcription_run tr
          WHERE tr.subject_type = 'bench_window'
            AND tr.subject_id = j.subject_id
       );

-- P8: before the server required an explicitly reported second device, the browser's automatic
-- backup capture could leave a measured spare pair on a one-microphone room. That pair describes
-- a phantom input, not a reported spare. Clear only the listener vital; no piece is touched. A
-- native client that later reports a real second device writes a fresh pair on its next poll.
UPDATE bench_listener
   SET spare_peak = NULL,
       spare_avg = NULL
 WHERE spare_device IS DISTINCT FROM TRUE
   AND (spare_peak IS NOT NULL OR spare_avg IS NOT NULL);

INSERT INTO schema_migrations (version, name)
VALUES (69, '0069_build3_corrective')
ON CONFLICT DO NOTHING;
