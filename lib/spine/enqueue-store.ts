/**
 * lib/spine/enqueue-store.ts — SPINE-P2 shadow ENQUEUER. runSpineEnqueue(now): for encounters inside the 72 h horizon, plan the FREE-stage jobs (lib/spine/enqueue.ts) and insert them
 * into spine_job. A stage in `shadow` is inserted with status `shadow` (never claimable); a stage in `live` is inserted `queued` (and a spent `shadow` row of the same key goes back to
 * `queued`). A paid stage is never planned. Idempotent on (encounter_id, stage, cut_version, input_key). Jobs of an older cut_version of the same encounter, and queued / shadow
 * jobs of a merged or rejected encounter, are marked `superseded` (never deleted). One spine_tick row (kind `enqueue`) per live pass.
 * Gate: spine_config `jobs` (missing / malformed = off) and `mode.<stage>` per stage (missing = off); kill_switch respected (config.readModes).
 */
import { sql } from "@/lib/db";
import { readModes } from "./config";
import { HORIZON_MS } from "./merge";
import { FREE_STAGES, STAGE_NEEDS, cutVersion, effectiveModes, planJobs, stagesFor, type EncounterRow } from "./enqueue";

type Q = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
const q = (): Q => sql as unknown as Q;

const READ_LIMIT = 2000;

const SELECT_SQL = `SELECT encounter_id, status, boundary_rev, flags, t_close FROM spine_encounter
 WHERE ist_date >= (($1::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date ORDER BY t_open DESC LIMIT ${READ_LIMIT}`;

/** Older cuts (and every queued / shadow job of an encounter that is merged / rejected: cut_version null) become superseded. */
export const SUPERSEDE_SQL = `
WITH c AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(encounter_id text, cut_version text)),
u AS (
  UPDATE spine_job j SET status = 'superseded', done_at = now()
    FROM c WHERE j.encounter_id = c.encounter_id AND j.status IN ('queued', 'shadow') AND (c.cut_version IS NULL OR j.cut_version <> c.cut_version)
  RETURNING 1
) SELECT count(*)::int AS superseded FROM u`;

export const INSERT_SQL = `
WITH ins AS (
  INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status)
  SELECT x.encounter_id, x.stage, x.cut_version, x.input_key, x.status
    FROM jsonb_to_recordset($1::jsonb) AS x(encounter_id text, stage text, cut_version text, input_key text, status text, needs text[])
   WHERE x.status = 'shadow' OR NOT EXISTS (
     SELECT 1 FROM unnest(x.needs) n WHERE NOT EXISTS (SELECT 1 FROM spine_job d WHERE d.encounter_id = x.encounter_id AND d.stage = n AND d.cut_version = x.cut_version AND d.status = 'done'))
  ON CONFLICT ON CONSTRAINT spine_job_key_uq DO UPDATE
     SET status = 'queued', attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL, last_error_class = NULL, last_error_code = NULL, done_at = NULL
   WHERE EXCLUDED.status = 'queued' AND spine_job.status = 'shadow'
  RETURNING stage, status
) SELECT stage, status, count(*)::int AS n FROM ins GROUP BY stage, status`;

export type EnqueueCounts =
  | { skipped: "off" }
  | { jobs: "shadow" | "live"; encounters: number; planned: number; shadow: number; queued: number; superseded: number; by_stage: Record<string, number>; ambiguous_no_freescript: number };

export async function runSpineEnqueue(now: number): Promise<EnqueueCounts> {
  const m = await readModes(FREE_STAGES);
  const modes = effectiveModes(m.jobs, m.stages);
  if (m.jobs === "off" || FREE_STAGES.every((s) => modes[s] === "off")) return { skipped: "off" };
  const rows = await q()(SELECT_SQL, [new Date(now - HORIZON_MS).toISOString()]);
  const encs: EncounterRow[] = rows.map((r) => ({
    encounter_id: String(r.encounter_id), status: String(r.status), boundary_rev: Number(r.boundary_rev),
    flags: Array.isArray(r.flags) ? (r.flags as unknown[]).map(String) : String(r.flags ?? "").replace(/[{}]/g, "").split(",").filter(Boolean),
    t_close: r.t_close == null ? null : Date.parse(String(r.t_close)),
  }));
  const plan = planJobs(encs, modes, now);
  const sup = encs.filter((e) => e.status === "merged" || e.status === "rejected" || e.status === "confirmed" || e.status === "candidate")
    .map((e) => ({ encounter_id: e.encounter_id, cut_version: e.status === "confirmed" || e.status === "candidate" ? cutVersion(e.boundary_rev) : null }));
  const s = await q()(SUPERSEDE_SQL, [JSON.stringify(sup)]);
  const ins = plan.length ? await q()(INSERT_SQL, [JSON.stringify(plan.map((p) => ({ ...p, needs: STAGE_NEEDS[p.stage] ?? [] })))]) : [];
  const by_stage: Record<string, number> = {};
  let shadow = 0, queued = 0;
  for (const r of ins) {
    const n = Number(r.n);
    by_stage[String(r.stage)] = (by_stage[String(r.stage)] ?? 0) + n;
    if (r.status === "shadow") shadow += n; else queued += n;
  }
  const ambiguous_no_freescript = encs.filter((e) => e.status === "confirmed" && e.flags.includes("ambiguous") && stagesFor(e, now).length > 0).length;
  const counts = { jobs: m.jobs as "shadow" | "live", encounters: encs.length, planned: plan.length, shadow, queued, superseded: Number(s[0]?.superseded ?? 0), by_stage, ambiguous_no_freescript };
  await q()("INSERT INTO spine_tick (kind, counts) VALUES ($1, $2::jsonb)", ["enqueue", JSON.stringify(counts)]);
  return counts;
}
