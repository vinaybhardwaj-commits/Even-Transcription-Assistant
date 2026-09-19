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
-- A ROW IS ALWAYS WRITTEN (D-11). "No English for this window" is an evidenced state, never an
-- absence: english = NULL with source = 'empty' means tried-and-produced-nothing, distinct from
-- there being no row at all (job never ran).
--
-- source IS THE PROVENANCE, A CLOSED VOCABULARY:
--   run_english  transcript_english was already populated (the free live path the day room-drain
--                flips to translate:true; NULL today on every window).
--   native_en    the window is already English — decided from metrics_json (full_window_language,
--                sarvam_language, language_timeline.language_mix all agree), so transcript_original
--                is stored as-is. detected_language is NOT consulted: it is NULL on every window.
--   translated   transcript_original was translated through the Mini's local qwen leg.
--   empty        the result was empty/whitespace, OR translation was gated off
--                (ETA_JEV_TRANSLATE_ENABLED unset) — either way, evidenced, not absent.
--
-- ADDITIVE AND IDEMPOTENT. One new table, name-guarded index, no existing table touched, no CHECK
-- on an existing column changed. Rolls forward from the current head (0103). App-owned: no GRANTs.
-- =====================================================================

CREATE TABLE IF NOT EXISTS jev_window_text (
  window_id   text        PRIMARY KEY REFERENCES bench_window(id),
  room_day_id text        NOT NULL,
  english     text,                      -- NULL = tried and produced nothing (source='empty'), not "not tried"
  source      text        NOT NULL CHECK (source IN ('run_english', 'native_en', 'translated', 'empty')),
  char_count  int         NOT NULL,
  model       text,                      -- NULL for run_english / native_en / empty; the translate model otherwise
  latency_ms  int,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_jev_window_text_room_day ON jev_window_text (room_day_id);

COMMENT ON TABLE jev_window_text IS
  'Slice J0 (ETA-JEV-ARM-D §3A): the English text each bench window is read as by the jev arm, produced by lib/jobs/kinds/jev-english.ts. A row is always written per window read; english=NULL with source=empty is an evidenced no-English state (D-11).';
COMMENT ON COLUMN jev_window_text.english IS
  'The English transcript. NULL means the source produced nothing (source=empty), never "not attempted".';
COMMENT ON COLUMN jev_window_text.source IS
  'Provenance: run_english (transcription_run.transcript_english) | native_en (already English per metrics_json) | translated (Mini-local qwen) | empty (nothing produced, or translation gated off).';
COMMENT ON COLUMN jev_window_text.model IS
  'The translation model (e.g. qwen2.5:14b) for source=translated; NULL otherwise.';

INSERT INTO schema_migrations (version, name)
VALUES (105, '0105_jev_window_text')
ON CONFLICT DO NOTHING;
