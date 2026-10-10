-- 0143_nemotron_lab.sql — the Nemotron LAB lane (nemotron_lab_run job) and per-frame probabilities (production).
--
-- Additive and idempotent; no grants. One transaction (as 0140).
--
-- 1. nemotron_lab_run   — one row per nemotron_lab_run job (job_id = scribe_job.id): the normalised spec (overrides) and the deadline.
-- 2. nemotron_lab_item  — one row per input (window | r2_key | span) of a run: its resolved clip, the worker's lease and attempt count
--    (same shape as diarize_nemotron_claim), and the worker's RESULT (turns, counts, R2 keys of the probability / embedding files).
--    THIS TABLE IS THE ONLY LAB WRITE TARGET. Nothing here references room_diarize_window, room_turn_speaker or
--    diarize_nemotron_window, and no lab code path writes them.
-- 3. diarize_nemotron_window.probs_r2_key — nullable pointer to the window's per-frame probability file (lab/nemotron-probs/<window>.nlp).
--
-- NO AUDIO, NO TEXT, NO NAMES. Embeddings live only in R2 files under lab/nemotron/ (never in a column).

BEGIN;

CREATE TABLE IF NOT EXISTS nemotron_lab_run (
  job_id       text        PRIMARY KEY,
  spec         jsonb       NOT NULL,
  spec_hash    text        NOT NULL,
  n_items      integer     NOT NULL,
  actor        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  deadline_at  timestamptz NOT NULL,
  CONSTRAINT nemotron_lab_run_items_chk CHECK (n_items BETWEEN 1 AND 10)
);

COMMENT ON TABLE nemotron_lab_run IS
  'One nemotron_lab_run job (LAB ONLY). spec = the allow-listed overrides, normalised to JSON (no YAML, no free-form string). Never read by production.';

CREATE TABLE IF NOT EXISTS nemotron_lab_item (
  run_id             text        NOT NULL REFERENCES nemotron_lab_run(job_id) ON DELETE CASCADE,
  idx                integer     NOT NULL,
  source_kind        text        NOT NULL,
  window_id          text,
  input_r2_key       text,
  span               jsonb,
  clip_r2_key        text,
  state              text        NOT NULL DEFAULT 'queued',
  worker_id          text,
  claimed_at         timestamptz,
  lease_until        timestamptz,
  attempts           integer     NOT NULL DEFAULT 0,
  last_error_code    text,
  failure_history    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error_code         text,
  model              text,
  model_rev          text,
  config             jsonb,
  audio_ms           integer,
  clip_sha256        text,
  turns_json         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  speaker_count      integer     NOT NULL DEFAULT 0,
  turn_count         integer     NOT NULL DEFAULT 0,
  speech_ms          integer     NOT NULL DEFAULT 0,
  overlap_ms         integer     NOT NULL DEFAULT 0,
  probs_r2_key       text,
  embeddings_r2_key  text,
  embeddings_dims    integer,
  embed_error        text,
  infer_s            real,
  received_at        timestamptz,
  CONSTRAINT nemotron_lab_item_pk PRIMARY KEY (run_id, idx),
  CONSTRAINT nemotron_lab_item_idx_chk CHECK (idx BETWEEN 0 AND 9),
  CONSTRAINT nemotron_lab_item_source_chk CHECK (source_kind IN ('window', 'r2_key', 'span')),
  CONSTRAINT nemotron_lab_item_state_chk CHECK (state IN ('queued', 'ok', 'empty', 'failed')),
  CONSTRAINT nemotron_lab_item_attempts_chk CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT nemotron_lab_item_failed_chk CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT nemotron_lab_item_source_cols_chk CHECK (
    (source_kind = 'window' AND window_id IS NOT NULL) OR (source_kind = 'r2_key' AND input_r2_key IS NOT NULL) OR (source_kind = 'span' AND span IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS nemotron_lab_item_open_idx ON nemotron_lab_item (run_id, idx) WHERE state = 'queued';

COMMENT ON TABLE nemotron_lab_item IS
  'One input of a nemotron_lab_run: its clip, the box worker''s 15-minute lease (max 3 attempts) and its result. turns_json = [[start_ms, end_ms, "spkN"], ...]. R2 keys point at NLP1 files under lab/nemotron/. LAB ONLY: the sole table the lab ingest writes.';

ALTER TABLE diarize_nemotron_window ADD COLUMN IF NOT EXISTS probs_r2_key text NULL;

COMMENT ON COLUMN diarize_nemotron_window.probs_r2_key IS
  'R2 key of the window''s per-frame speaker probabilities (NLP1, u8-quantised, lab/nemotron-probs/<window_id>.nlp). A pointer, not part of the result: payload_sha256 excludes it. NULL when the worker saved none.';

INSERT INTO schema_migrations (version, name)
VALUES (143, '0143_nemotron_lab')
ON CONFLICT DO NOTHING;

COMMIT;
