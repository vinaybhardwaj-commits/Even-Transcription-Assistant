-- =====================================================================
-- Migration 0105 — jev_window_text: the English text a bench window is read as, by Arm D.
--
-- WHY (ETA-JEV-ARM-D-SPEC v1.1 §3A, Slice J0). Arm D is English-primary and its declared input,
-- transcription_run.transcript_english for subject_type='bench_window', is NULL on every window
-- that has ever existed: lib/stt/room-drain.ts submits the router with translate:false, and
-- detected_language never comes back either, so §5.2's fallback cannot fire. As written Arm D would
-- skip 100% of windows and emit nothing, silently. J0 produces the input in Arm D's own job
-- (lib/jobs/kinds/jev-english.ts) and persists it here, touching no existing pipeline file and
-- backfilling history — option B in §3A. Translation, when it runs, is LOCAL (the Mini's qwen leg),
-- never TypeSafe; D1 does not gate J0.
--
-- AN ABSENCE AND A FAILURE NEVER SHARE A VALUE. Three situations are told apart by reading a row:
--   not_ready — no transcription run exists for the window YET, or translation is gated off while
--               there is still text to translate. NOT terminal: a normal re-run (no force, no human)
--               re-evaluates it and it becomes a real source on its own once a run appears / the flag
--               is turned on. This is the fix for the finding that the whole corpus (2,263/2,265
--               closed windows have no run) was being stamped permanently 'empty'.
--   empty     — a run exists and its source text is genuinely empty. Terminal, and 'empty' is honest.
--   failed    — translation was attempted and FAILED (qwen error, timeout, abort, or empty output).
--               Terminal for that attempt, RETRYABLE (a re-run reprocesses it without force), and the
--               closed-code reason is in `error`.
--   run_english / native_en / translated — terminal successes, skipped on re-run.
--
-- source IS THE PROVENANCE, A CLOSED VOCABULARY (extended for the three-way distinction above):
--   run_english  transcript_english was already populated (the free live path the day room-drain
--                flips to translate:true; NULL today on every window).
--   native_en    already English per metrics_json (full_window_language, sarvam_language,
--                language_timeline.language_mix all agree); transcript_original stored as-is.
--   translated   transcript_original was translated through the Mini's local qwen leg.
--   empty        a run exists and its source text was genuinely empty.
--   not_ready    no run yet, or translation gated off with text to do — re-evaluated on the next run.
--   failed       translation attempted and failed; retryable; reason in `error`.
--
-- input_chars records the pre-truncation length of the text sent to translate, so a 'translated' row
-- can never silently hide that a long window was clipped (see TRANSLATE_CHAR_CAP in lib/jev/translate.ts).
--
-- ADDITIVE AND IDEMPOTENT. One new table, name-guarded index, no existing table touched, no CHECK
-- on an existing column changed. Rolls forward from the current head (0104). App-owned: no GRANTs.
-- NOTE (Refuter round 2): this migration has NOT been applied; the two columns and the wider CHECK
-- vocabulary below were added here rather than in a new migration, as the fix brief permits.
-- =====================================================================

CREATE TABLE IF NOT EXISTS jev_window_text (
  window_id   text        PRIMARY KEY REFERENCES bench_window(id),
  room_day_id text        NOT NULL,
  english     text,                      -- NULL for every non-success source (empty / not_ready / failed)
  source      text        NOT NULL CHECK (source IN ('run_english', 'native_en', 'translated', 'empty', 'not_ready', 'failed')),
  char_count  int         NOT NULL,      -- length of `english`; 0 when english IS NULL
  model       text,                      -- the translate model for source='translated'; NULL otherwise
  error       text,                      -- CLOSED-CODE reason for source='failed' (e.g. qwen_error, qwen_timeout, empty_output); NULL otherwise
  input_chars int,                       -- pre-truncation length sent to translate (source='translated'); NULL otherwise
  latency_ms  int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jev_window_text_room_day ON jev_window_text (room_day_id);

COMMENT ON TABLE jev_window_text IS
  'Slice J0 (ETA-JEV-ARM-D §3A): the English text each bench window is read as by the jev arm, produced by lib/jobs/kinds/jev-english.ts. not_ready (no run yet / gated off) is re-evaluated on every run; empty (run exists, no text) and failed (translation failed, reason in error) are terminal, failed being retryable.';
COMMENT ON COLUMN jev_window_text.english IS
  'The English transcript for a success source; NULL for empty / not_ready / failed.';
COMMENT ON COLUMN jev_window_text.source IS
  'run_english | native_en | translated (successes) | empty (run exists, text genuinely empty) | not_ready (no run yet, or translation gated off — NOT terminal, re-evaluated) | failed (translation attempted and failed — retryable, reason in error).';
COMMENT ON COLUMN jev_window_text.model IS
  'The translation model (e.g. qwen2.5:14b) for source=translated; NULL otherwise.';
COMMENT ON COLUMN jev_window_text.error IS
  'Closed-code reason for source=failed (qwen_error | qwen_timeout | empty_output). Never an exception string or transcript. NULL otherwise.';
COMMENT ON COLUMN jev_window_text.input_chars IS
  'Pre-truncation length of the text handed to translate, for source=translated; lets a reader see if a long window was clipped. NULL otherwise.';

INSERT INTO schema_migrations (version, name)
VALUES (105, '0105_jev_window_text')
ON CONFLICT DO NOTHING;
