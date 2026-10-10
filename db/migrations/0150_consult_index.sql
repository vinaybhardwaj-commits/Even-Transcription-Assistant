-- 0150_consult_index.sql — the Scribe consult index (consult_uid -> cut clip) and Sarvam results per consult_uid.
--
-- Additive and idempotent; no grants. One transaction (as 0140).
--
-- 1. consult_index        — one row per consult_uid, synced hourly from CONSULT's name-free index in R2 (bucket eta-lab-results,
--    consult/index/latest.jsonl + manifest.json, sha256-checked): where the cut clip is (R2 eta-audio consult-clips/...), its absolute UTC span,
--    the room and (when one covers it) the bench session, the cutter's doctor_uid AS RECORDED (a hint, not identity: VP-ACC-01 failed), the cut
--    version and the sealed flag. `sealed` is sticky: once true, a later sync cannot clear it. No names, no text, no audio.
-- 2. consult_index_sync   — one row per sync run: what the manifest said, how many rows were read / written / changed / skipped (and why).
-- 3. consult_sarvam_result — the Sarvam result of one (consult_uid, cut_version, mode, english): a pointer to the R2 object plus model and
--    revision. UNIQUE on that key is the idempotency guard: a second ask for the same cut returns this row and is never billed.

BEGIN;

CREATE TABLE IF NOT EXISTS consult_index (
  consult_uid       text        PRIMARY KEY,
  room_id           text        NOT NULL,
  room_slug         text        NOT NULL,
  ist_date          date        NOT NULL,
  session_id        text,
  t0_ms             bigint      NOT NULL,
  t1_ms             bigint      NOT NULL,
  clip_r2_key       text        NOT NULL,
  doctor_uid        text,
  doctor_identified boolean,
  cut_version       text        NOT NULL,
  code_commit       text,
  sealed            boolean     NOT NULL DEFAULT false,
  voice_isolated    boolean,
  minutes           numeric,
  bytes             bigint,
  quality           text,
  coverage          numeric,
  source_sha256     text        NOT NULL,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  synced_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consult_index_span_chk CHECK (t1_ms > t0_ms),
  CONSTRAINT consult_index_key_chk CHECK (clip_r2_key LIKE 'consult-clips/%' AND position('..' in clip_r2_key) = 0)
);

CREATE INDEX IF NOT EXISTS consult_index_day_idx ON consult_index (ist_date, room_slug);
CREATE INDEX IF NOT EXISTS consult_index_session_idx ON consult_index (session_id) WHERE session_id IS NOT NULL;

COMMENT ON TABLE consult_index IS
  'consult_uid -> cut clip, from CONSULT''s name-free R2 index (hourly sync). doctor_uid is the cutter''s own record, a hint and never identity (VP-ACC-01 failed). sealed is sticky. No names, text or audio.';

CREATE TABLE IF NOT EXISTS consult_index_sync (
  id               bigserial   PRIMARY KEY,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  status           text        NOT NULL DEFAULT 'running',
  error_code       text,
  manifest_sha256  text,
  manifest_rows    integer,
  rows_read        integer     NOT NULL DEFAULT 0,
  rows_written     integer     NOT NULL DEFAULT 0,
  rows_changed     integer     NOT NULL DEFAULT 0,
  rows_skipped     integer     NOT NULL DEFAULT 0,
  skipped          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT consult_index_sync_status_chk CHECK (status IN ('running', 'ok', 'failed'))
);

CREATE INDEX IF NOT EXISTS consult_index_sync_recent_idx ON consult_index_sync (started_at DESC);

CREATE TABLE IF NOT EXISTS consult_sarvam_result (
  id                bigserial   PRIMARY KEY,
  consult_uid       text        NOT NULL,
  cut_version       text        NOT NULL,
  mode              text        NOT NULL,
  english           boolean     NOT NULL,
  num_speakers      integer,
  job_id            text        NOT NULL,
  result_r2_key     text        NOT NULL,
  model_stt         text        NOT NULL,
  model_translate   text        NOT NULL,
  model_rev         text        NOT NULL,
  pipeline_rev      text        NOT NULL,
  language_code     text,
  duration_s        numeric,
  speaker_count     integer     NOT NULL DEFAULT 0,
  transcript_chars  integer     NOT NULL DEFAULT 0,
  english_chars     integer     NOT NULL DEFAULT 0,
  english_pass      text,
  t0_ms             bigint      NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consult_sarvam_result_once UNIQUE (consult_uid, cut_version, mode, english),
  CONSTRAINT consult_sarvam_result_mode_chk CHECK (mode IN ('transcribe', 'codemix')),
  CONSTRAINT consult_sarvam_result_key_chk CHECK (result_r2_key LIKE 'mcp-sarvam/%' AND position('..' in result_r2_key) = 0)
);

CREATE INDEX IF NOT EXISTS consult_sarvam_result_uid_idx ON consult_sarvam_result (consult_uid, created_at DESC);

COMMENT ON TABLE consult_sarvam_result IS
  'The Sarvam result of one cut of one consult: R2 pointer (mcp-sarvam/<job>.json), model + revision, counts. UNIQUE (consult_uid, cut_version, mode, english) = never billed twice for the same cut. No text here.';

INSERT INTO schema_migrations (version, name)
VALUES (150, '0150_consult_index')
ON CONFLICT DO NOTHING;

COMMIT;
