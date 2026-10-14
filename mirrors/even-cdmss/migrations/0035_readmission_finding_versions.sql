-- 0035_readmission_finding_versions.sql — R8.1 finding versions (CDMSS-READMISSIONS-R8.1-
-- FINDING-VERSIONS PRD v1.0, 20 Aug 2026). REFERENCE COPY, DOCUMENTATION ONLY — the
-- executable path is POST /api/admin/migrate-readmission-versions, which runs this DDL
-- idempotently. R8 takes 0036.
--
-- One row per READING of a case. capture_reason is a closed set of exactly two:
--   'overwrite' — the reading a re-audit or refresh was about to replace (written by
--                 saveAuditResult in the same statement as its UPDATE, so a crash can
--                 never leave a snapshot with no overwrite behind it — O2 blocks the
--                 UPDATE when the snapshot fails);
--   'replay'    — a deliberate stability re-run; the snapshot is the NEW reading and the
--                 live readmission_findings row was not touched (O5).
-- O1: row_snapshot holds the whole row as JSON so a future engine's columns never go
-- stale; the scalar columns are copies for querying. template_coverage is lifted out of
-- the finding blob because it answers "did the evidence differ between these readings".
-- O4: nothing user-facing reads this table.

CREATE TABLE IF NOT EXISTS readmission_finding_versions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source      TEXT NOT NULL DEFAULT 'standalone',
  capture_reason  TEXT NOT NULL,
  dedup_key       TEXT NOT NULL,
  engine_version  TEXT NOT NULL,
  avoidable       TEXT,
  planned         TEXT,
  same_condition  TEXT,
  preventable_injury TEXT,
  audit_status    TEXT,
  model           TEXT,
  provider        TEXT,
  audited_at      TIMESTAMPTZ,
  template_coverage JSONB,
  row_snapshot    JSONB NOT NULL,
  trace_id        TEXT
);
CREATE INDEX IF NOT EXISTS readmission_finding_versions_key_idx
  ON readmission_finding_versions (dedup_key, engine_version, captured_at DESC);
CREATE INDEX IF NOT EXISTS readmission_finding_versions_reason_idx
  ON readmission_finding_versions (capture_reason, captured_at DESC);
