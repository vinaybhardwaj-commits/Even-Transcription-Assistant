-- =====================================================================
-- Migration 0003 — note_json_edited column on encounter
--
-- Sprint 2.A: Edit-before-send lock. The LLM-generated note_json is
-- preserved as the original; doctor edits land in note_json_edited.
-- Email render uses COALESCE(note_json_edited, note_json) so unedited
-- encounters use the LLM original automatically.
-- =====================================================================

BEGIN;

ALTER TABLE encounter
  ADD COLUMN IF NOT EXISTS note_json_edited JSONB;

INSERT INTO schema_migrations (version, name)
  VALUES (3, '0003_note_edited')
  ON CONFLICT DO NOTHING;

COMMIT;
