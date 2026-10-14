-- 0013_ipd_discharge_audits — persisted IPD discharge-summary audits (M1 of the IPD
-- Discharge-Audit module). One row per audited discharge summary. The clinical CONTENT is
-- de-identified before it reaches the LLM (doc-audit extract's cardinal privacy rule), but the
-- re-identification KEYS (document_id/ip_uid/member_id) are retained here so a clinician-admin
-- can join back to db13 `accounts-members-miscellaneous_documents` and the KareXpert IP
-- admission (V's constraint, same posture as 0007). No patient names/UHID are stored. Shared
-- Neon DB; app_source defaults 'standalone'.
--
-- Idempotency: UNIQUE (document_id, engine_version) — the worker re-runs safely, the Mini/Qwen
-- backfill coexists with prod rows via its '-mini' engine-version suffix, and a new engine
-- version can re-audit the same summary without clobbering the prior row.

CREATE TABLE IF NOT EXISTS ipd_discharge_audits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audited_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source             TEXT NOT NULL DEFAULT 'standalone',

  -- link-back keys (re-identification path into db13; never sent to the LLM)
  document_id            TEXT NOT NULL,       -- miscellaneous_documents _doc_id
  ip_uid                 TEXT,                -- IP booking id ('IP-NNN')
  member_id              TEXT,                -- _parent_doc_id
  speciality             TEXT,
  discharge_type         TEXT,
  los_days               INT,
  discharged_at          TIMESTAMPTZ,
  de_identified          BOOLEAN NOT NULL DEFAULT TRUE,

  -- headline (Care-Value Scorecard)
  care_value_index       INT NOT NULL,
  band                   TEXT NOT NULL,

  -- 6 domain scores (0..100)
  score_appropriateness  INT,
  score_efficiency       INT,
  score_safety           INT,
  score_cost             INT,
  score_documentation    INT,
  score_patient_centred  INT,

  -- detail
  completeness_pct       INT,
  n_findings             INT NOT NULL DEFAULT 0,
  n_low_value            INT NOT NULL DEFAULT 0,
  n_context_dependent    INT NOT NULL DEFAULT 0,
  findings               JSONB,
  suggestions            JSONB,
  billed_total           NUMERIC,             -- populated by the M3 billing join; NULL until then

  -- provenance
  engine_version         TEXT NOT NULL DEFAULT 'ipd-discharge-audit/0.1',
  model                  TEXT,
  trace_id               TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ipd_discharge_audits_doc_engine_uq ON ipd_discharge_audits (document_id, engine_version);
CREATE INDEX        IF NOT EXISTS ipd_discharge_audits_discharged_idx ON ipd_discharge_audits (discharged_at DESC);
CREATE INDEX        IF NOT EXISTS ipd_discharge_audits_speciality_idx ON ipd_discharge_audits (speciality);
CREATE INDEX        IF NOT EXISTS ipd_discharge_audits_band_idx       ON ipd_discharge_audits (band);
CREATE INDEX        IF NOT EXISTS ipd_discharge_audits_ip_uid_idx     ON ipd_discharge_audits (ip_uid);
