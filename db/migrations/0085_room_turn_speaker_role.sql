-- =====================================================================
-- Migration 0085 — Tier 2 Slice C2: room_turn_speaker learns WHO, not just WHICH CLUSTER.
--
-- The table has carried `speaker_idx` since 0074 and nothing else about identity. An index is not
-- a person: it is the position of a cluster in a list the service sorts by total speaking time
-- (server.py:191), so idx 0 is merely the most talkative voice in the window. In a consultation
-- that is usually the doctor, which is exactly what makes it the tempting wrong answer.
--
-- These columns exist so a role can be recorded ONLY when it was actually established — by the
-- service's cosine match against an enrolled voiceprint — and so that a reader can tell the
-- difference between "this is Dr X" and "this is the voice that talked most".
--
-- THE CHECK IS THE RULE, IN THE SCHEMA. A row may claim role='clinician' only if it also names a
-- clinician_id and carries the confidence the match was made at. A future writer that infers a
-- clinician from speaker order cannot store the result: it has no id to put here, and the row is
-- rejected by the database rather than accepted and believed. Attributing a patient's words to
-- their doctor — or the reverse — is worse than leaving the span unlabelled.
--
-- Additive and idempotent; no backfill, because there is nothing to backfill (the table is empty).
-- =====================================================================

ALTER TABLE room_turn_speaker
  ADD COLUMN IF NOT EXISTS clinician_id     text,
  ADD COLUMN IF NOT EXISTS role             text,
  ADD COLUMN IF NOT EXISTS match_confidence double precision;

-- `role` is a closed vocabulary. 'clinician' is the only value that asserts an identity; every
-- other value describes what the service could tell WITHOUT one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_role_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_role_ck
      CHECK (role IS NULL OR role IN ('clinician', 'unattributed'));
  END IF;
END $$;

-- A clinician role REQUIRES an id and a confidence. This is the rule that cannot be commented out.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_turn_speaker_clinician_ck') THEN
    ALTER TABLE room_turn_speaker
      ADD CONSTRAINT room_turn_speaker_clinician_ck
      CHECK (role <> 'clinician' OR (clinician_id IS NOT NULL AND match_confidence IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_room_turn_speaker_clinician
  ON room_turn_speaker (clinician_id) WHERE clinician_id IS NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (85, '0085_room_turn_speaker_role')
ON CONFLICT DO NOTHING;
