-- =====================================================================
-- Migration 0165 — room_alert_outbox: four more kinds for FR-1 (gating/fr1-c3, 13 Oct 2026). Number assigned by gating-lead.
--
-- WHY. FR-1 adds guardian signals that must reach a person through the same outbox the Mini relay already pulls (scribe_room_alerts, lib/room-alerts.ts).
-- This widens the kind CHECK only, in the same drop + add idempotent shape as 0164:
--   needs_enrol      a room has a recorder that must be enrolled again before it can record
--   capture_stalled  a recorder reports capture running but no audio is arriving
--   guardian_quiet   the on-Mac guardian has stopped reporting
--   heal_escalated   an automatic heal did not work and a person is needed
-- Dedupe is by (kind, room, status_to) inside one hour, in lib/alerts/ops-alert.ts.
--
-- ADDITIVE. Drops and re-adds one CHECK on a table that is only ever appended to. APPLY BEFORE THE CODE THAT WRITES THE NEW KINDS IS DEPLOYED: an
-- unapplied CHECK rejects the insert, which lib/alerts/ops-alert.ts logs and swallows.
-- =====================================================================
BEGIN;
ALTER TABLE room_alert_outbox DROP CONSTRAINT IF EXISTS room_alert_outbox_kind_chk;
ALTER TABLE room_alert_outbox
  ADD CONSTRAINT room_alert_outbox_kind_chk
  CHECK (kind IN ('offline', 'degraded', 'recovered', 'fleet_outage', 'session_reaped',
                  'install_retired', 'recorder_off', 'mic_denied', 'no_machine', 'room_disabled',
                  'needs_enrol', 'capture_stalled', 'guardian_quiet', 'heal_escalated'));
INSERT INTO schema_migrations (version, name) VALUES (165, '0165_room_alert_outbox_fr1_kinds')
ON CONFLICT (version) DO NOTHING;
COMMIT;
