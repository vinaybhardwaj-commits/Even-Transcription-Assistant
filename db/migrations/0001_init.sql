-- =====================================================================
-- Migration 0001 — initial schema for Even Transcription Assistant
-- Mirrors PRD §6.1 exactly. All identifiers per §6.3.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------- ENUMS ----------------
DO $$ BEGIN
  CREATE TYPE admin_role        AS ENUM ('super', 'ops');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE doctor_status     AS ENUM ('active', 'disabled', 'locked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE encounter_status  AS ENUM ('draft', 'processing', 'complete', 'failed', 'deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE send_status       AS ENUM ('pending', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE send_event_status AS ENUM ('queued', 'sent', 'delivered', 'opened', 'bounced', 'complained', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE trace_stage       AS ENUM ('capture', 'transcribe', 'clean', 'critique', 'revise', 'cdmss', 'email');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE trace_status      AS ENUM ('ok', 'warn', 'fail');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE recipient_role    AS ENUM ('admin', 'records', 'finance', 'compliance', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE recipient_set_by  AS ENUM ('admin', 'doctor');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE actor_type        AS ENUM ('admin', 'doctor', 'system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE retry_backoff     AS ENUM ('linear', 'exponential');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------- admin_user ----------------
CREATE TABLE IF NOT EXISTS admin_user (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  role            admin_role NOT NULL DEFAULT 'super',
  last_active_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------- doctor ----------------
CREATE TABLE IF NOT EXISTS doctor (
  id                TEXT PRIMARY KEY,
  full_name         TEXT NOT NULL,
  email             CITEXT UNIQUE NOT NULL,
  phone             TEXT,
  url_slug          TEXT UNIQUE NOT NULL,
  url_token         TEXT NOT NULL,
  pin_hash          TEXT,
  pin_set_at        TIMESTAMPTZ,
  failed_pin_count  INTEGER NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,
  status            doctor_status NOT NULL DEFAULT 'active',
  last_active_at    TIMESTAMPTZ,
  joined_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by        UUID NOT NULL REFERENCES admin_user(id),
  deleted_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_doctor_url_slug        ON doctor(url_slug);
CREATE INDEX IF NOT EXISTS idx_doctor_email           ON doctor(email);
CREATE INDEX IF NOT EXISTS idx_doctor_status_active   ON doctor(status, last_active_at DESC);

-- ---------------- pin_attempt ----------------
CREATE TABLE IF NOT EXISTS pin_attempt (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   TEXT NOT NULL REFERENCES doctor(id),
  success     BOOLEAN NOT NULL,
  ip          INET,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pin_attempt_doctor_time ON pin_attempt(doctor_id, created_at DESC);

-- ---------------- encounter ----------------
CREATE TABLE IF NOT EXISTS encounter (
  id                  TEXT PRIMARY KEY,
  doctor_id           TEXT NOT NULL REFERENCES doctor(id),
  patient_label_raw   TEXT,
  patient_age         INTEGER,
  patient_sex         TEXT,
  chief_complaint     TEXT,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_seconds    INTEGER,
  status              encounter_status NOT NULL DEFAULT 'draft',
  audio_object_key    TEXT,
  audio_bytes         INTEGER,
  transcript_raw      TEXT,
  transcript_clean    TEXT,
  note_json           JSONB,
  cdmss_json          JSONB,
  send_status         send_status NOT NULL DEFAULT 'pending',
  sent_at             TIMESTAMPTZ,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  deleted_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_enc_doctor_recorded ON encounter(doctor_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_enc_status_recorded ON encounter(status, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_enc_send_status     ON encounter(send_status, recorded_at DESC);

-- ---------------- trace ----------------
CREATE TABLE IF NOT EXISTS trace (
  id                TEXT PRIMARY KEY,
  encounter_id      TEXT NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  stage             trace_stage NOT NULL,
  model             TEXT NOT NULL,
  prompt_full       TEXT,
  response_full     TEXT,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  latency_ms        INTEGER,
  cost_estimate_usd NUMERIC(10, 5),
  status            trace_status NOT NULL,
  error_message     TEXT,
  metadata_json     JSONB,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trace_enc_started      ON trace(encounter_id, started_at);
CREATE INDEX IF NOT EXISTS idx_trace_stage_completed  ON trace(stage, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trace_status_started   ON trace(status, started_at DESC);

-- ---------------- recipient_global ----------------
CREATE TABLE IF NOT EXISTS recipient_global (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       CITEXT NOT NULL,
  name        TEXT NOT NULL,
  role        recipient_role NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  UUID NOT NULL REFERENCES admin_user(id)
);

-- ---------------- recipient_per_doctor ----------------
CREATE TABLE IF NOT EXISTS recipient_per_doctor (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id   TEXT NOT NULL REFERENCES doctor(id),
  email       CITEXT NOT NULL,
  name        TEXT NOT NULL,
  role        recipient_role NOT NULL,
  set_by      recipient_set_by NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------- send_event ----------------
CREATE TABLE IF NOT EXISTS send_event (
  id                TEXT PRIMARY KEY,
  encounter_id      TEXT NOT NULL REFERENCES encounter(id) ON DELETE CASCADE,
  recipient_email   CITEXT NOT NULL,
  recipient_role    TEXT,
  subject_rendered  TEXT NOT NULL,
  resend_message_id TEXT,
  status            send_event_status NOT NULL DEFAULT 'queued',
  opened_at         TIMESTAMPTZ,
  bounced_at        TIMESTAMPTZ,
  complained_at     TIMESTAMPTZ,
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_se_encounter      ON send_event(encounter_id);
CREATE INDEX IF NOT EXISTS idx_se_status_created ON send_event(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_se_resend_msg_id  ON send_event(resend_message_id);

-- ---------------- audit_log ----------------
CREATE TABLE IF NOT EXISTS audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_type    actor_type NOT NULL,
  actor_id      TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT,
  metadata_json JSONB,
  ip            INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_target_time ON audit_log(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor_time  ON audit_log(actor_id, created_at DESC);

-- ---------------- settings (singleton, id = 1) ----------------
CREATE TABLE IF NOT EXISTS settings (
  id                      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  subject_template        TEXT NOT NULL DEFAULT '[Even] {patient_name}, {patient_demo} - {chief_complaint} - {date}',
  include_patient_on_send BOOLEAN NOT NULL DEFAULT FALSE,
  send_drafts             BOOLEAN NOT NULL DEFAULT FALSE,
  block_on_critique_fail  BOOLEAN NOT NULL DEFAULT TRUE,
  retry_policy_max        INTEGER NOT NULL DEFAULT 3,
  retry_policy_backoff    retry_backoff NOT NULL DEFAULT 'exponential',
  resend_from_email       TEXT,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by              UUID
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------- schema_migrations bookkeeping ----------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO schema_migrations (version, name) VALUES (1, '0001_init') ON CONFLICT DO NOTHING;

COMMIT;
