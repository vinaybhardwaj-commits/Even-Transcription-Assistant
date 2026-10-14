-- DDL only, copied verbatim from the CDMSS reference migrations (0005, 0007, 0042, 0047, 0061). No data.

-- from 0005_choosing_wisely.sql
CREATE TABLE IF NOT EXISTS lvc_recommendations (
  id                  TEXT PRIMARY KEY,            -- <region>-<society>-<ordinal>, e.g. cwin-ncg-004
  region              TEXT NOT NULL,               -- US | CA | IN
  society             TEXT NOT NULL,
  specialty           TEXT,
  statement           TEXT NOT NULL,               -- verbatim "Don't / Avoid" line
  precondition        TEXT,                        -- conditional setting the applicability judge confirms
  action_type         TEXT,                        -- imaging|lab|medication|procedure|screening|monitoring|referral|other
  consider_instead    TEXT,
  rationale           TEXT,
  keywords            TEXT[] DEFAULT '{}',         -- test/treatment names + synonyms for the deterministic match leg
  citation_doi        TEXT,
  citation_pmid       TEXT,
  citation_url        TEXT,
  source_release_year INT,
  status              TEXT DEFAULT 'active',        -- active | superseded | withdrawn
  chunk_text_hash     TEXT,                         -- links to the embedded mksap_chunks row (provenance both ways)
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS lvc_region_idx      ON lvc_recommendations (region);
CREATE INDEX IF NOT EXISTS lvc_specialty_idx   ON lvc_recommendations (specialty);
CREATE INDEX IF NOT EXISTS lvc_action_type_idx ON lvc_recommendations (action_type);
CREATE INDEX IF NOT EXISTS lvc_status_idx      ON lvc_recommendations (status);
CREATE INDEX IF NOT EXISTS lvc_keywords_gin    ON lvc_recommendations USING GIN (keywords);

-- from 0007_opd_note_audits.sql
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

-- from 0042_preop_risk.sql
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

-- from 0047_clinical_states.sql
CREATE TABLE IF NOT EXISTS clinical_states (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  doc_kind        TEXT NOT NULL,
  source_uid      TEXT NOT NULL,
  member_uid      TEXT,
  encounter_ref   TEXT,
  schema_version  TEXT NOT NULL,
  status          TEXT NOT NULL,
  state_json      JSONB NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS clinical_states_doc_idx
  ON clinical_states (doc_kind, source_uid, schema_version);
CREATE INDEX IF NOT EXISTS clinical_states_encounter_idx
  ON clinical_states (encounter_ref, schema_version);
CREATE INDEX IF NOT EXISTS clinical_states_member_idx
  ON clinical_states (member_uid, schema_version);

-- from 0049_stay_library_hardening.sql:74-76
ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS check_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clinical_states ADD COLUMN IF NOT EXISTS superseded_by   UUID;

-- from 0061_ot_note_audits.sql
CREATE TABLE IF NOT EXISTS ot_note_audits (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audited_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_source             TEXT NOT NULL DEFAULT 'standalone',
  note_class             TEXT NOT NULL DEFAULT 'ot',

  -- link-back keys (db13 kx_clinical_template_ot_notes); never sent to an LLM as PHI chrome
  uid                    TEXT NOT NULL,
  hospital_uid           TEXT,
  facility_id            TEXT,
  encounter_id           TEXT,
  uhid                   TEXT,
  surgery_name           TEXT,
  surgeon_raw            TEXT,
  note_day               DATE NOT NULL,
  note_created_at        TIMESTAMPTZ,
  note_modified_at       TIMESTAMPTZ,
  scraped_at             TIMESTAMPTZ,

  -- body + structured extras
  note                   TEXT,
  component_json         JSONB,

  -- surgeon hop (fail-closed)
  doctor_uid             TEXT,
  map_status             TEXT NOT NULL DEFAULT 'unmapped',
  -- mapped | unmapped | multi_surgeon_hold

  -- findings (queue card shape; same OpdFinding / stampFindingIdentity vocabulary)
  n_findings             INT NOT NULL DEFAULT 0,
  findings               JSONB,

  engine_version         TEXT NOT NULL DEFAULT 'ot-note-audit/0.1',
  model                  TEXT,
  trace_id               TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ot_note_audits_uid_engine_uq
  ON ot_note_audits (uid, engine_version);
CREATE INDEX IF NOT EXISTS ot_note_audits_note_day_idx
  ON ot_note_audits (note_day DESC);
CREATE INDEX IF NOT EXISTS ot_note_audits_doctor_uid_idx
  ON ot_note_audits (doctor_uid);
CREATE INDEX IF NOT EXISTS ot_note_audits_map_status_idx
  ON ot_note_audits (map_status);
CREATE INDEX IF NOT EXISTS ot_note_audits_hospital_uid_idx
  ON ot_note_audits (hospital_uid);
CREATE TABLE IF NOT EXISTS ot_surgeon_map (
  surgeon_key            TEXT PRIMARY KEY,
  doctor_uid             TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'surfer_seed_n3plus_y',
  seeded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ot_surgeon_map_doctor_uid_idx
  ON ot_surgeon_map (doctor_uid);
