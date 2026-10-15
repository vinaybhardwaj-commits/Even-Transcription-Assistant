/**
 * lib/room-access/consult-select.ts — JEV-EVERY-CONSULT S1: the SQL (eta_encounter_windows, reb_track_index are room-data tables, so the room-access gate wants it HERE) behind
 * lib/jev/worker/consult-eligible.ts and coverage.ts. Counts and consult_key values only; no text. See those files for the rules.
 */
import { sql } from "@/lib/db";

export async function selectTranscribedConsults(n: number, days: number, sha: string | null, mode: string, subjectType: string): Promise<string[]> {
  const rows = (await sql`
    WITH q AS (
      SELECT w.consult_key, w.consult_uid, w.t_close FROM eta_encounter_windows w
       WHERE w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND w.room_id IS NOT NULL
         AND w.t_open >= ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') - make_interval(days => ${days}::int)) AT TIME ZONE 'Asia/Kolkata') AND w.t_open <= now()
         AND EXISTS (SELECT 1 FROM encounter_catalog ec WHERE ec.consult_uid = w.consult_uid AND ec.stages->'sealed'->>'state' = 'ok')
         AND (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'translate')
              OR (EXISTS (SELECT 1 FROM reb_track_index x WHERE x.window_id = 'consult-' || w.consult_uid AND x.status = 'ok' AND x.shadow = false AND x.layer = 'stt')
                  AND EXISTS (SELECT 1 FROM consult_sarvam_result sr WHERE sr.consult_uid = w.consult_uid AND sr.language_code ILIKE 'en%')))
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
                  AND EXISTS (SELECT 1 FROM consult_sarvam_result sr WHERE sr.consult_uid = w.consult_uid AND sr.language_code ILIKE 'en%')))`,
  ])) as unknown as Array<Array<{ c: unknown }>>;
  return { cut: Number(cut[0]?.c ?? 0), transcribed: Number(trans[0]?.c ?? 0) };
}

/** Distinct consults with a decision under `sha` (shadow, derived) whose window closed on `istDate` (IST). */
export async function coverageJevDone(sha: string, subjectType: string, istDate: string): Promise<number> {
  const r = (await sql`
    SELECT count(DISTINCT w.consult_uid)::int AS c FROM jev_decision d JOIN eta_encounter_windows w ON w.consult_key = d.subject_id
     WHERE d.question_set_sha256 = ${sha}::text AND d.subject_type = ${subjectType} AND d.mode = 'shadow' AND d.order_variant = 'derived'
       AND w.t_close IS NOT NULL AND w.consult_uid IS NOT NULL AND (w.t_close AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date`) as Array<{ c: unknown }>;
  return Number(r[0]?.c ?? 0);
}
