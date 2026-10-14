-- 0008_ccb_briefs — persisted Care Conversation Briefs (CCB P1).
-- One row per generated brief (the de-identified CcbEnvelope as jsonb). The clinical content
-- reaching the LLM is de-identified; the re-identification keys (presc_uid/individual_uid/uhid/
-- kx_encounter_id) are retained HERE only so a clinician-admin can join back to db13 and so the
-- P5 conversion funnel can link forward (uhid → kx_billing IP; individual_uid → surgery_cases).
-- No patient names/UHID text bodies are stored beyond these keys. Shared Neon DB; app_source 'standalone'.
--
-- Idempotency: UNIQUE (presc_uid, engine_version) — re-runs are safe; a new engine version can
-- regenerate the same episode's brief without clobbering the prior row.

CREATE TABLE IF NOT EXISTS ccb_briefs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source            TEXT NOT NULL DEFAULT 'standalone',

  -- link-back / forward-join keys (never sent to the LLM)
  presc_uid             TEXT NOT NULL,
  individual_uid        TEXT NOT NULL,
  uhid                  TEXT,
  kx_encounter_id       TEXT,
  note_date             TIMESTAMPTZ,
  coverage              TEXT,                 -- 'rich' | 'order_only'

  engine_version        TEXT NOT NULL DEFAULT 'care-brief/0.1',

  -- denormalised headline (for dashboards + the P5 funnel)
  priority              TEXT,
  pitch_allowed         BOOLEAN,
  n_findings            INT,
  n_cited               INT,
  citation_coverage_pct INT,
  distinct_sources      INT,

  envelope              JSONB NOT NULL,       -- the full de-identified CcbEnvelope
  model                 TEXT,
  trace_id              TEXT,
  latency_ms            INT
);

CREATE UNIQUE INDEX IF NOT EXISTS ccb_briefs_presc_engine_uq ON ccb_briefs (presc_uid, engine_version);
CREATE INDEX IF NOT EXISTS ccb_briefs_note_date_idx ON ccb_briefs (note_date DESC);
CREATE INDEX IF NOT EXISTS ccb_briefs_individual_idx ON ccb_briefs (individual_uid);
CREATE INDEX IF NOT EXISTS ccb_briefs_uhid_idx ON ccb_briefs (uhid);
CREATE INDEX IF NOT EXISTS ccb_briefs_pitch_idx ON ccb_briefs (pitch_allowed);
