-- =====================================================================
-- Migration 0037 — NoteGen (typed-note / text authoring) encounter cols.
--
-- Additive + dark: no code reads these until the NoteGen surface ships
-- (flag NEXT_PUBLIC_ETA_NOTEGEN). A typed note is a normal encounter whose
-- text is authored in the editor instead of dictated.
--   input_mode  — 'audio' (default, existing behaviour) | 'text'
--   editor_text — the in-progress live document (autosaved) for the text path
-- =====================================================================

ALTER TABLE encounter ADD COLUMN IF NOT EXISTS input_mode  TEXT NOT NULL DEFAULT 'audio';
ALTER TABLE encounter ADD COLUMN IF NOT EXISTS editor_text TEXT;

INSERT INTO schema_migrations (version, name)
VALUES (37, '0037_notegen_encounter_cols')
ON CONFLICT DO NOTHING;
