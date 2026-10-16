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
import { RUBRICS, unitsOf } from "./registry";
import { isBlindRoomDay } from "./blind-room-days";
import { RUBRIC_RUN_KIND } from "@/lib/jobs/kinds/rubric-run";
import { findOpenJob } from "@/lib/jobs/store";
import { JobArgsError, submitJob } from "@/lib/jobs/submit";
import { labStore } from "@/lib/sarvam-lab";

export const SWEEP_ACTOR = "cron:rubric-sweep";
export const SWEEP_SUMMARY_KEY = "rubric/sweep/1.0.0/last.json"; // fits the lab store's RUBRIC_KEY allowlist (rubric/<id>/<semver>/<name>.json)
export const SWEEP_DEFER_HOURS = 24;
export const SWEEP_MIN_DATE = "2026-09-09";
export const SWEEP_JOB_UNITS = 200;
export const SWEEP_DAILY_UNITS_DEFAULT = 1500;
/** The candidate list is walked in pages of this size (every statement stays bounded to one page), at most SWEEP_MAX_PAGES pages per tick. */
export const SWEEP_PAGE_SIZE = 5000;
export const SWEEP_MAX_PAGES = 4;
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

/** PURE. ALL the consults that pass every rule except FreeScript-by-row and "done": date, not held out, text source. Ordered recent (last 48 h) newest first, then older newest first. */
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
  return out;
}

export type RubricSummary = { id: string; version: string; eligible: number; done: number; deferred: number; no_window: number; multi_window: number; planned: number; submitted_job_id: string | null; skipped_reason: string | null; today_units: number };
export type SweepSummary = { at: string; mode: "dry" | "live"; rubrics: RubricSummary[]; backfill_window: boolean; pages: number; page_capped: boolean };
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

export type WindowRow = { consult_uid: string; consult_key: string; t_open: string | Date; t_close: string | Date };

/**
 * One statement per page: the window rows (eta_encounter_windows) of the page's catalog consult_uids. The rubric_run consult unit is resolved by consult_key
 * ('<encounter_id>@<machine>', readConsultSpan), not by the bare consult_uid, so every later statement and the job's unit_keys use consult_key. A still-open window (no t_close) is not a unit yet.
 */
async function windowsFor(uids: string[]): Promise<WindowRow[]> {
  if (uids.length === 0) return [];
  return dbRead(async () => (await sql`
    SELECT consult_uid, consult_key, t_open, t_close FROM eta_encounter_windows
     WHERE consult_uid = ANY(${uids}::text[]) AND t_close IS NOT NULL
  `) as WindowRow[]);
}

/**
 * PURE. consult_uid -> ONE consult_key. A consult_uid with several rows (one per machine) takes the row with the longest (t_close - t_open); ties go to the lexically smallest
 * consult_key. A uid with no row is absent from the map. Counts: no_window = uids without a row, multi_window = uids with more than one.
 */
export function pickWindowKeys(uids: readonly string[], rows: readonly WindowRow[]): { keys: Map<string, string>; no_window: number; multi_window: number } {
  const by = new Map<string, WindowRow[]>();
  for (const r of rows) { const l = by.get(r.consult_uid); if (l) l.push(r); else by.set(r.consult_uid, [r]); }
  const span = (r: WindowRow): number => Date.parse(String(r.t_close)) - Date.parse(String(r.t_open));
  const keys = new Map<string, string>();
  let noWindow = 0, multi = 0;
  for (const u of uids) {
    const l = by.get(u);
    if (!l || l.length === 0) { noWindow += 1; continue; }
    if (l.length > 1) multi += 1;
    const best = l.reduce((a, b) => { const d = (Number.isFinite(span(b)) ? span(b) : -Infinity) - (Number.isFinite(span(a)) ? span(a) : -Infinity); return d > 0 || (d === 0 && b.consult_key < a.consult_key) ? b : a; });
    keys.set(u, best.consult_key);
  }
  return { keys, no_window: noWindow, multi_window: multi };
}

/** One statement per rubric: which of the CONSULT KEYS already have a PRODUCTION result (lab = false) for this rubric AND version, any status. */
async function doneKeys(rubricId: string, version: string, uids: string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  const rows = await dbRead(async () => (await sql`
    SELECT unit_key FROM rubric_result WHERE rubric_id = ${rubricId}::text AND version = ${version}::text AND lab = false AND unit_key = ANY(${uids}::text[])
  `) as Array<{ unit_key: string }>);
  return new Set(rows.map((r) => r.unit_key));
}

/**
 * One statement per rubric: the keys (among the page) that were in the unit_keys of a FINISHED (done or failed) rubric_run job the sweep submitted for this rubric in the last
 * 24 h. A key still without a row after that is DEFERRED for 24 h from the job's finished_at, so a unit a run cannot write never starves the units behind it.
 */
async function recentlyRun(rubricId: string, uids: string[]): Promise<Set<string>> {
  if (uids.length === 0) return new Set();
  const rows = await dbRead(async () => (await sql`
    SELECT DISTINCT k.key AS unit_key
      FROM scribe_job j, jsonb_array_elements_text(CASE WHEN jsonb_typeof(j.args->'unit_keys') = 'array' THEN j.args->'unit_keys' ELSE '[]'::jsonb END) AS k(key)
     WHERE j.kind = 'rubric_run' AND j.actor = ${SWEEP_ACTOR}::text AND j.args->>'rubric_id' = ${rubricId}::text
       AND j.status IN ('done', 'failed') AND j.finished_at > now() - make_interval(hours => ${SWEEP_DEFER_HOURS}::int)
       AND k.key = ANY(${uids}::text[])
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

export async function runRubricSweep(mode: "dry" | "live", opts: { now?: number; origin?: string; env?: Record<string, string | undefined>; pageSize?: number } = {}): Promise<SweepOutcome> {
  const nowMs = opts.now ?? Date.now();
  const rubrics = RUBRICS.filter((r) => r.status === "production" && unitsOf(r).includes("consult"));
  if (rubrics.length === 0) return { skipped: "no_production_rubric" };
  const backfill = inBackfillWindow(nowMs);
  const cap = dailyUnitsCap(opts.env ?? process.env);

  // ---- every read, before any submit ----
  const catalog = await loadCatalog(nowMs);
  if (!catalog) throw new SweepReadError("catalog_unavailable");
  const cands = candidatesOf(catalog.rows.values(), nowMs, backfill);
  const pageSize = opts.pageSize ?? SWEEP_PAGE_SIZE;

  // per rubric: what is needed this tick (nothing when a job is open or the day's units are used) and what has been counted so far
  type Walk = { r: (typeof rubrics)[number]; need: number; keys: string[]; done: number; deferred: number; noWindow: number; multi: number; todo: number; today: number; reason: string | null };
  const walks: Walk[] = [];
  for (const r of rubrics) {
    const today = await todayUnits(r.id, r.version);
    const open = await dbRead(() => findOpenJob(RUBRIC_RUN_KIND, [["rubric_id", r.id]]));
    const remaining = Math.max(0, cap - today);
    walks.push({ r, need: open || remaining === 0 ? 0 : Math.min(SWEEP_JOB_UNITS, remaining), keys: [], done: 0, deferred: 0, noWindow: 0, multi: 0, todo: 0, today, reason: open ? "job_open" : remaining === 0 ? "daily_units_cap" : null });
  }

  // walk the sorted candidates in pages; every statement is bounded to one page; stop when every rubric that needs keys has its job's worth, the list ends, or SWEEP_MAX_PAGES pages are done
  let pages = 0;
  let walked = 0;
  while (walked < cands.length && pages < SWEEP_MAX_PAGES && walks.some((w) => w.need > 0 && w.keys.length < w.need)) {
    const page = cands.slice(walked, walked + pageSize);
    walked += page.length;
    pages += 1;
    const hasFs = await freescriptSettled(page.filter((c) => !c.settledByAge).map((c) => c.uid));
    const uids = page.filter((c) => c.settledByAge || hasFs.has(c.uid)).map((c) => c.uid);
    // catalog consult_uid -> window consult_key, once per page; from here on every key is the consult_key
    const mapped = pickWindowKeys(uids, await windowsFor(uids));
    const unitKeys = uids.map((u) => mapped.keys.get(u)).filter((k): k is string => typeof k === "string");
    for (const w of walks) {
      if (w.need === 0 || w.keys.length >= w.need) continue;
      w.noWindow += mapped.no_window;
      w.multi += mapped.multi_window;
      const done = await doneKeys(w.r.id, w.r.version, unitKeys);
      const ran = await recentlyRun(w.r.id, unitKeys);
      for (const u of unitKeys) {
        if (done.has(u)) w.done += 1;
        else if (ran.has(u)) w.deferred += 1;
        else { w.todo += 1; if (w.keys.length < w.need) w.keys.push(u); }
      }
    }
  }
  const pageCapped = pages >= SWEEP_MAX_PAGES && walked < cands.length && walks.some((w) => w.need > 0 && w.keys.length < w.need);

  const plans: Plan[] = walks.map((w) => ({
    keys: w.keys,
    summary: { id: w.r.id, version: w.r.version, eligible: cands.length, done: w.done, deferred: w.deferred, no_window: w.noWindow, multi_window: w.multi, planned: w.keys.length, submitted_job_id: null, skipped_reason: w.reason ?? (w.todo === 0 ? "nothing_to_do" : null), today_units: w.today },
  }));

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

  const summary: SweepSummary = { at: new Date(nowMs).toISOString(), mode, rubrics: plans.map((p) => p.summary), backfill_window: backfill, pages, page_capped: pageCapped };
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

