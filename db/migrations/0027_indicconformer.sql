-- =====================================================================
-- Migration 0027 — AI4Bharat IndicConformer-600M as an STT Lab engine.
-- Local Indic ASR on the Mac Mini (Pattern B, INDICCONFORMER_BASE_URL).
-- Indic-only, submit-time fallback (NOT live, NOT English). Two rows:
--   indicconformer         — ASR tier (native-script transcript; WER once Indic gold labeled)
--   indicconformer_scribe  — Scribe tier (IndicConformer -> Even note-gen), rubric vs even_pipeline
-- free (owned hardware) so cost_per_min = 0. Registered ENABLED but fanout OFF:
-- flip fanout_enabled on (Engines tab) ONCE the Mac-Mini exposes
-- indic.llmvinayminihome.uk (Pattern B). The adapter no-ops on non-Indic clips
-- so it only ever competes on the Indic slice.
-- =====================================================================
INSERT INTO stt_engine (id, display_name, adapter_key, capabilities_json, enabled, fanout_enabled, is_paid, cost_per_min_usd, config_json, sort_order) VALUES
  ('indicconformer', 'IndicConformer-600M (AI4Bharat, Mac Mini)', 'indicconformer',
     '{"tiers":["asr"],"stages":["note"],"languages":["indic"],"streaming":false,"translates":false,"async":false}'::jsonb,
     true, false, false, 0,
     '{"base_env":"INDICCONFORMER_BASE_URL","decoding":"rnnt","note":"Indic-only; explicit language; no code-switch"}'::jsonb, 60),
  ('indicconformer_scribe', 'IndicConformer → Even Note', 'indicconformer_scribe',
     '{"tiers":["scribe"],"stages":["note"],"languages":["indic"],"streaming":false,"translates":false,"async":false}'::jsonb,
     true, false, false, 0,
     '{"asr":"indicconformer","note_llm":"even note-gen (qwen)","base_env":"INDICCONFORMER_BASE_URL"}'::jsonb, 65)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (27, '0027_indicconformer') ON CONFLICT DO NOTHING;
