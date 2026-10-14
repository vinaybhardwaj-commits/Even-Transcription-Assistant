-- 0007_opd_note_audits — persisted OPD note-quality audits (M2 of the OPD Audit pipeline).
-- One row per audited OPD note. The clinical CONTENT is de-identified before it reaches the
-- LLM, but the four re-identification KEYS (uid/consult_uid/doctor_uid/kx_encounter_id) are
-- retained here so a clinician-admin can join back to db13 `individuals-prescriptions` and the
-- patient encounter (V's constraint). No patient names/UHID are stored. Shared Neon DB;
-- app_source defaults 'standalone'. The dashboard (M3) aggregates these by day/doctor/band.
--
-- Idempotency: UNIQUE (uid, engine_version) — the worker re-runs safely, and a new engine
-- version can re-audit the same note without clobbering the prior row.

CREATE TABLE IF NOT EXISTS opd_note_audits (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audited_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source           TEXT NOT NULL DEFAULT 'standalone',

  -- link-back keys (re-identification path into db13; never sent to the LLM)
  uid                  TEXT NOT NULL,
  consult_uid          TEXT,
  doctor_uid           TEXT,
  kx_encounter_id      TEXT,
  note_date            TIMESTAMPTZ,
  prescription_type    TEXT,
  consult_type         TEXT,
  de_identified        BOOLEAN NOT NULL DEFAULT TRUE,

  -- headline
  note_quality_index   INT NOT NULL,
  band                 TEXT NOT NULL,

  -- 5 domain scores (0..100)
  score_documentation       INT,
  score_note_quality        INT,
  score_appropriateness     INT,
  score_prescribing_safety  INT,
  score_patient_centred     INT,

  -- detail
  pdqi9                JSONB,
  completeness_pct     INT,
  n_missing_mandatory  INT,
  n_findings           INT NOT NULL DEFAULT 0,
  n_low_value          INT NOT NULL DEFAULT 0,
  n_context_dependent  INT NOT NULL DEFAULT 0,
  n_interaction_alerts INT NOT NULL DEFAULT 0,
  findings             JSONB,
  suggestions          JSONB,

  engine_version       TEXT NOT NULL DEFAULT 'opd-note-audit/0.1',
  model                TEXT,
  trace_id             TEXT,
  latency_ms           INT
);

CREATE UNIQUE INDEX IF NOT EXISTS opd_note_audits_uid_engine_uq   ON opd_note_audits (uid, engine_version);
CREATE INDEX        IF NOT EXISTS opd_note_audits_note_date_idx   ON opd_note_audits (note_date DESC);
CREATE INDEX        IF NOT EXISTS opd_note_audits_doctor_idx      ON opd_note_audits (doctor_uid);
CREATE INDEX        IF NOT EXISTS opd_note_audits_band_idx        ON opd_note_audits (band);
CREATE INDEX        IF NOT EXISTS opd_note_audits_consult_type_idx ON opd_note_audits (consult_type);
