-- =====================================================================
-- Migration 0058 — transcription_run.subject_type / subject_id.
-- STEP ONE OF FIVE (22 Aug 2026). Steps 2..5 are NOT in this file.
--
-- WHERE THIS IS GOING
-- A transcription_run is currently, by its schema, always a run over an
-- ENCOUNTER: encounter_id is NOT NULL with an FK. It will need to also be a run
-- over a bench_window (0057). The end state is a polymorphic subject —
-- (subject_type, subject_id) — with encounter_id eventually retired. This step
-- ONLY adds the pair and makes it true for every existing row. Nothing reads it.
--
-- WHAT THIS STEP GUARANTEES
--   · every existing row gets subject_type='encounter', subject_id=encounter_id
--   · every NEW row gets the same, without one line of application code changing
--   · encounter_id KEEPS its NOT NULL and its foreign key — untouched
--   · no reader anywhere changes, and behaviour after this migration is identical
--
-- THE TRIGGER, AND WHY IT IS NOT OPTIONAL
-- Five live code paths INSERT INTO transcription_run with an explicit column
-- list and none of them names subject_id:
--   app/[slug]/api/encounters/[id]/finalize-upload/route.ts  (the DOCTOR
--     RECORDING PATH — one row per engine, best-effort testbed log)
--   lib/stt/fanout.ts                                        (×3: asr, even_pipeline, scribe)
--   lib/stt/translate-bakeoff.ts                             (×1)
-- A NOT NULL column with no default would make every one of those inserts fail
-- from the moment this migration lands. Four of the five swallow the error into
-- a warnings array, so the failure would be SILENT: the STT lab and the testbed
-- log would simply stop recording, and nothing would say why. That is precisely
-- the behaviour change this step is required not to make — and it would land two
-- days before a live OPD day.
--
-- So subject_id is filled by a BEFORE INSERT trigger instead. It is a COALESCE,
-- not an override: a caller that DOES name subject_id keeps whatever it passed,
-- which is what makes steps 2..5 able to start writing bench_window subjects
-- without fighting this. A DEFAULT could not do this job — a column default
-- cannot reference another column of the same row.
--
-- The trigger is scaffolding for the transition and is expected to be dropped in
-- a later step, once every writer names the pair explicitly.
--
-- COMMENT AMENDED 23 Aug 2026 (K4a C4) — THE EXACT CONDITION FOR REMOVAL, written down so it
-- is not guessed at. Do NOT drop this trigger until ALL FIVE of these name subject_type and
-- subject_id in their INSERT column list:
--
--   app/[slug]/api/encounters/[id]/finalize-upload/route.ts   (the DOCTOR RECORDING PATH)
--   lib/stt/fanout.ts  x3   (asr, even_pipeline, scribe)
--   lib/stt/translate-bakeoff.ts  x1
--
-- Four of the five swallow insert errors into a warnings array, so dropping the trigger while
-- any of them still omits the column would break them SILENTLY: no exception, no failed
-- request, just runs that quietly stop being written. K4a moved every READER onto subject_id,
-- which makes the trigger REDUNDANT — but redundant is not unused, and fixing the writers is
-- its own build. Tracked in ETA-BACKLOG-SCOPED.md.
--
-- IDEMPOTENT THROUGHOUT: ADD COLUMN IF NOT EXISTS, an UPDATE that only touches
-- NULLs, SET NOT NULL (a no-op when already set), CREATE OR REPLACE FUNCTION,
-- DROP TRIGGER IF EXISTS before CREATE TRIGGER, and the DO wrapper that gives
-- ADD CONSTRAINT the IF NOT EXISTS it does not have.
--
-- NOT TOUCHED: transcription_run's primary key, encounter_id (NOT NULL + FK
-- intact), tier/mode/engine and every 0019 column, idx_transcription_run_encounter,
-- and every row count — this migration inserts and deletes nothing.
-- =====================================================================

ALTER TABLE transcription_run
  ADD COLUMN IF NOT EXISTS subject_type TEXT NOT NULL DEFAULT 'encounter';

ALTER TABLE transcription_run
  ADD COLUMN IF NOT EXISTS subject_id   TEXT;

-- Backfill: every existing run is a run over its encounter.
UPDATE transcription_run SET subject_id = encounter_id WHERE subject_id IS NULL;

-- Keep new rows true without touching a single writer (see the note above).
CREATE OR REPLACE FUNCTION transcription_run_fill_subject()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.subject_id IS NULL THEN
    NEW.subject_id := NEW.encounter_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transcription_run_fill_subject_trg ON transcription_run;

CREATE TRIGGER transcription_run_fill_subject_trg
  BEFORE INSERT ON transcription_run
  FOR EACH ROW EXECUTE FUNCTION transcription_run_fill_subject();

-- Safe only because the backfill above ran and the trigger covers every new row.
ALTER TABLE transcription_run ALTER COLUMN subject_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE transcription_run
    ADD CONSTRAINT transcription_run_subject_type_chk
    CHECK (subject_type IN ('encounter','bench_window'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_transcription_run_subject
  ON transcription_run (subject_type, subject_id);

INSERT INTO schema_migrations (version, name)
VALUES (58, '0058_run_subject_add')
ON CONFLICT DO NOTHING;
