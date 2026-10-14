-- migrations/lab-v2/0003_paired_audit.sql
-- Paired signed-vs-override OPD audits. LAB_V2_DATABASE_URL only.
--
-- Applied by /api/admin/lab-v2/migrate, which reads every migrations/lab-v2/*.sql in
-- name order. Nothing here is created in the production database, and nothing here is
-- read by doctors.evenos.app.
--
-- This file has not shipped. The dedupe key, the attempt cap and the structured
-- override columns are in the original migration rather than a follow-up.
--
-- override_text is the alternate prescription when the caller sent text. Structured
-- JSON is the preferred input and lives in override_struct. Neither is selected by
-- the results tools. clinician_uid is constrained so an override arm cannot be
-- stamped with the signing doctor's uid.
--
-- content identity for dedupe is override_hash: sha256 of the raw text, of the
-- canonical structured override, or of the signed case actually audited. model is
-- part of the same key, so a new model or a revised prescription never reuses a row.

CREATE TABLE IF NOT EXISTS lab_v2.paired_audit_runs (
  id                    uuid PRIMARY KEY,
  owner                 text NOT NULL,
  experiment_label      text NOT NULL,
  idempotency_key       text NOT NULL,
  engine_version        text NOT NULL,
  prompt_hash           text NOT NULL,
  model                 text NOT NULL,
  provider              text NOT NULL,
  status                text NOT NULL,
  stop_reason           text,
  max_llm_calls         integer NOT NULL,
  max_spend_microusd    bigint,
  calls_used            integer NOT NULL DEFAULT 0,
  spend_microusd        bigint NOT NULL DEFAULT 0,
  unpriced              boolean NOT NULL DEFAULT false,
  signed_repeats        integer NOT NULL DEFAULT 1,
  override_repeats      integer NOT NULL DEFAULT 1,
  -- Uids whose signed row had neither kx_encounter_id nor consult_uid. The join still passes.
  external_ref_unkeyed  integer NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  finished_at           timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS paired_audit_runs_owner_idem
  ON lab_v2.paired_audit_runs (owner, idempotency_key);

CREATE TABLE IF NOT EXISTS lab_v2.paired_audit_results (
  id                 uuid PRIMARY KEY,
  uid                text NOT NULL,
  arm                text NOT NULL,
  engine_version     text NOT NULL,
  prompt_hash        text NOT NULL,
  model              text NOT NULL,
  -- Signed case hash, structured-override hash, or raw-text hash. See the header.
  override_hash      text NOT NULL,
  input_path         text NOT NULL,
  repeat_idx         integer NOT NULL,
  clinician_uid      text,
  result             jsonb NOT NULL,
  calls              integer NOT NULL DEFAULT 0,
  spend_microusd     bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- The override arm is never attributed to the signing doctor.
  CONSTRAINT paired_audit_results_author_ck
    CHECK (arm = 'signed' OR clinician_uid IS NULL)
);

-- One billed result per uid, arm, engine, prompt, model, content and repeat.
CREATE UNIQUE INDEX IF NOT EXISTS paired_audit_results_dedupe
  ON lab_v2.paired_audit_results (uid, arm, engine_version, prompt_hash, model, override_hash, repeat_idx);

CREATE TABLE IF NOT EXISTS lab_v2.paired_audit_items (
  id              uuid PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES lab_v2.paired_audit_runs(id),
  uid             text NOT NULL,
  external_ref    text NOT NULL,
  arm             text NOT NULL,
  repeat_idx      integer NOT NULL,
  status          text NOT NULL,
  skip_reason     text,
  -- Incremented when a tick claims the row. Capped at 2: a stale claim is requeued
  -- while attempts < 2, and marked failed (attempt_cap) once it has been claimed twice.
  attempts        integer NOT NULL DEFAULT 0,
  -- Set when a tick claims the row. A tick that dies mid-item leaves status 'running';
  -- the next tick requeues a claim older than 20 minutes only while attempts remain.
  claimed_at      timestamptz,
  -- Alternate prescription. NULL on the signed arm. Never selected by a results tool.
  override_text   text,
  override_struct jsonb,
  override_hash   text,
  -- signed | structured | text. structured is the caller's JSON; text is the debug parser.
  input_path      text NOT NULL,
  -- Set when a text override is judged. A skip of override_unparsed stores both counts.
  parse_lines_total  integer,
  parse_lines_parsed integer,
  result_id       uuid REFERENCES lab_v2.paired_audit_results(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT paired_audit_items_override_ck
    CHECK (arm <> 'signed' OR (override_text IS NULL AND override_struct IS NULL))
);

CREATE INDEX IF NOT EXISTS paired_audit_items_run_idx
  ON lab_v2.paired_audit_items (run_id, status, uid);
