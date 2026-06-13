-- =====================================================================
-- Migration 0029 — Indic Comprehension Layer.
-- For non-English encounters, persist a faithful NATIVE-LANGUAGE structured
-- analysis (for inspection/dissemination) + record which translator produced
-- the English the note pipeline reasoned over. See ETA-INDIC-COMPREHENSION-LAYER-PRD.md.
-- Additive, nullable; nothing reads these until the layer runs.
-- =====================================================================
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS native_analysis      jsonb;
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS native_analysis_lang text;
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS translation_engine   text;

INSERT INTO schema_migrations (version, name) VALUES (29, '0029_indic_comprehension') ON CONFLICT DO NOTHING;
