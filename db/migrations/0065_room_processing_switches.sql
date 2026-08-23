-- =====================================================================
-- Migration 0065 — the two processing switches move out of the environment and onto the room.
--
-- WHY (PRD §2, decision R1). ROOM_STT_DRAIN_ENABLED and FUSE_LIVE_ENABLED are environment
-- variables holding a comma-separated list of room ids, and Vercel bakes environment variables
-- into a build. So TURNING PROCESSING OFF DURING A CLINIC REQUIRES A REDEPLOY. The only instant
-- switch that exists today is room.disabled_at, which stops the room entirely including its
-- recording — a hammer, not a dial.
--
-- room.disabled_at is also the pattern being copied: a per-room switch in the database, read at
-- the point of use, instant, no deploy.
--
-- CHANGES NO BEHAVIOUR. Neither environment variable is set in production, so both parse to off
-- for all seven rooms. FALSE is therefore the effective state today, and this migration writes
-- exactly that. Nothing starts processing because this ran.
--
-- R2: a NEWLY CREATED room also defaults false. A room does not begin writing to its own live
-- record because somebody added it.
--
-- GRANTS. `room` is already SELECT-able by brain_svc and that is all it needs — the brain reads
-- these columns, it never writes them. brain_svc MUST NOT gain UPDATE on room (PRD §5.1): the
-- switches are written by the app role only, through one audited route. No grant is issued here,
-- and the absence is the point.
--
-- NOT TOUCHED: room.disabled_at, which remains the only control that stops a room completely;
-- every other column of room; every row's data beyond the two new defaults.
-- =====================================================================

ALTER TABLE room
  ADD COLUMN IF NOT EXISTS transcript_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS visits_enabled     BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN room.transcript_enabled IS
  'Turn this room''s audio into words (the STT drain). Replaces ROOM_STT_DRAIN_ENABLED. Read at the point of use; no deploy to change. Default false.';
COMMENT ON COLUMN room.visits_enabled IS
  'Build this room''s record of who was seen (the live fuse). Replaces FUSE_LIVE_ENABLED. Read at the point of use; no deploy to change. Default false.';

INSERT INTO schema_migrations (version, name)
VALUES (65, '0065_room_processing_switches')
ON CONFLICT DO NOTHING;
