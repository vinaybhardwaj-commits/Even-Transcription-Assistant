-- =====================================================================
-- Migration 0060 — a run may belong to something that is not an encounter
-- (22 Aug 2026). Step three of five.
--
-- transcription_run.encounter_id has been NOT NULL since 0006, which is the single thing
-- standing between this table and a bench_window run. Dropping that NOT NULL is the whole
-- migration; the CHECK beside it is what stops the drop from being a loss.
--
-- DROP NOT NULL WITHOUT A REPLACEMENT WOULD BE A REGRESSION. Every encounter run needs its
-- encounter, and until now the column's NOT NULL said so. transcription_run_encounter_present_chk
-- says the same thing again, but only for the rows it is true of: an 'encounter' run must
-- still carry an encounter_id, while a 'bench_window' run may leave it NULL. Together with
-- 0059's agreement CHECK, an encounter run is now MORE constrained than it was, not less —
-- it must have an encounter_id AND that id must equal subject_id.
--
-- The FOREIGN KEY is untouched and still enforced: a non-null encounter_id must still name a
-- real encounter, and ON DELETE CASCADE still applies.
--
-- NOT TOUCHED: subject_type's default and CHECK (0058), subject_id's NOT NULL, the 0058
-- trigger, idx_transcription_run_subject, and every row — this migration writes no data.
-- =====================================================================

ALTER TABLE transcription_run ALTER COLUMN encounter_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE transcription_run
    ADD CONSTRAINT transcription_run_encounter_present_chk
    CHECK (subject_type <> 'encounter' OR encounter_id IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO schema_migrations (version, name)
VALUES (60, '0060_run_encounter_nullable')
ON CONFLICT DO NOTHING;
