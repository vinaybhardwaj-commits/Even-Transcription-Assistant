-- =====================================================================
-- Migration 0047 — the warehouse cue's natural key (ETA Fuse slice 3, 21 Aug 2026).
-- Additive + idempotent. Same shape as 0046, one column and one partial index.
--
-- Slice 2 gave the replay a scratch graph to write into and a natural key,
-- (session_id, type, at) WHERE source = 'replay', so re-running a replay writes
-- nothing twice. Slice 3 gives the OTHER evidence source the same guarantee.
--
-- A warehouse event has no session. What it does have is the identity of the
-- warehouse row it came from — a queue_token_steps row, a 7404 service line, a
-- Pulse note — and that identity is what makes the loader re-runnable:
--
--   cue.source_ref  — the warehouse row's own id, promoted OUT of the payload
--                     jsonb for exactly the reason 0046 promoted `source`: a key
--                     has to be real and indexable, and slice 4 must be able to
--                     find the cue a warehouse row produced without reading json.
--                     NULLABLE. Every live cue and every replay cue keeps writing
--                     nothing here.
--
-- PARTIAL, for the same reason 0046's index is partial, and it is the whole point:
-- a live cue carries a NULL source and a replay cue carries 'replay', so neither
-- enters this index and neither can ever collide with a warehouse cue. The
-- database already holds a real 19 August (cue_95z4avnv on OPD 7) and this
-- migration is safe against it.
--
-- NO CHECK on cue.source and none on cue.type, per 0046 and 0042: `type` is an
-- open set by design, and a CHECK on `source` would be a trap for a later writer.
--
-- NOT TOUCHED, deliberately: cue_replay_natural_key (slice 2's key — a second
-- index over different columns with a disjoint predicate, so the two never
-- interact), room_day's UNIQUE (room_id, ist_date), SQL_ROOM_DAY_UPSERT and
-- SQL_CUE_INSERT.
--
-- ADD COLUMN IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS are idempotent
-- by name, so no DO $$ … EXCEPTION $$ wrapper is needed here (0045 has one only
-- because ADD CONSTRAINT has no IF NOT EXISTS).
-- =====================================================================

-- 1. The warehouse row's own id. Existing rows get NULL — byte-identical
--    history, and a NULL source keeps every one of them out of the index below.
ALTER TABLE cue
  ADD COLUMN IF NOT EXISTS source_ref text;

-- 2. The natural key (source_ref, type, at), for warehouse cues ONLY.
--    Re-running the loader writes nothing that already exists: the scratch
--    insert takes ON CONFLICT DO NOTHING, which covers this index too.
CREATE UNIQUE INDEX IF NOT EXISTS cue_warehouse_natural_key
  ON cue (source_ref, type, at)
  WHERE source = 'warehouse';

INSERT INTO schema_migrations (version, name)
VALUES (47, '0047_warehouse_cue_key')
ON CONFLICT DO NOTHING;
