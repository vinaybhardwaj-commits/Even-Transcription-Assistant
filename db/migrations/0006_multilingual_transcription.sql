-- =====================================================================
-- Migration 0006 — multilingual transcription (Sarvam testbed)
--
-- 29 May 2026. Adds support for non-English (Indian-language) encounters:
--   • encounter.detected_language   — BCP-47 code from the winning engine
--                                       (e.g. 'kn-IN'); NULL = English/unknown
--   • encounter.transcript_original  — original-language transcript preserved
--                                       (English stays in transcript_raw)
--   • transcription_run              — one row per engine per encounter, the
--                                       multi-engine comparison testbed log
--                                       (Deepgram | Whisper | Sarvam | ...)
--
-- Workflow unchanged: English encounters never populate detected_language /
-- transcript_original (they stay on the existing Deepgram path).
-- =====================================================================

ALTER TABLE encounter
  ADD COLUMN IF NOT EXISTS detected_language   TEXT,
  ADD COLUMN IF NOT EXISTS transcript_original TEXT;

CREATE TABLE IF NOT EXISTS transcription_run (
  id                  TEXT PRIMARY KEY,                -- trun_<nanoid>
  encounter_id        TEXT NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  engine              TEXT NOT NULL,                   -- 'deepgram' | 'whisper' | 'sarvam' | 'whisperlive' | 'indicconformer'
  mode                TEXT NOT NULL,                   -- 'live' | 'submit' | 'batch'
  detected_language   TEXT,
  transcript_original TEXT,
  transcript_english  TEXT,
  latency_ms          INTEGER,
  judge_score         NUMERIC(4,2),
  is_winner           BOOLEAN NOT NULL DEFAULT FALSE,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcription_run_encounter
  ON transcription_run (encounter_id, created_at);

INSERT INTO schema_migrations (version, name)
VALUES (6, '0006_multilingual_transcription')
ON CONFLICT DO NOTHING;
