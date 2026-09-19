-- =====================================================================
-- Migration 0103 — room_alert_state: the Room Watchdog's per-room edge-trigger memory.
--
-- WHY (ORB3, 12-13 Sep 2026: three mains-power losses between Friday 14:26 and Saturday 07:22,
-- 16.8 hours of recording lost, discovered only because V asked someone to look). The watchdog
-- (lib/room-watchdog.ts, cron GET /api/admin/room-watchdog) polls every minute and must send ONE
-- message on a transition into a bad state and ONE on recovery — never a repeat for every minute a
-- room sits in a bad state. That requires remembering, per room, what the LAST reported status was
-- and when it began.
--
-- status IS THE WATCHDOG'S OWN VOCABULARY, NOT room_install's. 'ok' | 'offline' | 'degraded' — a
-- coarser set than the fleet card's five row states, because the watchdog does not need to say WHY
-- a room needs attention, only whether the last message it sent about this room still describes it.
--
-- since IS WHEN THE CURRENT status BEGAN, not when the row was last touched. The recovery message
-- names "how long it was gone" by subtracting this from now, so it must move only on a real
-- transition, never on every run that finds nothing changed.
--
-- muted_until IS NULLABLE AND ADMIN-SET (D9, POST /api/admin/room-watchdog/mute). A muted room's
-- status is still recorded here every run — muting hides the MESSAGE, not the fact — so unmuting
-- mid-outage does not require the outage to re-begin before anyone is told.
--
-- ADDITIVE. One new table. No existing table is touched.
-- =====================================================================

CREATE TABLE IF NOT EXISTS room_alert_state (
  room_id      text        PRIMARY KEY REFERENCES room(id),
  status       text        NOT NULL DEFAULT 'ok',
  since        timestamptz NOT NULL DEFAULT now(),
  muted_until  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_alert_state_status_chk CHECK (status IN ('ok', 'offline', 'degraded'))
);

COMMENT ON TABLE room_alert_state IS
  'Room Watchdog (lib/room-watchdog.ts) edge-trigger memory: the last status reported for each room and when it began, so a room sitting in a bad state is not messaged twice. No row for a room = never evaluated — the seed run writes one and sends nothing (D2).';
COMMENT ON COLUMN room_alert_state.status IS
  'The watchdog''s own three-state vocabulary — ok | offline | degraded — distinct from room_install-derived fleet-card state. offline = no poll for OFFLINE_AFTER_MS (D4, lib/room-watchdog.ts). degraded = a Tier 1 §2 degradation flag, the tape stalled while a session is open, or disk critically low (D7).';
COMMENT ON COLUMN room_alert_state.since IS
  'When the CURRENT status began. Moves only on a transition, never on a run that finds no change, so a recovery message can name how long the room was gone by subtracting this from now().';
COMMENT ON COLUMN room_alert_state.muted_until IS
  'D9. NULL = not muted. While now() < muted_until, this room''s status is still recorded every run but no message is ever sent about it. Set by POST /api/admin/room-watchdog/mute.';

INSERT INTO schema_migrations (version, name)
VALUES (103, '0103_room_alert_state')
ON CONFLICT DO NOTHING;
