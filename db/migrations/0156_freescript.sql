-- =====================================================================
-- Migration 0156 — FreeScript door: stored eta2freescript artifacts.
--
-- WHAT. The output of `python -m tools.eta2freescript` (and tools/eta2freescript/nightly.py), posted by the box to
-- POST /api/freescript/ingest. Two tables:
--   freescript_run        one row per stored result (consult_uid, prescription_uid when linked, schema version,
--                         validator result, generator SHAs, cost, created_at)
--   freescript_artifact   the artifact JSON and completion_required for that run
--   freescript_latest     view: per consult_uid, the newest row
--
-- NO TRANSCRIPT TEXT. There is no transcript, segment, audio or note-source column. The artifact JSON is the
-- structured FreeScript extraction (gp_extraction, provenance labels, completion_required, the rendered note).
-- The ingest validator refuses a payload that carries transcript segments.
--
-- KEYS. consult_uid is the ETA consult uid (FK-free, like 0150). prescription_uid is set only when the artifact's
-- pulse_link already names one. room_slug / ist_date / doctor_uid8 are placement for the read tool, not identity.
--
-- ADDITIVE AND IDEMPOTENT. CREATE ... IF NOT EXISTS / CREATE OR REPLACE VIEW. No existing table is altered.
-- GRANTS: none (app-owned, like 0155; brain_svc gets nothing). Down-migration: db/rollbacks/0156_freescript.down.sql
-- (run by hand, never from here). The door stays closed unless ETA_FREESCRIPT is on.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS freescript_run (
  id                    bigserial   PRIMARY KEY,
  consult_uid           text        NOT NULL,
  prescription_uid      text,
  schema_version        text        NOT NULL,
  room_slug             text,
  room_id               text,
  ist_date              date,
  doctor_uid8           text,
  state                 text        NOT NULL,
  validator_ok          boolean     NOT NULL,
  validator_errors      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  generator_code_sha    text        NOT NULL,
  generator_prompt_sha  text        NOT NULL,
  model_id              text,
  cost_usd              numeric(12,6),
  input_sha256          text        NOT NULL,
  job_id                text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT freescript_run_uid_chk CHECK (consult_uid ~ '^[A-Za-z0-9_.:@-]{4,128}$'),
  CONSTRAINT freescript_run_rx_chk CHECK (prescription_uid IS NULL OR prescription_uid ~ '^[A-Za-z0-9_.:@-]{1,80}$'),
  CONSTRAINT freescript_run_schema_chk CHECK (schema_version IN ('eta.freescript.v0.1', 'eta.freescript.v0.2')),
  CONSTRAINT freescript_run_uid8_chk CHECK (doctor_uid8 IS NULL OR doctor_uid8 ~ '^[A-Za-z0-9]{8}$'),
  CONSTRAINT freescript_run_state_chk CHECK (state IN ('ok', 'invalid') AND ((state = 'ok') = validator_ok)),
  CONSTRAINT freescript_run_errors_chk CHECK (jsonb_typeof(validator_errors) = 'array'),
  CONSTRAINT freescript_run_sha_chk CHECK (
    generator_code_sha ~ '^[0-9a-f]{64}$' AND generator_prompt_sha ~ '^[0-9a-f]{64}$' AND input_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT freescript_run_job_chk CHECK (job_id IS NULL OR job_id ~ '^job_[A-Za-z0-9_-]{4,80}$'),
  CONSTRAINT freescript_run_cost_chk CHECK (cost_usd IS NULL OR (cost_usd >= 0 AND cost_usd <= 50)),
  UNIQUE (consult_uid, input_sha256)
);

CREATE TABLE IF NOT EXISTS freescript_artifact (
  run_id               bigint      PRIMARY KEY REFERENCES freescript_run(id) ON DELETE CASCADE,
  consult_uid          text        NOT NULL,
  prescription_uid     text,
  schema_version       text        NOT NULL,
  artifact             jsonb       NOT NULL,
  completion_required  jsonb       NOT NULL,
  validator_ok         boolean     NOT NULL,
  validator_errors     jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT freescript_artifact_obj_chk CHECK (jsonb_typeof(artifact) = 'object'),
  CONSTRAINT freescript_artifact_completion_chk CHECK (jsonb_typeof(completion_required) = 'array'),
  CONSTRAINT freescript_artifact_errors_chk CHECK (jsonb_typeof(validator_errors) = 'array')
);

CREATE INDEX IF NOT EXISTS freescript_run_consult_idx ON freescript_run (consult_uid, created_at DESC);
CREATE INDEX IF NOT EXISTS freescript_run_room_day_idx ON freescript_run (room_slug, ist_date);
CREATE INDEX IF NOT EXISTS freescript_run_doctor_idx ON freescript_run (doctor_uid8, ist_date) WHERE doctor_uid8 IS NOT NULL;
CREATE INDEX IF NOT EXISTS freescript_run_job_idx ON freescript_run (job_id) WHERE job_id IS NOT NULL;

CREATE OR REPLACE VIEW freescript_latest AS
SELECT DISTINCT ON (r.consult_uid)
       r.id AS run_id,
       r.consult_uid,
       r.prescription_uid,
       r.schema_version,
       r.room_slug,
       r.room_id,
       r.ist_date,
       r.doctor_uid8,
       r.validator_ok,
       r.validator_errors,
       r.generator_code_sha,
       r.generator_prompt_sha,
       r.model_id,
       r.cost_usd,
       r.job_id,
       r.created_at,
       a.artifact,
       a.completion_required
  FROM freescript_run r
  JOIN freescript_artifact a ON a.run_id = r.id
 ORDER BY r.consult_uid, r.created_at DESC, r.id DESC;

COMMENT ON TABLE freescript_run IS
  'One eta2freescript result (0156). consult_uid, optional prescription_uid, schema version, validator, generator SHAs, cost. No transcript text.';
COMMENT ON TABLE freescript_artifact IS
  'The FreeScript artifact JSON and completion_required for one freescript_run (0156). No transcript segments.';
COMMENT ON VIEW freescript_latest IS
  'Per consult_uid, the newest freescript_run plus its artifact. Readers use this so a re-post of the same inputs does not double-count.';

INSERT INTO schema_migrations (version, name)
VALUES (156, '0156_freescript')
ON CONFLICT DO NOTHING;

COMMIT;
