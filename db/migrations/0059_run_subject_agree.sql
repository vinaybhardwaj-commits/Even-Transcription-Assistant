-- =====================================================================
-- Migration 0059 — the two keys must AGREE (22 Aug 2026). Step two of five.
--
-- 0058 added subject_type/subject_id and backfilled subject_id = encounter_id on every row.
-- Nothing has enforced that since: an encounter run could be written with a subject_id
-- pointing at some other encounter, or at a bench_window, and no reader would notice until
-- the two keys disagreed about which subject a run belonged to.
--
-- This is the constraint that makes the rest of the migration safe to lean on. Once the
-- database refuses a disagreeing row, a reader may switch from encounter_id to subject_id
-- WITHOUT having to prove that every writer stayed in step — which is exactly what step
-- three (0060) and the K4a reader move depend on.
--
-- Scoped to subject_type = 'encounter' on purpose: a 'bench_window' run has no encounter to
-- agree with, and 0060 is what makes its encounter_id nullable.
--
-- ADD CONSTRAINT has no IF NOT EXISTS; the DO wrapper is what makes this idempotent.
--
-- NOT TOUCHED: every row (this adds no data), encounter_id's NOT NULL and FK — 0060 owns
-- that — the 0058 trigger, and stt_fanout_job.
-- =====================================================================

DO $$ BEGIN
  ALTER TABLE transcription_run
    ADD CONSTRAINT transcription_run_encounter_agree_chk
    CHECK (subject_type <> 'encounter' OR subject_id = encounter_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO schema_migrations (version, name)
VALUES (59, '0059_run_subject_agree')
ON CONFLICT DO NOTHING;
