-- =====================================================================
-- Migration 0022 — seed the virtual 'even_pipeline' scribe-tier competitor
-- (the encounter's own transcribe->LLM note). It has no code adapter; the
-- scribe fan-out fills its rows from encounter.note_json. Lets it appear in the
-- Engines tab + scribe leaderboard with a name.
-- =====================================================================
INSERT INTO stt_engine (id, display_name, adapter_key, capabilities_json, enabled, fanout_enabled, is_paid, cost_per_min_usd, config_json, sort_order) VALUES
  ('even_pipeline', 'Even pipeline (ASR → LLM note)', 'even_pipeline',
   '{"tiers":["scribe"],"stages":["note"],"languages":["multi"],"streaming":false,"translates":true,"async":false}'::jsonb,
   true, true, false, 0, '{"virtual":true,"source":"encounter.note_json"}'::jsonb, 60)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (22, '0022_stt_even_pipeline') ON CONFLICT DO NOTHING;
