/**
 * lib/rubrics/llm-cap.ts — S71-R4 G71: a COST BOUND for the llm_zdr rubrics, in code. A model call costs money, so a job and a day have a call ceiling:
 *   per job   RUBRIC_LLM_JOB_CALL_CAP   (default 600)   per IST day  RUBRIC_LLM_DAILY_CALL_CAP (default 2000)   — both read-only env names; this code never sets env.
 * COUNTING (existing tables, no migration): calls made today = for every finished rubric_run of an llm rubric started today (IST), units_ok + units_failed (one call per scored unit, a
 * lower bound: the one retry is not counted); for an UNFINISHED run, its units_planned (the reservation). Calls RESERVED by queued jobs = the units in the job (a run: unit_keys, else limit;
 * a bench: a fixed estimate per set). A job also counts the calls it has made itself (progress.llm_calls, from each unit's attempts).
 * SUBMIT refuses (JobArgsError llm_job_cap / llm_daily_cap, with the numbers). A RUNNING job stops at the cap: its remaining units are counted as skipped (reason llm_cap) and no more calls are made.
 */
import { sql } from "@/lib/db";
import { LLM_WIRED } from "./registry";

export const DEFAULT_JOB_CALL_CAP = 600;
export const DEFAULT_DAILY_CALL_CAP = 2000;
type Env = Record<string, string | undefined>;
const posInt = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : d; };
export const jobCallCap = (env: Env = process.env): number => posInt(env.RUBRIC_LLM_JOB_CALL_CAP, DEFAULT_JOB_CALL_CAP);
export const dailyCallCap = (env: Env = process.env): number => posInt(env.RUBRIC_LLM_DAILY_CALL_CAP, DEFAULT_DAILY_CALL_CAP);

export const isLlmRubric = (id: string): boolean => LLM_WIRED.has(id);
/** Calls a bench of each set is assumed to need when it is queued (a running bench is bounded by the caps anyway). */
export const BENCH_CALL_ESTIMATE: Record<string, number> = { gold: 30, grokbot_agreement: 200, human_v: 30, evr_perturb: 100 };

type Args = Record<string, unknown>;
/** The calls a queued job will reserve. 0 for a rubric that makes no model call. */
export function reservationFor(kind: string, args: Args): number {
  const id = String(args.rubric_id ?? "");
  if (!isLlmRubric(id)) return 0;
  if (kind === "rubric_run") return Array.isArray(args.unit_keys) ? args.unit_keys.length : Number(args.limit) || 200;
  if (kind === "rubric_bench") return BENCH_CALL_ESTIMATE[String(args.set ?? "gold")] ?? 100;
  return 0;
}

/** Calls counted against today (IST) before a new job: finished runs, unfinished runs' reservations, and queued jobs' reservations. */
export async function dayUsage(): Promise<{ used: number; queued: number }> {
  const ids = [...LLM_WIRED];
  const u = (await sql`
    SELECT coalesce(sum(CASE WHEN finished_at IS NULL THEN units_planned ELSE units_ok + units_failed END), 0)::int AS n FROM rubric_run
     WHERE rubric_id = ANY(${ids}::text[]) AND (started_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
  `) as Array<{ n: number }>;
  const q = (await sql`
    SELECT kind, args FROM scribe_job WHERE kind IN ('rubric_run', 'rubric_bench') AND status = 'queued'
  `) as Array<{ kind: string; args: Args | string }>;
  const queued = q.reduce((s, r) => s + reservationFor(r.kind, typeof r.args === "string" ? (JSON.parse(r.args) as Args) : r.args), 0);
  return { used: Number(u[0]?.n ?? 0), queued };
}

/** At submit: throws the closed refusal text (the tool turns it into an error code) when this job would break either ceiling. */
export async function capRefusal(kind: string, args: Args, env: Env = process.env): Promise<string | null> {
  const planned = reservationFor(kind, args);
  if (planned === 0) return null;
  const jc = jobCallCap(env), dc = dailyCallCap(env);
  if (planned > jc) return `llm_job_cap: job needs ${planned} calls, per-job cap ${jc}`;
  const { used, queued } = await dayUsage();
  if (used + queued + planned > dc) return `llm_daily_cap: today ${used} used + ${queued} queued + ${planned} planned > daily cap ${dc}`;
  return null;
}

/** For a RUNNING job: how many more calls it may make now. Excludes its own reservation (its unfinished run row) and adds what it has made. <= 0 = stop. */
export async function callsLeft(ownPlanned: number, madeByJob: number, env: Env = process.env): Promise<number> {
  const { used, queued } = await dayUsage();
  const others = Math.max(0, used - ownPlanned) + queued;
  return Math.min(jobCallCap(env) - madeByJob, dailyCallCap(env) - (others + madeByJob));
}
