-- =====================================================================
-- Migration 0052 — stt_window joins the turn family (speech turns, slice A, K3, 22 Aug 2026).
--
-- WHY THE WRITE UNIT CHANGED. Whisper is not a deterministic writer: two runs of the same clip
-- returned 162 and 165 segments. A key built on segment boundaries therefore ACCUMULATES rather
-- than deduplicating — the second run's 165 segments mostly miss the first run's 162 keys, so a
-- re-run adds rows instead of replacing them. The designer moved the write unit from the turn to
-- the WINDOW: a window's turns are deleted and re-inserted as a set, in one transaction.
--
-- source_ref stays exactly what 0050 made it, and stays the WITHIN-WRITE key: two turns that
-- share a start still both land, which 0051 proved in production. What it is NOT is the
-- cross-run key. Segmentation is Whisper's opinion about a window, and an opinion is replaced,
-- not merged.
--
-- WHAT THIS MIGRATION DOES. `stt_window` is the new completeness cue — one row per asked window
-- saying whether the window was finished. It is a replay cue of the same family as stt_turn and
-- stt_silence, so it must appear in BOTH predicates or it lands in the wrong index:
--
--   · cue_replay_natural_key (0046, narrowed by 0051) keys replay cues on (session_id, type, at)
--     and must EXCLUDE stt_window. Without that, the one stt_window row per window would collide
--     with any other replay cue sharing its (session, type, at) — and worse, would be keyed by
--     the clock rather than by the window it describes.
--   · cue_turn_natural_key (0050) keys the turn family on (source_ref, type) and must INCLUDE
--     stt_window, so the completeness cue is idempotent within a write exactly as a turn is.
--
-- BOTH NEED A DROP AND A RECREATE, for the same reason 0051 did: Postgres has no
-- ALTER INDEX … SET PREDICATE. Named here so it does not become a precedent — this is the second
-- and last time the turn predicates move, because the family is now closed at four.
--
-- SAFE. The rows either index stops covering are stt_window rows, of which production holds
-- none (this migration introduces the type). Coverage of every existing row — the marks, the
-- warehouse cues, OPD 7's 35 stable turns at 04:02Z — is unchanged row for row.
--
-- ORDER MATTERS WITHIN THE FILE, not between the pairs: each DROP immediately precedes its own
-- CREATE, so at no point is a predicate left wider than the one before it.
--
-- IDEMPOTENT: every statement is IF EXISTS / IF NOT EXISTS by name, so a second run is a no-op.
--
-- SQL_CUE_INSERT_TURN in lib/brain/state.ts repeats the second predicate below CHARACTER FOR
-- CHARACTER as its ON CONFLICT inference predicate, and tests/unit/speech-turns-k2.test.ts
-- asserts that equality by reading this file. Change one and the other fails, which is the point.
-- =====================================================================

-- 1. The replay key EXCLUDES the four turn-family types.
DROP INDEX IF EXISTS cue_replay_natural_key;

CREATE UNIQUE INDEX IF NOT EXISTS cue_replay_natural_key
  ON cue (session_id, type, at)
  WHERE source = 'replay'
    AND type NOT IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match');

-- 2. The turn key INCLUDES them. Same four names, same order, opposite sense.
DROP INDEX IF EXISTS cue_turn_natural_key;

CREATE UNIQUE INDEX IF NOT EXISTS cue_turn_natural_key
  ON cue (source_ref, type)
  WHERE source = 'replay'
    AND type IN ('stt_turn', 'stt_silence', 'stt_window', 'speaker_match');

INSERT INTO schema_migrations (version, name)
VALUES (52, '0052_stt_window_type')
ON CONFLICT DO NOTHING;
