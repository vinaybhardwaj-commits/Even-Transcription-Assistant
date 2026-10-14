-- 0042_preop_risk.sql — the Pre-op Risk Agent's three tables (CDMSS-PREOP-RISK-AGENT-PRD
-- v1.1-LOCKED, 26 Aug 2026; Build Plan B1). REFERENCE COPY, DOCUMENTATION ONLY — the
-- executable path is POST /api/admin/migrate-preop, which runs this DDL idempotently.
--
--   preop_findings         one LIVE row per surgical episode, keyed (episode_key,
--                          engine_version); episode_key = surgery_cases._doc_id. The
--                          current snapshot as jsonb, plus scalar copies of everything
--                          the board filters or sorts on.
--   preop_finding_versions append-only history — one row per reading that was replaced
--                          ('overwrite') or deliberately re-run ('replay'). This table
--                          IS the case page's snapshot timeline (readmissions R8.1 rail).
--   preop_sweeps           one row per worker tick. Beyond the two tables the Build Plan
--                          names, and flagged for V: the board's "last sweep" stamp needs
--                          a heartbeat, and writing it onto the finding rows would break
--                          the "second tick writes nothing" idempotency guarantee.
--
-- No GRANTs: every sibling table is created by and read through the same DATABASE_URL
-- role, and no sibling migration issues one. See the route header.

CREATE TABLE IF NOT EXISTS preop_findings (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source           TEXT NOT NULL DEFAULT 'standalone',
      episode_key          TEXT NOT NULL,
      engine_version       TEXT NOT NULL DEFAULT 'preop-risk/0.1',
      individual_uid       TEXT,
      uhid                 TEXT,
      patient_name         TEXT,
      age                  INT,
      sex                  TEXT,
      procedure            TEXT,
      hospital             TEXT,
      department           TEXT,
      surgeon              TEXT,
      surgery_date         DATE,
      tier                 TEXT,
      rcri_lo              INT,
      rcri_hi              INT,
      mfi_lo               INT,
      mfi_hi               INT,
      cci_lo               INT,
      cci_hi               INT,
      needs_review         BOOLEAN NOT NULL DEFAULT FALSE,
      booking_only         BOOLEAN NOT NULL DEFAULT FALSE,
      pac_on_file          BOOLEAN NOT NULL DEFAULT FALSE,
      pac_status           TEXT,
      pac_report_uid       TEXT,
      pac_finalized_at     TIMESTAMPTZ,
      pac_verdict          TEXT,
      why_line             TEXT,
      missing_line         TEXT,
      situation_line       TEXT,
      snapshot             JSONB NOT NULL,
      snapshot_fingerprint TEXT NOT NULL,
      version_no           INT NOT NULL DEFAULT 1,
      reviewed_at          TIMESTAMPTZ,
      reviewed_by          TEXT,
      reviewed_version     INT,
      computed_at          TIMESTAMPTZ,
      trace_id             TEXT
    );

CREATE UNIQUE INDEX IF NOT EXISTS preop_findings_key_engine_uq
      ON preop_findings (episode_key, engine_version);

CREATE INDEX IF NOT EXISTS preop_findings_surgery_idx
      ON preop_findings (engine_version, surgery_date);

CREATE INDEX IF NOT EXISTS preop_findings_tier_idx ON preop_findings (tier);

CREATE INDEX IF NOT EXISTS preop_findings_review_idx
      ON preop_findings (needs_review, surgery_date);

CREATE INDEX IF NOT EXISTS preop_findings_individual_idx ON preop_findings (individual_uid);

CREATE TABLE IF NOT EXISTS preop_finding_versions (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      captured_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source           TEXT NOT NULL DEFAULT 'standalone',
      capture_reason       TEXT NOT NULL,
      episode_key          TEXT NOT NULL,
      engine_version       TEXT NOT NULL,
      version_no           INT,
      tier                 TEXT,
      rcri_lo              INT,
      rcri_hi              INT,
      mfi_lo               INT,
      mfi_hi               INT,
      cci_lo               INT,
      cci_hi               INT,
      snapshot_fingerprint TEXT,
      capture_note         TEXT,
      computed_at          TIMESTAMPTZ,
      row_snapshot         JSONB NOT NULL,
      trace_id             TEXT
    );

CREATE INDEX IF NOT EXISTS preop_finding_versions_key_idx
      ON preop_finding_versions (episode_key, engine_version, captured_at ASC);

CREATE INDEX IF NOT EXISTS preop_finding_versions_reason_idx
      ON preop_finding_versions (capture_reason, captured_at DESC);

CREATE TABLE IF NOT EXISTS preop_sweeps (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ran_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      app_source     TEXT NOT NULL DEFAULT 'standalone',
      engine_version TEXT NOT NULL,
      episodes       INT NOT NULL DEFAULT 0,
      inserted       INT NOT NULL DEFAULT 0,
      updated        INT NOT NULL DEFAULT 0,
      unchanged      INT NOT NULL DEFAULT 0,
      skipped        INT NOT NULL DEFAULT 0,
      by_tier        JSONB,
      pac_linked     INT NOT NULL DEFAULT 0,
      ms             INT NOT NULL DEFAULT 0,
      notes          TEXT
    );

CREATE INDEX IF NOT EXISTS preop_sweeps_engine_idx
      ON preop_sweeps (engine_version, ran_at DESC);
