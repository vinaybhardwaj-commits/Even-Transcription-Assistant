-- =====================================================================
-- Migration 0104 — room_turn_repeat_run: mark-never-delete flag for phrase-loop turns.
--
-- WHY (phrase-loop root cause, 19 Sep 2026, docs/handoff/scratch/phrase-loop-19-SEP-2026.md).
-- Whisper's own segment-level output loops on some windows — the same short phrase transcribed
-- as many separate consecutive segments (one window measured: 197 of 358 turns, longest run 42).
-- The turns are real evidence of a real decoder failure; deleting or rewriting them would destroy
-- the only record of it. This table lets a reader EXCLUDE looped turns from a statistic at read
-- time, by a plain WHERE, without touching room_turn_speaker or cue.
--
-- ADDITIVE. One new table. No existing table, column, or CHECK constraint is touched.
--
-- ONE ROW PER MEASURED TURN, keyed the same way room_turn_speaker is: (window_id, source_ref).
-- NO ROW = never measured (predates this change, or the backfill has not reached it yet).
-- A ROW WITH in_run = false = measured, found clean.
-- A ROW WITH in_run = true = measured, inside a repeat run; run_id/run_length/run_rank say which.
--
-- A turn's row is written once by whichever pass measures it (the backfill or the live drain path)
-- and may be REPLACED by a later pass over the same (window_id, source_ref) — a turn cannot be
-- re-detected into two different runs at once, so the newer measurement simply wins.
-- =====================================================================

CREATE TABLE IF NOT EXISTS room_turn_repeat_run (
  window_id    text        NOT NULL,
  source_ref   text        NOT NULL,
  in_run       boolean     NOT NULL,
  run_id       text,
  run_length   integer     NOT NULL,
  run_rank     integer     NOT NULL,
  measured_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (window_id, source_ref)
);

CREATE INDEX IF NOT EXISTS idx_room_turn_repeat_run_in_run
  ON room_turn_repeat_run (window_id)
  WHERE in_run;

COMMENT ON TABLE room_turn_repeat_run IS
  'Mark-never-delete phrase-loop flag (lib/transcript/repeat-runs.ts). No row for a (window_id, source_ref) = never measured. Existence of a row is what distinguishes a pre-change turn from one measured and found clean; in_run distinguishes clean from looped.';
COMMENT ON COLUMN room_turn_repeat_run.run_id IS
  'Stable id for the run this turn belongs to: the source_ref of the run''s first (earliest) turn. NULL when in_run is false.';
COMMENT ON COLUMN room_turn_repeat_run.run_length IS
  'Total turns in this turn''s run. 1 when in_run is false (a "run" of just itself).';
COMMENT ON COLUMN room_turn_repeat_run.run_rank IS
  '1-indexed position of this turn within its run, in time order. 1 when in_run is false.';

INSERT INTO schema_migrations (version, name)
VALUES (104, '0104_room_turn_repeat_run')
ON CONFLICT DO NOTHING;
