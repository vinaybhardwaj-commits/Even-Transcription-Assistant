-- 0140_diarize_nemotron.sql — epic #23 ticket (b): Nemotron-3-Diarization turns, as a SHADOW engine.
--
-- Additive and idempotent; no grants. Nothing here is read by anything a clinician sees. Written by
-- lib/diarize-nemotron/store.ts only, through /api/diarize/nemotron/{pending,ingest,heartbeat}, all of
-- which answer 404 until DIARIZE_NEMOTRON_SHADOW is on.
--
-- 1. diarize_nemotron_window — one row per (window, engine, model revision, config). The worker posts
--    whole-window turns; ETA derives the counts. No embeddings, no confidence, no text: Nemotron outputs
--    none of them, and overlap shows only as intersecting turns.
-- 2. diarize_nemotron_claim — the worker's lease on a window and its attempt count (PRD §6.1). One row
--    per window, whatever the model revision: the claim is about work in flight, not about a result.
-- 3. diarize_nemotron_worker — the last heartbeat per worker (PRD §6.1 fields, allow-listed at ingest).
-- 4. diarize_window_label's engine CHECK gains 'nemotron', so teacher labels can carry Nemotron turns.
--
-- One transaction (as 0138), so the label CHECK is never absent between its DROP and its re-ADD.

BEGIN;

CREATE TABLE IF NOT EXISTS diarize_nemotron_window (
  id              bigserial   PRIMARY KEY,
  window_id       text        NOT NULL,
  room_day_id     text        NOT NULL,
  engine          text        NOT NULL DEFAULT 'nemotron',
  model           text        NOT NULL,
  model_rev       text        NOT NULL,
  config          jsonb       NOT NULL,
  config_hash     text        NOT NULL,
  worker_id       text        NOT NULL,
  machine         text        NOT NULL,
  audio_ms        integer     NOT NULL,
  clip_sha256     text,
  turns_json      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  speaker_count   integer     NOT NULL DEFAULT 0,
  turn_count      integer     NOT NULL DEFAULT 0,
  speech_ms       integer     NOT NULL DEFAULT 0,
  overlap_ms      integer     NOT NULL DEFAULT 0,
  payload_sha256  text        NOT NULL,
  status          text        NOT NULL,
  error_code      text,
  received_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT diarize_nemotron_window_engine_chk  CHECK (engine = 'nemotron'),
  CONSTRAINT diarize_nemotron_window_machine_chk CHECK (machine IN ('box', 'hf')),
  CONSTRAINT diarize_nemotron_window_status_chk  CHECK (status IN ('ok', 'empty', 'failed')),
  CONSTRAINT diarize_nemotron_window_error_chk   CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT diarize_nemotron_window_counts_chk  CHECK (audio_ms >= 0 AND (status = 'failed' OR audio_ms > 0) AND speaker_count BETWEEN 0 AND 8 AND turn_count BETWEEN 0 AND 5000
                                                        AND speech_ms >= 0 AND overlap_ms >= 0 AND speech_ms <= audio_ms AND overlap_ms <= speech_ms),
  CONSTRAINT diarize_nemotron_window_once UNIQUE (window_id, engine, model_rev, config_hash)
);

CREATE INDEX IF NOT EXISTS diarize_nemotron_window_window_idx ON diarize_nemotron_window (window_id, received_at DESC);
CREATE INDEX IF NOT EXISTS diarize_nemotron_window_day_idx    ON diarize_nemotron_window (room_day_id, received_at DESC);

COMMENT ON TABLE diarize_nemotron_window IS
  'Nemotron-3-Diarization turns per bench_window (epic #23 b), SHADOW only. turns_json = [[start_ms, end_ms, "spkN"], ...] relative to the clip start. Ids, counts and timings only: no audio, text, embeddings or names.';
COMMENT ON COLUMN diarize_nemotron_window.payload_sha256 IS
  'sha256 of the canonical ingest body (keys sorted, no whitespace) without worker_id and machine, so the same result from another worker is a duplicate. An identical re-post is a no-op; a different payload for the same (window_id, engine, model_rev, config_hash) is refused 409 and never overwrites.';

CREATE TABLE IF NOT EXISTS diarize_nemotron_claim (
  window_id        text        PRIMARY KEY,
  worker_id        text        NOT NULL,
  claimed_at       timestamptz NOT NULL DEFAULT now(),
  lease_until      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 1,
  done_at          timestamptz,
  last_error_code  text,
  failure_history  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT diarize_nemotron_claim_attempts_chk CHECK (attempts BETWEEN 1 AND 3)
);

CREATE INDEX IF NOT EXISTS diarize_nemotron_claim_open_idx ON diarize_nemotron_claim (lease_until) WHERE done_at IS NULL;

COMMENT ON TABLE diarize_nemotron_claim IS
  'The Nemotron worker''s lease per window (15 min) and its attempt count (max 3). failure_history holds [{at, worker_id, error_code}] only.';

CREATE TABLE IF NOT EXISTS diarize_nemotron_worker (
  worker_id     text        PRIMARY KEY,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE diarize_nemotron_worker IS
  'Last heartbeat per Nemotron worker (PRD §6.1 fields, allow-listed by lib/diarize-nemotron/validate.ts). Counts, ids and timings only.';

ALTER TABLE diarize_window_label DROP CONSTRAINT IF EXISTS diarize_window_label_engine_known;
ALTER TABLE diarize_window_label ADD CONSTRAINT diarize_window_label_engine_known
  CHECK (engine IN ('pyannoteai', 'local', 'nemotron'));

INSERT INTO schema_migrations (version, name)
VALUES (140, '0140_diarize_nemotron')
ON CONFLICT DO NOTHING;

COMMIT;
