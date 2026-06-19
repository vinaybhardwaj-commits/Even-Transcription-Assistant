-- =====================================================================
-- Migration 0039 — NoteGen expansion_log: every accepted shorthand->expansion
-- from the editor's rewrite stream, to grow a curated lexicon later. Dark until
-- the NoteGen surface ships.
-- =====================================================================

CREATE TABLE IF NOT EXISTS expansion_log (
  id          BIGSERIAL PRIMARY KEY,
  encounter_id TEXT,
  note_type   TEXT,
  from_text   TEXT NOT NULL,
  to_text     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version, name)
VALUES (39, '0039_notegen_expansion_log')
ON CONFLICT DO NOTHING;
