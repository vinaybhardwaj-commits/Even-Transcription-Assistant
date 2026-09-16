-- tests/fixtures/pre-e24-diarize-window-insert.sql
--
-- WHAT THIS IS. The room_diarize_window upsert EXACTLY as lib/stt/diarize-window.ts wrote it at commit
-- a05d750 — the last commit before E24 (8c4a18c) added segments_run_id. Captured 16 Sep 2026.
--
-- WHY IT IS COMMITTED RATHER THAN READ FROM GIT (E26 T2). tests/unit/e25-deploy-order.test.ts used to shell
-- out to `git show a05d750:lib/stt/diarize-window.ts`. That made the proof depend on how the repo was
-- cloned: red in an archive or shallow clone, green in a full one. A proof whose result depends on clone
-- depth is not a proof, so the shape it needs is committed here and EXECUTED against the post-0099 schema.
--
-- DO NOT UPDATE THIS FILE TO MATCH CURRENT CODE. It stands for the code that ran BEFORE E24 deployed, which
-- is what a straddling production writer is. Its whole value is that it names no segments_run_id: applied to
-- a post-0099 schema, the column takes its default and the row lands with NULL provenance.
--
-- The ${...} interpolations of the original are placeholders (:window_id, :speakers_json, …); the test
-- substitutes quoted literals. Nothing else is changed.

INSERT INTO room_diarize_window
      (window_id, room_day_id, state, speakers_json, segments_json, clip_r2_key, error, timing_json, last_run_id, diarized_at)
    VALUES
      (:window_id, :room_day_id, :state,
       :speakers_json::jsonb,
       :segments_json::jsonb,
       :clip_r2_key, :error,
       :timing_json::jsonb,
       :last_run_id, NOW())
    ON CONFLICT (window_id) DO UPDATE SET
      state           = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.state ELSE room_diarize_window.state END,
      speakers_json   = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.speakers_json ELSE room_diarize_window.speakers_json END,
      segments_json   = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.segments_json ELSE room_diarize_window.segments_json END,
      clip_r2_key     = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.clip_r2_key ELSE room_diarize_window.clip_r2_key END,
      error           = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.error ELSE room_diarize_window.error END,
      timing_json     = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.timing_json ELSE room_diarize_window.timing_json END,
      diarized_at     = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.diarized_at ELSE room_diarize_window.diarized_at END,
      attempts        = CASE WHEN room_diarize_window.state = 'failed' THEN room_diarize_window.attempts + 1 ELSE room_diarize_window.attempts END,
      failure_history = CASE WHEN room_diarize_window.state = 'failed'
                             THEN room_diarize_window.failure_history || jsonb_build_array(jsonb_build_object(
                                    'attempt', room_diarize_window.attempts,
                                    'error', room_diarize_window.error,
                                    'diarized_at', room_diarize_window.diarized_at))
                             ELSE room_diarize_window.failure_history END,
      last_run_id     = COALESCE(EXCLUDED.last_run_id, room_diarize_window.last_run_id)
