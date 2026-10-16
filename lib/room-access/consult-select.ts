/**
 * lib/room-access/consult-select.ts — JEV-EVERY-CONSULT S1: the SQL (eta_encounter_windows is a room-data table, so the room-access gate wants it HERE) behind
 * lib/jev/worker/consult-eligible.ts and coverage.ts. Counts and consult_key values only; no text. See those files for the rules.
 *
 * "Transcribed" (eligibility AND coverage) is the palimpsest encounter_catalog stage rule, INFERRED (stage keys per 0168_encounter_catalog.sql:4,15 "stage states with reasons"; the writer is the lab box's ledger, not in this repo):
 *   stages->'sealed'->>'state' = 'ok' AND stages->'stt'->>'state' = 'ok'
 *   AND (stages->'translate'->>'state' = 'ok' OR (stages->'translate'->>'state' = 'n/a' AND stages->'translate'->>'reason' = 'english')).
 * From 16 Oct palimpsest's R2 ready feed replaces this (not this slice).
 */
import { sql } from "@/lib/db";
import { newDecisionId, type WorkerDecision } from "@/lib/jev/worker/persist";

/** JEV-NODATA-RETRY R1: a consult whose rows for (sha, mode) are ALL no_state = 'no_data' markers is re-offered once the newest is older than this many minutes. Every other marker reason stays terminal. */
export const NODATA_RETRY_MIN = 30;

/** JEV-NODATA-RETRY FIX1 F3: a no_data consult is re-offered only while its t_close is within this many hours; older no_data markers stay terminal (bounds the rebuild cost). */
export const NODATA_RETRY_MAX_AGE_H = 48;

/**
 * FIX1 F4: of `keys` (consult_keys a sweep is about to build), the ones that are R1 re-offers: they already hold derived rows (all no_data markers, or the select would not have returned them) for (sha, mode).
 * Count-only use: the sweeper logs `jev consult nodata_retry=<n>` from the consults that survive pendingSubjects.
 */
export async function nodataRetryKeys(keys: string[], sha: string, mode: string, subjectType: string): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = (await sql`
    SELECT DISTINCT d.subject_id FROM jev_decision d
     WHERE d.subject_type = ${subjectType} AND d.question_set_sha256 = ${sha}::text AND d.mode = ${mode}::text AND d.order_variant = 'derived'
       AND d.subject_id = ANY(${keys}::text[])`) as Array<{ subject_id: string }>;
  return rows.map((r) => r.subject_id);
}

export async function selectTranscribedConsults(n: number, days: number, sha: string | null, mode: string, subjectType: string): Promise<string[]> {
  const rows = (await sql`
    WITH q AS (
      SELECT w.consult_key, w.consult_uid, w.t_close FROM eta_encounter_windows w
       WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL
         AND w.t_open >= ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => ${days}::int)) AT TIME ZONE 'Asia/Kolkata') AND w.t_open <= now()
         AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid
                       AND ec.stages->'sealed'->>'state' = 'ok' AND ec.stages->'stt'->>'state' = 'ok'
                       AND (ec.stages->'translate'->>'state' = 'ok' OR (ec.stages->'translate'->>'state' = 'n/a' AND ec.stages->'translate'->>'reason' = 'english')))
    ), pick AS (
      SELECT DISTINCT ON (consult_uid) consult_key, consult_uid, t_close FROM q ORDER BY consult_uid, consult_key
    )
    SELECT p.consult_key,
           (${sha}::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM jev_decision r JOIN eta_encounter_windows rx ON rx.consult_key = r.subject_id
               WHERE rx.consult_uid = p.consult_uid AND r.subject_type = ${subjectType} AND r.question_set_sha256 = ${sha}::text AND r.mode = ${mode}::text AND r.order_variant = 'derived')) AS retried
      FROM pick p
     WHERE ${sha}::text IS NULL OR NOT EXISTS (
       -- decided = any derived row that is NOT a no_data marker (answered, abstained, refused, read_refused, ...), or a no_data marker still inside the cooldown, or a no_data marker on a consult past the retry window
       SELECT 1 FROM jev_decision d JOIN eta_encounter_windows x ON x.consult_key = d.subject_id
        WHERE x.consult_uid = p.consult_uid AND d.subject_type = ${subjectType} AND d.question_set_sha256 = ${sha}::text AND d.mode = ${mode}::text AND d.order_variant = 'derived'
          AND (d.evidence->>'no_state' IS DISTINCT FROM 'no_data' OR d.created_at > now() - make_interval(mins => ${NODATA_RETRY_MIN}::int)
               OR p.t_close < now() - make_interval(hours => ${NODATA_RETRY_MAX_AGE_H}::int)))
     -- FIX1 F2: fresh consults (no derived rows) first, then the no_data re-offers; each group oldest t_close first
     ORDER BY retried ASC, p.t_close ASC, p.consult_key ASC
     LIMIT ${n}::int
  `) as Array<{ consult_key: string; retried: boolean }>;
  return rows.map((r) => r.consult_key);
}

/**
 * BACKFILL-SINCE pass 2: the SAME predicates as selectTranscribedConsults (transcribed rule, the uid's lexically smallest key, decided-for-sha/mode exclusion, oldest first) over the
 * half-open range [`lo`, `hi`) (FIX1 F2: both bound as timestamptz, computed once per call by the caller: `lo` = SINCE 00:00 IST, `hi` = start of the pass-1 window). A uid with any window at or after that start is pass 1's, so it is excluded here: the two passes never share a uid.
 * `liveKeys` are the keys pass 1 returned: a uid owning any of them is skipped, so a boundary that moved between the two statements (IST midnight) still gives one key per uid.
 */
export async function selectTranscribedConsultsBefore(n: number, lo: string, hi: string, liveKeys: string[], sha: string | null, mode: string, subjectType: string): Promise<string[]> {
  const rows = (await sql`
    WITH b AS (
      SELECT ${hi}::timestamptz AS hi, ${lo}::timestamptz AS lo
    ), lu AS (
      SELECT DISTINCT z.consult_uid FROM eta_encounter_windows z
       WHERE z.consult_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(liveKeys)}::jsonb)) AND z.consult_uid IS NOT NULL
    ), q AS (
      SELECT w.consult_key, w.consult_uid, w.t_close FROM eta_encounter_windows w, b
       WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL
         AND w.t_open >= b.lo AND w.t_open < b.hi
         AND NOT EXISTS (SELECT 1 FROM eta_encounter_windows z WHERE z.consult_uid = w.consult_uid AND z.t_open >= b.hi AND z.t_open <= now())
         AND w.consult_uid NOT IN (SELECT consult_uid FROM lu)
         AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid
                       AND ec.stages->'sealed'->>'state' = 'ok' AND ec.stages->'stt'->>'state' = 'ok'
                       AND (ec.stages->'translate'->>'state' = 'ok' OR (ec.stages->'translate'->>'state' = 'n/a' AND ec.stages->'translate'->>'reason' = 'english')))
    ), pick AS (
      SELECT DISTINCT ON (consult_uid) consult_key, consult_uid, t_close FROM q ORDER BY consult_uid, consult_key
    )
    SELECT p.consult_key,
           (${sha}::text IS NOT NULL AND EXISTS (
              SELECT 1 FROM jev_decision r JOIN eta_encounter_windows rx ON rx.consult_key = r.subject_id
               WHERE rx.consult_uid = p.consult_uid AND r.subject_type = ${subjectType} AND r.question_set_sha256 = ${sha}::text AND r.mode = ${mode}::text AND r.order_variant = 'derived')) AS retried
      FROM pick p
     WHERE ${sha}::text IS NULL OR NOT EXISTS (
       -- decided = any derived row that is NOT a no_data marker (answered, abstained, refused, read_refused, ...), or a no_data marker still inside the cooldown, or a no_data marker on a consult past the retry window
       SELECT 1 FROM jev_decision d JOIN eta_encounter_windows x ON x.consult_key = d.subject_id
        WHERE x.consult_uid = p.consult_uid AND d.subject_type = ${subjectType} AND d.question_set_sha256 = ${sha}::text AND d.mode = ${mode}::text AND d.order_variant = 'derived'
          AND (d.evidence->>'no_state' IS DISTINCT FROM 'no_data' OR d.created_at > now() - make_interval(mins => ${NODATA_RETRY_MIN}::int)
               OR p.t_close < now() - make_interval(hours => ${NODATA_RETRY_MAX_AGE_H}::int)))
     -- FIX1 F2: fresh consults (no derived rows) first, then the no_data re-offers; each group oldest t_close first
     ORDER BY retried ASC, p.t_close ASC, p.consult_key ASC
     LIMIT ${n}::int
  `) as Array<{ consult_key: string; retried: boolean }>;
  return rows.map((r) => r.consult_key);
}

export async function coverageCutAndTranscribed(istDate: string): Promise<{ cut: number; transcribed: number }> {
  const [cut, trans] = (await Promise.all([
    sql`SELECT count(DISTINCT w.consult_uid)::int AS c FROM eta_encounter_windows w
         WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date`,
    sql`SELECT count(DISTINCT w.consult_uid)::int AS c FROM eta_encounter_windows w
         WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date
           AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid
                         AND ec.stages->'sealed'->>'state' = 'ok' AND ec.stages->'stt'->>'state' = 'ok'
                         AND (ec.stages->'translate'->>'state' = 'ok' OR (ec.stages->'translate'->>'state' = 'n/a' AND ec.stages->'translate'->>'reason' = 'english')))`,
  ])) as unknown as Array<Array<{ c: unknown }>>;
  return { cut: Number(cut[0]?.c ?? 0), transcribed: Number(trans[0]?.c ?? 0) };
}

/**
 * Coverage of one set on `istDate` (IST), over the TRANSCRIBED consults only (same catalog-stage test as selectTranscribedConsults).
 * done = distinct consults holding at least one shadow derived row for `sha` that is NOT a no_state marker (a Jev call was made);
 * noState = distinct consults whose rows for `sha` are markers only (Jev was never called).
 */
export async function coverageJevDone(sha: string, subjectType: string, istDate: string): Promise<{ done: number; noState: number }> {
  const r = (await sql`
    WITH t AS (
      SELECT DISTINCT w.consult_uid FROM eta_encounter_windows w
       WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date
         AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid
                       AND ec.stages->'sealed'->>'state' = 'ok' AND ec.stages->'stt'->>'state' = 'ok'
                       AND (ec.stages->'translate'->>'state' = 'ok' OR (ec.stages->'translate'->>'state' = 'n/a' AND ec.stages->'translate'->>'reason' = 'english')))
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
 * M1: write no_state MARKER rows (outcome no_answer, evidence.no_state) without ever changing a real row. Skipped entirely when ANY jev_decision row for
 * (subject_type, subject_id, question_set_sha256, mode) is something other than a no_data marker (a real answer, an abstain, a terminal marker such as read_refused).
 * JEV-NODATA-RETRY R2: over rows that are ALL no_data markers the insert goes through and ON CONFLICT refreshes the marker (reason, created_at = now(), so the 30-minute
 * cooldown restarts); the DO UPDATE is guarded by `WHERE jev_decision.evidence->>'no_state' = 'no_data'`, so a row that is not a no_data marker is never touched.
 * One statement, so the check and the insert cannot interleave. A later real answer replaces the marker rows through upsertDecisions (same worker key).
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
     WHERE NOT EXISTS (SELECT 1 FROM jev_decision e WHERE e.subject_type = x.subject_type AND e.subject_id = x.subject_id AND e.question_set_sha256 = x.question_set_sha256 AND e.mode = x.mode
                         AND e.evidence->>'no_state' IS DISTINCT FROM 'no_data')
    ON CONFLICT (subject_type, subject_id, question_id, question_set_sha256, order_variant, mode) WHERE question_set_sha256 IS NOT NULL DO UPDATE SET
      evidence = EXCLUDED.evidence, call_id = EXCLUDED.call_id, job_id = EXCLUDED.job_id, created_at = now()
      WHERE jev_decision.evidence->>'no_state' = 'no_data'
    RETURNING 1`) as unknown[];
  return out.length;
}
