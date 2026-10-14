-- 0057_doctor_triage_doors.sql — P1 stamp audit + P2 doctor-response idempotency.
-- Additive only. TRIAGE_BOT_WRITE remains an application gate and defaults closed.

CREATE TABLE IF NOT EXISTS triage_stamp_events (
  id               uuid PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  app_source       text NOT NULL DEFAULT 'standalone',
  queue_item_ref   text NOT NULL,
  verb             text NOT NULL,
  reason           text NOT NULL,
  actor            text NOT NULL,
  policy_version   text NOT NULL,
  run_id           text,
  run_metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_id      uuid,
  signal_reference text,
  outcome          text NOT NULL,
  error            text
);

CREATE INDEX IF NOT EXISTS triage_stamp_events_queue_idx
  ON triage_stamp_events (queue_item_ref, created_at DESC);

CREATE TABLE IF NOT EXISTS opd_doctor_response_request (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id         uuid NOT NULL,
  doctor_uid        text NOT NULL,
  client_request_id text NOT NULL,
  verb              text NOT NULL,
  comment           text,
  response          jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS opd_doctor_response_request_key_uq
  ON opd_doctor_response_request (signal_id, doctor_uid, client_request_id);

CREATE UNIQUE INDEX IF NOT EXISTS opd_doctor_response_request_thread_uq
  ON opd_doctor_response_request (signal_id, doctor_uid);
