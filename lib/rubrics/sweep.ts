/**
 * lib/rubrics/sweep.ts — the per-consult rubric runner's planner (RUBRIC-SWEEP, 16 Oct 2026). Every tick it finds the consults that have no result yet for each PRODUCTION consult
 * rubric and submits at most ONE capped `rubric_run` job per rubric. It reads the registry, the R2 consult catalog and a handful of bounded SQL statements (one per rubric per
 * question, never one per consult), and writes ONE summary object to R2. It never sets env. Counts and ids only: no consult key, text or name leaves it (the summary has none).
 *
 *   mode  off | dry | live  (RUBRIC_SWEEP_MODE; the route reads it). dry does every read and count and submits nothing.
 *   A read failure (database or R2) ends the tick before ANY submit (SweepReadError); a failing submit is that rubric's skipped_reason and does not stop the others.
 */
import { sql } from "@/lib/db";
import { loadCatalog, type Row } from "@/lib/room-access/readers/catalog-consult";
import { RUBRICS } from "./registry";
import { isBlindRoomDay } from "./blind-room-days";
import { RUBRIC_RUN_KIND } from "@/lib/jobs/kinds/rubric-run";
import { findOpenJob } from "@/lib/jobs/store";
import { JobArgsError, submitJob } from "@/lib/jobs/submit";
import { labStore } from "@/lib/sarvam-lab";

export const SWEEP_ACTOR = "cron:rubric-sweep";
export const SWEEP_SUMMARY_KEY = "rubric/sweep/last.json";
export const SWEEP_MIN_DATE = "2026-09-09";
export const SWEEP_JOB_UNITS = 200;
export const SWEEP_DAILY_UNITS_DEFAULT = 1500;
/** The most candidates one tick looks at (newest first), so the "done" statement stays bounded. Beyond it the oldest wait for newer ones to finish. */
export const SWEEP_CANDIDATE_CAP = 5000;
const H48_MS = 48 * 3_600_000;
const H24_MS = 24 * 3_600_000;
const IST_MS = 19_800_000;

export type SweepMode = "off" | "dry" | "live";
export class SweepModeError extends Error {}
export class SweepReadError extends Error {
  constructor(public code: string) { super(code); }
}

/** PURE. Missing, blank or "off" = off; an unknown value throws (a typo is not "off"). */
export function sweepMode(raw: string | undefined): SweepMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "off") return "off";
  if (v === "dry" || v === "live") return v;
  throw new SweepModeError("RUBRIC_SWEEP_MODE has an unrecognised value");
}

/** PURE. The IST hour of an instant. */
export const istHour = (nowMs: number): number => new Date(nowMs + IST_MS).getUTCHours();
/** PURE. The backfill window is [22:00, 07:00) IST: 22:00:00 is in, 07:00:00 is out. */
export const inBackfillWindow = (nowMs: number): boolean => { const h = istHour(nowMs); return h >= 22 || h < 7; };

const asRec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const numOf = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const keyOf = (l: unknown): string => { const r = asRec(l); return r && typeof r.r2_key === "string" ? r.r2_key : ""; };

/** PURE. Does the catalog row say a transcript source exists: a translate track, or an stt track the row itself marks English (no R2 read). */
export function hasTextSource(row: Row): boolean {
  const layers = asRec(row.layers);
  if (!layers) return false;
  if (keyOf(layers.translate) !== "") return true;
  const stt = asRec(layers.stt);
  const lang = stt ? (stt.lang ?? stt.language) : null;
  return keyOf(stt) !== "" && typeof lang === "string" && /^en(\b|[-_])/i.test(lang);
}

export type Candidate = { uid: string; ended: number | null; recent: boolean; settledByAge: boolean };

/** PURE. The consults that pass every rule except FreeScript-by-row and "done": date, not held out, text source. Ordered recent (last 48 h) newest first, then older newest first. */
export function candidatesOf(rows: Iterable<Row>, nowMs: number, backfill: boolean): Candidate[] {
  const out: Candidate[] = [];
  for (const row of rows) {
    const uid = typeof row.consult_uid === "string" ? row.consult_uid : "";
    const day = typeof row.ist_date === "string" ? row.ist_date.slice(0, 10) : "";
    const room = typeof row.room_id === "string" ? row.room_id : null;
    if (!uid || day < SWEEP_MIN_DATE || isBlindRoomDay(day, room) || !hasTextSource(row)) continue;
    const ended = numOf(row.t_close) ?? numOf(row.t_open);
    const closed = numOf(row.t_close);
    const recent = ended !== null && nowMs - ended <= H48_MS;
    if (!recent && !backfill) continue;
    out.push({ uid, ended, recent, settledByAge: closed !== null && nowMs - closed > H24_MS });
  }
  out.sort((a, b) => (a.recent === b.recent ? 0 : a.recent ? -1 : 1) || (b.ended ?? Number.NEGATIVE_INFINITY) - (a.ended ?? Number.NEGATIVE_INFINITY) || (a.uid < b.uid ? -1 : 1));
  return out.slice(0, SWEEP_CANDIDATE_CAP);
}

export type RubricSummary = { id: string; version: string; eligible: number; done: number; planned: number; submitted_job_id: string | null; skipped_reason: string | null; today_units: number };
export type SweepSummary = { at: string; mode: "dry" | "live"; rubrics: RubricSummary[]; backfill_window: boolean };
export type SweepOutcome = { skipped: "no_production_rubric" } | { summary: SweepSummary; summary_written: boolean };

export const dailyUnitsCap = (env: Record<string, string | undefined> = process.env): number => {
  const n = Number(env.RUBRIC_SWEEP_DAILY_UNITS);
  return Number.isInteger(n) && n > 0 ? n : SWEEP_DAILY_UNITS_DEFAULT;
};

const dbRead = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch { throw new SweepReadError("db_read_failed"); }
};

/** One statement: which of the keys already have a FreeScript row (any status). */
async function freescriptSettled(uids: string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  const rows = await dbRead(async () => (await sql`
    SELECT consult_uid FROM freescript_latest WHERE consult_uid = ANY(${uids}::text[])
  `) as Array<{ consult_uid: string }>);
  return new Set(rows.map((r) => r.consult_uid));
}

/** One statement per rubric: which of the keys already have a result for this rubric AND version, any status. */
async function doneKeys(rubricId: string, version: string, uids: string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  const rows = await dbRead(async () => (await sql`
    SELECT unit_key FROM rubric_result WHERE rubric_id = ${rubricId}::text AND version = ${version}::text AND unit_key = ANY(${uids}::text[])
  `) as Array<{ unit_key: string }>);
  return new Set(rows.map((r) => r.unit_key));
}

/** One statement per rubric: the rows written today (IST) by runs the sweep itself submitted. */
async function todayUnits(rubricId: string, version: string): Promise<number> {
  const rows = await dbRead(async () => (await sql`
    SELECT count(*)::int AS n
      FROM rubric_result r JOIN rubric_run u ON u.run_id = r.run_id
     WHERE r.rubric_id = ${rubricId}::text AND r.version = ${version}::text AND u.actor = ${SWEEP_ACTOR}::text
       AND (r.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
  `) as Array<{ n: number }>);
  return Number(rows[0]?.n ?? 0);
}

type Plan = { summary: RubricSummary; keys: string[] };

/** The first closed word of a refusal reason (never the reason's numbers or values). */
const reasonCode = (e: JobArgsError): string => /^([a-z_]+)/.exec(e.reason)?.[1] ?? "refused";

export async function runRubricSweep(mode: "dry" | "live", opts: { now?: number; origin?: string; env?: Record<string, string | undefined> } = {}): Promise<SweepOutcome> {
  const nowMs = opts.now ?? Date.now();
  const rubrics = RUBRICS.filter((r) => r.status === "production" && r.unit === "consult");
  if (rubrics.length === 0) return { skipped: "no_production_rubric" };
  const backfill = inBackfillWindow(nowMs);
  const cap = dailyUnitsCap(opts.env ?? process.env);

  // ---- every read, before any submit ----
  const catalog = await loadCatalog(nowMs);
  if (!catalog) throw new SweepReadError("catalog_unavailable");
  const cands = candidatesOf(catalog.rows.values(), nowMs, backfill);
  const needFs = cands.filter((c) => !c.settledByAge).map((c) => c.uid);
  const hasFs = await freescriptSettled(needFs);
  const eligible = cands.filter((c) => c.settledByAge || hasFs.has(c.uid));
  const uids = eligible.map((c) => c.uid);

  const plans: Plan[] = [];
  for (const r of rubrics) {
    const done = await doneKeys(r.id, r.version, uids);
    const today = await todayUnits(r.id, r.version);
    const open = await dbRead(() => findOpenJob(RUBRIC_RUN_KIND, [["rubric_id", r.id]]));
    const remaining = Math.max(0, cap - today);
    const todo = uids.filter((u) => !done.has(u));
    const keys = open || remaining === 0 ? [] : todo.slice(0, Math.min(SWEEP_JOB_UNITS, remaining));
    const reason = open ? "job_open" : remaining === 0 ? "daily_units_cap" : todo.length === 0 ? "nothing_to_do" : null;
    plans.push({ keys, summary: { id: r.id, version: r.version, eligible: uids.length, done: uids.length - todo.length, planned: keys.length, submitted_job_id: null, skipped_reason: reason, today_units: today } });
  }

  // ---- submit phase (live only); one rubric failing never stops the others ----
  for (const p of plans) {
    if (p.keys.length === 0) continue;
    if (mode === "dry") { p.summary.skipped_reason = "dry_run"; continue; }
    try {
      const job = await submitJob({ kind: RUBRIC_RUN_KIND, args: { rubric_id: p.summary.id, unit: "consult", lab: false, unit_keys: p.keys }, actor: SWEEP_ACTOR, ...(opts.origin ? { origin: opts.origin } : {}), scopes: new Set(["invoke"] as const) });
      p.summary.submitted_job_id = job.id;
    } catch (e) {
      // a cap refusal is a counted outcome, not an error; anything else is that rubric's reason (a closed word, never a value)
      p.summary.skipped_reason = e instanceof JobArgsError ? (/^llm_(job|daily)_cap/.test(e.reason) ? "llm_cap" : `refused:${reasonCode(e)}`) : "submit_failed";
    }
  }

  const summary: SweepSummary = { at: new Date(nowMs).toISOString(), mode, rubrics: plans.map((p) => p.summary), backfill_window: backfill };
  return { summary, summary_written: await writeSummary(summary) };
}

/** Best effort: the tick's result is the route's answer either way. Logs a closed code only. */
async function writeSummary(summary: SweepSummary): Promise<boolean> {
  try {
    const store = labStore();
    if (!store) return false;
    await store.put(SWEEP_SUMMARY_KEY, JSON.stringify(summary), {});
    return true;
  } catch {
    console.warn("[rubric-sweep]", JSON.stringify({ code: "summary_write_failed" }));
    return false;
  }
}

/** The last summary, or null when none was written. Throws on a read failure. */
export async function readSweepSummary(): Promise<SweepSummary | null> {
  const store = labStore();
  if (!store) throw new SweepReadError("lab_store_unavailable");
  const got = await store.get(SWEEP_SUMMARY_KEY);
  if (!got) return null;
  try {
    const v = JSON.parse(got.body) as unknown;
    return asRec(v) ? (v as SweepSummary) : null;
  } catch {
    return null;
  }
}

