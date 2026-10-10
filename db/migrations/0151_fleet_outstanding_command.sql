-- =====================================================================
-- Migration 0151 — TS-H4 (#41), refute round 2, F2: ONE outstanding command per (device, verb), enforced by the database.
--
-- WHY. The enqueue route checked "is one already queued?" and then inserted: two statements, so six parallel POSTs of the same verb all passed the check and left six
-- queued rows (reproduced on postgres:16). A double click on a privileged verb must not stack real work on a Mac. A partial unique index makes the race impossible:
-- the second concurrent insert fails with a unique violation, which lib/fleet/commands.ts maps to `outstanding` (HTTP 409).
--
-- "OUTSTANDING" = state 'queued' or 'delivered' (handed to the helper, no result yet). A command whose expires_at has passed is flipped to 'expired' by the issuer
-- before it inserts (lib/fleet/commands.ts), so an abandoned command never blocks its verb for longer than its own TTL (<= 900 s). A late result for a delivered-then-
-- expired command is still accepted (lib/fleet/results.ts).
--
-- ADDITIVE AND IDEMPOTENT: one CREATE UNIQUE INDEX IF NOT EXISTS. No table is altered. GRANTS: none (app-owned, like the rest of fleet_*).
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS fleet_commands_outstanding_uidx
  ON fleet_commands (device_id, verb)
  WHERE state IN ('queued', 'delivered');

INSERT INTO schema_migrations (version, name)
VALUES (151, '0151_fleet_outstanding_command')
ON CONFLICT DO NOTHING;
