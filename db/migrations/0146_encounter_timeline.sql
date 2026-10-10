-- =====================================================================
-- Migration 0146 — epic #23 ticket (f): the pre-STT TIMELINE run source.
--
-- shadow-v3 (lib/encounter-clock/shadow-v3.ts) reads Pulse anchors, Nemotron turns and the level log, asks Jev
-- about the speaker-turn timeline (no text), and writes one more run beside the acoustic and fused ones.
--
-- 1. encounter_hypothesis_run.source gains 'timeline'.
-- 2. encounter_hypothesis.closed_by gains the five reasons the fusion-timeline ranks name:
--      pulse_end       a real End click (Pulse endConsult) corroborated by the last diarized speech
--      jev_end         Jev's end row, snapped to the last diarized turn in that row
--      next_start      the next Start minus 15 s
--      last_doc_turn   the last turn of the consult's doctor plus 30 s
--      cap_90m         the 90-minute ceiling
--    (acoustic closes keep their existing values non_speech / tape_off / dead_mic.)
--    The order named three of these; last_doc_turn and cap_90m are added because borrowing 'end_of_input' for them
--    would record a reason that did not happen.
-- 3. encounter_hypothesis.origin — which evidence placed the END: 'anchor' | 'acoustic' | 'jev'. NULL on every
--    pre-existing row (those runs never recorded it); only timeline runs set it.
--
-- ADDITIVE AND IDEMPOTENT. Each constraint is dropped-if-exists and re-added with the wider set. No row is
-- rewritten. App-owned: no GRANTs. jev_decision already admits subject_type 'encounter'.
-- =====================================================================

BEGIN;

ALTER TABLE encounter_hypothesis_run DROP CONSTRAINT IF EXISTS encounter_hypothesis_run_source_chk;
ALTER TABLE encounter_hypothesis_run ADD CONSTRAINT encounter_hypothesis_run_source_chk
  CHECK (source IN ('acoustic', 'fused', 'timeline'));

ALTER TABLE encounter_hypothesis DROP CONSTRAINT IF EXISTS encounter_hypothesis_closed_by_chk;
ALTER TABLE encounter_hypothesis ADD CONSTRAINT encounter_hypothesis_closed_by_chk CHECK (
  closed_by IN ('non_speech', 'unjudged_gap', 'tape_off', 'dead_mic', 'end_of_input', 'content_boundary',
                'pulse_end', 'jev_end', 'next_start', 'last_doc_turn', 'cap_90m'));

ALTER TABLE encounter_hypothesis ADD COLUMN IF NOT EXISTS origin text NULL;
ALTER TABLE encounter_hypothesis DROP CONSTRAINT IF EXISTS encounter_hypothesis_origin_chk;
ALTER TABLE encounter_hypothesis ADD CONSTRAINT encounter_hypothesis_origin_chk
  CHECK (origin IS NULL OR origin IN ('anchor', 'acoustic', 'jev'));

COMMENT ON COLUMN encounter_hypothesis.origin IS
  'Which evidence placed the end of a timeline-run interval: anchor (Pulse), acoustic, or jev. NULL for acoustic and fused runs.';

INSERT INTO schema_migrations (version, name)
VALUES (146, '0146_encounter_timeline')
ON CONFLICT DO NOTHING;

COMMIT;
