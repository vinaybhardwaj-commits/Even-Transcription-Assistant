-- =====================================================================
-- Migration 0011 — V2.S0: encounter.note_type
--
-- PRD §7.1, renumbered from 0006b. Additive; existing rows default to
-- clinic_encounter (matches v1 behavior). /process starts respecting note_type
-- in V2.S2; the recording-screen picker is added there too.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE note_type AS ENUM (
    'clinic_encounter', 'general_medical', 'operative_procedure',
    'dietetic_consult', 'physiotherapy'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE encounter
  ADD COLUMN IF NOT EXISTS note_type note_type NOT NULL DEFAULT 'clinic_encounter';

CREATE INDEX IF NOT EXISTS idx_encounter_note_type ON encounter(note_type);

INSERT INTO schema_migrations (version, name)
VALUES (11, '0011_encounter_note_type')
ON CONFLICT DO NOTHING;
