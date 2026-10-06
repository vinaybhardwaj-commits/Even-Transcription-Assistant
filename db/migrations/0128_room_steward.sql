-- =====================================================================
-- Migration 0128 — Room Steward, part 1: config, decision log, repair tickets, replay nonces.
--
-- WHY. The Room Steward schedules room recording and repairs kiosks through signed, short-lived, single-use repair tickets. This migration is the
-- storage only: nothing here acts on a room or a kiosk. Part 2 (control loop) reads steward_config and writes steward_decisions; part 3 is the admin panel.
--
--   steward_config     key/value config, seeded once. Every action starts in SHADOW mode and the kill switch starts ON (steward does nothing).
--   steward_decisions  append-only log of what the steward decided and why. inputs carries ids, hashes and counts only, never names or PHI.
--   steward_tickets    Ed25519-signed repair tickets a kiosk fetches from GET /api/steward/tickets (lib/steward/tickets.ts is the contract).
--                      Partial unique index: at most ONE outstanding (issued or fetched) ticket per (machine, action).
--   steward_nonces     nonces already consumed by a steward.result event, so a replayed result cannot be applied twice. 7-day retention.
--
-- RETENTION. /api/cron/kiosk-health-retention also deletes steward_nonces older than 7 days (seen_at) and steward_decisions older than 30 days (ts).
-- steward_tickets.decision_id is ON DELETE SET NULL so decision retention never fails on a ticket that still points at an old decision.
--
-- GRANTS: none. All four tables are APP-OWNED, same as kiosk_health_events (0126).
--
-- SEED ROOMS (steward_config.rooms), ids read from the room table on 6 Oct 2026:
--   room_jwyrr4dc  ORB3         flags dev,test      machine ORBOX3
--   room_2qe955hy  Home Office  flags dev,test      machine Vinays-Mac-mini
--   room_mah3aspr  ORB2         class ot            machine vinay-orb2 (the OT2 recorder)
--
-- ADDITIVE AND IDEMPOTENT. CREATE TABLE/INDEX IF NOT EXISTS, seeds ON CONFLICT DO NOTHING (a value an admin has since changed is never overwritten).
-- =====================================================================

CREATE TABLE IF NOT EXISTS steward_config (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

INSERT INTO steward_config (key, value, updated_by) VALUES
  ('kill_switch', '{"on":true}'::jsonb, 'migration-0128'),
  ('shadow', '{"global":true,"actions":{}}'::jsonb, 'migration-0128'),
  ('schedule', '{"clinic":{"start":"07:30","end":"21:30","tz":"Asia/Kolkata","late_stop_max_min":30},"ot":{"start":"06:00","end":"04:00","tz":"Asia/Kolkata","late_stop_max_min":30}}'::jsonb, 'migration-0128'),
  ('days', '{"mode":"every_day","closed":[]}'::jsonb, 'migration-0128'),
  ('caps', '{"actions_per_room_per_hour":4,"policy_cycle_per_profile_per_day":1,"start_retries":3}'::jsonb, 'migration-0128'),
  ('priority', '{"order":["ot","opd","clinic"]}'::jsonb, 'migration-0128'),
  ('rooms', '{"room_jwyrr4dc":{"flags":["dev","test"],"machine":"ORBOX3"},"room_2qe955hy":{"flags":["dev","test"],"machine":"Vinays-Mac-mini"},"room_mah3aspr":{"class":"ot","flags":[],"machine":"vinay-orb2"}}'::jsonb, 'migration-0128')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS steward_decisions (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  room_id      text,
  machine      text,
  window_kind  text,
  rule         text NOT NULL,
  action       text NOT NULL,
  params       jsonb NOT NULL DEFAULT '{}'::jsonb,
  mode         text NOT NULL CHECK (mode IN ('shadow', 'live')),
  result       text,
  actor        text NOT NULL DEFAULT 'steward',
  why          text,
  why_not      text,
  inputs_hash  text,
  inputs       jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS steward_decisions_room_ts_idx
  ON steward_decisions (room_id, ts DESC);

CREATE INDEX IF NOT EXISTS steward_decisions_ts_idx
  ON steward_decisions (ts);

COMMENT ON COLUMN steward_decisions.inputs IS
  'Ids, hashes and counts only. Never names, never PHI.';

CREATE TABLE IF NOT EXISTS steward_tickets (
  ticket_id     text PRIMARY KEY,
  machine       text NOT NULL,
  action        text NOT NULL,
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision_id   bigint REFERENCES steward_decisions (id) ON DELETE SET NULL,
  issued_at     timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  nonce         text NOT NULL UNIQUE,
  signature     text NOT NULL,
  status        text NOT NULL CHECK (status IN ('issued', 'fetched', 'done', 'failed', 'expired')),
  fetched_at    timestamptz,
  completed_at  timestamptz,
  result        jsonb
);

CREATE INDEX IF NOT EXISTS steward_tickets_machine_status_idx
  ON steward_tickets (machine, status);

CREATE INDEX IF NOT EXISTS steward_tickets_expires_idx
  ON steward_tickets (expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS steward_tickets_one_outstanding_idx
  ON steward_tickets (machine, action)
  WHERE status IN ('issued', 'fetched');

CREATE TABLE IF NOT EXISTS steward_nonces (
  nonce    text PRIMARY KEY,
  machine  text NOT NULL,
  seen_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS steward_nonces_seen_idx
  ON steward_nonces (seen_at);

INSERT INTO schema_migrations (version, name)
VALUES (128, '0128_room_steward')
ON CONFLICT DO NOTHING;
