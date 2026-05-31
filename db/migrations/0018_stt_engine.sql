-- =====================================================================
-- Migration 0018 — stt_engine registry (STT Engine Lab L0).
-- One row per speech-to-text / scribe engine. A code adapter
-- (lib/stt/adapters/<adapter_key>.ts) implements the actual calls; this
-- table controls enable/fan-out/cost/config so a new engine = 1 adapter
-- file + 1 row (no schema/UI change). Additive; nothing reads it until L0c.
-- =====================================================================
CREATE TABLE IF NOT EXISTS stt_engine (
  id                text PRIMARY KEY,            -- slug, e.g. 'deepgram'
  display_name      text NOT NULL,
  adapter_key       text NOT NULL,               -- maps to a code adapter
  capabilities_json jsonb NOT NULL DEFAULT '{}'::jsonb, -- {tiers,stages,languages,streaming,translates,async}
  enabled           boolean NOT NULL DEFAULT true,       -- selectable in routing pool
  fanout_enabled    boolean NOT NULL DEFAULT true,       -- participates in offline fan-out
  is_paid           boolean NOT NULL DEFAULT true,
  cost_per_min_usd  numeric(10,5),                       -- NULL = unknown (admin fills later)
  config_json       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- model name, env var names, thresholds
  sort_order        integer NOT NULL DEFAULT 100,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Seed the three live engines (enabled) + the two new ones (disabled until L6/L7).
INSERT INTO stt_engine (id, display_name, adapter_key, capabilities_json, enabled, fanout_enabled, is_paid, cost_per_min_usd, config_json, sort_order) VALUES
  ('deepgram',   'Deepgram nova-3-medical', 'deepgram',
     '{"tiers":["asr"],"stages":["live","note"],"languages":["english"],"streaming":true,"translates":false,"async":false}'::jsonb,
     true,  true,  true,  NULL, '{"model":"nova-3-medical","key_env":"DEEPGRAM_API_KEY"}'::jsonb, 10),
  ('whisper',    'Whisper large-v3-turbo (Mac Mini)', 'whisper',
     '{"tiers":["asr"],"stages":["live","note"],"languages":["multi"],"streaming":false,"translates":false,"async":false}'::jsonb,
     true,  true,  false, 0,    '{"model":"ggml-large-v3-turbo","base_env":"WHISPER_BASE_URL"}'::jsonb, 20),
  ('sarvam',     'Sarvam Saaras v3', 'sarvam',
     '{"tiers":["asr"],"stages":["live","note"],"languages":["indic","multi"],"streaming":true,"translates":true,"async":false}'::jsonb,
     true,  true,  true,  NULL, '{"model":"saaras:v3","key_env":"SARVAM_API_KEY"}'::jsonb, 30),
  ('elevenlabs', 'ElevenLabs Scribe v2', 'elevenlabs',
     '{"tiers":["asr"],"stages":["live","note"],"languages":["multi"],"streaming":true,"translates":false,"async":false}'::jsonb,
     false, false, true,  NULL, '{"model":"scribe_v1","key_env":"ELEVENLABS_API_KEY"}'::jsonb, 40),
  ('ekascribe',  'EkaScribe v2 (eka.care)', 'ekascribe',
     '{"tiers":["asr","scribe"],"stages":["note"],"languages":["indic","multi"],"streaming":false,"translates":true,"async":true}'::jsonb,
     false, false, true,  NULL, '{"client_id_env":"EKACARE_CLIENT_ID","client_secret_env":"EKACARE_CLIENT_SECRET","asr_template":"transcript_template","scribe_template":"clinical_notes_template","model":"pro"}'::jsonb, 50)
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (18, '0018_stt_engine') ON CONFLICT DO NOTHING;
