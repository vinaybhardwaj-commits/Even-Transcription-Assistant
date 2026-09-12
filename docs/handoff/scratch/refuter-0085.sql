CREATE TABLE room_turn_speaker (
  window_id   text NOT NULL,
  source_ref  text NOT NULL,
  speaker_idx integer NOT NULL,
  cluster_id  text,
  overlap_ms  integer NOT NULL DEFAULT 0,
  room_day_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_id, source_ref)
);
CREATE TABLE schema_migrations (version int primary key, name text);
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
