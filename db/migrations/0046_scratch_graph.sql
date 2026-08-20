-- =====================================================================
-- Migration 0046 — the scratch graph (ETA Fuse slice 2, 20 Aug 2026).
-- Additive + idempotent. The FIRST schema change in the fuse programme.
--
-- Replay (slice 1, scribe_replay_session) can produce a cue list and post
-- nothing. Slice 2 lets it write that list into a SCRATCH graph, so the fuse
-- has something to run against without touching a real clinic day.
--
-- Three additions, and nothing else:
--
--   1. room_day.scratch  — the write guard's flag. NOT part of any key. The
--                          cue route refuses to write to a room_day whose
--                          scratch is not true, and it only ever checks it on
--                          the new explicit room_day_id path (F7, F9).
--
--   2. cue.session_id    — the bench_session a replayed cue came from.
--      cue.source        — the cue's own source, promoted OUT of the payload
--                          jsonb so the natural key is real and indexable and
--                          slice 4 can find replay cues without reading json
--                          (F8). Both NULLABLE: every live cue keeps writing
--                          neither, through the untouched SQL_CUE_INSERT.
--
--   3. A PARTIAL unique index over (session_id, type, at) WHERE source =
--      'replay' — the natural key slice 1 declared, made real. PARTIAL is the
--      whole point: live cues carry a NULL source and must never enter this
--      index, so a real clinic cue can never collide with a replayed one, and
--      this migration is safe against a database that already holds a real
--      19 August (it does — cue_95z4avnv on OPD 7).
--
-- NO CHECK constraint on cue.source, and none on cue.type. `type` is an open
-- set by design (0042), and "kiosk" already appears as a source inside live
-- cue payloads without being one of the MCP's CUE_SOURCES — a CHECK on either
-- would be a trap for a later writer, not a safety net.
--
-- NOT TOUCHED, deliberately: room_day's UNIQUE (room_id, ist_date), which
-- resolveRoomDay's ON CONFLICT names verbatim. A scratch day never shares that
-- key with a live one because it hangs off its own scratch room (F6).
--
-- ADD COLUMN IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS are already
-- idempotent by name, so the 0045 DO $$ … EXCEPTION WHEN duplicate_object $$
-- wrapper (which exists there only because ADD CONSTRAINT has no IF NOT
-- EXISTS) is not needed here.
-- =====================================================================

-- 1. The scratch flag on the day. Default false → every existing room_day,
--    including the real 19 August, is a live day and stays refused.
ALTER TABLE room_day
  ADD COLUMN IF NOT EXISTS scratch boolean NOT NULL DEFAULT false;

-- 2. The two nullable cue columns. Existing rows get NULL in both — byte-
--    identical history, and NULL source keeps them out of the index below.
ALTER TABLE cue
  ADD COLUMN IF NOT EXISTS session_id text;

ALTER TABLE cue
  ADD COLUMN IF NOT EXISTS source text;

-- 3. The natural key (session_id, type, at), for replay cues ONLY.
--    Re-running a replay writes nothing that already exists: the scratch
--    insert takes ON CONFLICT DO NOTHING against this index.
CREATE UNIQUE INDEX IF NOT EXISTS cue_replay_natural_key
  ON cue (session_id, type, at)
  WHERE source = 'replay';

INSERT INTO schema_migrations (version, name)
VALUES (46, '0046_scratch_graph')
ON CONFLICT DO NOTHING;
