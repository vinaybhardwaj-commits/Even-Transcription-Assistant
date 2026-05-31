-- =====================================================================
-- Migration 0020 — stt_gold (STT Engine Lab L3): per-encounter verbatim
-- reference ("truth") for objective WER/CER + medical-term fidelity.
-- One row per gold-labeled encounter. Additive.
-- =====================================================================
CREATE TABLE IF NOT EXISTS stt_gold (
  encounter_id        text PRIMARY KEY REFERENCES encounter(id) ON DELETE CASCADE,
  reference_original  text,          -- verbatim native-language transcript
  reference_english   text,          -- verbatim English (optional; for translation-axis WER)
  reference_language  text,
  critical_terms_json jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{term,type}] extracted from the reference
  terms_model         text,          -- which model extracted the terms (cloud or qwen)
  labeled_by_admin_id text,
  labeled_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name) VALUES (20, '0020_stt_gold') ON CONFLICT DO NOTHING;
