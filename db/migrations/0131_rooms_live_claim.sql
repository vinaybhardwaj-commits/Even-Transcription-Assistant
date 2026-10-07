-- =====================================================================
-- Migration 0131 — rooms_live_claim: who is looking after a room right now (Rooms Live v1).
--
-- WHY. The Rooms Live monitor lets an operator claim a room that needs hands-on attention (and clear it again), so two people do not chase the same
-- fault. One row per claim. A claim is OPEN while cleared_at IS NULL. At most one open claim per room is enforced by a partial UNIQUE index, so a
-- second claim on a room that is already claimed fails at the database, not just in the app. History (cleared claims) stays for 7 days.
--
-- OPERATIONAL ONLY. No PHI: no patient, no encounter, no transcript, no audio. claimed_by / cleared_by are short operator labels (1-64 chars),
-- state_at_claim is the room's audio-state label at the moment of the claim, note is a free line of at most 280 chars.
--
-- room_id is FK-FREE on purpose (scratch and OT rooms are not in any rooms table), as in room_audio_state (0129).
--
-- NO ROLE GRANTS. The app reaches this table over the owner connection. eta_audio_writer gets nothing here.
--
-- RETENTION. /api/cron/kiosk-health-retention deletes cleared claims older than 7 days (by claimed_at) and auto-clears open claims older than
-- 7 days (cleared_by = 'retention').
--
-- ADDITIVE AND IDEMPOTENT. CREATE TABLE/INDEX IF NOT EXISTS and the schema_migrations row.
-- =====================================================================

CREATE TABLE IF NOT EXISTS rooms_live_claim (
  id               bigserial PRIMARY KEY,
  room_id          text NOT NULL,
  claimed_by       text NOT NULL CHECK (char_length(claimed_by) BETWEEN 1 AND 64),
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  cleared_at       timestamptz NULL CHECK (cleared_at IS NULL OR cleared_at >= claimed_at),
  cleared_by       text NULL CHECK (cleared_by IS NULL OR char_length(cleared_by) BETWEEN 1 AND 64),
  state_at_claim   text NULL CHECK (state_at_claim IS NULL OR char_length(state_at_claim) <= 64),
  note             text NULL CHECK (note IS NULL OR char_length(note) <= 280)
);

CREATE INDEX IF NOT EXISTS rooms_live_claim_room_claimed_idx ON rooms_live_claim (room_id, claimed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_live_claim_one_open_idx ON rooms_live_claim (room_id) WHERE cleared_at IS NULL;

COMMENT ON TABLE rooms_live_claim IS
  'Rooms Live operator claims on a room. Operational only: no PHI. One open claim per room.';

INSERT INTO schema_migrations (version, name)
VALUES (131, '0131_rooms_live_claim')
ON CONFLICT DO NOTHING;
