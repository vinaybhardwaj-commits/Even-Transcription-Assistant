-- =====================================================================
-- Migration 0125 — pulse_presence_events.source accepts 'guard'.
--
-- WHY. 0122 created the table with CHECK (source IN ('ext', 'poller')). The presence guard (eta-presence-guard, a LaunchDaemon that restores the Chrome
-- extension policy file after a reboot) now POSTs its own events to /api/presence with source 'guard' (reasons boot, missing, stripped, rewrite_failed,
-- relaunch, unknown_host); lib/presence-ingest.ts stores them and lib/encounter-windows/ext-health.ts + the Bench fleet row (guard_activity) read them.
--
-- APPLY BEFORE the ingest change deploys. Until it is applied a guard row violates the CHECK (SQLSTATE 23514), which /api/presence treats as a data fault:
-- it counts the row as rejected and still answers 200, so the guard would not retry. Nothing else changes: no data is touched, ext and poller rows are
-- unaffected, the (machine, ts) index serves the guard reads.
--
-- IDEMPOTENT. DROP ... IF EXISTS then ADD (the constraint keeps its default name, pulse_presence_events_source_check). NOT VALID then VALIDATE keeps the
-- table lock short: the ADD takes it only for the catalog change, the VALIDATE scans under a weaker lock.
-- =====================================================================

ALTER TABLE pulse_presence_events DROP CONSTRAINT IF EXISTS pulse_presence_events_source_check;
ALTER TABLE pulse_presence_events
  ADD CONSTRAINT pulse_presence_events_source_check CHECK (source IN ('ext', 'poller', 'guard')) NOT VALID;
ALTER TABLE pulse_presence_events VALIDATE CONSTRAINT pulse_presence_events_source_check;

COMMENT ON TABLE pulse_presence_events IS
  'Append-only presence events from the Pulse extension (source ext), the tailnet poller (source poller) and the presence guard (source guard: event guard, payload.reason). machine = machine_id (ext) or machine (poller, guard); event = event (ext), state (poller) or guard.';

INSERT INTO schema_migrations (version, name)
VALUES (125, '0125_presence_source_guard')
ON CONFLICT DO NOTHING;
