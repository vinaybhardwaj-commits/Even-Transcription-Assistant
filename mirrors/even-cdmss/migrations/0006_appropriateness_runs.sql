-- 0006_appropriateness_runs — research retention for the /appropriateness modes.
-- One row per COMPLETED run of any mode (check | pathway | audit). Stores the full,
-- DE-IDENTIFIED output JSON so researchers can re-export it to Excel and so every use
-- is auditable in admin. The case-audit extractor strips name/UHID, so no direct
-- identifiers are captured here (de_identified defaults TRUE). Anonymous (no per-user
-- attribution — CAT has no clinician login). Shared Neon DB; tagged app_source='standalone'.

CREATE TABLE IF NOT EXISTS appropriateness_runs (
  id            TEXT PRIMARY KEY,                         -- uuid
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  mode          TEXT NOT NULL CHECK (mode IN ('check','pathway','audit')),
  app_source    TEXT NOT NULL DEFAULT 'standalone',
  scenario      TEXT,                                     -- de-identified input scenario / dx snippet
  doc_type      TEXT,                                     -- audit: discharge_summary | ot_note | opd_rx
  summary       TEXT,                                     -- short human one-liner
  n_sources     INT NOT NULL DEFAULT 0,
  n_findings    INT NOT NULL DEFAULT 0,
  input         JSONB,                                    -- {proposedActions, patient:{age,sex}, region, docType}
  output        JSONB NOT NULL,                           -- full result payload (de-identified)
  de_identified BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS appropriateness_runs_mode_idx    ON appropriateness_runs (mode, created_at DESC);
CREATE INDEX IF NOT EXISTS appropriateness_runs_created_idx ON appropriateness_runs (created_at DESC);
