/**
 * lib/steward/loop.ts — Room Steward part 2: the one-minute SHADOW control loop.
 *
 *   runSteward(sql, { asOf, budgetMs }): lock -> config -> roster -> senseAll -> decide (two passes, for the fleet-incident count) -> dedupe -> shadow-execute -> ONE INSERT.
 *
 * SHADOW ONLY. The executor the loop uses is ShadowExecutor: it never calls Scribe, never issues a ticket, never messages. With the kill switch ON (the seed) every
 * actionable decision is recorded with result "kill_switch"; with it OFF and shadow on, "shadow: would <action>". Asking for LIVE (shadow off for an action) selects the
 * LiveExecutor stub, which throws; the loop records the decision as shadow with result "blocked: live executor not enabled in P0" and names it in `degraded`.
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
import { buildRoster, loadConfig, type Config, type RosterRow } from "./config";
import { LIVE_EXECUTOR_DISABLED, LiveExecutor, ShadowExecutor, dispatch, type Executor } from "./executor";
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
     LIMIT 3000
  `) as DbRow[];
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
        SELECT r.id AS room_id, r.name AS room_name, ri.hostname, ri.state_flags
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
        try {
          mem = await raceTimeout(() => loadRecent(sql, roster.map((r) => r.room_id), A), Math.min(cfg.source_timeout_ms, left));
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
    const executorFor = opts.executorFor ?? ((live: boolean) => (live ? new LiveExecutor() : new ShadowExecutor()));

    const record = async (d: Decision, primary: boolean, seq: number): Promise<void> => {
      let mode: "shadow" | "live" = "shadow";
      let result: string | null = null;
      if (d.action !== "none" && d.action !== "log_only") {
        if (cfg.kill_switch) {
          result = "kill_switch";
        } else {
          const shadow = cfg.shadow.actions[d.action] ?? cfg.shadow.global;
          try {
            result = (await dispatch(executorFor(!shadow), d))?.result ?? null;
            if (!shadow) mode = "live";
          } catch (e) {
            result = `blocked: ${e instanceof Error ? e.message.slice(0, 120) : LIVE_EXECUTOR_DISABLED}`;
            mode = "shadow";
            degrade("live_executor");
          }
        }
      }
      rows.push({
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
        inputs: { ...d.inputs, tick: asOfIso, primary, seq, ...(memoryDegraded ? { memory_degraded: true } : {}) },
        ts: asOfIso,
      });
    };

    let processed = 0;
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
          const same = last && lastTs && keyOf({ rule: last.rule, action: last.action, params: objOf(last.params) }) === keyOf(d) && A - Date.parse(lastTs) < DEDUPE_REFRESH_MS;
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
    const fleetDs = budgetHit ? [] : fleetDecisions(failingRooms);
    for (const d of fleetDs) {
      const k = keyOf(d);
      const dup = mem.fleetRows.some((r) => keyOf({ rule: r.rule, action: r.action, params: objOf(r.params) }) === k && A - Date.parse(toIso(r.ts) ?? "") < DEDUPE_REFRESH_MS);
      // the room list can change between ticks while the incident is the same: dedupe on the class alone
      const dupClass = mem.fleetRows.some((r) => objOf(r.params).class === d.params.class && A - Date.parse(toIso(r.ts) ?? "") < DEDUPE_REFRESH_MS);
      if (dup || dupClass) continue;
      await record(d, true, 0);
    }

    // --- ONE insert (always attempted when there is something to write)
    let written = 0;
    if (rows.length > 0) {
      const inserted = (await sql`
        INSERT INTO steward_decisions (ts, room_id, machine, window_kind, rule, action, params, mode, result, actor, why, why_not, inputs_hash, inputs)
        SELECT x.ts, x.room_id, x.machine, x.window_kind, x.rule, x.action, x.params, x.mode, x.result, 'steward', x.why, x.why_not, x.inputs_hash, x.inputs
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
            ts timestamptz, room_id text, machine text, window_kind text, rule text, action text, params jsonb, mode text, result text,
            why text, why_not text, inputs_hash text, inputs jsonb)
        RETURNING id
      `) as unknown[];
      written = inserted.length;
    }
    return summary({ rooms: processed, decisions_written: written, kill_switch: cfg.kill_switch, budget_hit: budgetHit, fleet_incidents: fleetDs.length });
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
