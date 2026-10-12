-- =====================================================================
-- Migration 0155 — Timbre T-9 (Architecture #78): v1 voice-affect storage.
--
-- WHAT. The output of `python -m tools.timbre.pipeline` (windows.parquet + consults.json + run manifest), stored as fixed, CHECKed columns:
--   affect_calibration_map  versioned, immutable calibration maps (aggregates only: room/doctor median+IQR, global, isotonic)
--   affect_run              one row per pipeline invocation (git sha, model ids/revisions, purity rule, calibration ids, counts, cost)
--   affect_window           one row per patient window (purity, scorable/reason, arousal + valence RAW and CALIBRATED)
--   affect_consult          one row per consult cut per run (medians + open/mid/close trajectory, RAW and CALIBRATED; reason counts)
--   affect_consult_latest   view: per (consult_uid, cut_version), the row from the newest run with state='ok'
--
-- RAW vs CALIBRATED (Vinay ruling, test 10, 11 Oct 2026). Both are stored. Raw is the default for trends/aggregates; calibrated values are a
-- display-only 1-5 scale (isotonic calibration collapses scores to few distinct values and lowers ranking: valence Spearman 0.51 raw vs 0.39-0.46).
--
-- KEYS. consult_uid + cut_version -> consult_index (0150), FK-free. encounter_consult_key -> eta_encounter_windows.consult_key (0123), FK-free
-- (NOT eta_encounter_windows.id: that serial is rewritten on every resolver refresh). room_day_id / bench_window_id / session_id are resolved at
-- write time by overlapping the absolute span; NULL = unplaced.
--
-- NO PHI: no audio, transcript text, URLs, R2 audio keys, names or patient identifiers. affect_window has NO identity or role column (role comes
-- only from room_turn_speaker via a join). doctor_uid8 on affect_consult is the pseudonymous calibration cell; research aggregates only, never a ranking.
--
-- RETENTION (Vinay ruling, 11 Oct 2026): 36 months for every Timbre table, enforced by the nightly job's purge (#79), not by the database.
-- 0089 / 0097 (room_emotion_window, room_span_emotion) are NOT touched here: they become read-only history.
--
-- ADDITIVE AND IDEMPOTENT: CREATE ... IF NOT EXISTS / CREATE OR REPLACE VIEW. No existing table is altered. GRANTS: none (app-owned, like
-- 0057, 0123, 0150; brain_svc gets nothing, see #56). Down-migration: db/rollbacks/0155_timbre_affect.down.sql (run by hand, never from here).
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS affect_calibration_map (
  id             bigserial   PRIMARY KEY,
  target         text        NOT NULL,
  score_col      text        NOT NULL,
  calib_version  text        NOT NULL,
  min_n          integer     NOT NULL,
  fit_on         text        NOT NULL,
  git_sha        text        NOT NULL,
  sha256         text        NOT NULL UNIQUE,
  payload        jsonb,
  r2_key         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at  timestamptz,
  CONSTRAINT affect_calibration_map_target_chk CHECK (target IN ('arousal', 'valence')),
  CONSTRAINT affect_calibration_map_sha_chk CHECK (sha256 ~ '^[0-9a-f]{64}$' AND git_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT affect_calibration_map_min_n_chk CHECK (min_n >= 1),
  CONSTRAINT affect_calibration_map_store_chk CHECK ((payload IS NULL) <> (r2_key IS NULL)),
  CONSTRAINT affect_calibration_map_superseded_chk CHECK (superseded_at IS NULL OR superseded_at >= created_at)
);

CREATE TABLE IF NOT EXISTS affect_run (
  id                      bigserial   PRIMARY KEY,
  pipeline_version        text        NOT NULL,
  git_sha                 text        NOT NULL,
  compute                 text        NOT NULL,
  device                  text,
  worker_id               text,
  speaker_source          text        NOT NULL,
  nemotron_model_rev      text,
  arousal_model_id        text        NOT NULL,
  arousal_model_rev       text        NOT NULL,
  fallback_model_id       text        NOT NULL,
  fallback_model_rev      text        NOT NULL,
  valence_model_id        text        NOT NULL,
  valence_model_rev       text,
  clef_question_set       text        NOT NULL,
  purity_rule_version     text        NOT NULL,
  purity_rule_json        jsonb       NOT NULL,
  calibration_arousal_id  bigint      NOT NULL REFERENCES affect_calibration_map(id),
  calibration_valence_id  bigint      NOT NULL REFERENCES affect_calibration_map(id),
  text_lane_on            boolean     NOT NULL DEFAULT false,
  text_question_set       text,
  scope_json              jsonb       NOT NULL,
  input_manifest_sha256   text        NOT NULL,
  state                   text        NOT NULL,
  error_code              text,
  n_consults              integer     NOT NULL DEFAULT 0,
  n_windows               integer     NOT NULL DEFAULT 0,
  n_scorable              integer     NOT NULL DEFAULT 0,
  n_fallback              integer     NOT NULL DEFAULT 0,
  n_clef_calls            integer     NOT NULL DEFAULT 0,
  n_text                  integer     NOT NULL DEFAULT 0,
  started_at              timestamptz NOT NULL DEFAULT now(),
  finished_at             timestamptz,
  timing_json             jsonb,
  gpu_seconds             numeric,
  clef_input_tokens       bigint,
  cost_usd_est            numeric(10,4),
  CONSTRAINT affect_run_git_sha_chk CHECK (git_sha ~ '^[0-9a-f]{40}$'),
  CONSTRAINT affect_run_compute_chk CHECK (compute IN ('lab_gpu', 'hf_gpu', 'cpu_dev')),
  CONSTRAINT affect_run_speaker_chk CHECK (speaker_source IN ('nemotron', 'segments')),
  CONSTRAINT affect_run_text_chk CHECK (text_lane_on = (text_question_set IS NOT NULL)),
  CONSTRAINT affect_run_state_chk CHECK (state IN ('running', 'ok', 'partial', 'failed')),
  CONSTRAINT affect_run_error_chk CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT affect_run_counts_chk CHECK (n_consults >= 0 AND n_windows >= 0 AND n_scorable >= 0 AND n_fallback >= 0
                                          AND n_clef_calls >= 0 AND n_text >= 0 AND n_scorable <= n_windows),
  CONSTRAINT affect_run_finished_chk CHECK (finished_at IS NULL OR finished_at >= started_at),
  CONSTRAINT affect_run_cost_chk CHECK ((gpu_seconds IS NULL OR gpu_seconds >= 0) AND (clef_input_tokens IS NULL OR clef_input_tokens >= 0)
                                        AND (cost_usd_est IS NULL OR cost_usd_est >= 0))
);

CREATE TABLE IF NOT EXISTS affect_window (
  run_id                     bigint           NOT NULL REFERENCES affect_run(id) ON DELETE CASCADE,
  consult_uid                text             NOT NULL,
  cut_version                text             NOT NULL,
  window_key                 text             NOT NULL,
  start_ms                   integer          NOT NULL,
  end_ms                     integer          NOT NULL,
  abs_start_ms               bigint,
  abs_end_ms                 bigint,
  room_day_id                text,
  bench_window_id            text,
  session_id                 text,
  diarize_engine             text             NOT NULL,
  diarize_ref                text,
  speaker_idx                integer,
  doctor_slot                integer,
  phase                      text,
  lang                       text,
  purity                     double precision,
  purity_embedding           double precision,
  purity_probs               double precision,
  pure_patient_s             double precision,
  patient_cosine             double precision,
  scorable                   boolean          NOT NULL,
  unscorable_reason          text,
  arousal_raw                double precision,
  arousal_calibrated         double precision,
  arousal_calibration_level  text,
  arousal_model              text,
  odyssey_arousal_raw        double precision,
  audeering_arousal_raw      double precision,
  valence_raw                double precision,
  valence_calibrated         double precision,
  valence_calibration_level  text,
  text_valence               double precision,
  text_arousal               double precision,
  text_status                text,
  text_language              text,
  scored_at                  timestamptz      NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, window_key),
  CONSTRAINT affect_window_span_chk CHECK (start_ms >= 0 AND end_ms > start_ms),
  CONSTRAINT affect_window_abs_chk CHECK (abs_start_ms IS NULL OR abs_end_ms IS NULL OR abs_end_ms > abs_start_ms),
  CONSTRAINT affect_window_engine_chk CHECK (diarize_engine IN ('nemotron', 'segments')),
  CONSTRAINT affect_window_purity_chk CHECK (
    (purity IS NULL OR purity BETWEEN 0 AND 1) AND (purity_embedding IS NULL OR purity_embedding BETWEEN 0 AND 1)
    AND (purity_probs IS NULL OR purity_probs BETWEEN 0 AND 1) AND (pure_patient_s IS NULL OR pure_patient_s >= 0)),
  CONSTRAINT affect_window_reason_chk CHECK (unscorable_reason IS NULL OR unscorable_reason IN (
    'no_voiceprint', 'no_patient', 'low_purity', 'short_pure_speech', 'low_patient_cosine', 'overlap', 'too_short',
    'attender_speaks_for_patient', 'model_error')),
  CONSTRAINT affect_window_level_chk CHECK ((arousal_calibration_level IS NULL OR arousal_calibration_level IN ('room', 'doctor', 'global'))
                                            AND (valence_calibration_level IS NULL OR valence_calibration_level IN ('room', 'doctor', 'global'))),
  CONSTRAINT affect_window_arousal_model_chk CHECK (arousal_model IS NULL OR arousal_model IN ('odyssey', 'audeering_fallback')),
  CONSTRAINT affect_window_valence_range_chk CHECK ((valence_raw IS NULL OR valence_raw BETWEEN 1 AND 5)
                                                    AND (valence_calibrated IS NULL OR valence_calibrated BETWEEN 1 AND 5)),
  CONSTRAINT affect_window_scorable_chk CHECK (NOT scorable OR (
    unscorable_reason IS NULL AND arousal_raw IS NOT NULL AND arousal_calibrated IS NOT NULL AND arousal_calibration_level IS NOT NULL
    AND arousal_model IS NOT NULL AND valence_raw IS NOT NULL AND valence_calibrated IS NOT NULL AND valence_calibration_level IS NOT NULL)),
  CONSTRAINT affect_window_unscorable_chk CHECK (scorable OR (
    unscorable_reason IS NOT NULL AND arousal_raw IS NULL AND arousal_calibrated IS NULL AND valence_raw IS NULL AND valence_calibrated IS NULL))
);

CREATE TABLE IF NOT EXISTS affect_consult (
  run_id                         bigint   NOT NULL REFERENCES affect_run(id) ON DELETE CASCADE,
  consult_uid                    text     NOT NULL,
  cut_version                    text     NOT NULL,
  encounter_consult_key          text,
  room_id                        text,
  room_slug                      text,
  ist_date                       date     NOT NULL,
  doctor_uid8                    text,
  n_windows                      integer  NOT NULL,
  n_scorable                     integer  NOT NULL,
  scorable_pct                   numeric,
  arousal_median                 double precision,
  valence_median                 double precision,
  arousal_open                   double precision,
  arousal_mid                    double precision,
  arousal_close                  double precision,
  valence_open                   double precision,
  valence_mid                    double precision,
  valence_close                  double precision,
  arousal_raw_median             double precision,
  valence_raw_median             double precision,
  arousal_raw_open               double precision,
  arousal_raw_mid                double precision,
  arousal_raw_close              double precision,
  valence_raw_open               double precision,
  valence_raw_mid                double precision,
  valence_raw_close              double precision,
  n_no_voiceprint                integer  NOT NULL DEFAULT 0,
  n_no_patient                   integer  NOT NULL DEFAULT 0,
  n_low_purity                   integer  NOT NULL DEFAULT 0,
  n_short_pure_speech            integer  NOT NULL DEFAULT 0,
  n_low_patient_cosine           integer  NOT NULL DEFAULT 0,
  n_overlap                      integer  NOT NULL DEFAULT 0,
  n_too_short                    integer  NOT NULL DEFAULT 0,
  n_attender_speaks_for_patient  integer  NOT NULL DEFAULT 0,
  n_model_error                  integer  NOT NULL DEFAULT 0,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, consult_uid, cut_version),
  CONSTRAINT affect_consult_counts_chk CHECK (n_windows >= 0 AND n_scorable >= 0 AND n_scorable <= n_windows),
  CONSTRAINT affect_consult_pct_chk CHECK (
    (n_windows = 0 AND scorable_pct IS NULL)
    OR (n_windows > 0 AND scorable_pct IS NOT NULL AND abs(scorable_pct - 100.0 * n_scorable / n_windows) < 0.01)),
  CONSTRAINT affect_consult_reasons_chk CHECK (
    n_no_voiceprint >= 0 AND n_no_patient >= 0 AND n_low_purity >= 0 AND n_short_pure_speech >= 0 AND n_low_patient_cosine >= 0
    AND n_overlap >= 0 AND n_too_short >= 0 AND n_attender_speaks_for_patient >= 0 AND n_model_error >= 0
    AND n_no_voiceprint + n_no_patient + n_low_purity + n_short_pure_speech + n_low_patient_cosine + n_overlap + n_too_short
        + n_attender_speaks_for_patient + n_model_error = n_windows - n_scorable),
  CONSTRAINT affect_consult_unscorable_chk CHECK (n_scorable > 0 OR (
    arousal_median IS NULL AND valence_median IS NULL AND arousal_open IS NULL AND arousal_mid IS NULL AND arousal_close IS NULL
    AND valence_open IS NULL AND valence_mid IS NULL AND valence_close IS NULL
    AND arousal_raw_median IS NULL AND valence_raw_median IS NULL AND arousal_raw_open IS NULL AND arousal_raw_mid IS NULL
    AND arousal_raw_close IS NULL AND valence_raw_open IS NULL AND valence_raw_mid IS NULL AND valence_raw_close IS NULL))
);

CREATE INDEX IF NOT EXISTS affect_window_consult_idx ON affect_window (consult_uid, cut_version, start_ms);
CREATE INDEX IF NOT EXISTS affect_window_room_day_idx ON affect_window (room_day_id, abs_start_ms);
CREATE INDEX IF NOT EXISTS affect_window_bench_idx ON affect_window (bench_window_id) WHERE bench_window_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS affect_window_scored_idx ON affect_window (scored_at);
CREATE INDEX IF NOT EXISTS affect_consult_room_day_idx ON affect_consult (room_slug, ist_date);
CREATE INDEX IF NOT EXISTS affect_consult_doctor_idx ON affect_consult (doctor_uid8, ist_date) WHERE doctor_uid8 IS NOT NULL;
CREATE INDEX IF NOT EXISTS affect_consult_encounter_idx ON affect_consult (encounter_consult_key) WHERE encounter_consult_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS affect_consult_key_idx ON affect_consult (consult_uid, cut_version);
CREATE INDEX IF NOT EXISTS affect_run_state_idx ON affect_run (state, started_at DESC);

CREATE OR REPLACE VIEW affect_consult_latest AS
SELECT DISTINCT ON (c.consult_uid, c.cut_version)
       c.*,
       r.pipeline_version,
       r.git_sha,
       r.calibration_arousal_id,
       r.calibration_valence_id,
       r.text_lane_on,
       r.started_at AS run_started_at
  FROM affect_consult c
  JOIN affect_run r ON r.id = c.run_id
 WHERE r.state = 'ok'
 ORDER BY c.consult_uid, c.cut_version, r.started_at DESC, r.id DESC;

COMMENT ON TABLE affect_window IS
  'Timbre v1 per patient window (#78). Raw + calibrated A/V; raw is the default for trends, calibrated is display-only 1-5. No identity/role column; no audio/text. Retention 36 months.';
COMMENT ON TABLE affect_consult IS
  'Timbre v1 per consult cut per run (#78). Unscorable is never neutral: 0 scorable windows => null medians/trajectory. doctor_uid8 is a calibration cell, never a ranking. Retention 36 months.';
COMMENT ON TABLE affect_run IS 'Timbre v1 pipeline invocations (#78/#79). Retention 36 months.';
COMMENT ON TABLE affect_calibration_map IS 'Timbre calibration maps (#78). Immutable; a refit is a new row. Aggregates only.';
COMMENT ON VIEW affect_consult_latest IS 'Per (consult_uid, cut_version), the affect_consult row of the newest ok affect_run. Readers use this so re-runs never double-count.';

INSERT INTO schema_migrations (version, name)
VALUES (155, '0155_timbre_affect')
ON CONFLICT DO NOTHING;

COMMIT;
