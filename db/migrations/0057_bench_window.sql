-- =====================================================================
-- Migration 0057 — bench_window (22 Aug 2026). A new table, and NOTHING IN
-- THIS BUILD WRITES IT. Created empty, read by nobody, on purpose.
--
-- WHAT IT IS FOR
-- A window is a slice of a session's tape that is worth transcribing on its
-- own: bounded on the session clock (start_ms/end_ms, epoch ms), attributed to
-- ONE microphone (source_mic), optionally clipped out to R2 (clip_r2_key), and
-- carried through a lifecycle by `state`. scribe_transcribe_range answers
-- windows today by computing them per call and throwing them away; this table
-- is where a window becomes a ROW that survives the call, so the same window
-- can be re-read, re-run, and reported on without recomputing what it was.
--
-- WHY THE COLUMNS ARE SHAPED THIS WAY
--   session_id    ON DELETE CASCADE: a window has no meaning without its tape,
--                 so it must not outlive it. This is the only FK.
--   room_day_id   NULLABLE and unreferenced. A window belongs to a SESSION; the
--                 room-day is the graph's unit, and a window may be resolved to
--                 one later or never. No FK, so a scratch day that is cleaned up
--                 cannot take windows with it.
--   source_mic    NOT NULL and free text rather than a CHECK over
--                 ('primary','backup'): U4 already taught us the mic story is
--                 open, and a third capture source would otherwise need a
--                 migration before it could be recorded.
--   grid_aligned  TRUE by default — a window cut on the fixed grid. FALSE is the
--                 interesting case: a window a human or a mark asked for, whose
--                 bounds are its own. Recording which it was is what stops the
--                 two being averaged together in a report.
--   state         CLOSED SET, and 'failed' is terminal-but-retryable, not an
--                 error state to be cleaned up: a window whose transcription
--                 failed must stay visible as a window that failed, because
--                 "nothing was said" and "nothing could be read" are different
--                 facts about the tape.
--   closed_at     when the window stopped being 'open'. Nullable while open.
--
-- uq_bench_window_span is the natural key: one row per
-- (session, start, end, microphone). Re-deriving the same window writes
-- nothing twice, which is the same guarantee 0050 gives the turn writer, and
-- it is why the same window transcribed from BOTH mics is two legal rows
-- rather than a conflict.
--
-- idx_bench_window_state is PARTIAL over ('closed','transcribing') because that
-- is the work queue — the states something is waiting on. 'open', 'transcribed'
-- and 'failed' are the resting states and are not polled.
--
-- GRANTS: none. bench_window is APP-OWNED, written and read through the app
-- role like bench_session/bench_chunk/bench_event before it. The brain role
-- (brain_svc, 0053) has no business here and is granted nothing.
--
-- NOT TOUCHED: bench_session (referenced only), bench_chunk, bench_event, cue,
-- room_day, visit, and transcription_run.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bench_window (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES bench_session(id) ON DELETE CASCADE,
  room_day_id  TEXT,
  start_ms     BIGINT NOT NULL,
  end_ms       BIGINT NOT NULL,
  source_mic   TEXT NOT NULL,
  clip_r2_key  TEXT,
  grid_aligned BOOLEAN NOT NULL DEFAULT TRUE,
  state        TEXT NOT NULL DEFAULT 'open',
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT bench_window_state_chk
    CHECK (state IN ('open','closed','transcribing','transcribed','failed')),
  CONSTRAINT bench_window_span_chk CHECK (end_ms > start_ms)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bench_window_span
  ON bench_window (session_id, start_ms, end_ms, source_mic);

CREATE INDEX IF NOT EXISTS idx_bench_window_state
  ON bench_window (state) WHERE state IN ('closed','transcribing');

CREATE INDEX IF NOT EXISTS idx_bench_window_session
  ON bench_window (session_id, start_ms);

INSERT INTO schema_migrations (version, name)
VALUES (57, '0057_bench_window')
ON CONFLICT DO NOTHING;
