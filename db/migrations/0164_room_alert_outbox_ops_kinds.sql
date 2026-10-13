-- =====================================================================
-- Migration 0164 — room_alert_outbox: five more kinds for the OPD 4 lost-day guard (gating/opd4-guard, 13 Oct 2026).
--
-- WHY. OPD 4 lost 9-13 Oct with no alarm reaching a person: an install was retired by one click, the mic permission was denied, and the steward said
-- `no_machine` at severity info. The app cannot push to the bus (lib/room-alerts.ts); a relay on the Mini pulls room_alert_outbox through
-- scribe_room_alerts and posts it. So the new alerts are queued HERE, in the same outbox, and the relay carries them. This widens the kind CHECK only:
--   install_retired  an install was retired (manual, handover or forced); status_to = the install id
--   recorder_off     a roster room has had no audio for 15 min in clinic hours; status_to = 'recorder_off'
--   mic_denied       a room's reported mic_state is denied (any hour); status_to = 'mic_denied'
--   no_machine       a roster room has no live install in clinic hours; status_to = 'no_machine'
--   room_disabled    a room was disabled (admin or PIN lockout) inside clinic hours; status_to = 'room_disabled'
-- Dedupe is by (kind, room, status_to) inside one hour, in lib/alerts/ops-alert.ts. Numbered 0164: 0163 belongs to ENC.
--
-- ADDITIVE. Drops and re-adds one CHECK on a table that is only ever appended to. APPLY BEFORE THE CODE THAT WRITES THE NEW KINDS IS DEPLOYED: an
-- unapplied CHECK rejects the insert, which lib/alerts/ops-alert.ts logs and swallows (a retire is never blocked by its own alert).
-- =====================================================================
BEGIN;
ALTER TABLE room_alert_outbox DROP CONSTRAINT IF EXISTS room_alert_outbox_kind_chk;
ALTER TABLE room_alert_outbox
  ADD CONSTRAINT room_alert_outbox_kind_chk
  CHECK (kind IN ('offline', 'degraded', 'recovered', 'fleet_outage', 'session_reaped',
                  'install_retired', 'recorder_off', 'mic_denied', 'no_machine', 'room_disabled'));
INSERT INTO schema_migrations (version, name) VALUES (164, '0164_room_alert_outbox_ops_kinds')
ON CONFLICT (version) DO NOTHING;
COMMIT;
