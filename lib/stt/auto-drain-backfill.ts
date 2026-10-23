/**
 * lib/stt/auto-drain-backfill.ts — the paced one-off backfill for the auto-drain (V order, 23 Oct 2026).
 *
 * The live auto-drain only offers windows closed within AUTO_DRAIN_MAX_AGE_HOURS (6, max 48), so a backlog
 * older than that is never reached. This module decides WHEN a backfill tick may run and WHICH extra windows
 * it may offer. It offers only: every guard `drainRoomWindow` applies (actor, Transcript switch, blind
 * room-days, length, join config, O4 — room audio never goes to Sarvam) stays in force, and nothing here
 * writes. It adds no column and no table.
 *
 * SHIPS OFF. `AUTO_DRAIN_BACKFILL_SINCE` unset, empty or not a real IST date means off: a clean no-op, no
 * query, no fetch. A malformed value is off too (and says so in the tick's report), never a guess.
 *
 * NO CLOCK GATE (V, 23 Oct): there is no time-of-day window. ACTIVE ONLY WHEN all of:
 *   (a) AUTO_DRAIN_BACKFILL_SINCE is a real IST date;
 *   (b) the live set offered nothing this tick (live draining always has priority);
 *   (c) the Mini load guard passes: router /healthz answers `ok`, fewer than `limit` room_window jobs are
 *       already queued or running, and the recent finished room_window jobs show neither too many failures
 *       nor too slow a run. The guard never blocks LIVE draining; it is consulted only here.
 *
 * The per-tick cap is AUTO_DRAIN_BACKFILL_LIMIT (default 2, clamped 1-5).
 * Pure functions take no clock; the I/O (healthz, guard SQL, candidate SQL) is in this file but the caller
 * passes `sql` and `fetchImpl` so tests can drive it.
 */
import { sql as defaultSql } from "@/lib/db";
import { ROOM_WINDOW_KIND } from "@/lib/jobs/kinds/room-window-kind";
const IST_OFFSET_MS = 5.5 * 3_600_000;
import { poolEndpoints } from "@/lib/service-pool";
import { ROUTER_DEFAULT_URL } from "@/lib/stt/eta-router";
import { withServiceAccess } from "@/lib/service-access";

export const BACKFILL_SINCE_ENV = "AUTO_DRAIN_BACKFILL_SINCE";
export const BACKFILL_LIMIT_ENV = "AUTO_DRAIN_BACKFILL_LIMIT";

type Env = Record<string, string | undefined>;

/** Same rule as auto-drain's clampedIntEnv (not imported: auto-drain imports this file). */
function clampedIntEnv(name: string, def: number, min: number, max: number, env: Env): number {
  const raw = (env[name] ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return def;
  return Math.max(min, Math.min(max, Number(raw)));
}

/** healthz must answer inside this; a router too busy to say `ok` in 4 s is too busy to be handed backlog. */
export const BACKFILL_HEALTHZ_TIMEOUT_MS = 4_000;
/** The guard looks at the last 10 finished room_window jobs, no older than 12 h (a stale bad hour must not block for ever). */
export const BACKFILL_GUARD_SAMPLE = 10;
export const BACKFILL_GUARD_WINDOW_HOURS = 12;
/** Fewer than 5 finished jobs is too thin to judge a rate; the healthz and in-flight checks still apply. */
export const BACKFILL_GUARD_MIN_SAMPLE = 5;
/** More than 30% of the sample failed (3 of 10 is already a pattern; one in ten is noise). */
export const BACKFILL_GUARD_MAX_FAIL_RATE = 0.3;
/**
 * Average started->finished of the sample, seconds. A window is 900 s of audio and the longest router run
 * measured was 613 s; a job averaging over 1800 s (2x the audio) means the Mini is behind on live work or
 * contended, and more backlog would make it worse. A constant to tune from the first measured RTF data.
 */
export const BACKFILL_GUARD_MAX_AVG_JOB_S = 1800;
/** Backlog windows are served from rooms' history, so "last served" looks back this far (the live look-back is the max age). */
export const BACKFILL_SERVED_HORIZON_HOURS = 24;

export function backfillLimit(env: Env = process.env): number {
  return clampedIntEnv(BACKFILL_LIMIT_ENV, 2, 1, 5, env);
}

/** PURE — the IST date `YYYY-MM-DD` as the epoch ms of its IST midnight, or null when unset or not a real date. */
export function parseBackfillSince(raw: string | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d) return null;
  return utc.getTime() - IST_OFFSET_MS;
}

export type BackfillPlan =
  | { on: false; reason: "unset" | "bad_since" }
  | { on: true; sinceMs: number; limit: number };

/** PURE — is a backfill tick allowed to look at the backlog at all (before the live set and the load guard)? */
export function backfillPlan(env: Env = process.env): BackfillPlan {
  const raw = (env[BACKFILL_SINCE_ENV] ?? "").trim();
  if (raw === "") return { on: false, reason: "unset" };
  const sinceMs = parseBackfillSince(raw);
  if (sinceMs === null) return { on: false, reason: "bad_since" };
  return { on: true, sinceMs, limit: backfillLimit(env) };
}

export type GuardStats = { n: number; failed: number; avg_job_s: number | null; in_flight: number };

/** PURE — the guard's verdict on the recent-jobs stats; null means pass. */
export function guardVerdict(s: GuardStats, limit: number): string | null {
  if (s.in_flight >= limit) return "in_flight_at_limit";
  if (s.n >= BACKFILL_GUARD_MIN_SAMPLE) {
    if (s.failed / s.n > BACKFILL_GUARD_MAX_FAIL_RATE) return "recent_failure_rate";
    if (s.avg_job_s !== null && s.avg_job_s > BACKFILL_GUARD_MAX_AVG_JOB_S) return "recent_latency";
  }
  return null;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * GET <router base>/healthz on the bulk pool's endpoints (backfill windows are bulk work), same base URL
 * resolution and same service-access headers as the router client. Healthy when ANY endpoint answers a parsed
 * `ok: true` — branched on the body, never the status. Never throws.
 */
export async function routerHealthy(fetchImpl: Fetcher = (u, i) => fetch(u, i), env: Env = process.env): Promise<boolean> {
  const bases = poolEndpoints("router", { bulk: true, fallback: ROUTER_DEFAULT_URL }, env);
  for (const base of bases) {
    try {
      const url = `${base.replace(/\/+$/, "")}/healthz`;
      const res = await fetchImpl(url, withServiceAccess(url, { signal: AbortSignal.timeout(BACKFILL_HEALTHZ_TIMEOUT_MS), cache: "no-store" }, env));
      const body: unknown = await res.json().catch(() => null);
      if (body && typeof body === "object" && (body as { ok?: unknown }).ok === true) return true;
    } catch { /* next endpoint */ }
  }
  return false;
}

type SqlFn = (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;

/** The guard's inputs from scribe_job: in-flight count, and the recent finished sample. Read-only. */
export async function readGuardStats(sql: SqlFn = defaultSql as unknown as SqlFn): Promise<GuardStats> {
  const rows = (await sql`
    WITH recent AS (
      SELECT status, EXTRACT(EPOCH FROM (finished_at - started_at)) AS job_s
        FROM scribe_job
       WHERE kind = ${ROOM_WINDOW_KIND}
         AND status IN ('done', 'failed')
         AND finished_at >= NOW() - (${BACKFILL_GUARD_WINDOW_HOURS}::int * INTERVAL '1 hour')
       ORDER BY finished_at DESC
       LIMIT ${BACKFILL_GUARD_SAMPLE}::int
    )
    SELECT (SELECT COUNT(*) FROM recent)::int AS n,
           (SELECT COUNT(*) FROM recent WHERE status = 'failed')::int AS failed,
           (SELECT AVG(job_s) FROM recent WHERE job_s IS NOT NULL)::float8 AS avg_job_s,
           (SELECT COUNT(*) FROM scribe_job WHERE kind = ${ROOM_WINDOW_KIND} AND status IN ('queued', 'running'))::int AS in_flight
  `) as Array<Record<string, unknown>>;
  const r = rows[0] ?? {};
  return {
    n: Number(r.n ?? 0), failed: Number(r.failed ?? 0),
    avg_job_s: r.avg_job_s === null || r.avg_job_s === undefined ? null : Number(r.avg_job_s),
    in_flight: Number(r.in_flight ?? 0),
  };
}

/** Why a backfill tick did not offer, or null when it may. Order: cheap SQL first, then the network probe. */
export async function backfillGuard(
  limit: number,
  deps: { sql?: SqlFn; fetchImpl?: Fetcher; env?: Env } = {},
): Promise<string | null> {
  const verdict = guardVerdict(await readGuardStats(deps.sql), limit);
  if (verdict) return verdict;
  return (await routerHealthy(deps.fetchImpl, deps.env)) ? null : "router_unhealthy";
}

/**
 * The backlog candidates: closed between SINCE and now - maxAge, Transcript-on rooms, grid-aligned with a
 * room_day, not refused within the cooldown, NO room_window job in any state yet. Same row shape as the live
 * scan, so orderAutoDrainOffers ranks them. `last_served_ms` looks back BACKFILL_SERVED_HORIZON_HOURS.
 * Read-only.
 */
export async function scanBackfillCandidates(
  sql: SqlFn,
  o: { sinceMs: number; maxAgeHours: number; cooldownMinutes: number },
): Promise<Array<Record<string, unknown>>> {
  return (await sql`
    WITH offered AS (
      SELECT ss.room_id, j.created_at AS offered_at
        FROM scribe_job j
        JOIN bench_window sw ON sw.id = j.args->>'window_id'
        JOIN bench_session ss ON ss.id = sw.session_id
       WHERE j.kind = ${ROOM_WINDOW_KIND}
         AND j.status IN ('queued', 'running', 'done', 'failed', 'cancelled')
         AND j.created_at >= NOW() - (${BACKFILL_SERVED_HORIZON_HOURS}::int * INTERVAL '1 hour')
      UNION ALL
      SELECT rs.room_id, rw.auto_drain_refused_at AS offered_at
        FROM bench_window rw
        JOIN bench_session rs ON rs.id = rw.session_id
       WHERE rw.auto_drain_refused_at >= NOW() - (${BACKFILL_SERVED_HORIZON_HOURS}::int * INTERVAL '1 hour')
    ),
    served AS (
      SELECT room_id, MAX(offered_at) AS last_served_at FROM offered GROUP BY room_id
    )
    SELECT w.id, s.room_id, w.start_ms, w.end_ms,
           (EXTRACT(EPOCH FROM w.closed_at) * 1000)::float8 AS closed_ms,
           (EXTRACT(EPOCH FROM served.last_served_at) * 1000)::float8 AS last_served_ms
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
      LEFT JOIN served ON served.room_id = s.room_id
     WHERE w.state = 'closed'
       AND w.grid_aligned = TRUE
       AND w.room_day_id IS NOT NULL
       AND w.closed_at >= to_timestamp(${o.sinceMs}::float8 / 1000.0)
       AND w.closed_at < NOW() - (${o.maxAgeHours}::int * INTERVAL '1 hour')
       AND (w.auto_drain_refused_at IS NULL
            OR w.auto_drain_refused_at < NOW() - (${o.cooldownMinutes}::int * INTERVAL '1 minute'))
       AND NOT EXISTS (
         SELECT 1 FROM scribe_job j
          WHERE j.kind = ${ROOM_WINDOW_KIND}
            AND j.args->>'window_id' = w.id
       )
  `) as Array<Record<string, unknown>>;
}
