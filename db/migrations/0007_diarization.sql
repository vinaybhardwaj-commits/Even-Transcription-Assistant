-- =====================================================================
-- Migration 0007 — v2.1 Speaker Diarization schema (PRD §20.5)
--
-- Pulled forward AHEAD of v2.0. PRD §20.5 references the v2.0 `clinician`
-- table, which does not exist yet (v2.0 not started). Adapted to reference
-- the current `doctor` table; when v2.0 renames doctor→clinician these
-- FKs/columns carry over.
--
-- 0007a voice_print · 0007b encounter columns · 0007d doctor toggle.
-- (0007c was audit_log action docs only — no DDL.)
-- =====================================================================

-- 0007a — voice_print (one per enrolled clinician; ECAPA centroid + samples)
CREATE TABLE IF NOT EXISTS voice_print (
  doctor_id                TEXT PRIMARY KEY REFERENCES doctor(id) ON DELETE CASCADE,
  centroid                 BYTEA NOT NULL,                    -- 192 float32 = 768 bytes
  sample_count             INT NOT NULL DEFAULT 0,
  samples_json             JSONB NOT NULL DEFAULT '[]'::jsonb, -- base64 sample embeddings, rolling cap 20
  enrolled_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_sample_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  match_confidence_30d_avg FLOAT,
  needs_reenrollment       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_voice_print_needs_reenrollment
  ON voice_print(needs_reenrollment) WHERE needs_reenrollment;

-- 0007b — encounter diarization columns
ALTER TABLE encounter
  ADD COLUMN IF NOT EXISTS speakers             JSONB,
  ADD COLUMN IF NOT EXISTS transcript_segments  JSONB,
  ADD COLUMN IF NOT EXISTS overlap_windows      JSONB,
  ADD COLUMN IF NOT EXISTS manual_relabels      JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS aggregates           JSONB,
  ADD COLUMN IF NOT EXISTS mic_device_id        TEXT,
  ADD COLUMN IF NOT EXISTS diarize_status       TEXT,
  ADD COLUMN IF NOT EXISTS diarize_started_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS diarize_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS diarize_error        TEXT,
  ADD COLUMN IF NOT EXISTS diarize_used_buffer  BOOLEAN NOT NULL DEFAULT FALSE;

-- diarize_status allowed values (added separately so IF NOT EXISTS above stays simple)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'encounter_diarize_status_chk') THEN
    ALTER TABLE encounter ADD CONSTRAINT encounter_diarize_status_chk
      CHECK (diarize_status IN ('pending','running','complete','skipped','failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_encounter_diarize_status
  ON encounter(diarize_status) WHERE diarize_status IN ('pending','running','failed');
CREATE INDEX IF NOT EXISTS idx_encounter_mic_device_id
  ON encounter(mic_device_id) WHERE mic_device_id IS NOT NULL;

-- 0007d — clinician (doctor) email toggle (SD-Q4)
ALTER TABLE doctor
  ADD COLUMN IF NOT EXISTS email_show_conversation_with BOOLEAN NOT NULL DEFAULT FALSE;

INSERT INTO schema_migrations (version, name)
VALUES (7, '0007_diarization')
ON CONFLICT DO NOTHING;
