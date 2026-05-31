-- =====================================================================
-- Migration 0019 — STT Engine Lab L1 (offline fan-out).
-- (a) Extend transcription_run for the lab (tier + per-engine id + cost +
--     scoring columns used by L2/L3 + scribe-tier note columns used by L7).
-- (b) stt_fanout_job: one queue row per encounter (drained by the worker).
-- (c) stt_lab_config: singleton (daily budget, concurrency, judge model).
-- Additive + idempotent. Nothing in the doctor path changes.
-- =====================================================================
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS tier            text NOT NULL DEFAULT 'asr'; -- asr | scribe
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS stt_engine_id   text;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS cost_usd        numeric(10,5);
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS wer             double precision;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS cer             double precision;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS med_term_recall double precision;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS agreement_score double precision;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS note_text       text;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS note_json       jsonb;
ALTER TABLE transcription_run ADD COLUMN IF NOT EXISTS metrics_json    jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_transcription_run_engine_mode ON transcription_run (encounter_id, engine, mode, tier);

CREATE TABLE IF NOT EXISTS stt_fanout_job (
  encounter_id text PRIMARY KEY REFERENCES encounter(id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'pending',   -- pending | running | done | failed | deferred
  attempts     integer NOT NULL DEFAULT 0,
  error        text,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_stt_fanout_job_status ON stt_fanout_job (status, enqueued_at);

CREATE TABLE IF NOT EXISTS stt_lab_config (
  id                 integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  daily_budget_usd   numeric(10,2) NOT NULL DEFAULT 5,
  fanout_concurrency integer NOT NULL DEFAULT 3,
  judge_model        text NOT NULL DEFAULT 'qwen',
  weights_json       jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at         timestamptz NOT NULL DEFAULT now()
);
INSERT INTO stt_lab_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name) VALUES (19, '0019_stt_fanout') ON CONFLICT DO NOTHING;
