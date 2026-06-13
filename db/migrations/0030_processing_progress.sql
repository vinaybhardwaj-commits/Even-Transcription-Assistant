-- =====================================================================
-- Migration 0030 — persist pipeline progress so it's visible while the
-- background CDS pipeline runs (Library progress bar + in-detail stage tracker).
-- Updated by /process on each stage transition; additive/nullable.
-- =====================================================================
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS processing_pct    integer;
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS processing_stages jsonb;

INSERT INTO schema_migrations (version, name) VALUES (30, '0030_processing_progress') ON CONFLICT DO NOTHING;
