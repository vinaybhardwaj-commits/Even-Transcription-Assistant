/**
 * lib/room-access/consult-select.ts — JEV-EVERY-CONSULT S1: the SQL (eta_encounter_windows, reb_track_index are room-data tables, so the room-access gate wants it HERE) behind
 * lib/jev/worker/consult-eligible.ts and coverage.ts. Counts and consult_key values only; no text. See those files for the rules.
 */
import { sql } from "@/lib/db";
import { newDecisionId, type WorkerDecision } from "@/lib/jev/worker/persist";

export async function selectTranscribedConsults(n: number, days: number, sha: string | null, mode: string, subjectType: string): Promise<string[]> {
  const rows = (await sql`
    WITH q AS (
      SELECT w.consult_key, w.consult_uid, w.t_close FROM eta_encounter_windows w
       WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL
         AND w.t_open >= ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => ${days}::int)) AT TIME ZONE 'Asia/Kolkata') AND w.t_open <= now()
         AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid AND ec.stages->'sealed'->>'state' = 'ok')
         AND (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'translate')
              OR (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'stt')
                  AND EXISTS (SELECT 1 FROM consult_sarvam_result sr WHERE sr.consult_uid = w.consult_uid AND sr.language_code ILIKE 'en%'
                       AND sr.cut_version = (SELECT c.cut_version FROM consult_sarvam_result c WHERE c.consult_uid = w.consult_uid ORDER BY c.created_at DESC, c.id DESC LIMIT 1))))
    ), pick AS (
      SELECT DISTINCT ON (consult_uid) consult_key, consult_uid, t_close FROM q ORDER BY consult_uid, consult_key
    )
    SELECT p.consult_key FROM pick p
     WHERE ${sha}::text IS NULL OR NOT EXISTS (
       SELECT 1 FROM jev_decision d JOIN eta_encounter_windows x ON x.consult_key = d.subject_id
        WHERE x.consult_uid = p.consult_uid AND d.subject_type = ${subjectType} AND d.question_set_sha256 = ${sha}::text AND d.mode = ${mode}::text AND d.order_variant = 'derived')
     ORDER BY p.t_close ASC, p.consult_key ASC
     LIMIT ${n}::int
  `) as Array<{ consult_key: string }>;
  return rows.map((r) => r.consult_key);
}

export async function coverageCutAndTranscribed(istDate: string): Promise<{ cut: number; transcribed: number }> {
  const [cut, trans] = (await Promise.all([
    sql`SELECT count(DISTINCT w.consult_uid)::int AS c FROM eta_encounter_windows w
         WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date`,
    sql`SELECT count(DISTINCT w.consult_uid)::int AS c FROM eta_encounter_windows w
         WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date
           AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid AND ec.stages->'sealed'->>'state' = 'ok')
         AND (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'translate')
              OR (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'stt')
                  AND EXISTS (SELECT 1 FROM consult_sarvam_result sr WHERE sr.consult_uid = w.consult_uid AND sr.language_code ILIKE 'en%'
                       AND sr.cut_version = (SELECT c.cut_version FROM consult_sarvam_result c WHERE c.consult_uid = w.consult_uid ORDER BY c.created_at DESC, c.id DESC LIMIT 1))))`,
  ])) as unknown as Array<Array<{ c: unknown }>>;
  return { cut: Number(cut[0]?.c ?? 0), transcribed: Number(trans[0]?.c ?? 0) };
}

/**
 * Coverage of one set on `istDate` (IST), over the TRANSCRIBED consults only (same transcript test as selectTranscribedConsults).
 * done = distinct consults holding at least one shadow derived row for `sha` that is NOT a no_state marker (a Jev call was made);
 * noState = distinct consults whose rows for `sha` are markers only (Jev was never called).
 */
export async function coverageJevDone(sha: string, subjectType: string, istDate: string): Promise<{ done: number; noState: number }> {
  const r = (await sql`
    WITH t AS (
      SELECT DISTINCT w.consult_uid FROM eta_encounter_windows w
       WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date
         AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid AND ec.stages->'sealed'->>'state' = 'ok')
         AND (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'translate')
              OR (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'stt')
                  AND EXISTS (SELECT 1 FROM consult_sarvam_result sr WHERE sr.consult_uid = w.consult_uid AND sr.language_code ILIKE 'en%'
                       AND sr.cut_version = (SELECT c.cut_version FROM consult_sarvam_result c WHERE c.consult_uid = w.consult_uid ORDER BY c.created_at DESC, c.id DESC LIMIT 1))))
    ), per AS (
      SELECT t.consult_uid, bool_or(NOT (coalesce(d.evidence, '{}'::jsonb) ? 'no_state')) AS real_row
        FROM t JOIN eta_encounter_windows x ON x.consult_uid = t.consult_uid
        JOIN jev_decision d ON d.subject_id = x.consult_key
       WHERE d.question_set_sha256 = ${sha}::text AND d.subject_type = ${subjectType} AND d.mode = 'shadow' AND d.order_variant = 'derived'
       GROUP BY t.consult_uid)
    SELECT count(*) FILTER (WHERE real_row)::int AS done, count(*) FILTER (WHERE NOT real_row)::int AS no_state FROM per`) as Array<{ done: unknown; no_state: unknown }>;
  return { done: Number(r[0]?.done ?? 0), noState: Number(r[0]?.no_state ?? 0) };
}

/**
 * M1: write no_state MARKER rows (outcome no_answer, evidence.no_state) without ever changing an existing row. Skipped entirely when ANY jev_decision row already
 * exists for (subject_type, subject_id, question_set_sha256, mode); ON CONFLICT DO NOTHING besides. One statement, so the check and the insert cannot interleave.
 */
export async function insertNoStateMarkers(rows: WorkerDecision[]): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    id: newDecisionId(), subject_type: r.subjectType, subject_id: r.subjectId, question_id: r.questionId, prompt_version: r.promptVersion, model: r.model,
    question_set_id: r.setId, question_set_version: r.setVersion, question_set_sha256: r.setSha, order_variant: r.orderVariant, option_order_sha256: r.optionOrderSha,
    lane: r.lane, answer: r.answer, probabilities: r.probabilities, confidence: r.confidence, band: r.band, outcome: r.outcome, call_id: r.callId, job_id: r.jobId,
    mode: r.mode, latency_ms: r.latencyMs, input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: r.costUsd, evidence: r.evidence, state_sha256: r.stateSha, mock: r.mock,
  }));
  const out = (await sql`
    INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant,
                              option_order_sha256, lane, answer, probabilities, confidence, band, outcome, call_id, job_id, mode, latency_ms, input_tokens, output_tokens,
                              cost_usd, evidence, state_sha256, mock)
    SELECT id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant,
           option_order_sha256, lane, answer, probabilities, confidence, band, outcome, call_id, job_id, mode, latency_ms, input_tokens, output_tokens,
           cost_usd, evidence, state_sha256, mock
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
        id text, subject_type text, subject_id text, question_id text, prompt_version text, model text, question_set_id text, question_set_version text,
        question_set_sha256 text, order_variant text, option_order_sha256 text, lane text, answer jsonb, probabilities jsonb, confidence real, band text,
        outcome text, call_id text, job_id text, mode text, latency_ms int, input_tokens int, output_tokens int, cost_usd numeric, evidence jsonb,
        state_sha256 text, mock boolean)
     WHERE NOT EXISTS (SELECT 1 FROM jev_decision e WHERE e.subject_type = x.subject_type AND e.subject_id = x.subject_id AND e.question_set_sha256 = x.question_set_sha256 AND e.mode = x.mode)
    ON CONFLICT DO NOTHING
    RETURNING 1`) as unknown[];
  return out.length;
}
