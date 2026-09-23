-- =====================================================================
-- Migration 0116 — jev_decision: the general Jev decision log (PLAN-v3.md §2, J-CORE-2).
--
-- WHY. Every prior Jev use built its own narrow, use-specific table (jev_window_signal 0106,
-- jev_role_signal 0107). This is the shared one: any use asking any registered question
-- (lib/jev/registry.ts) through lib/jev/ask.ts gets one row per (subject, question, prompt
-- version) here for free, instead of inventing another table per use — "every use rides these
-- rails" (PLAN-v3.md §2).
--
-- NO TEXT COLUMN (kickoff, verbatim). `answer` is the STRUCTURED decision — a noul/choice/score
-- value from a closed vocabulary (lib/jev/types.ts's JevAnswer) — never the state Jev was given
-- or any transcript/clinician/patient text. Plan principle 6: "metadata-only logs (never state
-- text, never the key)".
--
-- subject_type IS DELIBERATELY POLYMORPHIC (window | turn | note_sentence | encounter |
-- collapse), so subject_id has NO foreign key here — its referent depends on subject_type and
-- spans tables this migration does not enumerate (bench_window, room_turn, an encounter's note
-- sentence index, encounter, and a collapse event id). This is an app-level invariant
-- (lib/jev/ask.ts's callers are typed to the five subject_types), not a database-enforced one;
-- flagged in the build report as the one place this migration trades a constraint for breadth
-- across five otherwise-unrelated tables.
--
-- UPSERT KEY: one row per (subject_type, subject_id, question_id, prompt_version) — a re-ask of
-- the same question against the same subject under the same wording replaces its own row, the
-- same idempotent-write idiom as every other Jev table (jev_role_signal 0107's own unique index).
--
-- Read-only MCP view: lib/mcp/tools/jev.ts's scribe_list_jev_decisions / scribe_get_jev_decision
-- (this migration adds no view object of its own — "MCP view" in the kickoff means the read-only
-- MCP tool surface, not a SQL VIEW; there is nothing here yet worth a second read shape).
--
-- ADDITIVE AND IDEMPOTENT. One new table, no existing table touched. Rolls forward from 0115.
-- App-owned: no GRANTs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS jev_decision (
  id              text PRIMARY KEY,
  subject_type    text NOT NULL CHECK (subject_type IN ('window','turn','note_sentence','encounter','collapse')),
  subject_id      text NOT NULL,
  question_id     text NOT NULL,
  prompt_version  text NOT NULL,
  model           text NOT NULL,
  answer          jsonb NOT NULL,
  probabilities   jsonb,
  confidence      real,
  latency_ms      int,
  input_tokens    int,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jev_decision_subject_question_version
  ON jev_decision (subject_type, subject_id, question_id, prompt_version);

CREATE INDEX IF NOT EXISTS idx_jev_decision_subject
  ON jev_decision (subject_type, subject_id);

CREATE INDEX IF NOT EXISTS idx_jev_decision_question_version
  ON jev_decision (question_id, prompt_version);

COMMENT ON TABLE jev_decision IS
  'PLAN-v3.md J-CORE-2: general Jev decision log, one row per (subject_type, subject_id, question_id, prompt_version). No text column — answer is a structured, closed-vocabulary value, never state or transcript text.';

COMMENT ON COLUMN jev_decision.subject_id IS
  'Polymorphic on subject_type: no FK here by design (five otherwise-unrelated referents). App-level invariant, not database-enforced.';

COMMENT ON COLUMN jev_decision.answer IS
  'The structured JevAnswer (noul/choice/score), never free text. See lib/jev/types.ts.';

INSERT INTO schema_migrations (version, name)
VALUES (116, '0116_jev_decision')
ON CONFLICT DO NOTHING;
