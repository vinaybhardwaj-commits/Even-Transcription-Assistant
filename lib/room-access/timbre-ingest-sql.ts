/**
 * lib/room-access/timbre-ingest-sql.ts — the Timbre T-9 load statements (Architecture #78, migration 0155).
 *
 * GENERATED from tools/timbre/store.py (ingest_statement / resolve_statements) and kept byte-identical:
 * tools/timbre/tests/test_store.py fails if the two drift. Edit the Python, then regenerate:
 *   python -c "from tools.timbre import store; ..." (see tools/timbre/STORE.md).
 *
 * INGEST_SQL ($1 = payload jsonb) is ONE statement: calibration maps (upsert by sha256), the run (skipped when the same
 * input_manifest_sha256 + git_sha + map ids already exists, so a re-post is idempotent), windows and consults.
 * RESOLVE_SQL ($1 = input_manifest_sha256) are the write-time joins: bench window / room day / session, encounter key, room.
 */
export const INGEST_SQL = `WITH p AS (SELECT $1::jsonb AS j),
ca AS (
  INSERT INTO affect_calibration_map (target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload)
  SELECT x.target, x.score_col, x.calib_version, x.min_n, x.fit_on, x.git_sha, x.sha256, x.payload
    FROM p, jsonb_populate_record(NULL::affect_calibration_map, p.j->'calibration_arousal') x
  ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
  RETURNING id
),
cv AS (
  INSERT INTO affect_calibration_map (target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload)
  SELECT x.target, x.score_col, x.calib_version, x.min_n, x.fit_on, x.git_sha, x.sha256, x.payload
    FROM p, jsonb_populate_record(NULL::affect_calibration_map, p.j->'calibration_valence') x
  ON CONFLICT (sha256) DO UPDATE SET sha256 = EXCLUDED.sha256
  RETURNING id
),
prior AS (
  SELECT r.id FROM affect_run r, p, ca, cv
   WHERE r.input_manifest_sha256 = p.j->'run'->>'input_manifest_sha256' AND r.git_sha = p.j->'run'->>'git_sha'
     AND r.calibration_arousal_id = ca.id AND r.calibration_valence_id = cv.id AND r.state <> 'failed'
),
run AS (
  INSERT INTO affect_run (pipeline_version, git_sha, compute, device, worker_id, speaker_source, nemotron_model_rev, arousal_model_id, arousal_model_rev, fallback_model_id, fallback_model_rev, valence_model_id, valence_model_rev, clef_question_set, purity_rule_version, purity_rule_json, text_lane_on, text_question_set, scope_json, input_manifest_sha256, state, error_code, n_consults, n_windows, n_scorable, n_fallback, n_clef_calls, n_text, finished_at, timing_json, gpu_seconds, clef_input_tokens, cost_usd_est, calibration_arousal_id, calibration_valence_id, started_at)
  SELECT x.pipeline_version, x.git_sha, x.compute, x.device, x.worker_id, x.speaker_source, x.nemotron_model_rev, x.arousal_model_id, x.arousal_model_rev, x.fallback_model_id, x.fallback_model_rev, x.valence_model_id, x.valence_model_rev, x.clef_question_set, x.purity_rule_version, x.purity_rule_json, x.text_lane_on, x.text_question_set, x.scope_json, x.input_manifest_sha256, x.state, x.error_code, x.n_consults, x.n_windows, x.n_scorable, x.n_fallback, x.n_clef_calls, x.n_text, x.finished_at, x.timing_json, x.gpu_seconds, x.clef_input_tokens, x.cost_usd_est, ca.id, cv.id, COALESCE(x.started_at, now())
    FROM p, ca, cv, jsonb_populate_record(NULL::affect_run, p.j->'run') x
   WHERE NOT EXISTS (SELECT 1 FROM prior)
  RETURNING id
),
w AS (
  INSERT INTO affect_window
  SELECT run.id, x.consult_uid, x.cut_version, x.window_key, x.start_ms, x.end_ms, x.abs_start_ms, x.abs_end_ms, x.room_day_id,
         x.bench_window_id, x.session_id, x.diarize_engine, x.diarize_ref, x.speaker_idx, x.doctor_slot, x.phase, x.lang, x.purity,
         x.purity_embedding, x.purity_probs, x.pure_patient_s, x.patient_cosine, x.scorable, x.unscorable_reason, x.arousal_raw,
         x.arousal_calibrated, x.arousal_calibration_level, x.arousal_model, x.odyssey_arousal_raw, x.audeering_arousal_raw,
         x.valence_raw, x.valence_calibrated, x.valence_calibration_level, x.text_valence, x.text_arousal, x.text_status,
         x.text_language, now()
    FROM run, p, jsonb_populate_recordset(NULL::affect_window, p.j->'windows') x
  RETURNING 1
),
c AS (
  INSERT INTO affect_consult
  SELECT run.id, x.consult_uid, x.cut_version, x.encounter_consult_key, x.room_id, x.room_slug, x.ist_date, x.doctor_uid8,
         x.n_windows, x.n_scorable, x.scorable_pct, x.arousal_median, x.valence_median, x.arousal_open, x.arousal_mid,
         x.arousal_close, x.valence_open, x.valence_mid, x.valence_close, x.arousal_raw_median, x.valence_raw_median,
         x.arousal_raw_open, x.arousal_raw_mid, x.arousal_raw_close, x.valence_raw_open, x.valence_raw_mid, x.valence_raw_close,
         x.n_no_voiceprint, x.n_no_patient, x.n_low_purity, x.n_short_pure_speech, x.n_low_patient_cosine, x.n_overlap,
         x.n_too_short, x.n_attender_speaks_for_patient, x.n_model_error, now()
    FROM run, p, jsonb_populate_recordset(NULL::affect_consult, p.j->'consults') x
  RETURNING 1
)
SELECT COALESCE((SELECT id FROM run), (SELECT id FROM prior LIMIT 1)) AS run_id,
       (SELECT count(*) FROM run)::int AS inserted,
       (SELECT count(*) FROM w)::int AS n_windows,
       (SELECT count(*) FROM c)::int AS n_consults`;

export const RESOLVE_SQL: readonly string[] = [
  `UPDATE affect_window w
   SET bench_window_id = s.bw_id, room_day_id = COALESCE(w.room_day_id, s.rd_id), session_id = COALESCE(w.session_id, s.sess)
  FROM (
    SELECT w2.run_id, w2.window_key, b.id AS bw_id, b.room_day_id AS rd_id, b.session_id AS sess
      FROM affect_window w2
      JOIN LATERAL (
        SELECT bw.id, bw.room_day_id, bw.session_id FROM bench_window bw
         WHERE bw.start_ms <= w2.abs_start_ms AND bw.end_ms > w2.abs_start_ms
           AND (w2.session_id IS NULL OR bw.session_id = w2.session_id)
         ORDER BY bw.start_ms DESC LIMIT 1
      ) b ON true
     WHERE w2.run_id IN (SELECT id FROM affect_run WHERE input_manifest_sha256 = $1) AND w2.bench_window_id IS NULL AND w2.abs_start_ms IS NOT NULL
  ) s
 WHERE w.run_id = s.run_id AND w.window_key = s.window_key`,
  `UPDATE affect_consult c
   SET encounter_consult_key = COALESCE(c.encounter_consult_key, s.ck),
       room_id = COALESCE(c.room_id, s.rid),
       room_slug = COALESCE((SELECT r.slug FROM room r WHERE r.id = COALESCE(c.room_id, s.rid)), c.room_slug)
  FROM (
    SELECT c2.run_id, c2.consult_uid, c2.cut_version,
           (SELECT e.consult_key FROM eta_encounter_windows e WHERE e.consult_uid = c2.consult_uid ORDER BY e.computed_at DESC NULLS LAST LIMIT 1) AS ck,
           COALESCE(
             (SELECT ci.room_id FROM consult_index ci WHERE ci.consult_uid = c2.consult_uid),
             (SELECT e.room_id FROM eta_encounter_windows e WHERE e.consult_uid = c2.consult_uid AND e.room_id IS NOT NULL ORDER BY e.computed_at DESC NULLS LAST LIMIT 1),
             (SELECT rd.room_id FROM affect_window w JOIN room_day rd ON rd.id = w.room_day_id
               WHERE w.run_id = c2.run_id AND w.consult_uid = c2.consult_uid AND w.cut_version = c2.cut_version ORDER BY w.start_ms LIMIT 1),
             (SELECT r.id FROM room r WHERE r.slug = c2.room_slug OR r.name = c2.room_slug ORDER BY r.disabled_at NULLS FIRST LIMIT 1)) AS rid
      FROM affect_consult c2
     WHERE c2.run_id IN (SELECT id FROM affect_run WHERE input_manifest_sha256 = $1)
  ) s
 WHERE c.run_id = s.run_id AND c.consult_uid = s.consult_uid AND c.cut_version = s.cut_version`,
];
