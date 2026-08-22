-- =====================================================================
-- Migration 0051 — narrow the replay natural key (speech turns, slice A, K2, 22 Aug 2026).
--
-- THE STATEMENT THAT DID NOT ARRIVE. Slice A's PRD §4 called for two statements; only one
-- reached the build, so 0050 shipped the turn key and this one was left open and FLAGGED
-- rather than invented. This is it, and it is the designed mechanism.
--
-- WHAT 0046 KEYED, AND WHY IT IS TOO WIDE NOW. 0046 put every replay cue into one index:
--
--     cue_replay_natural_key ON cue (session_id, type, at) WHERE source = 'replay'
--
-- A speech turn is also a replay cue (`source = 'replay'`), so a turn carrying its session
-- would enter that index as well as 0050's (source_ref, type) — one row under two keys,
-- deduplicated by whichever arbiter fired first rather than by the key that describes it.
-- Slice A avoided the collision by leaving cue.session_id NULL on turns, which WORKS (NULLs
-- are distinct in a unique index) but drops a column the design requires and reopens the
-- collision for any later writer that sets it. Narrowing the predicate closes it properly:
-- turn types leave 0046's index by definition, so the session can go back on the row.
--
-- NOT ADDITIVE, AND NAMED HERE SO IT IS NOT A PRECEDENT. Postgres has no ALTER INDEX … SET
-- PREDICATE: narrowing needs a DROP and a CREATE. It is safe because the rows the index stops
-- covering are exactly the three turn types, which no writer has written yet (0050 has not run
-- in production) and which 0050's own index covers row for row. Coverage of MARKS — the
-- consult_mark / mic-story replay cues that scribe_replay_write actually wrote — is unchanged.
--
-- 0050 AND 0051 RUN TOGETHER, IN ORDER. 0050 is unapplied in production; the pair is one
-- change to the same key, and applying 0050 alone would leave the two-key window open.
--
-- cue_turn_natural_key from 0050 is correct and is NOT touched here.
-- cue_warehouse_natural_key from 0047 is NOT touched here: its predicate is source =
-- 'warehouse', disjoint from both of the above.
--
-- IDEMPOTENT: DROP INDEX IF EXISTS then CREATE UNIQUE INDEX IF NOT EXISTS, both by name, so a
-- second run is a no-op — and the drop leaves nothing behind if the create is the part that
-- already ran.
-- =====================================================================

-- 1. Out with the wide predicate.
DROP INDEX IF EXISTS cue_replay_natural_key;

-- 2. In with the narrow one: replay cues that are NOT speech turns. Same columns, same name,
--    one fewer class of row. The three type names are 0050's list and TURN_CUE_TYPES in
--    lib/brain/state.ts — three places, one closed set.
CREATE UNIQUE INDEX IF NOT EXISTS cue_replay_natural_key
  ON cue (session_id, type, at)
  WHERE source = 'replay'
    AND type NOT IN ('stt_turn', 'stt_silence', 'speaker_match');

INSERT INTO schema_migrations (version, name)
VALUES (51, '0051_narrow_replay_key')
ON CONFLICT DO NOTHING;
