-- Arch #21: a reaper end is an alert. Widen the outbox kind check with 'session_reaped'.
-- Written, NOT applied (builder lane). Constraint swap is idempotent.
ALTER TABLE room_alert_outbox DROP CONSTRAINT IF EXISTS room_alert_outbox_kind_chk;
ALTER TABLE room_alert_outbox
  ADD CONSTRAINT room_alert_outbox_kind_chk
  CHECK (kind IN ('offline', 'degraded', 'recovered', 'fleet_outage', 'session_reaped'));

-- For kind 'session_reaped', status_to carries the copy phase: clinic_hours | end_of_day | overnight.
INSERT INTO schema_migrations (version, name) VALUES (132, '0132_room_alert_outbox_session_reaped')
ON CONFLICT (version) DO NOTHING;
