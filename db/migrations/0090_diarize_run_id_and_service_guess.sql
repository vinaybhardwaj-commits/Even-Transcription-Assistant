-- 0090 — diarize: a run id on every turn binding, and the service's speaker guess made unmistakable.
--
-- RUN ID. room_turn_speaker is rewritten by every diarize run (ON CONFLICT DO UPDATE), but nothing on
-- it recorded WHICH run wrote it, and room_diarize_window.attempts only moves when a FAILED window is
-- retried — a successful re-run rewrote the turns and left every counter where it was. So a reader
-- holding "the turns I planned from" had nothing to compare against.
--   room_turn_speaker.run_id        the run that last wrote this row (the diarize_window job stamps one
--                                   id per run on every row it writes)
--   room_diarize_window.last_run_id the most recent run that WROTE TURNS for the window (ok or
--                                   no_speakers); a run that failed before writing leaves it as it was
-- No CHECK constrains either value; the writers set them.
--
-- THE SERVICE'S GUESS. /diarize returns, per speaker, a heuristic `type` (clinician | patient |
-- attender | nurse | other), a `label`, and the `source`/`role_source` of that guess. None of it is
-- attribution: in this system a role comes only from a voiceprint match (room_turn_speaker.role).
-- Stored verbatim at the top level of speakers_json, one join on the speaker index made an unmatched
-- speaker read as whatever the service guessed. From now on the writer nests those fields under
-- `unverified_service_guess`; this statement moves any row already stored the old way. Nothing is
-- dropped. The embedding, index, timings and any voiceprint match (clinician_id, confidence) stay at
-- the top level.

ALTER TABLE room_turn_speaker ADD COLUMN IF NOT EXISTS run_id text;
ALTER TABLE room_diarize_window ADD COLUMN IF NOT EXISTS last_run_id text;

UPDATE room_diarize_window d
   SET speakers_json = (
     SELECT jsonb_agg(
              (e.sp - 'type' - 'label' - 'source' - 'role_source')
              || jsonb_build_object('unverified_service_guess', jsonb_strip_nulls(jsonb_build_object(
                   'type', e.sp->'type', 'label', e.sp->'label', 'source', e.sp->'source', 'role_source', e.sp->'role_source',
                   'is', 'the diarize service''s own heuristic guess, not an attribution; a role comes only from a voiceprint match')))
              ORDER BY e.ord)
       FROM jsonb_array_elements(d.speakers_json) WITH ORDINALITY AS e(sp, ord)
   )
 WHERE jsonb_typeof(d.speakers_json) = 'array'
   AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(d.speakers_json) s(sp)
      WHERE jsonb_typeof(s.sp) = 'object' AND (s.sp ? 'type' OR s.sp ? 'label' OR s.sp ? 'source' OR s.sp ? 'role_source')
   );

COMMENT ON COLUMN room_diarize_window.speakers_json IS
  'The service''s speakers array, embeddings included. Its heuristic type/label/source are nested under unverified_service_guess (0090): the service''s guess, not an attribution. A role comes only from room_turn_speaker.role.';

INSERT INTO schema_migrations (version, name)
VALUES (90, '0090_diarize_run_id_and_service_guess')
ON CONFLICT DO NOTHING;
