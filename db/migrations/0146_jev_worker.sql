-- =====================================================================
-- 0146 — the Jev worker: versioned question sets, a call ledger, a breaker, a decision log widened (Jev P1 #55, PRD §4-§6, §9)
--
-- ADDITIVE AND IDEMPOTENT. Every table is CREATE ... IF NOT EXISTS; every column is ADD COLUMN IF NOT EXISTS; every
-- CHECK is dropped-if-exists and re-added; the one backfill is `WHERE question_set_id IS NULL`, so a second run touches
-- nothing. Applies twice cleanly. NO GRANTS: the brain_svc SELECT grant is its own migration (0144). No text anywhere:
-- decisions, calls, labels and reports hold ids, closed codes, numbers and HMAC hashes (PRD §12).
--
-- jev_decision (0116) is WIDENED, not replaced:
--   * subject_type gains consult, pitch, stt_run, stt_pair, doubt (lib/jev/types.ts JEV_SUBJECT_TYPES is the list; a drift
--     test compares this CHECK to it).
--   * 0116's unique key (subject_type, subject_id, question_id, prompt_version) becomes a PARTIAL index for LEGACY rows
--     only (question_set_sha256 IS NULL) — lib/jev/decision-store.ts's ON CONFLICT names the same predicate. A worker row
--     is keyed by (subject_type, subject_id, question_id, question_set_sha256, order_variant, mode), so the same set
--     asked in shadow and later in live is two rows, and a new hash is a new row (history across versions is kept).
--   * legacy rows are backfilled question_set_id = 'legacy:' || prompt_version (the legacy bridge).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS jev_question_set (
  id               text NOT NULL,
  version          text NOT NULL,
  use              text NOT NULL CHECK (use IN ('encounter_timeline', 'stt_quality', 'stt_pick', 'consult_rubric', 'legacy')),
  subject_type     text NOT NULL,
  state_schema     text NOT NULL,
  model_pin        text NOT NULL,
  content_sha256   text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'bench', 'shadow', 'live', 'retired')),
  bands            jsonb,
  calibration_ref  text,
  created_by       text NOT NULL,
  ratified_by      text,
  ratified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version),
  CONSTRAINT jev_question_set_sha_uq UNIQUE (content_sha256),
  CONSTRAINT jev_question_set_version_chk CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  CONSTRAINT jev_question_set_ratified_chk CHECK (status IN ('draft', 'bench', 'retired') OR (ratified_by IS NOT NULL AND ratified_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS jev_question (
  question_set_id    text NOT NULL,
  version            text NOT NULL,
  question_id        text NOT NULL CHECK (question_id ~ '^[a-z][a-z0-9_]{1,48}$'),
  kind               text NOT NULL CHECK (kind IN ('choice', 'score', 'noul')),
  body               jsonb NOT NULL,
  option_order       text NOT NULL DEFAULT 'forward' CHECK (option_order IN ('forward', 'reversed', 'both')),
  gate_question_id   text,
  options            text[],                                   -- a Choice's option names IN ORDER (jsonb loses key order, so `body` cannot say it)
  escape_options     text[] NOT NULL DEFAULT '{}',
  bands              jsonb,
  calibration        jsonb,
  question_sha256    text NOT NULL,
  PRIMARY KEY (question_set_id, version, question_id),
  FOREIGN KEY (question_set_id, version) REFERENCES jev_question_set (id, version)
);

CREATE TABLE IF NOT EXISTS jev_question_set_event (
  seq              bigserial PRIMARY KEY,
  question_set_id  text NOT NULL,
  version          text NOT NULL,
  from_status      text,
  to_status        text NOT NULL,
  actor            text NOT NULL,
  reason           text,
  at               timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (question_set_id, version) REFERENCES jev_question_set (id, version)
);

CREATE TABLE IF NOT EXISTS jev_call (
  id                    text PRIMARY KEY,
  job_id                text,
  use                   text NOT NULL,
  mode                  text NOT NULL CHECK (mode IN ('bench', 'shadow', 'live')),
  question_set_sha256   text,
  subject_count         integer NOT NULL DEFAULT 1,
  question_count        integer NOT NULL DEFAULT 0,
  model_requested       text,
  model_returned        text,
  http_status           integer,
  error_class           text,
  latency_ms            integer,
  input_tokens          integer NOT NULL DEFAULT 0,
  output_tokens         integer NOT NULL DEFAULT 0,
  cost_usd              numeric(12, 8) NOT NULL DEFAULT 0,
  state_bytes           integer NOT NULL DEFAULT 0,
  mock                  boolean NOT NULL DEFAULT false,
  breaker_state         text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jev_call_created ON jev_call (created_at);
CREATE INDEX IF NOT EXISTS idx_jev_call_use_created ON jev_call (use, created_at);

CREATE TABLE IF NOT EXISTS jev_gold_label (
  id                  text PRIMARY KEY,
  use                 text NOT NULL,
  question_set_id     text NOT NULL,
  question_id         text NOT NULL,
  subject_type        text NOT NULL,
  subject_id          text NOT NULL,
  label               jsonb NOT NULL,
  source              text NOT NULL CHECK (source IN ('human_v', 'human_adjudicated', 'pqm', 'pulse_end_click', 'agent_v0_1', 'nemotron_rules')),
  strength            text NOT NULL CHECK (strength IN ('strong', 'weak')),
  split               text NOT NULL CHECK (split IN ('dev', 'test', 'live_audit')),
  label_set_sha256    text,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jev_gold_label_subject ON jev_gold_label (subject_type, subject_id);

CREATE TABLE IF NOT EXISTS jev_breaker (
  use                    text PRIMARY KEY,
  state                  text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  opened_at              timestamptz,
  reason_class           text,
  consecutive_failures   integer NOT NULL DEFAULT 0,
  window_errors          integer NOT NULL DEFAULT 0,
  window_calls           integer NOT NULL DEFAULT 0,
  recent                 text NOT NULL DEFAULT '',
  wait_ms                integer NOT NULL DEFAULT 600000,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jev_drift_report (
  ist_date             date NOT NULL,
  use                  text NOT NULL,
  question_set_sha256  text NOT NULL,
  question_id          text NOT NULL,
  metrics              jsonb NOT NULL,
  alerts               text[] NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ist_date, use, question_set_sha256, question_id)
);

-- The global in-flight slot count (PRD §10): a row per call in flight, counted while young. Serverless instances share nothing in memory.
CREATE TABLE IF NOT EXISTS jev_slot (
  slot_id     text PRIMARY KEY,
  job_id      text,
  claimed_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS question_set_id text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS question_set_version text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS question_set_sha256 text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS order_variant text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS option_order_sha256 text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS lane text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS band text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS calibrated_p real;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS outcome text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS call_id text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS job_id text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS mode text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS output_tokens integer;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS cost_usd numeric(12, 8);
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS evidence jsonb;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS state_sha256 text;
ALTER TABLE jev_decision ADD COLUMN IF NOT EXISTS mock boolean NOT NULL DEFAULT false;

ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_subject_type_check;
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_subject_type_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_subject_type_chk
  CHECK (subject_type IN ('window', 'turn', 'note_sentence', 'encounter', 'collapse', 'probe', 'consult', 'pitch', 'stt_run', 'stt_pair', 'doubt'));
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_order_variant_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_order_variant_chk CHECK (order_variant IS NULL OR order_variant IN ('fwd', 'rev', 'derived'));
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_lane_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_lane_chk CHECK (lane IS NULL OR lane IN ('timeline', 'text'));
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_band_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_band_chk CHECK (band IS NULL OR band IN ('act', 'caution', 'review', 'abstain'));
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_outcome_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_outcome_chk
  CHECK (outcome IS NULL OR outcome IN ('answered', 'no_answer', 'off_menu_rejected', 'gated_overwritten', 'state_too_large', 'error'));
ALTER TABLE jev_decision DROP CONSTRAINT IF EXISTS jev_decision_mode_chk;
ALTER TABLE jev_decision ADD CONSTRAINT jev_decision_mode_chk CHECK (mode IS NULL OR mode IN ('bench', 'shadow', 'live'));

-- 0116's key, now for LEGACY rows only; the worker's key is the second index.
DROP INDEX IF EXISTS uq_jev_decision_subject_question_version;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jev_decision_legacy_key
  ON jev_decision (subject_type, subject_id, question_id, prompt_version) WHERE question_set_sha256 IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_jev_decision_worker_key
  ON jev_decision (subject_type, subject_id, question_id, question_set_sha256, order_variant, mode) WHERE question_set_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jev_decision_set ON jev_decision (question_set_sha256, created_at) WHERE question_set_sha256 IS NOT NULL;

UPDATE jev_decision SET question_set_id = 'legacy:' || prompt_version WHERE question_set_id IS NULL;

-- What consumers read: the latest row per (subject, question) under each use's LIVE set, else its SHADOW set; mock rows never.
CREATE OR REPLACE VIEW jev_decision_current AS
SELECT DISTINCT ON (d.subject_type, d.subject_id, d.question_id) d.*
  FROM jev_decision d
  JOIN jev_question_set s ON s.content_sha256 = d.question_set_sha256
 WHERE d.mock = false
   AND d.order_variant = 'derived'
   AND d.outcome = 'answered'
   AND s.status IN ('live', 'shadow')
   AND d.mode IN ('live', 'shadow')
 ORDER BY d.subject_type, d.subject_id, d.question_id,
          (s.status = 'live' AND d.mode = 'live') DESC, d.created_at DESC;

CREATE OR REPLACE VIEW jev_cost_day AS
SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS ist_date, use, mode,
       count(*)::int AS calls,
       coalesce(sum(input_tokens), 0)::bigint AS tokens_in,
       coalesce(sum(cost_usd), 0)::numeric(14, 8) AS usd,
       count(*) FILTER (WHERE error_class IS NOT NULL)::int AS errors
  FROM jev_call
 GROUP BY 1, 2, 3;

COMMENT ON TABLE jev_call IS 'One row per Jev systemOne call (ledger and dead letter). Ids, classes and numbers only: no body, no state, no key. PRD §5.2.';
COMMENT ON TABLE jev_breaker IS 'Circuit breaker, one row per use, in the DATABASE because serverless instances share no memory. PRD §9.2.';

INSERT INTO schema_migrations (version, name)
VALUES (146, '0146_jev_worker')
ON CONFLICT DO NOTHING;

COMMIT;
