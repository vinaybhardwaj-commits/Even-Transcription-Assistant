-- =====================================================================
-- Migration 0002 — llm_traces (OPD-style per-pipeline tracing)
--
-- Decision: keep ETA's existing per-stage `trace` table (PRD §6.1, CDMSS shape)
-- AND add an OPD-style `llm_traces` table for the lifted observability components
-- (TracePanel, BackgroundTraceToaster, AiActivityList). Different audiences:
--   - `trace` = per-stage forensic detail (one row per LLM call within a pipeline)
--   - `llm_traces` = per-pipeline UX feedback (one row per multi-stage fire,
--     events as JSONB array)
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS llm_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  surface         TEXT NOT NULL,
  encounter_id    TEXT REFERENCES encounter(id) ON DELETE SET NULL,
  patient_id      TEXT,
  doctor_email    TEXT,
  request_input   JSONB,
  events          JSONB NOT NULL DEFAULT '[]'::jsonb,
  result_summary  JSONB,
  model_calls     JSONB,
  total_ms        INTEGER,
  status          TEXT NOT NULL DEFAULT 'in_progress',
  error_message   TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_llm_traces_surface_started   ON llm_traces(surface, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_llm_traces_encounter_started ON llm_traces(encounter_id, started_at DESC) WHERE encounter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_traces_patient_started   ON llm_traces(patient_id, started_at DESC) WHERE patient_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_traces_doctor_started    ON llm_traces(doctor_email, started_at DESC) WHERE doctor_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_llm_traces_status            ON llm_traces(status, started_at DESC) WHERE status != 'completed';

INSERT INTO schema_migrations (version, name) VALUES (2, '0002_llm_traces') ON CONFLICT DO NOTHING;

COMMIT;
