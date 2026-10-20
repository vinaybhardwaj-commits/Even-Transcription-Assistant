/**
 * lib/spine/pipeline-view.ts — Spine S4: a never-throwing, time-bounded, counts-only read of one IST day's spine pipeline, per room, for Rooms Live.
 * Display only: SELECTs on spine_* tables, no write, no flag. Per room: signals by proxy, encounters by status (ambiguous counted, never hidden: R1),
 * per stage done/queued/failed/dead (empty until S5 writes jobs), and the age in seconds of the oldest queued job.
 * Modelled on lib/jev/worker/coverage-view.ts: any throw or timeout gives null and ONE log line carrying a closed class (timeout|error), never the error's text;
 * concurrent callers for one date share one read; a success is reused for 10 s; a failure is never memoised; the result is rebuilt key by key (nothing extra reaches a route body).
 */
export const PIPELINE_VIEW_TIMEOUT_MS = 4000;
export const PIPELINE_MEMO_MS = 10_000;

export type StageCounts = { done: number; queued: number; failed: number; dead: number };
/** Status counts plus one count per merge flag (spine_encounter.flags, S0 R3). */
export interface EncounterCounts { candidate: number; confirmed: number; rejected: number; merged: number; ambiguous: number; multi_machine: number; pulse_overlap: number; clamped: number; clamp_failed: number; covered_by_pulse: number }
export interface RoomPipeline {
  signals: Record<string, number>;
  encounters: EncounterCounts;
  stages: Record<string, StageCounts>;
  oldest_queued_age_s: number | null;
}
export interface PipelineView {
  ist_date: string;
  rooms: Record<string, RoomPipeline>;
}

export interface SignalRow { room_id: string | null; proxy: string; n: unknown }
export interface EncounterRow { room_id: string | null; status: string; n: unknown; ambiguous: unknown; multi_machine?: unknown; pulse_overlap?: unknown; clamped?: unknown; clamp_failed?: unknown; covered_by_pulse?: unknown }
export interface JobRow { room_id: string | null; stage: string; status: string; n: unknown; oldest_queued: unknown }
export interface PipelineRows { signals: SignalRow[]; encounters: EncounterRow[]; jobs: JobRow[] }
export type PipelineDb = (text: string, params: unknown[]) => Promise<unknown[]>;

const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
};
const NO_ROOM = "_none";
const ENC_STATUS = ["candidate", "confirmed", "rejected", "merged"] as const;
const FLAGS = ["ambiguous", "multi_machine", "pulse_overlap", "clamped", "clamp_failed", "covered_by_pulse"] as const;
const JOB_BUCKET: Record<string, keyof StageCounts> = { done: "done", queued: "queued", leased: "queued", failed: "failed", dead: "dead" };

export const SIGNALS_SQL = `SELECT room_id, proxy, count(*)::int AS n FROM spine_signal WHERE (t_open AT TIME ZONE 'Asia/Kolkata')::date = $1::date GROUP BY room_id, proxy`;
export const ENCOUNTERS_SQL = `SELECT room_id, status, count(*)::int AS n, count(*) FILTER (WHERE flags @> ARRAY['ambiguous'])::int AS ambiguous, count(*) FILTER (WHERE flags @> ARRAY['multi_machine'])::int AS multi_machine, count(*) FILTER (WHERE flags @> ARRAY['pulse_overlap'])::int AS pulse_overlap, count(*) FILTER (WHERE flags @> ARRAY['clamped'])::int AS clamped, count(*) FILTER (WHERE flags @> ARRAY['clamp_failed'])::int AS clamp_failed, count(*) FILTER (WHERE flags @> ARRAY['covered_by_pulse'])::int AS covered_by_pulse FROM spine_encounter WHERE ist_date = $1::date GROUP BY room_id, status`;
export const JOBS_SQL = `SELECT e.room_id, j.stage, j.status, count(*)::int AS n, min(j.created_at) FILTER (WHERE j.status IN ('queued','leased')) AS oldest_queued FROM spine_job j JOIN spine_encounter e ON e.encounter_id = j.encounter_id WHERE e.ist_date = $1::date GROUP BY e.room_id, j.stage, j.status`;

const emptyEncounters = (): EncounterCounts => ({ candidate: 0, confirmed: 0, rejected: 0, merged: 0, ambiguous: 0, multi_machine: 0, pulse_overlap: 0, clamped: 0, clamp_failed: 0, covered_by_pulse: 0 });
const empty = (): RoomPipeline => ({ signals: {}, encounters: emptyEncounters(), stages: {}, oldest_queued_age_s: null });

/** Pure: rows in, view out. `now` is passed in; nothing here reads a clock. Only counts and closed-vocabulary keys leave. */
export function shapePipeline(istDate: string, rows: PipelineRows, now: Date): PipelineView {
  const rooms: Record<string, RoomPipeline> = {};
  const room = (id: string | null): RoomPipeline => (rooms[id ?? NO_ROOM] ??= empty());
  for (const r of rows.signals) {
    const p = room(r.room_id);
    p.signals[String(r.proxy)] = (p.signals[String(r.proxy)] ?? 0) + num(r.n);
  }
  for (const r of rows.encounters) {
    const p = room(r.room_id);
    if ((ENC_STATUS as readonly string[]).includes(r.status)) p.encounters[r.status as (typeof ENC_STATUS)[number]] += num(r.n);
    for (const f of FLAGS) p.encounters[f] += num(r[f]);
  }
  for (const r of rows.jobs) {
    const bucket = JOB_BUCKET[r.status];
    if (!bucket) continue; // superseded and shadow jobs are not pipeline work
    const p = room(r.room_id);
    const s = (p.stages[String(r.stage)] ??= { done: 0, queued: 0, failed: 0, dead: 0 });
    s[bucket] += num(r.n);
    const t = r.oldest_queued ? Date.parse(String(r.oldest_queued)) : NaN;
    if (bucket === "queued" && Number.isFinite(t)) {
      const age = Math.max(0, Math.round((now.getTime() - t) / 1000));
      p.oldest_queued_age_s = p.oldest_queued_age_s === null ? age : Math.max(p.oldest_queued_age_s, age);
    }
  }
  return { ist_date: istDate, rooms };
}

async function defaultDb(): Promise<PipelineDb> {
  const { sql } = await import("@/lib/db");
  return (text, params) => (sql as unknown as PipelineDb)(text, params);
}

export async function readPipeline(istDate: string, now: Date, db?: PipelineDb): Promise<PipelineView> {
  const q = db ?? (await defaultDb());
  const [signals, encounters, jobs] = await Promise.all([q(SIGNALS_SQL, [istDate]), q(ENCOUNTERS_SQL, [istDate]), q(JOBS_SQL, [istDate])]);
  return shapePipeline(istDate, { signals: signals as SignalRow[], encounters: encounters as EncounterRow[], jobs: jobs as JobRow[] }, now);
}

/** Rebuild key by key so nothing extra from a read reaches a route body. */
function project(v: PipelineView): PipelineView {
  const rooms: Record<string, RoomPipeline> = {};
  for (const [id, r] of Object.entries(v.rooms ?? {})) {
    const signals: Record<string, number> = {};
    for (const [k, n] of Object.entries(r.signals ?? {})) signals[k] = num(n);
    const stages: Record<string, StageCounts> = {};
    for (const [k, s] of Object.entries(r.stages ?? {})) stages[k] = { done: num(s.done), queued: num(s.queued), failed: num(s.failed), dead: num(s.dead) };
    const e = (r.encounters ?? {}) as Partial<Record<keyof EncounterCounts, unknown>>;
    rooms[id] = {
      signals,
      encounters: Object.fromEntries(Object.keys(emptyEncounters()).map((k) => [k, num(e[k as keyof EncounterCounts])])) as unknown as EncounterCounts,
      stages,
      oldest_queued_age_s: r.oldest_queued_age_s === null || r.oldest_queued_age_s === undefined ? null : num(r.oldest_queued_age_s),
    };
  }
  return { ist_date: String(v.ist_date), rooms };
}

const memo = new Map<string, { at: number; value: PipelineView }>();
const inflight = new Map<string, { p: Promise<PipelineView>; at: number }>();

/** Test-only: forget every memo and in-flight read. */
export function __resetPipelineMemoForTests(): void {
  memo.clear();
  inflight.clear();
}

export async function pipelineOrNull(istDate: string, opts: { timeoutMs?: number; read?: (istDate: string) => Promise<PipelineView> } = {}): Promise<PipelineView | null> {
  const read = opts.read ?? ((d: string) => readPipeline(d, new Date()));
  const timeoutMs = opts.timeoutMs ?? PIPELINE_VIEW_TIMEOUT_MS;
  const m = memo.get(istDate);
  if (m && Date.now() - m.at < PIPELINE_MEMO_MS) return m.value;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let cur = inflight.get(istDate);
    if (!cur || Date.now() - cur.at >= PIPELINE_MEMO_MS) {
      const p: Promise<PipelineView> = Promise.resolve()
        .then(() => read(istDate))
        .then((v) => {
          const value = project(v);
          memo.set(istDate, { at: Date.now(), value });
          return value;
        })
        .finally(() => {
          if (inflight.get(istDate)?.p === p) inflight.delete(istDate);
        });
      p.catch(() => { /* intentional: every caller logs its own failure; this only stops an unhandled rejection after all callers timed out */ });
      cur = { p, at: Date.now() };
      inflight.set(istDate, cur);
    }
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("pipeline_timeout")), timeoutMs);
    });
    return await Promise.race([cur.p, timeout]);
  } catch (e) {
    console.error(`[spine-pipeline] read failed ${e instanceof Error && e.message === "pipeline_timeout" ? "timeout" : "error"}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
