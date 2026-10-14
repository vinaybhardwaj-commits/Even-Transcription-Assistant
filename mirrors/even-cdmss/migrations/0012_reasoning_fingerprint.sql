-- 0012_reasoning_fingerprint — Reasoning Observability Stage 1 (Invocation Envelope).
-- Promotes the reasoning fingerprint from trace_events.payload JSONB into queryable
-- columns, stamped at the tracedChat choke point from the Stage-0 prompt registry.
-- All columns NULLABLE + additive + idempotent: existing rows stay null, every
-- existing writer is untouched, and re-running this file is a no-op.
-- Applied by POST /api/admin/migrate-reasoning (the admin route mirrors migrate-v8).

ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS prompt_id             TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS prompt_version        TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS prompt_hash           TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS rubric_versions       JSONB;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS output_schema_version TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS call_model            TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS call_provider         TEXT;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS gen_params            JSONB;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS tokens_in             INTEGER;
ALTER TABLE trace_events ADD COLUMN IF NOT EXISTS tokens_out            INTEGER;

-- Distinct registry ids used in the trace (list/filter rollup on the Runs tab, Stage 2).
ALTER TABLE traces ADD COLUMN IF NOT EXISTS prompt_ids JSONB;

CREATE INDEX IF NOT EXISTS trace_events_prompt_idx ON trace_events (prompt_id, prompt_version);
