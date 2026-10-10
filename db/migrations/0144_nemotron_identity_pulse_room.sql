-- 0144_nemotron_identity_pulse_room.sql — the 'pulse_room' centroid set on the Nemotron identity pass (suggest-only, DARK).
--
-- Additive and idempotent; no grants. The set is read only when IDENT_CENTROID_SET=pulse_room (default unchanged).
-- Its centroids are the ACTIVE pulse_doctor_voice rows (0142) of embedding_model speechbrain/spkrec-ecapa-voxceleb,
-- keyed by Pulse doctor uid. A Pulse uid is NOT a clinician id, so a pulse_room speaker row never sets clinician_id:
-- it carries pulse_doctor_uid (the match, if any), match_source 'pulse_room', the best cosine and the runner-up cosine.
-- An abstention is recorded with both cosines. Nothing here is a production attribution.
--
-- 1. Both centroid_set CHECKs also allow 'pulse_room'.
-- 2. diarize_nemotron_speaker gains decision / pulse_doctor_uid / match_source / best_cosine / runner_up_cosine.
--    Every existing row keeps NULL in all five; a row of any other set must keep them NULL.
--
-- NO EMBEDDINGS, as 0141. One transaction.

BEGIN;

ALTER TABLE diarize_nemotron_identity DROP CONSTRAINT IF EXISTS diarize_nemotron_identity_set_chk;
ALTER TABLE diarize_nemotron_identity ADD CONSTRAINT diarize_nemotron_identity_set_chk
  CHECK (centroid_set IN ('voice_print', 'voice_centroid:room_primary', 'confirmed6', 'pulse_room'));

ALTER TABLE diarize_nemotron_speaker DROP CONSTRAINT IF EXISTS diarize_nemotron_speaker_set_chk;
ALTER TABLE diarize_nemotron_speaker ADD CONSTRAINT diarize_nemotron_speaker_set_chk
  CHECK (centroid_set IN ('voice_print', 'voice_centroid:room_primary', 'confirmed6', 'pulse_room'));

ALTER TABLE diarize_nemotron_speaker ADD COLUMN IF NOT EXISTS decision          text NULL;
ALTER TABLE diarize_nemotron_speaker ADD COLUMN IF NOT EXISTS pulse_doctor_uid  text NULL;
ALTER TABLE diarize_nemotron_speaker ADD COLUMN IF NOT EXISTS match_source      text NULL;
ALTER TABLE diarize_nemotron_speaker ADD COLUMN IF NOT EXISTS best_cosine       real NULL;
ALTER TABLE diarize_nemotron_speaker ADD COLUMN IF NOT EXISTS runner_up_cosine  real NULL;

ALTER TABLE diarize_nemotron_speaker DROP CONSTRAINT IF EXISTS diarize_nemotron_speaker_pulse_chk;
ALTER TABLE diarize_nemotron_speaker ADD CONSTRAINT diarize_nemotron_speaker_pulse_chk CHECK (
  CASE WHEN centroid_set = 'pulse_room' THEN
         match_source = 'pulse_room'
         AND decision IN ('match', 'abstain', 'not_compared')
         -- suggest-only: a Pulse uid is not a clinician id, and no losing-candidate shadow is kept for this set
         AND clinician_id IS NULL AND match_confidence IS NULL AND losing_clinician_id IS NULL
         AND ((decision = 'match') = (pulse_doctor_uid IS NOT NULL))
         AND (decision <> 'match' OR (best_cosine IS NOT NULL AND runner_up_cosine IS NOT NULL))
         AND (decision <> 'not_compared' OR (best_cosine IS NULL AND runner_up_cosine IS NULL))
       ELSE
         decision IS NULL AND pulse_doctor_uid IS NULL AND match_source IS NULL AND best_cosine IS NULL AND runner_up_cosine IS NULL
  END);

COMMENT ON COLUMN diarize_nemotron_speaker.pulse_doctor_uid IS
  'pulse_room set only: the Pulse doctor uid a speaker matched (best cosine >= 0.65 and margin >= 0.05). A suggestion; never a clinician id.';

INSERT INTO schema_migrations (version, name)
VALUES (144, '0144_nemotron_identity_pulse_room')
ON CONFLICT DO NOTHING;

COMMIT;
