/**
 * lib/jev/worker/breaker.ts — the circuit breaker, in the DATABASE (PRD §9.2): one jev_breaker row per use, because
 * serverless instances share no memory.
 *
 *   OPEN when 5 consecutive breaker-counted failures, or an error rate >= 50% over the last 20 calls; `auth` opens at once.
 *   HALF-OPEN after the wait (10 min): ONE probe call. Success closes it; failure re-opens it with the wait DOUBLED, capped at 2 h.
 *   While open, jev_ask defers (circuit_open) and the sweeper does not enqueue for that use.
 *
 * `applyOutcome` and `isDue` are PURE (the unit tests drive them); the SQL around them is thin.
 * KNOWN LIMIT: record is read-modify-write, so two outcomes landing in the same millisecond can lose one count. The breaker is
 * an advisory brake, the budget cap is the hard stop, and a lost count only delays an open by one call.
 */
import { sql } from "@/lib/db";

export const BREAKER_CONSECUTIVE = 5;
export const BREAKER_WINDOW = 20;
export const BREAKER_RATE = 0.5;
export const BREAKER_WAIT_MS = 10 * 60_000;
export const BREAKER_WAIT_CAP_MS = 2 * 60 * 60_000;
export const HALF_OPEN_STALE_MS = 5 * 60_000;

export type BreakerState = "closed" | "open" | "half_open";
export type BreakerRow = {
  use: string;
  state: BreakerState;
  opened_at: string | null;
  reason_class: string | null;
  consecutive_failures: number;
  window_errors: number;
  window_calls: number;
  recent: string;
  wait_ms: number;
  updated_at: string | null;
};
export type Outcome = { ok: true } | { ok: false; counts: boolean; immediate?: boolean; cls: string };

export const freshBreaker = (use: string): BreakerRow => ({
  use, state: "closed", opened_at: null, reason_class: null, consecutive_failures: 0, window_errors: 0, window_calls: 0, recent: "", wait_ms: BREAKER_WAIT_MS, updated_at: null,
});

const tally = (recent: string) => ({ window_calls: recent.length, window_errors: [...recent].filter((c) => c === "e").length });

/** PURE. The next row after one call's outcome. */
export function applyOutcome(row: BreakerRow, o: Outcome, now: Date): BreakerRow {
  if (!o.ok && !o.counts) return row;                                 // a refusal that is not the provider's fault changes nothing
  const next: BreakerRow = { ...row };
  if (o.ok) {
    next.recent = (row.recent + "o").slice(-BREAKER_WINDOW);
    next.consecutive_failures = 0;
    if (row.state !== "closed") { next.state = "closed"; next.opened_at = null; next.reason_class = null; next.wait_ms = BREAKER_WAIT_MS; }
    return { ...next, ...tally(next.recent) };
  }
  next.recent = (row.recent + "e").slice(-BREAKER_WINDOW);
  next.consecutive_failures = row.consecutive_failures + 1;
  const t = tally(next.recent);
  if (row.state === "half_open") {
    next.state = "open"; next.opened_at = now.toISOString(); next.reason_class = o.cls;
    next.wait_ms = Math.min(row.wait_ms * 2, BREAKER_WAIT_CAP_MS);
  } else if (row.state === "closed" && (o.immediate || next.consecutive_failures >= BREAKER_CONSECUTIVE || (t.window_calls >= BREAKER_WINDOW && t.window_errors / t.window_calls >= BREAKER_RATE))) {
    next.state = "open"; next.opened_at = now.toISOString(); next.reason_class = o.cls;
  }
  return { ...next, ...t };
}

/** PURE. An open breaker whose wait has run out is due a probe. */
export const isDue = (row: BreakerRow, now: Date): boolean =>
  row.state === "open" && row.opened_at !== null && now.getTime() - new Date(row.opened_at).getTime() >= row.wait_ms;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
function norm(use: string, r: Record<string, unknown> | undefined): BreakerRow {
  if (!r) return freshBreaker(use);
  return {
    use, state: r.state as BreakerState, opened_at: r.opened_at ? new Date(r.opened_at as string).toISOString() : null, reason_class: (r.reason_class as string) ?? null,
    consecutive_failures: num(r.consecutive_failures), window_errors: num(r.window_errors), window_calls: num(r.window_calls),
    recent: String(r.recent ?? ""), wait_ms: num(r.wait_ms) || BREAKER_WAIT_MS, updated_at: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
  };
}

export async function getBreaker(use: string): Promise<BreakerRow> {
  const rows = (await sql`SELECT use, state, opened_at, reason_class, consecutive_failures, window_errors, window_calls, recent, wait_ms, updated_at FROM jev_breaker WHERE use = ${use}`) as Array<Record<string, unknown>>;
  return norm(use, rows[0]);
}

async function save(row: BreakerRow): Promise<void> {
  await sql`
    INSERT INTO jev_breaker (use, state, opened_at, reason_class, consecutive_failures, window_errors, window_calls, recent, wait_ms, updated_at)
    VALUES (${row.use}, ${row.state}, ${row.opened_at}::timestamptz, ${row.reason_class}, ${row.consecutive_failures}, ${row.window_errors}, ${row.window_calls}, ${row.recent}, ${row.wait_ms}, now())
    ON CONFLICT (use) DO UPDATE SET state = EXCLUDED.state, opened_at = EXCLUDED.opened_at, reason_class = EXCLUDED.reason_class,
      consecutive_failures = EXCLUDED.consecutive_failures, window_errors = EXCLUDED.window_errors, window_calls = EXCLUDED.window_calls,
      recent = EXCLUDED.recent, wait_ms = EXCLUDED.wait_ms, updated_at = now()`;
}

export type Admit = { admit: true; state: BreakerState; probe: boolean } | { admit: false; state: BreakerState };

/**
 * May a call go out for this use? Closed: yes. Open and due: the FIRST caller wins an atomic open->half_open flip and is the
 * probe; everyone else is refused. Half-open: refused, unless the probe never reported back for HALF_OPEN_STALE_MS.
 */
export async function breakerAdmit(use: string, now = new Date()): Promise<Admit> {
  const row = await getBreaker(use);
  if (row.state === "closed") return { admit: true, state: "closed", probe: false };
  if (row.state === "open") {
    if (!isDue(row, now)) return { admit: false, state: "open" };
    const won = (await sql`UPDATE jev_breaker SET state = 'half_open', updated_at = now() WHERE use = ${use} AND state = 'open' RETURNING use`) as unknown[];
    return won.length ? { admit: true, state: "half_open", probe: true } : { admit: false, state: "half_open" };
  }
  if (row.updated_at && now.getTime() - new Date(row.updated_at).getTime() >= HALF_OPEN_STALE_MS) {
    const won = (await sql`UPDATE jev_breaker SET updated_at = now() WHERE use = ${use} AND state = 'half_open' AND updated_at < now() - make_interval(secs => ${HALF_OPEN_STALE_MS / 1000}) RETURNING use`) as unknown[];
    if (won.length) return { admit: true, state: "half_open", probe: true };
  }
  return { admit: false, state: "half_open" };
}

export async function recordOutcome(use: string, o: Outcome, now = new Date()): Promise<BreakerRow> {
  const row = await getBreaker(use);
  const next = applyOutcome(row, o, now);
  if (next !== row) await save(next);
  return next;
}

/** The sweeper's question: is this use's circuit open (or half-open and not stale)? */
export async function breakerIsOpen(use: string, now = new Date()): Promise<boolean> {
  const row = await getBreaker(use);
  return row.state === "open" || (row.state === "half_open" && !(row.updated_at && now.getTime() - new Date(row.updated_at).getTime() >= HALF_OPEN_STALE_MS));
}
