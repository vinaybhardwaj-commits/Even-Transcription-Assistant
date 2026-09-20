-- =====================================================================
-- Migration 0109 — room_clinician_attestation: who was in the room, because they said so.
--
-- WHY. `room_day.doctor_id` is NULL on all 102 room-days in production: nothing has ever recorded
-- which clinician was in a room, so every downstream binding is inferred from voice matching, and
-- a voice match cannot be checked against anything. This table is the other kind of fact — a
-- clinician PRESENTED THEIR PIN in a room at a time, and the server verified it.
--
-- ATTESTED, AND DISTINGUISHABLE FOR EVER FROM AN INFERENCE. Every row here is one PIN presentation
-- that passed. `method` exists so a future inferred binding can never be written into this table
-- and silently read as attested: the only value this build writes is 'pin', and a reader filters
-- on it rather than on the table's name.
--
-- A SITTING ALWAYS HAS AN END (see lib/attestation.ts). `expires_at` is NOT NULL and is set at
-- insert to start + the sitting cap, so an attestation can never silently claim the rest of the
-- day. The EFFECTIVE end is the earliest of `expires_at`, an explicit `ended_at`, and the
-- recording session's own end — resolved on read, so it can only ever narrow, never widen.
--
-- NO PIN, EVER. Nothing here stores or references a PIN, hashed or otherwise; `pin_presented`
-- records only THAT one was presented and verified.
-- =====================================================================

CREATE TABLE IF NOT EXISTS room_clinician_attestation (
  id            text        PRIMARY KEY,
  room_id       text        NOT NULL,
  clinician_id  text        NOT NULL,
  session_id    text,
  started_at    timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  ended_at      timestamptz,
  method        text        NOT NULL DEFAULT 'pin',
  pin_presented boolean     NOT NULL DEFAULT TRUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_clinician_attestation_window_ck CHECK (expires_at > started_at),
  CONSTRAINT room_clinician_attestation_ended_ck  CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT room_clinician_attestation_method_ck CHECK (method IN ('pin'))
);

-- The two overlap questions this table is asked, both bounded by time.
CREATE INDEX IF NOT EXISTS idx_rca_room_time      ON room_clinician_attestation (room_id, started_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_rca_clinician_time ON room_clinician_attestation (clinician_id, started_at, expires_at);
-- One live attestation per (room, session): a replayed request finds this and is answered from it
-- rather than writing a second row. Partial, so a closed sitting does not block the next one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rca_room_session_open
  ON room_clinician_attestation (room_id, session_id)
  WHERE ended_at IS NULL AND session_id IS NOT NULL;

COMMENT ON TABLE room_clinician_attestation IS
  'One verified PIN presentation binding a clinician to a room for a sitting. Attested, never inferred: filter on method = ''pin''. No PIN value is stored here.';
COMMENT ON COLUMN room_clinician_attestation.expires_at IS
  'Hard cap, set at insert to started_at + the sitting cap. The effective end is the earliest of this, ended_at, and the session end — resolved on read so it can only narrow.';
COMMENT ON COLUMN room_clinician_attestation.pin_presented IS
  'THAT a PIN was presented and verified. Never the PIN, and never its hash.';

INSERT INTO schema_migrations (version, name)
VALUES (109, '0109_room_clinician_attestation')
ON CONFLICT DO NOTHING;
