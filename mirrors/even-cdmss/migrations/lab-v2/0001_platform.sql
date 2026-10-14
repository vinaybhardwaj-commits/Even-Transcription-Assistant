-- migrations/lab-v2/0001_platform.sql
-- Lab MCP v2, Slice A round 1 platform schema (LAB-MCP-V2-PRD-v1.0 §4.1).
--
-- APPLIED TO LAB_V2_DATABASE_URL ONLY, by /api/admin/lab-v2/migrate, and recorded in
-- lab_v2.migrations by name and checksum. This is a SEPARATE SERIES from the production
-- migrations/00NN_*.sql — decision 8 puts v2 state in its own Neon database precisely so
-- that no research write can reach a production table, and mixing the series would be
-- the first step back toward one database.
--
-- Everything is IF NOT EXISTS: the migrate route is idempotent, and re-running it after a
-- partial failure must converge rather than error.
--
-- Slice C adds targets, reviews and receipts (§11). No other tables.

CREATE SCHEMA IF NOT EXISTS lab_v2;

-- The migration ledger itself. Name is the key; checksum detects an edited file that has
-- already been applied, which is an ERROR and never a silent re-apply (§4).
CREATE TABLE IF NOT EXISTS lab_v2.migrations (
  name        text PRIMARY KEY,
  checksum    text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Immutable, hashed bodies: datasets, arms, experiments, artifacts, reports, plans.
-- UNIQUE (kind, hash) is the identity rule — the same body IS the same object, so two
-- principals independently freezing the same case converge on one row instead of two.
-- UNIQUE (owner, kind, idempotency_key) makes creation retry-safe per principal.
CREATE TABLE IF NOT EXISTS lab_v2.objects (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner           text NOT NULL,
  kind            text NOT NULL,
  body            jsonb NOT NULL,
  hash            text NOT NULL,
  classification  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz,
  idempotency_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS objects_kind_hash ON lab_v2.objects (kind, hash);
CREATE UNIQUE INDEX IF NOT EXISTS objects_owner_kind_idem ON lab_v2.objects (owner, kind, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS objects_owner ON lab_v2.objects (owner, kind);

-- Money. Four columns, one invariant, checked inside every reserving UPDATE:
--   spent + reserved + unknown + delta <= cap
-- `unknown` is not a rounding bucket: it is money we know left the building but cannot
-- yet attribute (a transport error with no usage). It stays reserved against the cap
-- until an operator reconciles it, because forgetting it would silently raise the cap.
CREATE TABLE IF NOT EXISTS lab_v2.budgets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner             text NOT NULL,
  name              text NOT NULL,
  cap_microusd      bigint NOT NULL,
  reserved_microusd bigint NOT NULL DEFAULT 0,
  spent_microusd    bigint NOT NULL DEFAULT 0,
  unknown_microusd  bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS budgets_owner_name ON lab_v2.budgets (owner, name);

-- One submission. `state` is DERIVED from items (§5.1) and cached here for cheap reads.
-- UNIQUE (owner, operation, idempotency_key) is what makes §5.2's "return the existing
-- run with deduplicated: true" a database guarantee rather than a race.
CREATE TABLE IF NOT EXISTS lab_v2.runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner               text NOT NULL,
  experiment_id       uuid REFERENCES lab_v2.objects(id),
  operation           text NOT NULL,
  request_hash        text NOT NULL,
  idempotency_key     text NOT NULL,
  budget_id           uuid NOT NULL REFERENCES lab_v2.budgets(id),
  state               text NOT NULL,
  cancel_requested_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  deadline_at         timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_owner_op_idem ON lab_v2.runs (owner, operation, idempotency_key);

-- One (case, arm, repetition). The unit of scheduling AND of result.
-- lease_token increments on every claim; every subsequent write asserts it, so a worker
-- whose lease expired mid-attempt cannot finish over the top of its successor (§5.3.4-5).
CREATE TABLE IF NOT EXISTS lab_v2.items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES lab_v2.runs(id),
  case_key           text NOT NULL,
  arm_hash           text NOT NULL,
  repetition         int NOT NULL,
  payload            jsonb NOT NULL,
  state              text NOT NULL,
  next_at            timestamptz NOT NULL DEFAULT now(),
  lease_owner        text,
  lease_token        int NOT NULL DEFAULT 0,
  lease_expires_at   timestamptz,
  attempts           int NOT NULL DEFAULT 0,
  error              jsonb,
  result             jsonb,
  execution_status   text,
  assessment_status  text,
  attribution_status text
);
CREATE UNIQUE INDEX IF NOT EXISTS items_identity ON lab_v2.items (run_id, case_key, arm_hash, repetition);
CREATE INDEX IF NOT EXISTS items_queue ON lab_v2.items (state, next_at);
CREATE INDEX IF NOT EXISTS items_run ON lab_v2.items (run_id);

-- One lease on one item by one worker. An item may have several; the history is the
-- evidence that a forced termination was detected and retried rather than lost.
CREATE TABLE IF NOT EXISTS lab_v2.attempts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL REFERENCES lab_v2.items(id),
  lease_token int NOT NULL,
  worker      text NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  outcome     text
);
CREATE INDEX IF NOT EXISTS attempts_item ON lab_v2.attempts (item_id);

-- Memoised stage outputs, keyed by the hash of everything the stage depended on.
-- Slice A writes them; Slice B's exact code replay reads them.
CREATE TABLE IF NOT EXISTS lab_v2.steps (
  item_id         uuid NOT NULL REFERENCES lab_v2.items(id),
  name            text NOT NULL,
  dependency_hash text NOT NULL,
  artifact_id     uuid NOT NULL REFERENCES lab_v2.objects(id),
  PRIMARY KEY (item_id, name)
);

-- One model request at one stage. `requested` is written BEFORE the network call and
-- `served` after, which is what makes attribution a measurement rather than a claim.
CREATE TABLE IF NOT EXISTS lab_v2.calls (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id           uuid NOT NULL REFERENCES lab_v2.items(id),
  lease_token       int NOT NULL,
  stage             text NOT NULL,
  budget_id         uuid NOT NULL REFERENCES lab_v2.budgets(id),
  requested         jsonb NOT NULL,
  request_hash      text NOT NULL,
  reserved_microusd bigint NOT NULL,
  actual_microusd   bigint,
  served            jsonb,
  state             text NOT NULL,
  pricing_version   text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  settled_at        timestamptz
);
CREATE INDEX IF NOT EXISTS calls_item ON lab_v2.calls (item_id);
CREATE INDEX IF NOT EXISTS calls_state_created ON lab_v2.calls (state, created_at);

-- Append only. Every tool call lands here with actor, tool and outcome — never the
-- request body of a tool that carries clinical text (§3.2.3).
CREATE TABLE IF NOT EXISTS lab_v2.events (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,
  aggregate  text NOT NULL,
  kind       text NOT NULL,
  body       jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_aggregate ON lab_v2.events (aggregate, created_at DESC);
CREATE INDEX IF NOT EXISTS events_kind_created ON lab_v2.events (kind, created_at DESC);

-- Slice A has exactly one row, id = 'vercel-tick'. `paused` stops new claims; running
-- items finish (§8.1 worker_control).
CREATE TABLE IF NOT EXISTS lab_v2.workers (
  id           text PRIMARY KEY,
  paused       boolean NOT NULL DEFAULT false,
  revision     int NOT NULL DEFAULT 0,
  heartbeat_at timestamptz,
  active_item  uuid
);
INSERT INTO lab_v2.workers (id) VALUES ('vercel-tick') ON CONFLICT (id) DO NOTHING;
