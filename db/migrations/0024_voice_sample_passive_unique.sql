-- =====================================================================
-- Migration 0024 — harden passive voiceprint dedup (B19 P2).
-- A passive voice_sample is captured once per (clinician, encounter); add a
-- partial UNIQUE index so a concurrent /process double-fire can't insert two.
-- Partial (passive + non-null encounter) so enrollment rows are unaffected.
-- Assumes no pre-existing passive duplicates (passive capture is brand-new).
-- =====================================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_voice_sample_passive_enc
  ON voice_sample (clinician_id, source_encounter_id)
  WHERE source = 'passive' AND source_encounter_id IS NOT NULL;

INSERT INTO schema_migrations (version, name) VALUES (24, '0024_voice_sample_passive_unique') ON CONFLICT DO NOTHING;
