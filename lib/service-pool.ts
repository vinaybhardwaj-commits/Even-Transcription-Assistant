/**
 * lib/service-pool.ts — the heavy services as ordered POOLS of endpoints (REDUNDANCY-R1 Phase 4, 24 Sep).
 *
 * WHY. Production reached whisper, the audio join, eta-diarize and eta-emotion through ONE URL each, all
 * of them the Mini behind one Cloudflare tunnel: one Mini, tunnel or power fault stopped everything, and
 * the backlog had to wait for night. Each service now takes a LIST, tried in order.
 *
 *   <svc>_URLS         comma-separated, tried in order (the old single var is honoured when this is unset)
 *   <svc>_BULK_URLS    for bulk work (a room_window job whose window closed more than BULK_AGE_MINUTES ago):
 *                      when set, bulk work uses ONLY this list, so the backlog can never land on the live
 *                      endpoints (the Mini) and hold up clinic audio. POOL_BULK_FALLBACK_LIVE=1 lets bulk
 *                      fall through to the ordinary list after it (default OFF; R3, Fable's ruling).
 *
 * ONE SERVICE, FOUR ROUTES (R2). eta-diarize serves /diarize, /embed_speakers, /speech_regions and /enroll, and a
 * twin need not serve all four (c3 is embed/VAD only). Each route is its own pool with its own breaker:
 * DIARIZE_EMBED_URLS, DIARIZE_VAD_URLS and DIARIZE_ENROLL_URLS (and their _BULK_URLS), each falling back to the
 * DIARIZE_BASE_URLS / DIARIZE_BULK_URLS lists and then to DIARIZE_BASE_URL. A 404 for the route is failover:
 * that endpoint does not serve it.
 *
 * ONE DEADLINE PER POOLED CALL (R1). The whole pool gets the budget ONE call had before (the client's own
 * timeout). The first endpoint gets all of it, exactly as today; a failover gets only what is left, and no
 * endpoint is started with less than POOL_MIN_ENDPOINT_BUDGET_MS. So a pooled call is never longer than the
 * unpooled call was, and a step cannot be killed by maxDuration half-way through a failover, orphaning work
 * on a server. Long work (diarize) also never fails over on its OWN timeout.
 *
 * FAILOVER is the caller's call, not this file's: every client already turns its transport into a result
 * with an error code, and only the client knows which of its codes mean "that endpoint is down" (connect
 * error, timeout, 5xx; for the join, also its single-flight mutex's `join_already_running`). The client
 * hands `runPool` a classifier; this file does the ordering, the deadline, the breaker and the bookkeeping.
 *
 * THE BREAKER is per endpoint, per route and per instance (module state, so per serverless instance): 3
 * consecutive failover-class failures open it for 5 minutes, and an open endpoint is skipped. If EVERY
 * endpoint is open, all are tried anyway, in order. A breaker exists to route around a dead endpoint, never
 * to turn "all endpoints were flaky" into "nothing was even attempted".
 *
 * BAD CONFIG NEVER STOPS THE DRAIN (R4). An unparseable BULK_AGE_MINUTES or POOL_BULK_FALLBACK_LIVE switches
 * that feature OFF, is logged once per value per instance, and is listed by `poolConfigProblems()` for the
 * health tool. It is never a throw inside a job step, where it would fail every room_window job.
 *
 * NO-ENV IDENTITY. With none of the new variables set, the pool for a service is exactly [the old single
 * value, as written — no trim], the call is made once with the client's own timeout, and its result is
 * returned untouched. `served_by` is only reported when a pool variable is set, so a result's shape does not
 * change either. Tests pin this.
 *
 * SERVED_BY is DERIVED: it is the origin (scheme + host, never a path, query or credential) of the endpoint
 * whose answer the caller actually used. It is never a constant.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const POOL_SERVICES = ["whisper", "join", "diarize", "diarize_embed", "diarize_vad", "diarize_enroll", "emotion", "indic", "router"] as const;
export type PoolService = (typeof POOL_SERVICES)[number];

type Env = Record<string, string | undefined>;

/**
 * The env names per service. `single` is the variable production has always read. `inherit` names the
 * service whose lists are used when this one's own are unset (the diarize routes inherit `diarize`).
 */
export const POOL_ENV: Record<PoolService, { single: string; list: string; bulk: string; inherit?: PoolService }> = {
  whisper: { single: "WHISPER_BASE_URL", list: "WHISPER_BASE_URLS", bulk: "WHISPER_BULK_URLS" },
  join: { single: "AUDIO_JOIN_URL", list: "AUDIO_JOIN_URLS", bulk: "AUDIO_JOIN_BULK_URLS" },
  diarize: { single: "DIARIZE_BASE_URL", list: "DIARIZE_BASE_URLS", bulk: "DIARIZE_BULK_URLS" },
  diarize_embed: { single: "DIARIZE_BASE_URL", list: "DIARIZE_EMBED_URLS", bulk: "DIARIZE_EMBED_BULK_URLS", inherit: "diarize" },
  diarize_vad: { single: "DIARIZE_BASE_URL", list: "DIARIZE_VAD_URLS", bulk: "DIARIZE_VAD_BULK_URLS", inherit: "diarize" },
  diarize_enroll: { single: "DIARIZE_BASE_URL", list: "DIARIZE_ENROLL_URLS", bulk: "DIARIZE_ENROLL_BULK_URLS", inherit: "diarize" },
  emotion: { single: "EMOTION_BASE_URL", list: "EMOTION_BASE_URLS", bulk: "EMOTION_BULK_URLS" },
  // STT-STACK-PARITY (Fable, 24 Sep): the other two thirds of the production stack. Until these existed a
  // bulk room window reached the twins for whisper and the MINI for IndicConformer and the router.
  indic: { single: "INDICCONFORMER_BASE_URL", list: "INDICCONFORMER_BASE_URLS", bulk: "INDICCONFORMER_BULK_URLS" },
  router: { single: "ETA_ROUTER_URL", list: "ETA_ROUTER_URLS", bulk: "ETA_ROUTER_BULK_URLS" },
};

export const BULK_AGE_MINUTES_ENV = "BULK_AGE_MINUTES";
export const BULK_FALLBACK_LIVE_ENV = "POOL_BULK_FALLBACK_LIVE";
export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 5 * 60_000;
/** R1 — no endpoint is started with less than this left of the pool's budget. */
export const POOL_MIN_ENDPOINT_BUDGET_MS = 5_000;

function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** A service's own list, else the inherited service's list. */
function listOf(svc: PoolService, which: "list" | "bulk", env: Env): string[] {
  const e = POOL_ENV[svc];
  const own = parseList(env[e[which]]);
  if (own.length > 0 || !e.inherit) return own;
  return parseList(env[POOL_ENV[e.inherit][which]]);
}

/** True when either pool variable is set (non-empty) for this service or the one it inherits — the only case `served_by` is reported. */
export function poolConfigured(svc: PoolService, env: Env = process.env): boolean {
  return listOf(svc, "list", env).length > 0 || listOf(svc, "bulk", env).length > 0;
}

// ── config that must never throw inside a job step (R4) ─────────────────────────────────────────
const warned = new Set<string>();
function warnOnce(name: string, raw: string): void {
  const k = `${name}\u0000${raw}`;
  if (warned.has(k)) return;
  warned.add(k);
  // Length only: an env value is not something to echo.
  console.error("[service-pool] invalid config — feature OFF", JSON.stringify({ name, length: raw.length }));
}

const TRUTHY = ["1", "true", "on", "yes"];
const FALSY = ["", "0", "false", "off", "no"];

function readAge(env: Env): { minutes: number | null; bad: boolean } {
  const raw = env[BULK_AGE_MINUTES_ENV];
  if (raw === undefined || raw.trim() === "") return { minutes: null, bad: false };
  const t = raw.trim();
  if (!/^\d+$/.test(t) || Number(t) <= 0) return { minutes: null, bad: true };
  return { minutes: Number(t), bad: false };
}

function readFallback(env: Env): { on: boolean; bad: boolean } {
  const raw = env[BULK_FALLBACK_LIVE_ENV];
  if (raw === undefined) return { on: false, bad: false };
  const v = raw.trim().toLowerCase();
  if (TRUTHY.includes(v)) return { on: true, bad: false };
  if (FALSY.includes(v)) return { on: false, bad: false };
  return { on: false, bad: true };
}

/**
 * BULK_AGE_MINUTES: unset/blank = OFF. A value that is not a positive whole number is ALSO off — logged once and
 * reported by `poolConfigProblems` — never a throw, so a typo cannot fail the drain it was meant to route.
 */
export function bulkAgeMinutes(env: Env = process.env): number | null {
  const r = readAge(env);
  if (r.bad) warnOnce(BULK_AGE_MINUTES_ENV, env[BULK_AGE_MINUTES_ENV] ?? "");
  return r.minutes;
}

/** R3 — may bulk work fall through to the live list? Default OFF; a bad value is OFF, logged once. */
export function bulkFallbackLive(env: Env = process.env): boolean {
  const r = readFallback(env);
  if (r.bad) warnOnce(BULK_FALLBACK_LIVE_ENV, env[BULK_FALLBACK_LIVE_ENV] ?? "");
  return r.on;
}

/** Names of pool settings whose values are invalid (and therefore OFF). For the health tool; names only, never values. */
export function poolConfigProblems(env: Env = process.env): string[] {
  const out: string[] = [];
  if (readAge(env).bad) out.push(BULK_AGE_MINUTES_ENV);
  if (readFallback(env).bad) out.push(BULK_FALLBACK_LIVE_ENV);
  for (const svc of POOL_SERVICES) {
    for (const which of ["list", "bulk"] as const) {
      const name = POOL_ENV[svc][which];
      if (parseList(env[name]).some((u) => servedByOf(u) === "unparseable_endpoint") && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/**
 * PURE — the endpoints for one call, in the order they will be tried.
 *
 * Ordinary: the service's list (or the one it inherits) when set, else `[<single>]` exactly as written (no trim, no
 * normalising, so the no-env call is byte-identical), else `[fallback]` when the caller has a built-in default,
 * else `[]` — which the caller turns into the same "not configured" answer it always gave.
 * Bulk: when a bulk list is set, ONLY that list — plus the ordinary list after it if POOL_BULK_FALLBACK_LIVE is on;
 * when none is set, the ordinary list. Duplicates dropped (first position wins).
 */
export function poolEndpoints(
  svc: PoolService,
  opts: { bulk?: boolean; fallback?: string } = {},
  env: Env = process.env,
): string[] {
  const list = listOf(svc, "list", env);
  const single = env[POOL_ENV[svc].single];
  const ordinary = list.length > 0 ? list : single ? [single] : opts.fallback ? [opts.fallback] : [];
  const bulkList = opts.bulk ? listOf(svc, "bulk", env) : [];
  const ordered = bulkList.length === 0 ? ordinary : bulkFallbackLive(env) ? [...bulkList, ...ordinary] : bulkList;
  return ordered.filter((u, i) => ordered.indexOf(u) === i);
}

/** PURE — the served_by label for an endpoint: its origin only. Never a path, query or userinfo. */
export function servedByOf(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return "unparseable_endpoint";
  }
}

// ── the breaker ────────────────────────────────────────────────────────────────────────────────
type BreakerState = { fails: number; openUntil: number };
const breakers = new Map<string, BreakerState>();
const key = (svc: PoolService, base: string) => `${svc} ${base}`;

export function breakerOpen(svc: PoolService, base: string, now: number = Date.now()): boolean {
  const b = breakers.get(key(svc, base));
  return !!b && b.openUntil > now;
}

function recordOutcome(svc: PoolService, base: string, failed: boolean, now: number): void {
  const k = key(svc, base);
  if (!failed) {
    breakers.delete(k);
    return;
  }
  const b = breakers.get(k) ?? { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= BREAKER_THRESHOLD) {
    b.openUntil = now + BREAKER_OPEN_MS;
    b.fails = 0; // a half-open retry after the window gets a fresh count of 3
  }
  breakers.set(k, b);
}

/** Tests only. */
export function resetBreakers(): void {
  breakers.clear();
  warned.clear();
}

// ── the call context: bulk routing in, served_by out ──────────────────────────────────────────
type PoolContext = { bulk: boolean; served: Partial<Record<PoolService, string>> };
const context = new AsyncLocalStorage<PoolContext>();

/**
 * Run `fn` with pool routing set for every pooled call inside it, and collect which endpoint served each
 * service. The job runner wraps every step in this; nothing below it has to thread a flag through.
 */
export async function withPoolContext<T>(
  opts: { bulk: boolean },
  fn: () => Promise<T>,
): Promise<{ value: T; served_by: Partial<Record<PoolService, string>> }> {
  const ctx: PoolContext = { bulk: opts.bulk, served: {} };
  const value = await context.run(ctx, fn);
  return { value, served_by: ctx.served };
}

/** Whether the current call is bulk work (false outside any pool context). */
export function isBulkContext(): boolean {
  return context.getStore()?.bulk === true;
}

export function isBulkWindow(closedAtMs: number | null, nowMs: number = Date.now(), env: Env = process.env): boolean {
  const mins = bulkAgeMinutes(env);
  if (mins === null || closedAtMs === null || !Number.isFinite(closedAtMs)) return false;
  return nowMs - closedAtMs > mins * 60_000;
}

// ── the loop ───────────────────────────────────────────────────────────────────────────────────
export type Verdict = "ok" | "failover" | "final";

/**
 * Try `call` against each endpoint in order until one answers with something other than `failover`, all inside
 * ONE budget (R1).
 *
 *   ok        success: breaker reset, answer returned
 *   final     the endpoint answered and the answer is the answer (e.g. a 4xx or an empty transcript):
 *             breaker reset (it is up), answer returned, NO failover — another endpoint would say the same
 *   failover  the endpoint is down or busy: breaker counts it, next endpoint — IF at least
 *             POOL_MIN_ENDPOINT_BUDGET_MS of the budget is left. Otherwise, or on the last endpoint, the answer
 *             is returned as it came, so a single-endpoint pool behaves exactly as before.
 *
 * `call(base, budgetMs)` must use `budgetMs` as its timeout: the first endpoint gets the whole budget (= the
 * client's old timeout), a failover only what remains. A `call` that THROWS is treated as failover too, and the
 * last throw is rethrown unchanged. `endpoints` must be non-empty; the caller answers the empty case itself.
 */
export async function runPool<T>(
  svc: PoolService,
  endpoints: readonly string[],
  call: (base: string, budgetMs: number) => Promise<T>,
  classify: (r: T) => Verdict,
  opts: { budgetMs: number; now?: () => number; env?: Env; floorMs?: number },
): Promise<{ value: T; base: string; served_by: string | null }> {
  const now = opts.now ?? Date.now;
  const floor = opts.floorMs ?? POOL_MIN_ENDPOINT_BUDGET_MS;
  if (endpoints.length === 0) throw new Error(`runPool(${svc}): no endpoints`);
  const start = now();
  const deadline = start + opts.budgetMs;
  const live = endpoints.filter((b) => !breakerOpen(svc, b, start));
  const order = live.length > 0 ? live : [...endpoints];
  const report = poolConfigured(svc, opts.env ?? process.env);
  const finish = (value: T, base: string) => {
    const served_by = report ? servedByOf(base) : null;
    const ctx = context.getStore();
    if (ctx && served_by) ctx.served[svc] = served_by;
    return { value, base, served_by };
  };

  for (let i = 0; i < order.length; i++) {
    const base = order[i];
    const budget = i === 0 ? opts.budgetMs : deadline - now();
    const last = i === order.length - 1;
    let value: T;
    try {
      value = await call(base, budget);
    } catch (e) {
      recordOutcome(svc, base, true, now());
      if (last || deadline - now() < floor) throw e;
      continue;
    }
    const v = classify(value);
    recordOutcome(svc, base, v === "failover", now());
    if (v !== "failover" || last || deadline - now() < floor) return finish(value, base);
  }
  // Unreachable: the last endpoint always returns or throws above.
  throw new Error(`runPool(${svc}): exhausted`);
}

/** Convenience for a caller that pools with the ambient bulk flag. */
export function endpointsFor(svc: PoolService, opts: { fallback?: string } = {}, env: Env = process.env): string[] {
  return poolEndpoints(svc, { bulk: isBulkContext(), fallback: opts.fallback }, env);
}
