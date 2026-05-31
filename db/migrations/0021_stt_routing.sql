-- =====================================================================
-- Migration 0021 — stt_routing (STT Engine Lab L5): which engine is the ACTIVE
-- production engine per stage × language bucket. engine_id 'auto' = use the
-- built-in default logic (no override). The resolver falls back safely to the
-- default behaviour if a row is missing, set to 'auto', or points at a
-- disabled engine — so production is unchanged until an admin sets an override.
-- =====================================================================
CREATE TABLE IF NOT EXISTS stt_routing (
  stage               text NOT NULL,          -- live | note | diarize
  language_bucket     text NOT NULL,          -- english | indic | default
  engine_id           text NOT NULL DEFAULT 'auto',
  updated_by_admin_id text,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stage, language_bucket)
);

-- Seed defaults that MATCH current behaviour (note/english stays 'auto' =
-- longer-of Deepgram/Whisper; non-English already Sarvam).
INSERT INTO stt_routing (stage, language_bucket, engine_id) VALUES
  ('note', 'english', 'auto'),
  ('note', 'indic',   'sarvam'),
  ('live', 'english', 'deepgram'),
  ('live', 'indic',   'sarvam')
ON CONFLICT (stage, language_bucket) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (21, '0021_stt_routing') ON CONFLICT DO NOTHING;
