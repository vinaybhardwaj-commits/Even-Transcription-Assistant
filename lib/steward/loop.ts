/**
 * lib/steward/loop.ts — Room Steward part 2: the one-minute SHADOW control loop.
 *
 *   runSteward(sql, { asOf, budgetMs }): lock -> config -> roster -> senseAll -> decide (two passes, for the fleet-incident count) -> dedupe -> shadow-execute -> ONE INSERT.
 *
 * SHADOW BY DEFAULT. config.actionMode decides per action: kill switch ON (the seed) -> result "kill_switch"; shadow.global true, or shadow.actions[action] true, or an action that is
 * not live-capable -> ShadowExecutor, "shadow: would <action>" (it never calls Scribe, never issues a ticket, never messages). Only kill_switch off AND shadow.global false AND
 * shadow.actions[action] !== true selects the LiveExecutor, which implements scribe_start (re-checked at execution time); any other live action throws and the loop records it as
 * shadow with result "blocked: live executor not enabled in P0" and names it in `degraded`. Caps (rules.ts) count only rows whose result is ok / failed.
 *
 * FIRE THEN COLLECT (F44). A live start is issued in the room loop (its "sending" row, the flag re-read and the executor's re-checks all unchanged) but its ack is NOT awaited there:
 * every eligible start is in flight at once and the acks are collected together after the room loop, inside the tick budget. No ack in the tick = "pending: sent, awaiting ack
 * command_id=..." (not a failure). A later tick RECONCILES each pending row from bench_command (reconcilePending): acked -> "ok: start_day acked (late)", failed / expired -> "failed:",
 * still pending after START_NO_ACK_FAIL_S -> "failed: no ack after 120 s". The row is UPDATED IN PLACE (one row per attempt, as the "sending" row is).
 *
 * CONFIG. Read BEFORE the lease. No `rooms` / `schedule` (or a failed read) = the tick is skipped with {ok:false, reason:"config_unavailable"}: nothing is taken, nothing released.
 * BUDGET. Sensing and the decision-log read share the first (budget - 3 s); every source read has its own timeout (steward_config source_timeout_ms, default 6 s); the last 3 s
 * are reserved for the decisions INSERT, which a tick always attempts once it holds the lease and has a config.
 * LAST TICK. The lease release also writes steward_config.last_tick (one statement) and the tick logs one JSON line `steward.tick`.
 *
 * LOCK. The spec asked for pg_try_advisory_lock. That lock is SESSION-scoped and the Neon HTTP driver gives no session: each statement may run on a different backend and
 * the lock would be dropped (or leaked) at once. The mutual exclusion here is therefore a LEASE ROW in steward_config (key 'loop_lease', value {holder, until}) taken and
 * released with single atomic statements; an expired lease (a crashed run) is taken over. See leaseLock.
 *
 * DEDUPE. A room's PRIMARY decision (element 0) is written only when (rule, action, params) differs from the room's last primary row, or that row is >= 15 min old.
 * Secondary decisions (element 1+) and fleet decisions are written unless an identical (rule, action, params) row is < 15 min old. Rows carry inputs.primary / inputs.tick.
 *
 * DEGRADED. A source that cannot be read is named in `degraded`; the rules see nulls. Nothing a source does can throw the tick: a failure of the decision-log read skips the
 * write (it would only repeat rows), a failure of the roster read ends the tick with rooms 0.
 */
import { randomUUID } from "node:crypto";
import { actionMode, buildRoster, isNeverLiveRoom, loadConfig, parseConfig, type Config, type RosterRow } from "./config";
import { LIVE_EXECUTOR_DISABLED, LiveExecutor, PENDING_PREFIX, isDeferredAck, ShadowExecutor, dispatch, type Executor } from "./executor";
import { START_NO_ACK_FAIL_S } from "./start-schedule";
import { FAILING_RULES, FLEET_HOLD_MS, decideRoom, failingClass, fleetDecisions, type Decision, type RecentAction, type RecentContext } from "./rules";
import { senseAll } from "./sense";
import { SourceTimeout, raceTimeout } from "./timeout";
import type { StewardSql } from "./tickets";

export const DEDUPE_REFRESH_MS = 15 * 60_000;
export const FLEET_COUNT_WINDOW_MS = 5 * 60_000;
export const LEASE_KEY = "loop_lease";
export const LEASE_TTL_S = 55;
/** the last part of the tick budget kept for the decisions INSERT (sensing and the log read stop before it) */
export const INSERT_RESERVE_MS = 3000;
export const LAST_TICK_KEY = "last_tick";
/** no live send is issued when less than this much of the tick budget is left (the row says "skipped: budget") */
export const LIVE_MIN_BUDGET_MS = 6000;

export type StewardSummary = {
  /** false only when the tick could not run at all (reason set) */
  ok: boolean;
  reason?: "config_unavailable";
  rooms: number;
  decisions_written: number;
  skipped_lock: boolean;
  elapsed_ms: number;
  degraded: string[];
  kill_switch: boolean;
  budget_hit: boolean;
  fleet_incidents: number;
};

export interface LoopLock {
  acquire(): Promise<boolean>;
  /** `lastTick`, when given, is stored as steward_config.last_tick in the SAME statement as the release */
  release(lastTick?: Record<string, unknown>): Promise<void>;
}

/** Lease row in steward_config; single atomic statements. See the file header for why this is not pg_try_advisory_lock. */
export function leaseLock(sql: StewardSql, opts: { holder?: string; ttlSeconds?: number } = {}): LoopLock {
  const holder = opts.holder ?? randomUUID();
  const ttl = opts.ttlSeconds ?? LEASE_TTL_S;
  return {
    async acquire() {
      const rows = (await sql`
        INSERT INTO steward_config (key, value, updated_by)
        VALUES (${LEASE_KEY}, jsonb_build_object('holder', ${holder}::text, 'until', (now() + make_interval(secs => ${ttl}::int))::text), ${holder}::text)
        ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
         WHERE steward_config.value->>'holder' IS NULL OR (steward_config.value->>'until')::timestamptz < now()
        RETURNING key
      `) as unknown[];
      return rows.length > 0;
    },
    async release(lastTick) {
      if (!lastTick) {
        await sql`
          UPDATE steward_config
             SET value = jsonb_build_object('holder', NULL::text, 'until', now()::text), updated_at = now()
           WHERE key = ${LEASE_KEY} AND value->>'holder' = ${holder}::text
        `;
        return;
      }
      // ONE statement: the guarded release (UPDATE) and the last_tick upsert (INSERT .. SELECT FROM the released row), so a lost lease writes no last_tick and a release costs one round trip
      await sql`
        WITH rel AS (
          UPDATE steward_config
             SET value = jsonb_build_object('holder', NULL::text, 'until', now()::text), updated_at = now()
           WHERE key = ${LEASE_KEY} AND value->>'holder' = ${holder}::text
          RETURNING key
        )
        INSERT INTO steward_config (key, value, updated_by)
        SELECT ${LAST_TICK_KEY}::text, ${JSON.stringify(lastTick)}::jsonb, ${holder}::text FROM rel
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
      `;
    },
  };
}

export type RunOptions = {
  asOf: number | string | Date;
  budgetMs: number;
  /** test seams */
  lock?: LoopLock;
  now?: () => number;
  executorFor?: (live: boolean) => Executor;
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const toIso = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const objOf = (v: unknown): Record<string, unknown> => {
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v);
      return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};
function stable(v: unknown): string {
  const s = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(s);
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(x as object).sort()) o[k] = s((x as Record<string, unknown>)[k]);
      return o;
    }
    return x;
  };
  return JSON.stringify(s(v));
}
const keyOf = (d: { rule: string; action: string; params: Record<string, unknown> }) => `${d.rule}|${d.action}|${stable(d.params)}`;

export function outcomeOf(result: string | null): RecentAction["outcome"] {
  if (!result) return null;
  if (result.startsWith("failed")) return "failed";
  if (result.startsWith("ok")) return "ok";
  if (result.startsWith("shadow") || result.startsWith("kill_switch") || result.startsWith("blocked")) return "shadow";
  return null;
}

type DbRow = { id?: unknown; room_id: string | null; ts: unknown; rule: string; action: string; params: unknown; result: string | null; primary?: unknown; failing_class?: string | null };

/** the cap on the 24 h rule-memory read in loadRecent */
export const RECENT_ROWS_LIMIT = 3000;

async function loadRecent(sql: StewardSql, roomIds: string[], A: number): Promise<{ lastPrimary: Map<string, DbRow>; recentRows: Map<string, RecentAction[]>; fleetRows: DbRow[] }> {
  const hi = new Date(A).toISOString();
  // newest primary row per room (the dedupe reference), last 24 h — (room_id, ts DESC) index
  const prim = (await sql`
    SELECT DISTINCT ON (d.room_id) d.room_id, d.ts, d.rule, d.action, d.params, d.result
      FROM steward_decisions d
     WHERE d.room_id = ANY(${roomIds}::text[]) AND d.ts > ${hi}::timestamptz - interval '24 hours' AND d.ts <= ${hi}::timestamptz
       AND d.inputs->>'primary' = 'true'
     ORDER BY d.room_id, d.ts DESC, d.id DESC
  `) as DbRow[];
  // every non-'none' row of the last 24 h (the rules' memory: tries, ladder steps, caps, policy_cycle per day) — newest first, capped
  const rows = (await sql`
    SELECT d.room_id, d.ts, d.rule, d.action, d.params, d.result, d.inputs->>'failing_class' AS failing_class
      FROM steward_decisions d
     WHERE d.room_id = ANY(${roomIds}::text[]) AND d.ts > ${hi}::timestamptz - interval '24 hours' AND d.ts <= ${hi}::timestamptz AND d.action <> 'none'
     ORDER BY d.ts DESC, d.id DESC
     LIMIT ${RECENT_ROWS_LIMIT}
  `) as DbRow[];
  // F44.1 (F5): live volume is ~160 rows a day, far from the cap; if it is ever reached the OLDEST rows are silently cut, so say so (counts only)
  if (rows.length >= RECENT_ROWS_LIMIT) console.warn(`[steward] decision log read hit its LIMIT (${RECENT_ROWS_LIMIT} rows): the oldest rows of the last 24 h are not in the rules' memory`);
  // fleet incident rows of the last 15 min (room_id NULL)
  const fleet = (await sql`
    SELECT d.room_id, d.ts, d.rule, d.action, d.params, d.result
      FROM steward_decisions d
     WHERE d.room_id IS NULL AND d.rule = 'fleet_incident'
       AND d.ts > ${hi}::timestamptz - make_interval(secs => ${FLEET_HOLD_MS / 1000}::int) AND d.ts <= ${hi}::timestamptz
     ORDER BY d.ts DESC
  `) as DbRow[];
  const lastPrimary = new Map<string, DbRow>();
  for (const r of prim) if (r.room_id) lastPrimary.set(r.room_id, r);
  const recentRows = new Map<string, RecentAction[]>();
  for (const r of rows) {
    const ts = toIso(r.ts);
    if (!r.room_id || !ts) continue;
    const a: RecentAction = { ts, rule: r.rule, action: r.action, params: objOf(r.params), outcome: outcomeOf(r.result), failing_class: typeof r.failing_class === "string" ? r.failing_class : null };
    const l = recentRows.get(r.room_id);
    if (l) l.push(a);
    else recentRows.set(r.room_id, [a]);
  }
  return { lastPrimary, recentRows, fleetRows: fleet };
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

type OutRow = {
  room_id: string | null;
  machine: string | null;
  window_kind: string;
  rule: string;
  action: string;
  params: Record<string, unknown>;
  mode: "shadow" | "live";
  result: string | null;
  why: string;
  why_not: string | null;
  inputs_hash: string;
  inputs: Record<string, unknown>;
  ts: string;
};

/** the one INSERT shape of the tick (also used for a "sending" row) */
async function insertRows(sql: StewardSql, rows: OutRow[]): Promise<unknown[]> {
  return (await sql`
    INSERT INTO steward_decisions (ts, room_id, machine, window_kind, rule, action, params, mode, result, actor, why, why_not, inputs_hash, inputs)
    SELECT x.ts, x.room_id, x.machine, x.window_kind, x.rule, x.action, x.params, x.mode, x.result, 'steward', x.why, x.why_not, x.inputs_hash, x.inputs
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
        ts timestamptz, room_id text, machine text, window_kind text, rule text, action text, params jsonb, mode text, result text,
        why text, why_not text, inputs_hash text, inputs jsonb)
    RETURNING id
  `) as unknown[];
}

// ---------------------------------------------------------------------------
// F44: reconcile pending starts
// ---------------------------------------------------------------------------

/**
 * R1 (F44.1): one deadline for a whole reconcile. `left()` is the time remaining under it; once it is spent it THROWS SourceTimeout, so no further statement is issued —
 * the reads and every UPDATE share the one budget instead of each taking a full timeout.
 */
function deadlineOf(totalMs: number, now: () => number): () => number {
  const end = now() + totalMs;
  return () => {
    const rest = end - now();
    if (rest <= 0) throw new SourceTimeout(totalMs);
    return rest;
  };
}

const PENDING_RE = /^pending\b.*command_id=(\S+)/;

/**
 * Settle the "pending: sent, awaiting ack" rows of the last 24 h from bench_command (the truth about the command). One SELECT for the rows, one for the commands, one UPDATE per settled row
 * (guarded `result LIKE 'pending%'`, so a second reader or a repeat is a no-op). The row is updated IN PLACE rather than followed by a new row: the log keeps ONE row per attempt (the
 * invariant the "sending" row already has), the room's dedupe reference and the per-hour caps count the attempt once, and inputs records that it was pending (pending_at, late, settled_at).
 * Returns the number of rows settled. A failure of either read leaves the rows pending (they are tried again next tick).
 */
/**
 * ARCH #17 (fix F, refute): a deferred start that was SETTLED ok can still turn out to have failed — the app's wait/retries end in a failure ack, which amends the command
 * to `failed` (ackCommand). Revisit the last 24 h of "ok: start_day deferred then recording" rows: if the command is now failed, the row becomes "failed: …". Guarded
 * (`result LIKE 'ok: start_day deferred%'`) so a repeat is a no-op, and the command must belong to the SAME room as the decision. Fail-safe: a read fault leaves rows as they are.
 */
export async function reviseDeferredOk(sql: StewardSql, A: number, timeoutMs: number, onFault?: () => void, now: () => number = Date.now): Promise<number> {
  const left = deadlineOf(timeoutMs, now);
  let revised = 0;
  let at = { room: "-", cmd: "-" }; // the row being worked on, for the one log line a fault leaves
  try {
  const hi = new Date(A).toISOString();
  const okRows = (await raceTimeout(
    () => sql`SELECT d.id, d.room_id, d.result FROM steward_decisions d WHERE d.action = 'scribe_start' AND d.mode = 'live' AND d.result LIKE 'ok: start_day deferred then recording%' AND d.ts > ${hi}::timestamptz - interval '24 hours' AND d.ts <= ${hi}::timestamptz ORDER BY d.ts DESC LIMIT 50`,
    left(),
  )) as Array<{ id: unknown; room_id: string | null; result: string | null }>;
  const todo = okRows.flatMap((r) => {
    const m = /command_id=(\S+)/.exec(r.result ?? "");
    return m ? [{ id: r.id, room: r.room_id, cmd: m[1]! }] : [];
  });
  if (todo.length === 0) return 0;
  at = { room: todo[0]!.room ?? "-", cmd: todo[0]!.cmd };
  const cmds = (await raceTimeout(
    () => sql`SELECT id, room_id, status, error FROM bench_command WHERE id = ANY(${todo.map((t) => t.cmd)}::text[]) AND status = 'failed'`,
    left(),
  )) as Array<{ id: string; room_id: string; status: string; error: string | null }>;
  const failed = new Map(cmds.map((c) => [c.id, c]));
  for (const t of todo) {
    const c = failed.get(t.cmd);
    if (!c || !t.room || c.room_id !== t.room) continue;
    at = { room: t.room, cmd: t.cmd };
    const result = `failed: start_day failed after it was settled ok${c.error ? ` (${String(c.error).slice(0, 80)})` : ""} command_id=${t.cmd}`;
    await raceTimeout(
      () => sql`UPDATE steward_decisions SET result = ${result}, inputs = inputs || ${JSON.stringify({ revised_at: hi, revised_from: "ok" })}::jsonb WHERE id = ${String(t.id)}::bigint AND result LIKE 'ok: start_day deferred%'`,
      left(),
    );
    revised++;
  }
  } catch (e) {
    // Not silent: one line naming the room and command, and the caller's tick is marked degraded (F44's reconcile_pending). The rows stay as they are; the next tick tries again.
    console.error(`[steward] deferred-start revision failed room=${at.room} command_id=${at.cmd}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    onFault?.();
  }
  return revised;
}

/**
 * R3 (F44.1): a start settled "failed: no ack after 120 s" in the last 30 min can still be acked by a slow kiosk. Revisit those rows: if the command is now `acked` (and not a
 * deferred ack, which is accepted-not-started), the row becomes "ok: start_day acked (late, after 120 s)" with inputs.late=true. Guarded by the settled result, so a repeat is a
 * no-op; the command must belong to the SAME room. A read fault leaves the rows as they are (onFault marks the tick degraded).
 */
export const LATE_ACK_WINDOW_MIN = 30;
export async function reviseLateAcks(sql: StewardSql, A: number, timeoutMs: number, onFault?: () => void, now: () => number = Date.now): Promise<number> {
  const left = deadlineOf(timeoutMs, now);
  let revised = 0;
  let at = { room: "-", cmd: "-" };
  try {
    const hi = new Date(A).toISOString();
    const failedRows = (await raceTimeout(
      () => sql`SELECT d.id, d.room_id, d.result FROM steward_decisions d WHERE d.action = 'scribe_start' AND d.mode = 'live' AND d.result LIKE ${`failed: no ack after ${START_NO_ACK_FAIL_S} s%`} AND d.ts > ${hi}::timestamptz - make_interval(mins => ${LATE_ACK_WINDOW_MIN}) AND d.ts <= ${hi}::timestamptz ORDER BY d.ts DESC LIMIT 50`,
      left(),
    )) as Array<{ id: unknown; room_id: string | null; result: string | null }>;
    const todo = failedRows.flatMap((r) => {
      const m = /command_id=(\S+)/.exec(r.result ?? "");
      return m ? [{ id: r.id, room: r.room_id, cmd: m[1]! }] : [];
    });
    if (todo.length === 0) return 0;
    at = { room: todo[0]!.room ?? "-", cmd: todo[0]!.cmd };
    const cmds = (await raceTimeout(
      () => sql`SELECT id, room_id, status, result FROM bench_command WHERE id = ANY(${todo.map((t) => t.cmd)}::text[]) AND status = 'acked'`,
      left(),
    )) as Array<{ id: string; room_id: string; status: string; result?: unknown }>;
    const acked = new Map(cmds.map((c) => [c.id, c]));
    for (const t of todo) {
      const c = acked.get(t.cmd);
      if (!c || c.status !== "acked" || !t.room || c.room_id !== t.room || isDeferredAck(c.result)) continue;
      at = { room: t.room, cmd: t.cmd };
      const result = `ok: start_day acked (late, after ${START_NO_ACK_FAIL_S} s) command_id=${t.cmd}`;
      await raceTimeout(
        () => sql`UPDATE steward_decisions SET result = ${result}, inputs = inputs || ${JSON.stringify({ late: true, revised_at: hi, revised_from: "failed" })}::jsonb WHERE id = ${String(t.id)}::bigint AND result LIKE ${`failed: no ack after ${START_NO_ACK_FAIL_S} s%`}`,
        left(),
      );
      revised++;
    }
  } catch (e) {
    console.error(`[steward] late-ack revision failed room=${at.room} command_id=${at.cmd}: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`);
    onFault?.();
  }
  return revised;
}

export async function reconcilePending(sql: StewardSql, A: number, timeoutMs: number, onReviseFault?: () => void, now: () => number = Date.now): Promise<number> {
  const left = deadlineOf(timeoutMs, now); // R1: ONE deadline for every read and UPDATE below (and for the revisions)
  const hi = new Date(A).toISOString();
  // The revision runs first and is independent of the pending rows below: a fault here never blocks them.
  const revised = (await reviseDeferredOk(sql, A, left(), onReviseFault, now)) + (await reviseLateAcks(sql, A, left(), onReviseFault, now));
  const pend = (await raceTimeout(
    () => sql`SELECT d.id, d.ts, d.result FROM steward_decisions d WHERE d.action = 'scribe_start' AND d.mode = 'live' AND d.result LIKE 'pending%' AND d.ts > ${hi}::timestamptz - interval '24 hours' AND d.ts <= ${hi}::timestamptz ORDER BY d.ts ASC LIMIT 50`,
    left(),
  )) as Array<{ id: unknown; ts: unknown; result: string | null }>;
  const todo = pend.flatMap((r) => {
    const m = PENDING_RE.exec(r.result ?? "");
    return m ? [{ id: r.id, ts: toIso(r.ts), cmd: m[1]! }] : [];
  });
  if (todo.length === 0) return revised;
  const cmds = (await raceTimeout(
    () => sql`SELECT id, room_id, status, error, created_at, result FROM bench_command WHERE id = ANY(${todo.map((t) => t.cmd)}::text[])`,
    left(),
  )) as Array<{ id: string; room_id?: string; status: string; error: string | null; created_at: unknown; result?: unknown }>;
  const byId = new Map(cmds.map((c) => [c.id, c]));
  let settled = 0;
  for (const t of todo) {
    const c = byId.get(t.cmd);
    const sentMs = Date.parse(toIso(c?.created_at) ?? t.ts ?? "");
    const waitedS = Number.isFinite(sentMs) ? (A - sentMs) / 1000 : 0;
    let result: string | null = null;
    if (c?.status === "acked" && isDeferredAck(c.result)) {
      // ARCH #17 (C2): the app ACCEPTED this start and is waiting for its input device; accepted is not started. Settle only on evidence: a session opened for the room
      // after the command was created (ok), or START_NO_ACK_FAIL_S with none (failed). Otherwise it stays pending. A late failure ack makes the command `failed`, handled below.
      // "Opened" is not enough (a start that died ~15 s in with no audio also opened a session): the session must be STILL OPEN and must have PRODUCED AUDIO since it began —
      // a piece of either stream, or a level sample from a poll that reported the session open with the tape advancing (the same evidence the fleet read uses; no new table).
      const opened = c.room_id && Number.isFinite(sentMs)
        ? ((await raceTimeout(
            () => sql`
              SELECT s.id FROM bench_session s
               WHERE s.room_id = ${c.room_id!} AND s.started_at >= ${new Date(sentMs).toISOString()}::timestamptz AND s.status IN ('recording', 'paused')
                 AND (EXISTS (SELECT 1 FROM bench_chunk ch WHERE ch.session_id = s.id)
                      OR EXISTS (SELECT 1 FROM bench_level_sample l WHERE l.room_id = s.room_id AND l.ist_date >= (s.started_at AT TIME ZONE 'Asia/Kolkata')::date AND l.sampled_at >= s.started_at AND l.session_open IS TRUE AND l.tape_advancing IS TRUE))
               ORDER BY s.started_at ASC LIMIT 1`,
            left(),
          )) as Array<{ id: string }>)
        : [];
      if (opened.length) result = `ok: start_day deferred then recording (late) session_id=${opened[0]!.id} command_id=${t.cmd}`;
      else if (waitedS > START_NO_ACK_FAIL_S) result = `failed: start_day deferred, no recording session after ${START_NO_ACK_FAIL_S} s command_id=${t.cmd}`;
    } else if (c?.status === "acked") result = `ok: start_day acked (late) command_id=${t.cmd}`;
    else if (c && (c.status === "failed" || c.status === "expired")) result = `failed: start_day ${c.status}${c.error ? ` (${String(c.error).slice(0, 80)})` : ""} command_id=${t.cmd}`;
    else if (waitedS > START_NO_ACK_FAIL_S) result = `failed: no ack after ${START_NO_ACK_FAIL_S} s command_id=${t.cmd}`;
    if (result === null) continue;
    await raceTimeout(
      () => sql`UPDATE steward_decisions SET result = ${result}, inputs = inputs || ${JSON.stringify({ pending_at: t.ts, late: true, settled_at: hi, waited_s: Math.round(waitedS) })}::jsonb WHERE id = ${String(t.id)}::bigint AND result LIKE 'pending%'`,
      left(),
    );
    settled++;
  }
  return settled + revised;
}

export async function runSteward(sql: StewardSql, opts: RunOptions): Promise<StewardSummary> {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const A = new Date(opts.asOf).getTime();
  if (!Number.isFinite(A)) throw new Error("runSteward: bad asOf");
  const asOfIso = new Date(A).toISOString();
  const degraded: string[] = [];
  const degrade = (s: string) => {
    if (!degraded.includes(s)) degraded.push(s);
  };
  const summary = (over: Partial<StewardSummary>): StewardSummary => ({
    ok: true,
    rooms: 0,
    decisions_written: 0,
    skipped_lock: false,
    elapsed_ms: now() - t0,
    degraded,
    kill_switch: true,
    budget_hit: false,
    fleet_incidents: 0,
    ...over,
  });

  // --- config FIRST, before the lease (F8). No `rooms` / `schedule` = no tick: a default roster would re-admit dev/test rooms and re-class the OT room. Nothing is
  //     taken, so nothing is released. (The seed fallback stays for caps / timeouts / switches only.)
  let cfg: Config;
  try {
    const r = await loadConfig(sql);
    if (r.fatal.length > 0) {
      console.error(`[steward] config unavailable: ${r.fatal.join(",")} missing or malformed`);
      for (const k of r.fatal) degrade(`config:${k}`);
      return configUnavailable(summary, degraded, now() - t0);
    }
    cfg = r.config;
    for (const k of r.invalid) degrade(`config:${k}`);
  } catch (e) {
    console.error("[steward] config read failed:", e instanceof Error ? e.message.slice(0, 200) : "error");
    degrade("steward_config");
    return configUnavailable(summary, degraded, now() - t0);
  }

  const lock = opts.lock ?? leaseLock(sql);
  let got = false;
  try {
    got = await lock.acquire();
  } catch (e) {
    console.error("[steward] lock failed:", e instanceof Error ? e.message.slice(0, 200) : "error");
    degrade("lock");
    return summary({ skipped_lock: true });
  }
  if (!got) return summary({ skipped_lock: true });

  // The tick body. Every path returns a summary; the lease is released (with the last_tick summary) after it, whatever happened.
  const body = async (): Promise<StewardSummary> => {
    // --- roster
    let rosterRows: RosterRow[] = [];
    try {
      rosterRows = (await sql`
        SELECT r.id AS room_id, r.name AS room_name, ri.hostname, ri.state_flags, ri.expected_device_name AS device_name
          FROM room r
          LEFT JOIN room_install ri ON ri.room_id = r.id AND ri.retired_at IS NULL AND ri.enrolled_at IS NOT NULL
         WHERE r.disabled_at IS NULL
      `) as RosterRow[];
    } catch (e) {
      console.error("[steward] roster read failed:", e instanceof Error ? e.message.slice(0, 200) : "error");
      degrade("roster");
      return summary({ kill_switch: cfg.kill_switch });
    }
    const roster = buildRoster(rosterRows, cfg);
    if (roster.length === 0) return summary({ kill_switch: cfg.kill_switch });

    // --- time plan (F3): sensing and the decision-log read stop INSERT_RESERVE_MS before the budget ends; the decisions INSERT always gets that reserve.
    const senseDeadline = t0 + opts.budgetMs - INSERT_RESERVE_MS;

    // --- sense: every source has its own timeout; past the deadline the remaining sources are skipped (degraded) and the tick still decides and writes
    let senses: Awaited<ReturnType<typeof senseAll>>;
    try {
      senses = await senseAll(sql, A, roster, degraded, { sourceTimeoutMs: cfg.source_timeout_ms, deadlineMs: senseDeadline, now });
    } catch (e) {
      console.error("[steward] sense failed:", e instanceof Error ? e.message.slice(0, 200) : "error");
      degrade("sense");
      senses = new Map();
    }

    // --- the decision log (memory for the rules and the dedupe reference). A failure / timeout does NOT end the tick: decisions are made without memory, flagged
    //     inputs.memory_degraded, and the INSERT is still attempted (the spec: a tick never ends without trying the insert).
    let mem: Awaited<ReturnType<typeof loadRecent>> = { lastPrimary: new Map(), recentRows: new Map(), fleetRows: [] };
    let memoryDegraded = false;
    {
      const left = senseDeadline - now();
      if (left <= 0) {
        degrade("steward_decisions:skipped");
        memoryDegraded = true;
      } else {
        // F44: settle the pending starts BEFORE the log is read, so the rules and the dedupe see the settled result. A failure leaves them pending; the tick goes on.
        // R1 (F44.1): the reconcile runs under ONE deadline, and `left` is taken again after it, so a slow reconcile can never push the log read past senseDeadline.
        try {
          await reconcilePending(sql, A, Math.min(cfg.source_timeout_ms, left), () => degrade("reconcile_revise"));
        } catch {
          console.error("[steward] pending starts could not be reconciled");
          degrade("reconcile_pending");
        }
        const leftForLog = senseDeadline - now();
        if (leftForLog <= 0) {
          degrade("steward_decisions:skipped");
          memoryDegraded = true;
        } else {
          try {
            mem = await raceTimeout(() => loadRecent(sql, roster.map((r) => r.room_id), A), Math.min(cfg.source_timeout_ms, leftForLog));
          } catch (e) {
            memoryDegraded = true;
            if (e instanceof SourceTimeout) {
              console.error("[steward] decision log read timed out");
              degrade("steward_decisions:timeout");
            } else {
              console.error("[steward] decision log read failed:", e instanceof Error ? e.message.slice(0, 200) : "error");
              degrade("steward_decisions");
            }
          }
        }
      }
    }

    const recentFor = (roomId: string, fleet: RecentContext["fleet"]): RecentContext => ({ room: mem.recentRows.get(roomId) ?? [], fleet });

    // --- pass 1 (no fleet context) -> who carries a POSITIVE failure signal, and of which class (F1)
    const failingRooms: Record<string, string[]> = {};
    const noFleet: RecentContext["fleet"] = { failing: {}, hold: {} };
    for (const room of roster) {
      const sense = senses.get(room.room_id);
      if (!sense) continue;
      const ds = decideRoom(sense, cfg, A, recentFor(room.room_id, noFleet));
      const cls = failingClass(ds);
      if (cls) (failingRooms[cls] ??= []).push(room.room_id);
      // a positive signal recorded in the last 5 minutes still counts toward "the same way within 5 min"; rows without failing_class (a room that merely had not started) never do
      for (const r of mem.recentRows.get(room.room_id) ?? []) {
        const t = Date.parse(r.ts);
        if (r.failing_class && FAILING_RULES.includes(r.failing_class) && A - t <= FLEET_COUNT_WINDOW_MS && t <= A) (failingRooms[r.failing_class] ??= []).push(room.room_id);
      }
    }
    const failing: Record<string, number> = {};
    for (const [cls, rooms] of Object.entries(failingRooms)) failing[cls] = new Set(rooms).size;
    const hold: Record<string, boolean> = {};
    for (const fr of mem.fleetRows) {
      const cls = objOf(fr.params).class;
      if (typeof cls === "string") hold[cls] = true;
    }
    const fleetCtx: RecentContext["fleet"] = { failing, hold };

    // --- pass 2 + dedupe + shadow execution
    const rows: OutRow[] = [];
    let budgetHit = false;
    // a live start waits for the kiosk's ack: never longer than the time left before the INSERT reserve (1 s floor, 8 s ceiling)
    const executorFor =
      opts.executorFor ??
      ((live: boolean) => (live ? new LiveExecutor({ ackTimeoutMs: Math.max(1000, Math.min(8000, cfg.live_call_timeout_ms - 1000, t0 + opts.budgetMs - INSERT_RESERVE_MS - now())), maxAttempts: cfg.caps.start_retries }) : new ShadowExecutor()));

    // rows written BEFORE the tick's single INSERT: one "sending" row per live send (F19)
    let earlyWritten = 0;
    const rowOf = (d: Decision, primary: boolean, seq: number, mode: "shadow" | "live", result: string | null, extra: Record<string, unknown> = {}): OutRow => ({
      room_id: d.room_id,
      machine: d.machine,
      window_kind: d.window_kind,
      rule: d.rule,
      action: d.action,
      params: d.params,
      mode,
      result,
      why: d.why,
      why_not: d.why_not,
      inputs_hash: d.inputs_hash,
      inputs: { ...d.inputs, tick: asOfIso, primary, seq, ...(memoryDegraded ? { memory_degraded: true } : {}), ...extra },
      ts: asOfIso,
    });
    const setResult = (id: unknown, mode: "shadow" | "live", result: string | null, patch: Record<string, unknown>) =>
      sql`UPDATE steward_decisions SET mode = ${mode}, result = ${result}, inputs = inputs || ${JSON.stringify(patch)}::jsonb WHERE id = ${String(id)}::bigint AND result = 'sending'`;

    /**
     * A LIVE send (F19): (1) refuse when under LIVE_MIN_BUDGET_MS of budget is left ("skipped: budget"); (2) write a "sending" row in its OWN statement (same dedupe key, inputs.attempt_no)
     * — no row, no send; (3) run the executor under live_call_timeout_ms; (4) update THAT row to ok / failed / skipped by id. A hung send leaves the "sending" row (the bench_command table
     * is the truth about whether a command was queued) and the tick goes on. F44: steps 1-2 and the flag re-read run here; the executor call is STARTED but not awaited: `finish`
     * collects it (after every room has been issued). Returns the row to add to the tick's INSERT (or null when the row already exists in the log), and `finish` when a send is in flight.
     */
    type LiveOut = { row: OutRow | null; finish?: () => Promise<OutRow | null> };
    const liveSend = async (d: Decision, primary: boolean, seq: number): Promise<LiveOut> => {
      if (t0 + opts.budgetMs - now() < LIVE_MIN_BUDGET_MS) {
        degrade("live_budget");
        return { row: rowOf(d, primary, seq, "live", "skipped: budget") };
      }
      const attemptNo = (typeof d.inputs.attempts === "number" ? d.inputs.attempts : 0) + 1;
      const sendingRow = rowOf(d, primary, seq, "live", "sending", { attempt_no: attemptNo });
      let id: unknown = null;
      try {
        const ins = await insertRows(sql, [sendingRow]);
        id = (ins[0] as { id?: unknown } | undefined)?.id ?? null;
      } catch {
        console.error("[steward] the sending row could not be written: no live send");
      }
      if (id === null || id === undefined) {
        degrade("steward_decisions");
        return { row: rowOf(d, primary, seq, "shadow", "blocked: audit row not written, nothing sent", { attempt_no: attemptNo }) };
      }
      earlyWritten++;
      const t1 = now();
      // the switches are read AGAIN, from the table, immediately before the send (one bound SELECT): a tick that started before an operator flipped kill_switch / start_day_live / shadow must not send.
      // Anything but "scribe_start is still live" — including an unreadable table — skips; the row says so.
      {
        let stillLive = false;
        let why = "flag_off_at_send";
        try {
          const keys = ["kill_switch", "start_day_live", "shadow"];
          const rowsNow = (await raceTimeout(() => sql`SELECT key, value FROM steward_config WHERE key = ANY(${keys}::text[])`, Math.min(cfg.source_timeout_ms, 3000))) as Array<{ key: string; value: unknown }>;
          const fresh = parseConfig(rowsNow.filter((r) => keys.includes(r.key))).config;
          stillLive = actionMode({ ...cfg, kill_switch: fresh.kill_switch, start_day_live: fresh.start_day_live, shadow: fresh.shadow }, d.action) === "live";
        } catch {
          why = "flag_unreadable_at_send";
        }
        if (!stillLive) {
          const skipped = `skipped: ${why}`;
          try {
            await setResult(id, "live", skipped, { call_ms: 0 });
            return { row: null };
          } catch {
            degrade("steward_decisions");
            return { row: rowOf(d, primary, seq, "live", skipped, { attempt_no: attemptNo }) };
          }
        }
      }
      const call = (async () => dispatch(executorFor(true), d))();
      call.catch(() => {}); // collected later by `finish`; a rejection before then must not be unhandled
      const finish = async (): Promise<OutRow | null> => {
        let mode: "shadow" | "live" = "live";
        let result: string | null;
        try {
          result = (await raceTimeout(() => call, Math.max(0, cfg.live_call_timeout_ms - (now() - t1))))?.result ?? null;
        } catch (e) {
          if (e instanceof SourceTimeout) {
            // the "sending" row stays; if the call finishes later in this process, the row is updated then (best effort)
            degrade("live_call_timeout");
            console.error("[steward] live call timed out: the sending row stays");
            call.then((r) => setResult(id, "live", r?.result ?? null, { call_ms: now() - t1, late: true })).catch(() => {});
            return null;
          }
          result = `blocked: ${e instanceof Error ? e.message.slice(0, 120) : LIVE_EXECUTOR_DISABLED}`;
          mode = "shadow";
          degrade("live_executor");
        }
        try {
          await setResult(id, mode, result, { call_ms: now() - t1 });
          return null;
        } catch {
          console.error("[steward] the sending row could not be updated: the result goes in a new row");
          degrade("steward_decisions");
          return rowOf(d, primary, seq, mode, result, { attempt_no: attemptNo });
        }
      };
      return { row: null, finish };
    };

    /** F44: the live sends issued in this tick whose acks are still to be collected */
    const inflight: Array<() => Promise<OutRow | null>> = [];
    const record = async (d: Decision, primary: boolean, seq: number): Promise<void> => {
      let mode: "shadow" | "live" = "shadow";
      let result: string | null = null;
      if (d.action !== "none" && d.action !== "log_only") {
        // config.actionMode: executes only if kill_switch off AND shadow.global false AND shadow.actions[action] !== true AND the action is live-capable
        let am = actionMode(cfg, d.action);
        // a LIVE scribe_start must also pass its gates (kiosk-health heartbeat <= 180 s, recorder ready + no session for >= 5 min, ...): the first failing gate is the result, nothing is sent
        const gateFail = am === "live" && d.action === "scribe_start" && typeof d.inputs.start_gate_fail === "string" ? d.inputs.start_gate_fail : null;
        // F20: the hard never-live list, checked here again whatever the rules said
        const neverLive = am === "live" && d.action === "scribe_start" && !gateFail && isNeverLiveRoom(d.room_id);
        if (gateFail || neverLive) {
          am = "shadow";
          result = `shadow: ${gateFail ?? "never_live_room"}`;
        }
        if (am === "kill_switch") {
          result = "kill_switch";
        } else if (gateFail || neverLive) {
          // result already set above; nothing executes
        } else if (am === "live") {
          const out = await liveSend(d, primary, seq);
          if (out.row) rows.push(out.row);
          if (out.finish) inflight.push(out.finish);
          return;
        } else {
          try {
            result = (await dispatch(executorFor(false), d))?.result ?? null;
          } catch (e) {
            result = `blocked: ${e instanceof Error ? e.message.slice(0, 120) : LIVE_EXECUTOR_DISABLED}`;
            degrade("live_executor");
          }
        }
      }
      rows.push(rowOf(d, primary, seq, mode, result));
    };

    let processed = 0;
    let fleetDs: Decision[] = [];
    // R4 (F44.1): fire -> collect is try/finally. If anything throws between a send and the collect, every in-flight row is still settled (none is left "sending");
    // the rows already built are then written best-effort and the error goes on to the tick's soft failure.
    let threw = true;
    try {
      for (const room of roster) {
        if (now() - t0 >= opts.budgetMs) {
          budgetHit = true;
          degrade("budget");
          break;
        }
        const sense = senses.get(room.room_id);
        if (!sense) continue;
        processed++;
        const ds = decideRoom(sense, cfg, A, recentFor(room.room_id, fleetCtx));
        const last = mem.lastPrimary.get(room.room_id);
        const lastTs = last ? toIso(last.ts) : null;
        for (let i = 0; i < ds.length; i++) {
          const d = ds[i]!;
          if (i === 0) {
            // A start that would EXECUTE now is never swallowed by a previous row that executed nothing (e.g. "shadow: recorder_ready_under_5m" a minute ago, same key): the attempt goes through.
            const wouldGoLive = d.action === "scribe_start" && actionMode(cfg, "scribe_start") === "live" && typeof d.inputs.start_gate_fail !== "string";
            // F21: a retry the schedule allows (the rules only emit scribe_start when the verdict is "go") is exempt from the 15-min dedupe, so the 5 / 15 / 45 min schedule is real. Only a
            // send still in flight ("sending") or a "skipped:" row younger than 5 min (kiosk not listening, ...) holds the key.
            const lastR = typeof last?.result === "string" ? last.result : "";
            const holdsKey = /^(sending|pending)/.test(lastR) || (/^skipped/.test(lastR) && lastTs !== null && A - Date.parse(lastTs) < 5 * 60_000);
            const same = last && lastTs && keyOf({ rule: last.rule, action: last.action, params: objOf(last.params) }) === keyOf(d) && A - Date.parse(lastTs) < DEDUPE_REFRESH_MS && !(wouldGoLive && !holdsKey);
            if (same) continue;
          } else {
            const k = keyOf(d);
            const dup = (mem.recentRows.get(room.room_id) ?? []).some((r) => keyOf(r) === k && A - Date.parse(r.ts) < DEDUPE_REFRESH_MS);
            if (dup) continue;
          }
          await record(d, i === 0, i);
        }
      }

      // --- fleet incidents (one decision per class)
      fleetDs = budgetHit ? [] : fleetDecisions(failingRooms);
      for (const d of fleetDs) {
        const k = keyOf(d);
        const dup = mem.fleetRows.some((r) => keyOf({ rule: r.rule, action: r.action, params: objOf(r.params) }) === k && A - Date.parse(toIso(r.ts) ?? "") < DEDUPE_REFRESH_MS);
        // the room list can change between ticks while the incident is the same: dedupe on the class alone
        const dupClass = mem.fleetRows.some((r) => objOf(r.params).class === d.params.class && A - Date.parse(toIso(r.ts) ?? "") < DEDUPE_REFRESH_MS);
        if (dup || dupClass) continue;
        await record(d, true, 0);
      }
      threw = false;
    } finally {
      // --- F44: collect the acks of every start issued this tick, together (each bounded by live_call_timeout_ms from its own send; the executor's ack wait is already capped to the budget)
      for (const o of await Promise.all(inflight.map((f) => f()))) if (o) rows.push(o);
      if (threw && rows.length > 0) await insertRows(sql, rows).catch(() => []);
    }

    // --- ONE insert (always attempted when there is something to write)
    let written = 0;
    if (rows.length > 0) {
      written = (await insertRows(sql, rows)).length;
    }
    return summary({ rooms: processed, decisions_written: written + earlyWritten, kill_switch: cfg.kill_switch, budget_hit: budgetHit, fleet_incidents: fleetDs.length });
  };

  let result: StewardSummary;
  try {
    result = await body();
  } catch (e) {
    // Anything not handled above: the tick fails soft, the lease is still released, the cron answers 200 with the degraded list.
    console.error("[steward] tick failed:", e instanceof Error ? e.message.slice(0, 200) : "error");
    degrade("tick");
    result = summary({});
  }
  // --- release the lease; the last_tick summary rides in the same statement (one round trip). No secrets, no PHI: counts, flags and source names.
  const tick = tickSummary(asOfIso, result);
  try {
    await lock.release(tick);
  } catch {
    console.error("[steward] lock release failed");
  }
  console.log(JSON.stringify({ evt: "steward.tick", ...tick }));
  return result;
}

/** The last_tick value and the steward.tick log line. */
export function tickSummary(at: string, s: StewardSummary): Record<string, unknown> {
  return { at, elapsed_ms: s.elapsed_ms, rooms: s.rooms, decisions_written: s.decisions_written, degraded: s.degraded, budget_hit: s.budget_hit };
}

function configUnavailable(summary: (over: Partial<StewardSummary>) => StewardSummary, degraded: string[], elapsed: number): StewardSummary {
  const s = summary({ ok: false, reason: "config_unavailable", elapsed_ms: elapsed });
  console.log(JSON.stringify({ evt: "steward.tick", reason: "config_unavailable", elapsed_ms: s.elapsed_ms, rooms: 0, decisions_written: 0, degraded, budget_hit: false }));
  return s;
}
