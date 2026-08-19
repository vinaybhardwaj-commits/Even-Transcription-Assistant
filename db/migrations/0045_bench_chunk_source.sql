-- =====================================================================
-- Migration 0045 — bench_chunk.source (Room Bench dual-mic capture,
-- Kickoff K-B, 19 Aug 2026). Additive + idempotent.
--
-- Every session now carries TWO chunk streams from two microphones:
--   'primary' — the USB conference mic (today's path; R2 chunk_{idx}.webm)
--   'backup'  — the machine's built-in/second mic, recorded in lockstep
--               (R2 backup_chunk_{idx}.webm in the same session folder)
-- Existing rows default to 'primary' — byte-identical history.
-- Uniqueness moves from (session_id, idx) to (session_id, source, idx):
-- 0041 declared `UNIQUE (session_id, idx)` unnamed, which Postgres names
-- bench_chunk_session_id_idx_key; dropped IF EXISTS and replaced.
-- =====================================================================

ALTER TABLE bench_chunk
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'primary';

DO $$ BEGIN
  ALTER TABLE bench_chunk
    ADD CONSTRAINT bench_chunk_source_check CHECK (source IN ('primary','backup'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Replace the (session_id, idx) uniqueness with (session_id, source, idx).
ALTER TABLE bench_chunk DROP CONSTRAINT IF EXISTS bench_chunk_session_id_idx_key;

DO $$ BEGIN
  ALTER TABLE bench_chunk
    ADD CONSTRAINT bench_chunk_session_source_idx_key UNIQUE (session_id, source, idx);
EXCEPTION WHEN duplicate_table THEN NULL;
          WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS bench_chunk_session_source_idx
  ON bench_chunk (session_id, source, idx);

INSERT INTO schema_migrations (version, name)
VALUES (45, '0045_bench_chunk_source')
ON CONFLICT DO NOTHING;
