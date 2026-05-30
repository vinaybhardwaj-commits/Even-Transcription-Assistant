-- =====================================================================
-- Migration 0010 — V2.S0: clinician table (generalize doctor)
--
-- PRD §7.1, renumbered from 0006a (0006-0009 were taken by the multilingual +
-- diarization work that shipped ahead of v2.0 — see ETA-V2-PRD-RESCOPE.md).
--
-- ADDITIVE. doctor stays the primary read path through V2.S1-S5; dual-write
-- lands in V2.S1, the read-switch in V2.S6, and the doctor table is dropped in
-- V2.S8. clinician mirrors the CURRENT doctor columns (incl. status +
-- email_show_conversation_with, which postdate the PRD's idealized DDL) plus
-- clinician_type + legacy_doctor_id. The copy PRESERVES id (clinician.id =
-- doctor.id), so every existing doctor_id FK (encounter, voice_print,
-- recipient_per_doctor, ...) stays valid against clinician with no repoint.
-- =====================================================================

DO $$ BEGIN
  CREATE TYPE clinician_type AS ENUM ('physician', 'dietitian', 'physiotherapist');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS clinician (
  id                           TEXT PRIMARY KEY,            -- = source doctor id
  legacy_doctor_id             TEXT UNIQUE,                 -- migration shim (= id for copied rows)
  clinician_type               clinician_type NOT NULL DEFAULT 'physician',
  full_name                    TEXT NOT NULL,
  email                        CITEXT NOT NULL UNIQUE,
  phone                        TEXT,
  email_show_conversation_with BOOLEAN NOT NULL DEFAULT FALSE,
  url_slug                     TEXT NOT NULL UNIQUE,
  url_token                    TEXT NOT NULL,
  pin_hash                     TEXT,
  pin_set_at                   TIMESTAMPTZ,
  failed_pin_count             INTEGER NOT NULL DEFAULT 0,
  locked_until                 TIMESTAMPTZ,
  status                       doctor_status NOT NULL DEFAULT 'active',
  last_active_at               TIMESTAMPTZ,
  joined_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by                   UUID REFERENCES admin_user(id),
  deleted_at                   TIMESTAMPTZ,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clinician_url_slug      ON clinician(url_slug);
CREATE INDEX IF NOT EXISTS idx_clinician_email         ON clinician(email);
CREATE INDEX IF NOT EXISTS idx_clinician_type          ON clinician(clinician_type);
CREATE INDEX IF NOT EXISTS idx_clinician_status_active ON clinician(status, last_active_at);

-- Copy existing doctor rows (id preserved; all type='physician').
INSERT INTO clinician (
  id, legacy_doctor_id, clinician_type, full_name, email, phone,
  email_show_conversation_with, url_slug, url_token, pin_hash, pin_set_at,
  failed_pin_count, locked_until, status, last_active_at, joined_at,
  created_by, deleted_at, created_at, updated_at
)
SELECT
  id, id, 'physician'::clinician_type, full_name, email, phone,
  email_show_conversation_with, url_slug, url_token, pin_hash, pin_set_at,
  failed_pin_count, locked_until, status, last_active_at, joined_at,
  created_by, deleted_at, created_at, updated_at
FROM doctor
ON CONFLICT (id) DO NOTHING;

INSERT INTO schema_migrations (version, name)
VALUES (10, '0010_clinician_table')
ON CONFLICT DO NOTHING;
