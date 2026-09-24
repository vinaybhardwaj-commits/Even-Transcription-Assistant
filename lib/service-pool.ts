/**
 * lib/service-pool.ts — the heavy services as ordered POOLS of endpoints (REDUNDANCY-R1 Phase 4, 24 Sep).
 *
 * WHY. Production reached whisper, the audio join, eta-diarize and eta-emotion through ONE URL each, all
 * of them the Mini behind one Cloudflare tunnel: one Mini, tunnel or power fault stopped everything, and
 * the backlog had to wait for night. Each service now takes a LIST, tried in order.
 *
 *   <svc>_URLS         comma-separated, tried in order (the old single var is honoured when this is unset)
 *   <svc>_BULK_URLS    tried FIRST for bulk work (a room_window job whose window closed more than
 *                      BULK_AGE_MINUTES ago), then the ordinary list, so the backlog runs on the twins
 *                      while live clinic audio stays on the Mini
 *
 * FAILOVER is the caller's call, not this file's: every client already turns its transport into a result
 * with an error code, and only the client knows which of its codes mean "that endpoint is down" (connect
 * error, timeout, 5xx; for the join, also its single-flight mutex's `join_already_running`). The client
 * hands `runPool` a classifier; this file does the ordering, the breaker and the bookkeeping.
 *
 * THE BREAKER is per endpoint and per instance (module state, so per serverless instance): 3 consecutive
 * failover-class failures open it for 5 minutes, and an open endpoint is skipped. If EVERY endpoint is
 * open, all are tried anyway, in order. A breaker exists to route around a dead endpoint, never to
 * turn "all endpoints were flaky" into "nothing was even attempted".
 *
 * NO-ENV IDENTITY. With none of the new variables set, the pool for a service is exactly [the old single
 * value, as written], the call is made once, and its result is returned untouched — same URL, same
 * request, same answer, same error. `served_by` is only reported when a pool variable is set for that
 * service, so a result's shape does not change either. Tests pin this.
 *
 * SERVED_BY is DERIVED: it is the origin (scheme + host, never a path, query or credential) of the endpoint
 * whose answer the caller actually used. It is never a constant.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const POOL_SERVICES = ["whisper", "join", "diarize", "emotion"] as const;
export type PoolService = (typeof POOL_SERVICES)[number];

type Env = Record<string, string | undefined>;

/** The env names per service. `single` is the variable production has always read. */
export const POOL_ENV: Record<PoolService, { single: string; list: string; bulk: string }> = {
  whisper: { single: "WHISPER_BASE_URL", list: "WHISPER_BASE_URLS", bulk: "WHISPER_BULK_URLS" },
  join: { single: "AUDIO_JOIN_URL", list: "AUDIO_JOIN_URLS", bulk: "AUDIO_JOIN_BULK_URLS" },
  diarize: { single: "DIARIZE_BASE_URL", list: "DIARIZE_BASE_URLS", bulk: "DIARIZE_BULK_URLS" },
  emotion: { single: "EMOTION_BASE_URL", list: "EMOTION_BASE_URLS", bulk: "EMOTION_BULK_URLS" },
};

export const BULK_AGE_MINUTES_ENV = "BULK_AGE_MINUTES";
export const BREAKER_THRESHOLD = 3;
export const BREAKER_OPEN_MS = 5 * 60_000;

function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** True when either pool variable is set (non-empty) for this service — the only case `served_by` is reported. */
export function poolConfigured(svc: PoolService, env: Env = process.env): boolean {
  const e = POOL_ENV[svc];
  return parseList(env[e.list]).length > 0 || parseList(env[e.bulk]).length > 0;
}

/**
 * PURE — the endpoints for one call, in the order they will be tried.
 *
 * Ordinary: `<svc>_URLS` when set, else `[<single>]` exactly as written (no trim, no normalising, so the
 * no-env call is byte-identical), else `[fallback]` when the caller has a built-in default, else `[]` —
 * which the caller turns into the same "not configured" answer it always gave.
 * Bulk: `<svc>_BULK_URLS` first, then the ordinary list, duplicates dropped (first position wins).
 */
export function poolEndpoints(
  svc: PoolService,
  opts: { bulk?: boolean; fallback?: string } = {},
  env: Env = process.env,
): string[] {
  const e = POOL_ENV[svc];
  const list = parseList(env[e.list]);
  const single = env[e.single];
  const ordinary = list.length > 0 ? list : single ? [single] : opts.fallback ? [opts.fallback] : [];
  const ordered = opts.bulk ? [...parseList(env[e.bulk]), ...ordinary] : ordinary;
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
}

// ── the call context: bulk routing in, served_by out ──────────────────────────────────────────
type PoolContext = { bulk: boolean; served: Partial<Record<PoolService, string>> };
const context = new AsyncLocalStorage<PoolContext>();

/**
 * Run `fn` with pool routing set for every pooled call inside it, and collect which endpoint served each
 * service. The job kinds wrap one step in this; nothing below them has to thread a flag through.
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

/**
 * PURE — is this window old enough to be bulk work? `BULK_AGE_MINUTES` unset or empty = OFF (never bulk).
 * Strict: a value that is not a positive integer throws, the same as every flag here, because a typo that
 * silently read as "off" would keep the backlog on the Mini without anyone knowing.
 */
export function bulkAgeMinutes(env: Env = process.env): number | null {
  const raw = env[BULK_AGE_MINUTES_ENV];
  if (raw === undefined || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) <= 0) {
    throw new Error(`${BULK_AGE_MINUTES_ENV} must be a positive whole number of minutes (length ${raw.length})`);
  }
  return Number(raw.trim());
}

export function isBulkWindow(closedAtMs: number | null, nowMs: number = Date.now(), env: Env = process.env): boolean {
  const mins = bulkAgeMinutes(env);
  if (mins === null || closedAtMs === null || !Number.isFinite(closedAtMs)) return false;
  return nowMs - closedAtMs > mins * 60_000;
}

// ── the loop ───────────────────────────────────────────────────────────────────────────────────
export type Verdict = "ok" | "failover" | "final";

/**
 * Try `call` against each endpoint in order until one answers with something other than `failover`.
 *
 *   ok        success: breaker reset, answer returned
 *   final     the endpoint answered and the answer is the answer (e.g. a 4xx or an empty transcript):
 *             breaker reset (it is up), answer returned, NO failover — another endpoint would say the same
 *   failover  the endpoint is down or busy: breaker counts it, next endpoint; on the LAST endpoint the
 *             answer is returned as it came, so a single-endpoint pool behaves exactly as before
 *
 * A `call` that THROWS is treated as failover too, and the last throw is rethrown unchanged.
 * `endpoints` must be non-empty; the caller answers the empty case with its own "not configured" result.
 */
export async function runPool<T>(
  svc: PoolService,
  endpoints: readonly string[],
  call: (base: string) => Promise<T>,
  classify: (r: T) => Verdict,
  opts: { now?: () => number; env?: Env } = {},
): Promise<{ value: T; base: string; served_by: string | null }> {
  const now = opts.now ?? Date.now;
  if (endpoints.length === 0) throw new Error(`runPool(${svc}): no endpoints`);
  const live = endpoints.filter((b) => !breakerOpen(svc, b, now()));
  const order = live.length > 0 ? live : [...endpoints];
  const report = poolConfigured(svc, opts.env ?? process.env);

  for (let i = 0; i < order.length; i++) {
    const base = order[i];
    const last = i === order.length - 1;
    let value: T;
    try {
      value = await call(base);
    } catch (e) {
      recordOutcome(svc, base, true, now());
      if (last) throw e;
      continue;
    }
    const v = classify(value);
    recordOutcome(svc, base, v === "failover", now());
    if (v !== "failover" || last) {
      const served_by = report ? servedByOf(base) : null;
      const ctx = context.getStore();
      if (ctx && served_by) ctx.served[svc] = served_by;
      return { value, base, served_by };
    }
  }
  // Unreachable: the last endpoint always returns or throws above.
  throw new Error(`runPool(${svc}): exhausted`);
}

/** Convenience for a caller that pools with the ambient bulk flag. */
export function endpointsFor(svc: PoolService, opts: { fallback?: string } = {}, env: Env = process.env): string[] {
  return poolEndpoints(svc, { bulk: isBulkContext(), fallback: opts.fallback }, env);
}
