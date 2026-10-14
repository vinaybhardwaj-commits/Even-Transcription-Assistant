-- =====================================================================
-- Migration 0168 — encounter catalog: one searchable row per consult_uid (ENCOUNTER-CATALOG-PLAN C2).
--
-- WHAT. encounter_catalog, filled hourly by the lab box's stage ledger (palimpsest consult_ledger, encounter-catalog.jsonl, C1) through
-- POST /api/encounter-catalog/ingest, and read by GET /api/encounter-catalog/search. The prescription join (C3) writes only the
-- `prescription` column, by the same ingest route (field-level upsert).
--
-- NO TRANSCRIPT TEXT. There is no transcript, segment, note or text column; the ingest refuses any key named text / transcript / note / content (or text_*)
-- at any depth. Rows hold ids, UTC times, R2 object keys, per-layer status, stage states with reasons, and minute counts.
-- IDENTITY (V's Encounter Explorer ruling, 14 Oct: internal admins only, no PHI removal). doctor_name, patient_name, individual_uid, prescription_uid and
-- presc_state come ONLY from the C3 db13 join (gating-lead), by the same ingest route (field-level upsert); the lab box's feed carries no names. They are PHI:
-- the search route returns them to ADMIN_TOKEN holders only. Never copy a value into a repo, a log, a fixture or a bus message.
--
-- KEYS. consult_uid is the ETA consult uid (FK-free, like 0150 / 0157). clip / layers / freescript / stages / allowance / prescription are jsonb
-- objects exactly as the box wrote them (catalog_version says which shape). first_gap is "stage:reason" or NULL.
--
-- ADDITIVE AND IDEMPOTENT. CREATE ... IF NOT EXISTS. No existing table is altered. GRANTS: none (app-owned, like 0157; brain_svc gets nothing).
-- Down-migration: db/rollbacks/0168_encounter_catalog.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS encounter_catalog (
  consult_uid      text        PRIMARY KEY,
  ist_date         date,
  doctor_uid       text,
  room_id          text,
  t_open           timestamptz,
  t_close          timestamptz,
  source           text,
  clip             jsonb,
  layers           jsonb,
  freescript       jsonb,
  stages           jsonb,
  first_gap        text,
  allowance        jsonb,
  prescription     jsonb,
  doctor_name      text,
  patient_name     text,
  individual_uid   text,
  prescription_uid text,
  presc_state      text,
  catalog_version  integer,
  generated_at     timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT encounter_catalog_uid_chk CHECK (consult_uid ~ '^[A-Za-z0-9_.:@-]{4,128}$'),
  CONSTRAINT encounter_catalog_source_chk CHECK (source IS NULL OR source IN ('cutter', 'caa')),
  CONSTRAINT encounter_catalog_first_gap_chk CHECK (first_gap IS NULL OR first_gap ~ '^[A-Za-z0-9_:.-]{1,120}$'),
  CONSTRAINT encounter_catalog_version_chk CHECK (catalog_version IS NULL OR catalog_version BETWEEN 1 AND 1000),
  CONSTRAINT encounter_catalog_clip_chk CHECK (clip IS NULL OR jsonb_typeof(clip) = 'object'),
  CONSTRAINT encounter_catalog_layers_chk CHECK (layers IS NULL OR jsonb_typeof(layers) = 'object'),
  CONSTRAINT encounter_catalog_freescript_chk CHECK (freescript IS NULL OR jsonb_typeof(freescript) = 'object'),
  CONSTRAINT encounter_catalog_stages_chk CHECK (stages IS NULL OR jsonb_typeof(stages) = 'object'),
  CONSTRAINT encounter_catalog_allowance_chk CHECK (allowance IS NULL OR jsonb_typeof(allowance) = 'object'),
  CONSTRAINT encounter_catalog_prescription_chk CHECK (prescription IS NULL OR jsonb_typeof(prescription) = 'object'),
  CONSTRAINT encounter_catalog_individual_uid_chk CHECK (individual_uid IS NULL OR individual_uid ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  CONSTRAINT encounter_catalog_prescription_uid_chk CHECK (prescription_uid IS NULL OR prescription_uid ~ '^[A-Za-z0-9_.:@-]{1,128}$'),
  CONSTRAINT encounter_catalog_presc_state_chk CHECK (presc_state IS NULL OR presc_state ~ '^[A-Za-z0-9_:.-]{1,40}$'),
  CONSTRAINT encounter_catalog_names_chk CHECK ((doctor_name IS NULL OR length(doctor_name) <= 200) AND (patient_name IS NULL OR length(patient_name) <= 200))
);

CREATE INDEX IF NOT EXISTS encounter_catalog_doctor_date_idx ON encounter_catalog (doctor_uid, ist_date);
CREATE INDEX IF NOT EXISTS encounter_catalog_room_date_idx ON encounter_catalog (room_id, ist_date);
CREATE INDEX IF NOT EXISTS encounter_catalog_date_idx ON encounter_catalog (ist_date, consult_uid);
CREATE INDEX IF NOT EXISTS encounter_catalog_has_prescription_idx ON encounter_catalog (ist_date, consult_uid) WHERE prescription IS NOT NULL;
CREATE INDEX IF NOT EXISTS encounter_catalog_prescription_uid_idx ON encounter_catalog (prescription_uid) WHERE prescription_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS encounter_catalog_individual_uid_idx ON encounter_catalog (individual_uid) WHERE individual_uid IS NOT NULL;

COMMENT ON TABLE encounter_catalog IS
  'One row per consult_uid (0168): ids, UTC times, R2 keys, layer status, stage states, allowance minutes, prescription join. No transcript text.';

INSERT INTO schema_migrations (version, name)
VALUES (168, '0168_encounter_catalog')
ON CONFLICT DO NOTHING;

COMMIT;
