-- Arch #21: a reaper end is an alert. Widen the outbox kind check with 'session_reaped'.
-- Constraint swap is idempotent; the version row is written inside the same transaction.
BEGIN;
ALTER TABLE room_alert_outbox DROP CONSTRAINT IF EXISTS room_alert_outbox_kind_chk;
ALTER TABLE room_alert_outbox
  ADD CONSTRAINT room_alert_outbox_kind_chk
  CHECK (kind IN ('offline', 'degraded', 'recovered', 'fleet_outage', 'session_reaped'));
-- For kind 'session_reaped', status_to carries the copy phase: clinic_hours | overnight.
INSERT INTO schema_migrations (version, name) VALUES (138, '0138_room_alert_outbox_session_reaped')
ON CONFLICT (version) DO NOTHING;
COMMIT;
