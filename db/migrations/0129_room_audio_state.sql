-- =====================================================================
-- Migration 0129 — room audio state: per-room interval log, per-day rollup, and the eta_audio_writer role.
--
-- WHY. A room-audio-state classifier labels every minute of every room (OPD kiosks and OT recorders) with what the room was doing:
-- recorder off, muted, exact-zero all day, audio present, audio gated, withheld, device missing/dead, quiet, speech, or an actual consult.
-- This migration is storage only. Nothing here reads or acts on a room. The classifier (a separate writer) and a later admin live monitor use it.
--
--   room_audio_state  one row per contiguous interval of one state in one room. METADATA ONLY: state labels, timestamps and small evidence
--                     counters. No audio, no text, no transcript, no names. A room-day is rewritten as DELETE + INSERT in one transaction.
--   room_audio_day    one row per (room, IST day): minutes per state, consult minutes split usable / uncertain / lost, and the consult count.
--                     The writer upserts it, so it needs UPDATE.
--
-- room_id is FK-FREE on purpose: scratch and OT rooms are not in any rooms table, and a retired room must not block or cascade over history.
-- source says which fleet produced the interval (kiosk = OPD room kiosk, ot = OT recorder). ist_day is the IST calendar date of ts_start.
--
-- ROLE eta_audio_writer. Created NOLOGIN here, because this file is committed to git and must carry no password. The LOGIN PASSWORD is set later,
-- out of band, by the owner. Least privilege, and nothing else:
--   SELECT, INSERT, DELETE on both tables; UPDATE on room_audio_day only (upsert); USAGE, SELECT on the state table's id sequence;
--   SELECT on eta_encounter_windows (the consult windows the classifier reads). No grant on kiosk_health_events, steward_*, or anything else.
--
-- RETENTION. /api/cron/kiosk-health-retention deletes room_audio_state older than 12 months and room_audio_day older than 36 months (by ist_day).
--
-- ADDITIVE AND IDEMPOTENT. CREATE TABLE/INDEX IF NOT EXISTS, a guarded CREATE ROLE, GRANTs (re-granting is a no-op), and the schema_migrations row.
-- APPLY AFTER 0123 (eta_encounter_windows must exist for its GRANT).
-- =====================================================================

CREATE TABLE IF NOT EXISTS room_audio_state (
  id                  bigserial PRIMARY KEY,
  room_id             text NOT NULL,
  machine             text,
  source              text NOT NULL CHECK (source IN ('kiosk', 'ot')),
  ist_day             date NOT NULL,
  state               text NOT NULL CHECK (state IN ('recorder_off', 'muted', 'zero_all_day', 'audio_present', 'audio_gated', 'withheld', 'device_missing', 'device_dead', 'room_quiet', 'speech', 'consult')),
  ts_start            timestamptz NOT NULL,
  ts_end              timestamptz NOT NULL CHECK (ts_end > ts_start),
  evidence            jsonb NOT NULL DEFAULT '{}'::jsonb,
  classifier_version  text NOT NULL,
  written_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_audio_state_room_start_idx ON room_audio_state (room_id, ts_start);
CREATE INDEX IF NOT EXISTS room_audio_state_day_room_idx   ON room_audio_state (ist_day, room_id);
CREATE INDEX IF NOT EXISTS room_audio_state_room_end_idx   ON room_audio_state (room_id, ts_end DESC);

COMMENT ON TABLE room_audio_state IS
  'Room audio-state intervals. Metadata only: no audio, no text.';

CREATE TABLE IF NOT EXISTS room_audio_day (
  room_id                text NOT NULL,
  ist_day                date NOT NULL,
  min_off                integer NOT NULL DEFAULT 0,
  min_muted              integer NOT NULL DEFAULT 0,
  min_zero_all_day       integer NOT NULL DEFAULT 0,
  min_present            integer NOT NULL DEFAULT 0,
  min_gated              integer NOT NULL DEFAULT 0,
  min_withheld           integer NOT NULL DEFAULT 0,
  consult_min_usable     integer NOT NULL DEFAULT 0,
  consult_min_uncertain  integer NOT NULL DEFAULT 0,
  consult_min_lost       integer NOT NULL DEFAULT 0,
  n_consults             integer NOT NULL DEFAULT 0,
  classifier_version     text NOT NULL,
  written_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, ist_day)
);

CREATE INDEX IF NOT EXISTS room_audio_day_day_idx ON room_audio_day (ist_day);

COMMENT ON TABLE room_audio_day IS
  'Per-room per-IST-day rollup of room_audio_state. Metadata only: no audio, no text.';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eta_audio_writer') THEN
    CREATE ROLE eta_audio_writer NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO eta_audio_writer;
GRANT SELECT, INSERT, DELETE ON room_audio_state, room_audio_day TO eta_audio_writer;
GRANT UPDATE ON room_audio_day TO eta_audio_writer;
GRANT USAGE, SELECT ON SEQUENCE room_audio_state_id_seq TO eta_audio_writer;
GRANT SELECT ON eta_encounter_windows TO eta_audio_writer;

INSERT INTO schema_migrations (version, name)
VALUES (129, '0129_room_audio_state')
ON CONFLICT DO NOTHING;
