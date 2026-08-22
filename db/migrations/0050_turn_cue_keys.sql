-- =====================================================================
-- Migration 0050 — the speech turn's natural key (speech turns, slice A, 22 Aug 2026).
-- Additive + idempotent. Same shape as 0046 and 0047: no new column, one
-- partial unique index, and its own schema_migrations row.
--
-- Slice 2 keyed the replay on (session_id, type, at) WHERE source = 'replay'.
-- Slice 3 keyed the warehouse loader on (source_ref, type, at) WHERE
-- source = 'warehouse'. A speech turn is the third evidence source and needs
-- the same guarantee: transcribing the same window twice must write the same
-- turns once.
--
-- WHAT IDENTIFIES A TURN. Not the session and the clock — two turns can share
-- a start when a window is re-cut, and the clock alone says nothing about who
-- spoke. A turn is identified by the four things that produced it, carried in
-- cue.source_ref (0047's column, reused rather than a fourth one added):
--
--     {session_id}|{start_ms}|{end_ms}|{speaker}
--
-- exactly four fields, pipe separated, no spaces; start_ms and end_ms integer
-- epoch milliseconds, FLOORED, never rounded and never ISO; `speaker` the
-- literal `-` in slice A and on every stt_silence. Slice B puts an integer in
-- that slot, which is why the slot exists now: a diarised re-run of the same
-- window is a DIFFERENT turn, not a duplicate of the anonymous one, and the
-- key says so without the format ever gaining a fifth field.
--
--   e.g.  bs_xvntaugh|1755576000000|1755576004320|-
--
-- (source_ref, type) and NOT (source_ref, type, at): the timestamps are
-- already inside source_ref, so adding `at` to the key would let a re-run that
-- rounded one millisecond differently write the same turn twice.
--
-- PARTIAL, and the predicate is the whole point — repeated verbatim by the
-- writer's ON CONFLICT so the two can be read against each other:
--
--     ON CONFLICT (source_ref, type)
--       WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'speaker_match')
--       DO NOTHING
--
-- A live cue carries a NULL source, a warehouse cue carries 'warehouse', and a
-- replay cue of any OTHER type (consult_mark, the mic story) fails the type
-- test — so none of them enters this index and none can collide with a turn.
--
-- NOT TOUCHED, deliberately: cue_replay_natural_key (0046) and
-- cue_warehouse_natural_key (0047). The turn writer leaves cue.session_id NULL
-- precisely so a turn cannot also enter 0046's index — the session is already
-- the first field of source_ref, and a row in two keys would be deduplicated by
-- whichever fired first rather than by the key that describes it. NULL keeps it
-- out, because NULLs are distinct in a unique index.
--
-- NO CHECK on cue.type and none on cue.source, per 0042/0046/0047: `type` is an
-- open set by design. The three names appear in an index predicate, which
-- constrains nothing that is not being written.
--
-- CREATE UNIQUE INDEX IF NOT EXISTS is idempotent by name, so no
-- DO $$ … EXCEPTION $$ wrapper is needed (0045 has one only because
-- ADD CONSTRAINT has no IF NOT EXISTS).
--
-- FLAGGED, NOT DECIDED: the slice A kickoff calls for "exactly the two
-- statements in §4", and §4 did not reach this build — only the conflict target
-- above did. The one statement it fully specifies is here. Nothing has been
-- invented to make up a second: a missing index costs a sequential scan, an
-- invented unique index costs writes. If §4's second statement is a supporting
-- (non-unique) index, it can be added as 0051 with no rework of anything below.
-- =====================================================================

-- 1. The natural key (source_ref, type), for speech-turn cues ONLY.
--    Re-transcribing a window writes nothing that already exists: the scratch
--    insert takes an unqualified ON CONFLICT DO NOTHING, which covers this
--    index exactly as it already covers 0046's and 0047's.
CREATE UNIQUE INDEX IF NOT EXISTS cue_turn_natural_key
  ON cue (source_ref, type)
  WHERE source = 'replay' AND type IN ('stt_turn', 'stt_silence', 'speaker_match');

INSERT INTO schema_migrations (version, name)
VALUES (50, '0050_turn_cue_keys')
ON CONFLICT DO NOTHING;
