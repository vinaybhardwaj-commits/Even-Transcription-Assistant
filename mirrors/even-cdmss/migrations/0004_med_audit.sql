-- 0004_med_audit.sql — Medication Chart Audit (EHRC Clinical Pharmacist surface)
-- Applied in-app via POST /api/admin/migrate-medaudit (admin-gated). This file is
-- the version-controlled reference; keep the two in sync.

-- Formulary (EHRC Pharmacy Formulary 2026, 2,174 items). Seeded from
-- data/formulary-2026.json via POST /api/admin/seed-formulary.
CREATE TABLE IF NOT EXISTS formulary (
  id              BIGSERIAL PRIMARY KEY,
  item_code       TEXT,
  brand           TEXT,
  generic         TEXT NOT NULL,
  generic_canon   TEXT NOT NULL,
  dosage_form     TEXT,
  major_grouping  TEXT,
  minor_grouping  TEXT,
  manufacturer    TEXT,
  schedule_dc     TEXT,
  schedule_ip     TEXT,
  dept_primary    TEXT,
  dept_secondary  TEXT,
  high_risk       BOOLEAN DEFAULT FALSE,   -- ISMP high-alert
  lasa            TEXT,                     -- look-alike/sound-alike
  ved             TEXT,                     -- WHO V/E/D
  audit_category  TEXT,                     -- antibiotic|gi|pain|dvt|anaesthetic|other
  restricted      BOOLEAN DEFAULT FALSE,    -- reserve antibiotic (AMS-curated)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS formulary_canon_idx    ON formulary (generic_canon);
CREATE INDEX IF NOT EXISTS formulary_category_idx  ON formulary (audit_category);
CREATE INDEX IF NOT EXISTS formulary_restricted_idx ON formulary (restricted) WHERE restricted;

-- One audit = one patient medication chart, captured prospectively on rounds.
CREATE TABLE IF NOT EXISTS med_audit_session (
  id                   BIGSERIAL PRIMARY KEY,
  uhid                 TEXT,
  auditor              TEXT,
  audit_date           DATE,
  location             TEXT,
  admission_date       DATE,
  consultant           TEXT,
  allergies_documented TEXT,                 -- 'yes' | 'no' | null
  known_allergies      JSONB DEFAULT '[]'::jsonb,
  status               TEXT DEFAULT 'final',  -- 'draft' | 'final'
  app_source           TEXT DEFAULT 'medaudit',
  created_by           TEXT,
  created_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS med_audit_session_uhid_idx ON med_audit_session (uhid, created_at DESC);

CREATE TABLE IF NOT EXISTS med_audit_drug (
  id            BIGSERIAL PRIMARY KEY,
  session_id    BIGINT REFERENCES med_audit_session(id) ON DELETE CASCADE,
  position      INT,
  name          TEXT NOT NULL,
  category      TEXT,
  dose          TEXT,
  frequency     TEXT,
  route         TEXT,
  reserve       BOOLEAN DEFAULT FALSE,
  high_alert    BOOLEAN DEFAULT FALSE,
  formulary_id  BIGINT REFERENCES formulary(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS med_audit_drug_session_idx ON med_audit_drug (session_id);

-- One row per flagged parameter (status != 'no error'). NCC MERP A–I on errors.
CREATE TABLE IF NOT EXISTS med_audit_finding (
  id          BIGSERIAL PRIMARY KEY,
  drug_id     BIGINT REFERENCES med_audit_drug(id) ON DELETE CASCADE,
  param_no    INT NOT NULL,
  param_label TEXT,
  status      TEXT NOT NULL,    -- 'error' | 'na'
  ncc_merp    CHAR(1),          -- A–I when status='error'
  note        TEXT
);
CREATE INDEX IF NOT EXISTS med_audit_finding_drug_idx ON med_audit_finding (drug_id);
