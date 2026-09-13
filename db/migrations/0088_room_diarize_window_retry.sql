-- 0088 — room_diarize_window: a FAILED window can be retried, and its failures are kept.
--
-- 0074 made `failed` a destination: the enqueue scan skipped any window with a row, so one transient
-- failure blocked that window forever. This adds what a bounded retry needs to be recorded.
--
--   attempts         how many times the window has been diarized. Starts at 1; the job's writer adds
--                    one each time it replaces a `failed` row. CHECK: attempts >= 1.
--   failure_history  every earlier attempt's {attempt, error, diarized_at}, appended by the writer
--                    before it overwrites a failed row. CHECK: it is a JSON array.
--
-- WHAT THE DATABASE DOES NOT ENFORCE: the bound. The retry limit lives in the enqueue scan
-- (DIARIZE_MAX_ATTEMPTS in lib/stt/diarize-job.ts), not in a CHECK, so an attempt that did run is
-- always recorded rather than rejected. Nor does it enforce that only `failed` rows are replaced —
-- that is the writer's ON CONFLICT ... WHERE state = 'failed'.
--
-- Existing rows get attempts = 1 and an empty history, so a window that failed before this ships
-- becomes eligible for its remaining attempts.

ALTER TABLE room_diarize_window
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS failure_history jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$ BEGIN
  ALTER TABLE room_diarize_window ADD CONSTRAINT room_diarize_window_attempts_chk CHECK (attempts >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE room_diarize_window ADD CONSTRAINT room_diarize_window_failure_history_chk
    CHECK (jsonb_typeof(failure_history) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN room_diarize_window.state IS
  'ok | failed | skipped | no_speakers. `failed` carries its reason in `error`. Since 0088 a failed window is re-enqueued until `attempts` reaches the bound in lib/stt/diarize-job.ts; earlier failures are kept in `failure_history`.';
COMMENT ON COLUMN room_diarize_window.attempts IS
  'Times this window has been diarized. >= 1 (CHECK). The retry bound is applied by the enqueue scan, not by the database.';
COMMENT ON COLUMN room_diarize_window.failure_history IS
  'Earlier attempts replaced on retry: [{attempt, error, diarized_at}]. A JSON array (CHECK).';

INSERT INTO schema_migrations (version, name)
VALUES (88, '0088_room_diarize_window_retry')
ON CONFLICT DO NOTHING;
