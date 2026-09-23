-- =====================================================================
-- Migration 0117 — diarize_window_label: what each diarizer said about a window.
--
-- WHY IT IS NOT A COLUMN ON room_diarize_window. V's ruling of 23 Sep makes pyannote.ai a TEACHER:
-- its turns are kept so the local diarizer can be trained to match them, and the requirement is
-- that a teacher label is "never overwritten by the local diarizer's output". room_diarize_window
-- cannot hold that. It has one row per window, and TWO writers mutate its segments — the
-- keep-rule in recordDiarizeWindow replaces everything on a failed row, and
-- repairStaleDiarizeSegments replaces segments outright on the E24 R10 path. A label that a later
-- run can overwrite is not a label.
--
-- ONE ROW PER (window, engine, run). Both engines write here, which is the point: the lab measures
-- the gap between them night by night, and a comparison needs both lanes side by side under one
-- key. `engine` says which lane; nothing else distinguishes them.
--
-- APPEND-ONLY. Nothing updates or deletes a row. A re-run of either engine is a NEW row with a new
-- run_id, so the history of what each diarizer said survives — that history is the training set.
--
-- `model` IS DERIVED FROM THE ENGINE'S OWN ANSWER AND IS NULLABLE. pyannote.ai reports it on the
-- /v2/jobs record and not on the job detail; the local service reports model_versions. When an
-- engine does not say, the column is NULL. It is never the model we asked for: a label restating
-- our own request reads as evidence and is none.
--
-- 0116 IS NOT FREE. It belongs to fleet's jev-core on an unmerged branch, which is invisible from
-- this branch's db/migrations (highest here is 0115). Numbers must be checked across every
-- unmerged ref, not against one's own base.
--
-- NO TEXT, NO AUDIO: spans, counts, ids and durations only. A segment here is {start_ms, end_ms,
-- speaker_idx} relative to the clip, exactly the shape lib/stt/speaker-clusters.ts parses.
--
-- ADDITIVE AND IDEMPOTENT. One new table and its indexes, all IF NOT EXISTS; no existing table is
-- touched. App-owned: no GRANTs (0107, 0112, 0113, 0114).
-- =====================================================================

CREATE TABLE IF NOT EXISTS diarize_window_label (
  id                text PRIMARY KEY,
  window_id         text NOT NULL,
  room_day_id       text NOT NULL,
  -- 'pyannoteai' | 'local' — the vocabulary comes from DIARIZE_ENGINES in lib/diarize-engine.ts,
  -- and a drift test compares this list against that array.
  engine            text NOT NULL,
  model             text,
  -- The provider's own job id, when it has one. Opaque, and carries no credential.
  provider_job_id   text,
  -- The ETA run that produced this label; the same id stamped on the window's turn rows.
  run_id            text NOT NULL,
  segments_json     jsonb NOT NULL,
  speaker_count     integer NOT NULL,
  segment_count     integer NOT NULL,
  -- Seconds of audio handed to the engine. For a paid engine this is what the cost is computed
  -- from at read time; a stored currency total would be an accumulator nobody could re-derive.
  audio_seconds     numeric,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT diarize_window_label_engine_known CHECK (engine IN ('pyannoteai', 'local')),
  CONSTRAINT diarize_window_label_counts_sane  CHECK (speaker_count >= 0 AND segment_count >= 0),
  CONSTRAINT diarize_window_label_seconds_sane CHECK (audio_seconds IS NULL OR audio_seconds >= 0),
  -- One label per engine per run. A replayed step writes the same row rather than a second one.
  CONSTRAINT diarize_window_label_once UNIQUE (window_id, engine, run_id)
);

-- The lab's read: both lanes for a window, newest first.
CREATE INDEX IF NOT EXISTS diarize_window_label_window_idx
  ON diarize_window_label (window_id, engine, created_at DESC);

-- The daily count: windows labelled, audio-hours and spend per engine per day.
CREATE INDEX IF NOT EXISTS diarize_window_label_engine_day_idx
  ON diarize_window_label (engine, created_at DESC);

-- Per room-day, for the gap report.
CREATE INDEX IF NOT EXISTS diarize_window_label_room_day_idx
  ON diarize_window_label (room_day_id, created_at DESC);

-- The runner reads this to know the migration is done; without it 0117 is re-attempted for ever.
INSERT INTO schema_migrations (version, name)
VALUES (117, '0117_diarize_window_label')
ON CONFLICT DO NOTHING;
