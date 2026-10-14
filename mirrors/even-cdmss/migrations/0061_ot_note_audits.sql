-- 0061_ot_note_audits.sql — greenfield OT note audit store + curated surgeon map.
--
-- Source grain: Metabase db13 public.kx_clinical_template_ot_notes.uid (final-only).
-- surgery_cases is bookings only and must never appear as note grain.
-- Doctor identity is the curated surgeon string → Pulse doctors.uid map only.
-- Never KX *_doctor_id. Never current_treating_doctor as operating surgeon.
--
-- Does not set TRIAGE_BOT_WRITE. Does not set TRIAGE_BOT_WRITE_CLASSES.
-- Does not enable note_class=ot route mint.

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

-- Curated free-text surgeon → Pulse doctors.uid. Seeded from Surfer n≥3 Y rows
-- that resolve to exactly one Pulse uid. N rows and multiline dumps stay unmapped.
CREATE TABLE IF NOT EXISTS ot_surgeon_map (
  surgeon_key            TEXT PRIMARY KEY,
  doctor_uid             TEXT NOT NULL,
  source                 TEXT NOT NULL DEFAULT 'surfer_seed_n3plus_y',
  seeded_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ot_surgeon_map_doctor_uid_idx
  ON ot_surgeon_map (doctor_uid);
