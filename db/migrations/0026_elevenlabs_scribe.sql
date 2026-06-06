-- =====================================================================
-- Migration 0026 — ElevenLabs scribe-tier engine; EkaScribe retired (V, 6 Jun 2026).
-- V decision: EkaScribe is too expensive — DISABLE it (keep the adapter code,
-- API path and row intact so it can be re-enabled anytime) and showcase
-- ElevenLabs in the demo instead, as a composite scribe-tier competitor:
-- ElevenLabs Scribe v2 ASR → the SAME Even note-gen LLM → note, rubric-scored
-- vs even_pipeline. Adapter: lib/stt/adapters/elevenlabs-scribe.ts.
-- =====================================================================

-- 1) EkaScribe off (row kept; reversible from the Engines tab).
UPDATE stt_engine
   SET enabled = false, fanout_enabled = false
 WHERE id = 'ekascribe';

-- 2) New composite scribe engine (ASR under test = ElevenLabs; note LLM = Even's).
INSERT INTO stt_engine (id, display_name, adapter_key, capabilities_json, enabled, fanout_enabled, is_paid, cost_per_min_usd, config_json, sort_order) VALUES
  ('elevenlabs_scribe', 'ElevenLabs → Even Note', 'elevenlabs_scribe',
     '{"tiers":["scribe"],"stages":["note"],"languages":["multi"],"streaming":false,"translates":false,"async":false}'::jsonb,
     true, true, true, NULL,
     '{"asr":"elevenlabs scribe_v2","note_llm":"even note-gen (qwen via OLLAMA_BASE_URL)","key_env":"ELEVENLABS_API_KEY"}'::jsonb, 45)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (26, '0026_elevenlabs_scribe') ON CONFLICT DO NOTHING;
