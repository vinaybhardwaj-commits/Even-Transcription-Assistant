/**
 * lib/spine/enqueue-store.ts — SPINE-P2 shadow ENQUEUER. runSpineEnqueue(now): for encounters inside the 72 h horizon, plan the FREE-stage jobs (lib/spine/enqueue.ts) and insert them
 * into spine_job. A stage in `shadow` is inserted with status `shadow` (never claimable); a stage in `live` is inserted `queued` (and a spent `shadow` row of the same key goes back to
 * `queued`; a `superseded` row of the same key is a re-plan and takes the planned status again). A paid stage is never planned. Idempotent on (encounter_id, stage, cut_version, input_key). Jobs of an older cut_version of the same encounter, and queued / shadow
 * jobs of a merged or rejected encounter, are marked `superseded` (never deleted). One spine_tick row (kind `enqueue`) per live pass.
 * S6 room scoping: a stage may be live for listed rooms only (config.ts THE ROOM RULE); an unlisted room's rows are planned `shadow`. A queued row of a room later taken out of the list is left as is (nothing deleted): the claim only
 * hands it to a would_run claim, and a room put back revives its shadow rows by the same ON CONFLICT rule as any live flip.
 * Gate: spine_config `jobs` (missing / malformed = off) and `mode.<stage>` per stage (missing = off); kill_switch respected (config.readModes).
 */
import { sql } from "@/lib/db";
import { readModes } from "./config";
import { HORIZON_MS } from "./merge";
import { FREE_STAGES, STAGE_NEEDS, cutVersion, effectiveModes, planJobs, stagesFor, type EncounterRow } from "./enqueue";

type Q = (text: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;
const q = (): Q => sql as unknown as Q;

const READ_LIMIT = 2000;

const SELECT_SQL = `SELECT encounter_id, status, boundary_rev, flags, t_close, room_id FROM spine_encounter
 WHERE ist_date >= (($1::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date ORDER BY t_open DESC LIMIT ${READ_LIMIT}`;

/** Older cuts, sp: rows of an encounter that is no longer confirmed_single_proxy (and non-sp rows of one that is), stages the encounter no longer plans (ambiguous loses freescript; candidate loses collector / freescript), and every queued / shadow job of an encounter that is merged / rejected (cut_version null), become superseded. */
export const SUPERSEDE_SQL = `
WITH c AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(encounter_id text, cut_version text, stages text[], sp boolean)),
u AS (
  UPDATE spine_job j SET status = 'superseded', done_at = now()
    FROM c WHERE j.encounter_id = c.encounter_id AND j.status IN ('queued', 'shadow') AND (c.cut_version IS NULL OR j.cut_version <> c.cut_version OR j.stage <> ALL (c.stages) OR (j.input_key LIKE 'sp:%') <> c.sp)
  RETURNING 1
) SELECT count(*)::int AS superseded FROM u`;

/** Rows per status over every spine_job of the pass's encounters, read AFTER the insert: a rerun tick (shadow 0, by_stage {}) still shows what is there. */
export const TOTALS_SQL = `SELECT status, count(*)::int AS n FROM spine_job WHERE encounter_id IN (SELECT jsonb_array_elements_text($1::jsonb)) GROUP BY status`;

export const INSERT_SQL = `
WITH ins AS (
  INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status)
  SELECT x.encounter_id, x.stage, x.cut_version, x.input_key, x.status
    FROM jsonb_to_recordset($1::jsonb) AS x(encounter_id text, stage text, cut_version text, input_key text, status text, needs text[])
   WHERE x.status = 'shadow' OR NOT EXISTS (
     SELECT 1 FROM unnest(x.needs) n WHERE NOT EXISTS (SELECT 1 FROM spine_job d WHERE d.encounter_id = x.encounter_id AND d.stage = n AND d.cut_version = x.cut_version AND d.status = 'done'))
  ON CONFLICT ON CONSTRAINT spine_job_key_uq DO UPDATE
     SET status = EXCLUDED.status, attempts = 0, next_attempt_at = NULL, lease_owner = NULL, lease_until = NULL, last_error_class = NULL, last_error_code = NULL, done_at = NULL
   WHERE (EXCLUDED.status = 'queued' AND spine_job.status = 'shadow') OR spine_job.status = 'superseded'
      -- S6: a job the runner HELD as blocked (no consult_uid link: queued, next_attempt_at infinity) comes back once an active consult_uid link exists. Nothing else called enqueue({unblock}), so it stayed held for ever.
      OR (EXCLUDED.status = 'queued' AND spine_job.status = 'queued' AND spine_job.next_attempt_at = 'infinity'::timestamptz
          AND EXISTS (SELECT 1 FROM spine_link l WHERE l.encounter_id = EXCLUDED.encounter_id AND l.key_kind = 'consult_uid' AND l.active))
  RETURNING stage, status
) SELECT stage, status, count(*)::int AS n FROM ins GROUP BY stage, status`;

export type EnqueueCounts =
  | { skipped: "off" }
  | { jobs: "shadow" | "live"; encounters: number; planned: number; shadow: number; queued: number; superseded: number; by_stage: Record<string, number>; ambiguous_no_freescript: number; totals: Record<string, number> };

export async function runSpineEnqueue(now: number): Promise<EnqueueCounts> {
  const m = await readModes(FREE_STAGES);
  const modes = effectiveModes(m.jobs, m.stages);
  if (m.jobs === "off" || FREE_STAGES.every((s) => modes[s] === "off")) return { skipped: "off" };
  const rows = await q()(SELECT_SQL, [new Date(now - HORIZON_MS).toISOString()]);
  const encs: EncounterRow[] = rows.map((r) => ({
    encounter_id: String(r.encounter_id), status: String(r.status), boundary_rev: Number(r.boundary_rev),
    flags: Array.isArray(r.flags) ? (r.flags as unknown[]).map(String) : String(r.flags ?? "").replace(/[{}]/g, "").split(",").filter(Boolean),
    t_close: r.t_close == null ? null : Date.parse(String(r.t_close)),
    room_id: r.room_id == null ? null : String(r.room_id),
  }));
  const plan = planJobs(encs, m.stages, now, m.scopes, m.jobs);
  const sup = encs.filter((e) => e.status === "merged" || e.status === "rejected" || e.status === "confirmed" || e.status === "candidate" || e.status === "confirmed_single_proxy")
    .map((e) => ({
      encounter_id: e.encounter_id, cut_version: e.status === "merged" || e.status === "rejected" ? null : cutVersion(e.boundary_rev), sp: e.status === "confirmed_single_proxy",
      // the stages the encounter plans once its close grace has passed (the grace is time, not status: a queued job is not superseded by it)
      stages: stagesFor({ ...e, t_close: 0 }, Number.MAX_SAFE_INTEGER),
    }));
  const s = await q()(SUPERSEDE_SQL, [JSON.stringify(sup)]);
  const ins = plan.length ? await q()(INSERT_SQL, [JSON.stringify(plan.map((p) => ({ ...p, needs: STAGE_NEEDS[p.stage] ?? [] })))]) : [];
  const by_stage: Record<string, number> = {};
  let shadow = 0, queued = 0;
  for (const r of ins) {
    const n = Number(r.n);
    by_stage[String(r.stage)] = (by_stage[String(r.stage)] ?? 0) + n;
    if (r.status === "shadow") shadow += n; else queued += n;
  }
  const totals: Record<string, number> = {};
  if (encs.length) for (const r of await q()(TOTALS_SQL, [JSON.stringify(encs.map((e) => e.encounter_id))])) totals[String(r.status)] = Number(r.n);
  const ambiguous_no_freescript = encs.filter((e) => (e.status === "confirmed" || e.status === "confirmed_single_proxy") && e.flags.includes("ambiguous") && stagesFor(e, now).length > 0).length;
  const counts = { jobs: m.jobs as "shadow" | "live", encounters: encs.length, planned: plan.length, shadow, queued, superseded: Number(s[0]?.superseded ?? 0), by_stage, ambiguous_no_freescript, totals };
  await q()("INSERT INTO spine_tick (kind, counts) VALUES ($1, $2::jsonb)", ["enqueue", JSON.stringify(counts)]);
  return counts;
}
