-- 0058_triage_stamp_idempotency.sql — stamp replay identity for the gated triage door.
--
-- 0057 created triage_stamp_events. This is the next free migration and the production
-- path for the idempotency columns and unique indexes. The stamp route still runs the
-- same ALTER / CREATE INDEX IF NOT EXISTS statements as belt-and-suspenders, because
-- migrations/ is not what the Vercel function executes.
--
-- CREATE / ALTER only. No DROP. Does not set TRIAGE_BOT_WRITE. Does not touch
-- opd_audit_triage or opd_gov_signal (those stay on insertDecision / the existing mint).
--
-- Replay identity, either one is enough:
--   UNIQUE (queue_item_ref, run_id) WHERE run_id IS NOT NULL
--   UNIQUE (client_request_id)      WHERE client_request_id IS NOT NULL
-- client_request_id is the body field or the Idempotency-Key header, same as doctor-response.
-- A second stamp with the same identity returns the original decision and signal.

ALTER TABLE triage_stamp_events ADD COLUMN IF NOT EXISTS client_request_id text;
ALTER TABLE triage_stamp_events ADD COLUMN IF NOT EXISTS result jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS triage_stamp_events_run_uq
  ON triage_stamp_events (queue_item_ref, run_id)
  WHERE run_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS triage_stamp_events_idem_uq
  ON triage_stamp_events (client_request_id)
  WHERE client_request_id IS NOT NULL;
