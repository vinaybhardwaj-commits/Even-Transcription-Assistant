/**
 * lib/steward/loop.ts — the shadow loop, with an in-memory stand-in for the database and a controlled sense: dedupe, lock, budget, kill switch / shadow / live-blocked,
 * degraded sources, fleet incidents, processing order. Real SQL is proven in steward-pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ago, failedAttempt, healthy, idle, ist, pendingAttempt, readyRecorder } from "../support/steward-fixtures";
import type { RoomSense } from "@/lib/steward/sense";

const M = vi.hoisted(() => ({ senseAll: vi.fn() }));
vi.mock("@/lib/steward/sense", () => ({ senseAll: M.senseAll }));
vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));

import { DEDUPE_REFRESH_MS, RECENT_ROWS_LIMIT, leaseLock, outcomeOf, runSteward, type LoopLock } from "@/lib/steward/loop";
import { LiveExecutor, ShadowExecutor, dispatch, type StartDeps } from "@/lib/steward/executor";
import { decideStart } from "@/lib/bench-commands";
import { startVerdict } from "@/lib/steward/start-schedule";
import type { Decision } from "@/lib/steward/rules";

type Stored = { id: number; room_id: string | null; ts: string; rule: string; action: string; params: Record<string, unknown>; result: string | null; mode: string; inputs: Record<string, unknown>; why: string; why_not: string | null; actor: string; machine: string | null; window_kind: string; inputs_hash: string };

/** A fake of the Neon tag that answers exactly the statements the loop sends. */
function fakeDb(opts: { cfg?: Record<string, unknown>; dropCfg?: string[]; rooms?: Array<{ room_id: string; room_name: string; hostname: string | null }>; fail?: Array<RegExp>; hang?: Array<RegExp>; delay?: Array<[RegExp, number]>; onStmt?: (text: string) => void } = {}) {
  const cfg: Record<string, unknown> = {
    kill_switch: { on: true },
    shadow: { global: true, actions: {} },
    schedule: { clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 }, ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 } },
    days: { mode: "every_day", closed: [] },
    caps: { actions_per_room_per_hour: 4, policy_cycle_per_profile_per_day: 1, start_retries: 3 },
    priority: { order: ["ot", "opd", "clinic"] },
    rooms: {},
    ...opts.cfg,
  };
  for (const k of opts.dropCfg ?? []) delete cfg[k];
  const state = { cfg, rooms: opts.rooms ?? [{ room_id: "room_a", room_name: "OPD A", hostname: "HOST-A" }], table: [] as Stored[], calls: [] as string[], nextId: 1, bench: new Map<string, { id: string; status: string; error: string | null; created_at: string }>() };
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("?");
    state.calls.push(text.replace(/\s+/g, " ").trim().slice(0, 60));
    for (const re of opts.fail ?? []) if (re.test(text)) throw new Error("boom");
    for (const re of opts.hang ?? []) if (re.test(text)) return new Promise(() => {});
    opts.onStmt?.(text);
    for (const [re, ms] of opts.delay ?? []) if (re.test(text)) await new Promise<void>((r) => setTimeout(r, ms));
    if (text.includes("SELECT key, value FROM steward_config")) return Object.entries(state.cfg).map(([key, value]) => ({ key, value }));
    if (text.includes("FROM room r")) return state.rooms.map((r) => ({ ...r, state_flags: null }));
    if (text.includes("DISTINCT ON (d.room_id)")) {
      const best = new Map<string, Stored>();
      for (const r of state.table) if (r.room_id && r.inputs.primary === true) {
        const p = best.get(r.room_id);
        if (!p || r.ts > p.ts || (r.ts === p.ts && r.id > p.id)) best.set(r.room_id, r);
      }
      return [...best.values()];
    }
    if (text.includes("d.action <> 'none'"))
      return state.table
        .filter((r) => r.room_id && r.action !== "none")
        .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id))
        .map((r) => ({ ...r, failing_class: (r.inputs.failing_class as string | undefined) ?? null }));
    if (text.includes("d.rule = 'fleet_incident'")) {
      // bound: ts in (hi - hold_secs, hi]  (v = [hi, hold_secs, hi])
      const hiMs = Date.parse(String(v[0]));
      const holdMs = Number(v[1]) * 1000;
      return state.table.filter((r) => r.room_id === null && r.rule === "fleet_incident" && Date.parse(r.ts) > hiMs - holdMs && Date.parse(r.ts) <= hiMs).sort((a, b) => (a.ts < b.ts ? 1 : -1));
    }
    if (text.includes("d.result LIKE 'pending%'")) return state.table.filter((r) => r.action === "scribe_start" && r.mode === "live" && (r.result ?? "").startsWith("pending"));
    if (text.includes("AND d.result LIKE ? AND d.ts")) {
      // F44.1 R3 read: rows settled "failed: no ack after 120 s" in the last 30 min (v = [pattern, hi, minutes, hi])
      const hiMs = Date.parse(String(v[1]));
      return state.table.filter((r) => r.action === "scribe_start" && r.mode === "live" && (r.result ?? "").startsWith("failed: no ack after 120 s") && Date.parse(r.ts) > hiMs - Number(v[2]) * 60_000);
    }
    if (text.includes("d.result LIKE 'ok: start_day deferred")) return []; // arch#17 reviseDeferredOk read: nothing to revise (the one allowed change to this fake)
    if (text.includes("FROM bench_command WHERE id = ANY")) return (v[0] as string[]).flatMap((id) => (state.bench.has(id) ? [state.bench.get(id)!] : []));
    if (text.includes("UPDATE steward_decisions") && text.includes("AND result LIKE ?")) {
      // F44.1 R3: a "failed: no ack after 120 s" row -> "ok ... (late, after 120 s)" (v = [result, inputs patch, id, pattern])
      const row = state.table.find((r) => String(r.id) === String(v[2]) && (r.result ?? "").startsWith("failed: no ack after 120 s"));
      if (row) {
        row.result = v[0] as string;
        Object.assign(row.inputs, JSON.parse(String(v[1])));
      }
      return [];
    }
    if (text.includes("AND result LIKE 'pending%'")) {
      // F44 reconcile: a pending row -> its settled result, by id (v = [result, inputs patch, id])
      const row = state.table.find((r) => String(r.id) === String(v[2]) && (r.result ?? "").startsWith("pending"));
      if (row) {
        row.result = v[0] as string;
        Object.assign(row.inputs, JSON.parse(String(v[1])));
      }
      return [];
    }
    if (text.includes("UPDATE steward_decisions")) {
      // the live send's "sending" row -> its final result, by id (v = [mode, result, inputs patch, id])
      const row = state.table.find((r) => String(r.id) === String(v[3]) && r.result === "sending");
      if (row) {
        row.mode = String(v[0]);
        row.result = v[1] as string | null;
        Object.assign(row.inputs, JSON.parse(String(v[2])));
      }
      return [];
    }
    if (text.includes("INSERT INTO steward_decisions")) {
      const rows = JSON.parse(String(v[0])) as Array<Omit<Stored, "id" | "actor">>;
      return rows.map((r) => {
        const s: Stored = { ...r, id: state.nextId++, actor: "steward" };
        state.table.push(s);
        return { id: s.id };
      });
    }
    throw new Error(`fake db: unexpected statement ${text.slice(0, 80)}`);
  }) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  return { sql, state };
}

const okLock = (): LoopLock & { acquired: number; released: number; lastTick: Record<string, unknown> | null } => {
  const l = {
    acquired: 0,
    released: 0,
    lastTick: null as Record<string, unknown> | null,
    acquire: async () => (l.acquired++, true),
    release: async (t?: Record<string, unknown>) => {
      l.released++;
      l.lastTick = t ?? null;
    },
  };
  return l;
};

/** senseAll mock: every roster room gets `mk(room, A)`. */
const senseWith = (mk: (roomId: string, A: number) => RoomSense) =>
  M.senseAll.mockImplementation(async (_sql: unknown, A: number, roster: Array<{ room_id: string }>) => new Map(roster.map((r) => [r.room_id, mk(r.room_id, A)])));

const T = ist("10:00");
const MIN = 60_000;
/** a room whose session died: open, no chunk for 12 min, recorder.status stale */
const died = (A: number, id: string) => healthy(A, { room_id: id, recording: { last_chunk_at: ago(A, 720), recorder_status: { state: "recording", session_open: true, received_at: ago(A, 300) } } });
const run = (sql: ReturnType<typeof fakeDb>["sql"], asOf: number, extra: Record<string, unknown> = {}) => runSteward(sql as never, { asOf, budgetMs: 20_000, lock: okLock(), ...extra });

beforeEach(() => {
  M.senseAll.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("dedupe", () => {
  it("the same decision twice within 10 minutes is ONE row; after 15 minutes a second row; a changed decision writes at once", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id }));
    const a = await run(db.sql, T);
    expect(a).toMatchObject({ rooms: 1, decisions_written: 1, skipped_lock: false });
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]).toMatchObject({ rule: "not_recording", action: "scribe_start", mode: "shadow", result: "kill_switch", actor: "steward" });

    expect((await run(db.sql, T + 10 * MIN)).decisions_written).toBe(0);
    expect(db.state.table).toHaveLength(1);

    expect((await run(db.sql, T + DEDUPE_REFRESH_MS + MIN)).decisions_written).toBe(1);
    expect(db.state.table).toHaveLength(2);

    // the room recovers: a different primary decision is written at once, inside the 15 minutes
    senseWith((id, A) => healthy(A, { room_id: id }));
    expect((await run(db.sql, T + DEDUPE_REFRESH_MS + 2 * MIN)).decisions_written).toBe(1);
    expect(db.state.table[2]).toMatchObject({ rule: "ok", action: "none", result: null });
  });

  it("a two-decision tick (wake + message) is deduped per decision on the next tick", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id, reachable: { poller_ok_at: ago(A, 700), kh_heartbeat_at: ago(A, 700) } }));
    expect((await run(db.sql, T)).decisions_written).toBe(2);
    expect(db.state.table.map((r) => [r.action, r.inputs.primary, r.inputs.seq])).toEqual([["ticket:wake", true, 0], ["message", false, 1]]);
    expect((await run(db.sql, T + 2 * MIN)).decisions_written).toBe(0);
  });

  it("the row carries ts = asOf, the tick, no names; params and inputs_hash as decided", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id }));
    await run(db.sql, T);
    const r = db.state.table[0]!;
    expect(r.ts).toBe(new Date(T).toISOString());
    expect(r.inputs).toMatchObject({ tick: new Date(T).toISOString(), primary: true, seq: 0 });
    expect(JSON.stringify(r)).not.toContain("OPD A");
    expect(r.inputs_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(r.machine).toBe("HOST-A");
    expect(r.window_kind).toBe("clinic");
  });
});

describe("lock", () => {
  it("a held lock skips the whole tick: nothing is read, nothing sensed, nothing written", async () => {
    const db = fakeDb();
    const lock: LoopLock = { acquire: async () => false, release: vi.fn(async () => {}) };
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock });
    expect(s).toMatchObject({ skipped_lock: true, rooms: 0, decisions_written: 0 });
    // only the config read happened (config is read before the lease, F8); no roster, no sense, no decision log, no insert
    expect(db.state.calls).toEqual(["SELECT key, value FROM steward_config"]);
    expect(M.senseAll).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it("the lock is released after a normal tick and after a crashed one; a lock that cannot be taken is a skip with degraded 'lock'", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id }));
    const l1 = okLock();
    await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock: l1 });
    expect(l1.released).toBe(1);

    M.senseAll.mockRejectedValue(new Error("sense exploded"));
    const l2 = okLock();
    const s = await runSteward(db.sql as never, { asOf: T + 20 * MIN, budgetMs: 20_000, lock: l2 });
    expect(s.degraded).toContain("sense");
    expect(l2.released).toBe(1);
    // a crash outside every guarded step (here: the decision INSERT) is the 'tick' catch: still released
    M.senseAll.mockReset();
    senseWith((id, A) => idle(A, { room_id: id }));
    const crashing = fakeDb({ fail: [/INSERT INTO steward_decisions/] });
    const l3 = okLock();
    expect((await runSteward(crashing.sql as never, { asOf: T, budgetMs: 20_000, lock: l3 })).degraded).toContain("tick");
    expect(l3.released).toBe(1);

    const bad: LoopLock = { acquire: async () => { throw new Error("db down"); }, release: async () => {} };
    expect(await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock: bad })).toMatchObject({ skipped_lock: true, degraded: ["lock"] });
  });

  it("leaseLock takes and releases one steward_config row with bound parameters", async () => {
    const seen: Array<{ text: string; v: unknown[] }> = [];
    const sql = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      seen.push({ text: s.join("?"), v });
      return seen.length === 1 ? [{ key: "loop_lease" }] : [];
    }) as never;
    const lock = leaseLock(sql, { holder: "h1", ttlSeconds: 55 });
    expect(await lock.acquire()).toBe(true);
    await lock.release();
    expect(seen[0]!.text).toContain("ON CONFLICT (key) DO UPDATE");
    expect(seen[0]!.v).toEqual(expect.arrayContaining(["loop_lease", "h1", 55]));
    expect(seen[1]!.text).toContain("UPDATE steward_config");
  });
});

describe("budget", () => {
  it("stops cleanly when the budget is spent: the rooms done so far are written, the lock is released, budget_hit is reported", async () => {
    const db = fakeDb({ rooms: ["room_a", "room_b", "room_c"].map((id, i) => ({ room_id: id, room_name: `R${i}`, hostname: `H${i}` })) });
    senseWith((id, A) => idle(A, { room_id: id }));
    let t = 0;
    const lock = okLock();
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock, now: () => (t += 4000) }); // 4 s a call: the F44.1 recompute of `left` after the reconcile is one more clock read than before
    expect(s).toMatchObject({ rooms: 2, decisions_written: 2, budget_hit: true });
    expect(s.degraded).toContain("budget");
    expect(db.state.table.map((r) => r.room_id)).toEqual(["room_a", "room_b"]);
    expect(lock.released).toBe(1);
  });
});

describe("kill switch, shadow and the live executor that is not there", () => {
  it("kill switch ON (the seed): every actionable decision is shadow with result 'kill_switch'; none/log_only carry no result; no executor is called", async () => {
    const spy = { scribeStart: vi.fn(), scribeStop: vi.fn(), scribeRestart: vi.fn(), issueTicket: vi.fn(), message: vi.fn() };
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id }));
    await run(db.sql, T, { executorFor: () => spy });
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: "kill_switch" });
    expect(Object.values(spy).every((f) => f.mock.calls.length === 0)).toBe(true);
    senseWith((id, A) => healthy(A, { room_id: id }));
    await run(db.sql, T + 20 * MIN);
    expect(db.state.table[1]).toMatchObject({ action: "none", result: null });
  });

  it("kill switch OFF, shadow ON: the shadow executor records 'shadow: would <action>' (and nothing else happens)", async () => {
    const db = fakeDb({ cfg: { kill_switch: { on: false } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    const s = await run(db.sql, T);
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: "shadow: would scribe_start" });
    expect(s.kill_switch).toBe(false);
  });

  it("asking for LIVE on an action the live executor does not implement reaches the throwing method: the row stays shadow, the result says blocked, 'live_executor' is degraded", async () => {
    // ticket:wake is live-capable by name, but LiveExecutor.issueTicket throws (only scribe_start is built)
    const db = fakeDb({ cfg: { kill_switch: { on: false }, shadow: { global: false, actions: {} } } });
    senseWith((id, A) => idle(A, { room_id: id, reachable: { poller_ok_at: ago(A, 300), kh_heartbeat_at: ago(A, 300) } }));
    const s = await run(db.sql, T);
    expect(db.state.table[0]).toMatchObject({ action: "ticket:wake", mode: "shadow" });
    expect(db.state.table[0]!.result).toContain("live executor not enabled in P0");
    expect(s.degraded).toContain("live_executor");
  });

  it("(d) a per-action `false` no longer lifts an action while shadow.global is true (global true shadows everything)", async () => {
    const db2 = fakeDb({ cfg: { kill_switch: { on: false }, shadow: { global: true, actions: { scribe_start: false } } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    const live = { scribeStart: vi.fn(), scribeStop: vi.fn(), scribeRestart: vi.fn(), issueTicket: vi.fn(), message: vi.fn() };
    await run(db2.sql, T, { executorFor: (l: boolean) => (l ? live : new ShadowExecutor()) });
    expect(db2.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: "shadow: would scribe_start" });
    expect(Object.values(live).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("the executors: Shadow records, Live throws, dispatch routes by action and ignores none/log_only", async () => {
    const d = (action: string) => ({ action, params: {} }) as unknown as Decision;
    const sh = new ShadowExecutor();
    expect(await dispatch(sh, d("scribe_restart"))).toEqual({ result: "shadow: would scribe_restart" });
    expect(await dispatch(sh, d("ticket:wake"))).toEqual({ result: "shadow: would ticket:wake" });
    expect(await dispatch(sh, d("message"))).toEqual({ result: "shadow: would message" });
    expect(await dispatch(sh, d("none"))).toBeNull();
    expect(await dispatch(sh, d("log_only"))).toBeNull();
    // the live executor implements scribe_start only (steward-executor.test.ts); every other method throws
    for (const a of ["scribe_stop", "scribe_restart", "ticket:wake", "message"]) await expect(dispatch(new LiveExecutor(), d(a))).rejects.toThrow("live executor not enabled in P0");
  });

  it("outcomeOf maps results to the rules' memory", () => {
    expect([outcomeOf(null), outcomeOf("kill_switch"), outcomeOf("shadow: would x"), outcomeOf("blocked: x"), outcomeOf("failed: x"), outcomeOf("ok")]).toEqual([null, "shadow", "shadow", "shadow", "failed", "ok"]);
  });
});

describe("degraded sources never throw the tick", () => {
  it("a source that fails is named and the rules see nulls: the tick still decides and writes", async () => {
    const db = fakeDb();
    M.senseAll.mockImplementation(async (_s: unknown, A: number, roster: Array<{ room_id: string }>, degraded: string[]) => {
      degraded.push("presence_poller");
      return new Map(roster.map((r) => [r.room_id, healthy(A, { room_id: r.room_id, reachable: { poller_ok_at: null }, missing: ["presence_poller"] })]));
    });
    const s = await run(db.sql, T);
    expect(s.degraded).toContain("presence_poller");
    expect(db.state.table[0]).toMatchObject({ rule: "sense_degraded", action: "log_only" });
  });

  it("an invalid key (caps) falls back to the seed default and is named; the kill switch falls back ON", async () => {
    const db2 = fakeDb({ cfg: { caps: { actions_per_room_per_hour: "x" } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    expect((await run(db2.sql, T)).degraded).toContain("config:caps");
    const db3 = fakeDb({ cfg: { kill_switch: "yes" } });
    senseWith((id, A) => idle(A, { room_id: id }));
    const s3 = await run(db3.sql, T);
    expect(s3.kill_switch).toBe(true);
    expect(db3.state.table[0]!.result).toBe("kill_switch");
  });

  it("an unreadable roster ends the tick with rooms 0; an unreadable decision log does NOT end the tick: it decides without memory, flags inputs.memory_degraded and still INSERTs (F3)", async () => {
    senseWith((id, A) => idle(A, { room_id: id }));
    const a = fakeDb({ fail: [/FROM room r/] });
    expect(await run(a.sql, T)).toMatchObject({ rooms: 0, decisions_written: 0 });
    const b = fakeDb({ fail: [/DISTINCT ON \(d\.room_id\)/] });
    const s = await run(b.sql, T);
    expect(s.degraded).toContain("steward_decisions");
    expect(s.decisions_written).toBe(1);
    expect(b.state.table).toHaveLength(1);
    expect(b.state.table[0]!.inputs).toMatchObject({ memory_degraded: true, primary: true });
  });

  it("test and dev rooms are not in the roster: nothing is sensed or written for them", async () => {
    const db = fakeDb({
      cfg: { rooms: { room_t: { flags: ["dev", "test"], machine: "ORBOX3" } } },
      rooms: [{ room_id: "room_t", room_name: "ORB3", hostname: "ORBOX3" }, { room_id: "room_a", room_name: "OPD A", hostname: "HOST-A" }],
    });
    senseWith((id, A) => idle(A, { room_id: id }));
    await run(db.sql, T);
    expect(db.state.table.map((r) => r.room_id)).toEqual(["room_a"]);
  });
});

describe("ordering and fleet incidents", () => {
  it("rooms are processed ot first, then clinic", async () => {
    const db = fakeDb({
      cfg: { rooms: { room_ot: { class: "ot", flags: [], machine: "ORB2" } } },
      rooms: [{ room_id: "room_a", room_name: "A", hostname: "HA" }, { room_id: "room_ot", room_name: "Z", hostname: null }],
    });
    senseWith((id, A) => idle(A, { room_id: id, ...(id === "room_ot" ? { klass: "ot", kind: "ot" } : {}) }));
    await run(db.sql, T);
    expect(db.state.table.map((r) => r.room_id)).toEqual(["room_ot", "room_a"]);
    expect(db.state.table[0]!.window_kind).toBe("ot");
  });

  it("F1: 3 rooms with a POSITIVE signal (a dead session): each per-room action is held, ONE fleet decision is written; the next tick writes nothing new", async () => {
    const db = fakeDb({ rooms: ["a", "b", "c"].map((x) => ({ room_id: `room_${x}`, room_name: x, hostname: `H${x}` })) });
    senseWith((id, A) => died(A, id));
    // S5: the 1st tick of a session_died only notes it ("confirming", log_only); the fleet class counts from the 2nd consecutive tick
    const s0 = await run(db.sql, T - MIN);
    expect(s0.fleet_incidents).toBe(0);
    expect(db.state.table.map((r) => [r.rule, r.action])).toEqual([["session_died", "log_only"], ["session_died", "log_only"], ["session_died", "log_only"]]);
    const s = await run(db.sql, T);
    expect(s.fleet_incidents).toBe(1);
    const per = db.state.table.filter((r) => r.room_id && r.ts === new Date(T).toISOString());
    expect(per.map((r) => [r.rule, r.action])).toEqual([["fleet_hold", "log_only"], ["fleet_hold", "log_only"], ["fleet_hold", "log_only"]]);
    expect(per.every((r) => r.inputs.failing_class === "session_died")).toBe(true);
    const fleet = db.state.table.filter((r) => r.room_id === null);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ rule: "fleet_incident", action: "message", window_kind: "fleet", result: "kill_switch" });
    expect(fleet[0]!.params).toMatchObject({ class: "session_died", count: 3 });

    expect((await run(db.sql, T + 2 * MIN)).decisions_written).toBe(0);
  });

  it("F1: 9 rooms that have NOT started yet at 07:31 produce scribe_start (shadow) decisions, not fleet_hold, and no fleet incident", async () => {
    const db = fakeDb({ rooms: Array.from({ length: 9 }, (_, i) => ({ room_id: `room_${i}`, room_name: `R${i}`, hostname: `H${i}` })) });
    senseWith((id, A) => idle(A, { room_id: id }));
    const open = ist("07:31");
    const s = await run(db.sql, open);
    expect(s.fleet_incidents).toBe(0);
    expect(db.state.table).toHaveLength(9);
    expect(db.state.table.every((r) => r.rule === "not_recording" && r.action === "scribe_start" && r.mode === "shadow" && r.result === "kill_switch")).toBe(true);
    expect(db.state.table.some((r) => r.rule === "fleet_hold" || r.rule === "fleet_incident")).toBe(false);
    // and a minute later nothing changes
    expect((await run(db.sql, open + MIN)).decisions_written).toBe(0);
  });

  it("F1: the hold stops renewing once fewer than 3 rooms carry a positive signal: after 15 min the 2 that still fail act, no new fleet row", async () => {
    const db = fakeDb({ rooms: ["a", "b", "c"].map((x) => ({ room_id: `room_${x}`, room_name: x, hostname: `H${x}` })) });
    senseWith((id, A) => died(A, id));
    await run(db.sql, T - MIN); // S5: the 1st tick only notes the dead session
    await run(db.sql, T);
    expect(db.state.table.filter((r) => r.rule === "fleet_incident")).toHaveLength(1);
    // room_c recovers; a, b still dead
    senseWith((id, A) => (id === "room_c" ? healthy(A, { room_id: id }) : died(A, id)));
    const s2 = await run(db.sql, T + 6 * MIN);
    expect(s2.fleet_incidents).toBe(0); // 2 failing; room_c's 6-min-old signal has left the 5-min count; the standing hold row (6 min old) still holds a and b
    expect(db.state.table.filter((r) => r.rule === "fleet_incident")).toHaveLength(1);
    // 16 min later the hold row has expired and fewer than 3 rooms fail: a and b get their own decision, no fleet row is renewed
    const s3 = await run(db.sql, T + 16 * MIN);
    expect(s3.fleet_incidents).toBe(0);
    expect(db.state.table.filter((r) => r.rule === "fleet_incident")).toHaveLength(1);
    const late = db.state.table.filter((r) => r.ts === new Date(T + 16 * MIN).toISOString() && r.room_id);
    expect(late.map((r) => [r.room_id, r.rule, r.action]).sort()).toEqual([["room_a", "session_died", "scribe_restart"], ["room_b", "session_died", "scribe_restart"]]);
  });

  it("2 rooms failing is not a fleet incident: both starts are recorded, no fleet row", async () => {
    const db = fakeDb({ rooms: ["a", "b"].map((x) => ({ room_id: `room_${x}`, room_name: x, hostname: `H${x}` })) });
    senseWith((id, A) => idle(A, { room_id: id }));
    const s = await run(db.sql, T);
    expect(s.fleet_incidents).toBe(0);
    expect(db.state.table.map((r) => r.action)).toEqual(["scribe_start", "scribe_start"]);
  });

  it("F11: SHADOW start rows are not attempts: 60+ min of shadow scribe_start decisions for 4 unstarted rooms is still scribe_start every time, never start_exhausted, never fleet_hold", async () => {
    const db = fakeDb({ rooms: ["a", "b", "c", "d"].map((x) => ({ room_id: `room_${x}`, room_name: x, hostname: `H${x}` })) });
    senseWith((id, A) => idle(A, { room_id: id }));
    for (const m of [0, 16, 32, 48, 64]) await run(db.sql, T + m * MIN);
    expect(db.state.table).toHaveLength(20);
    expect(db.state.table.every((r) => r.rule === "not_recording" && r.action === "scribe_start" && r.mode === "shadow")).toBe(true);
    expect(db.state.table.some((r) => r.rule === "fleet_hold" || r.rule === "fleet_incident" || r.action === "message")).toBe(false);
    expect(db.state.table.some((r) => r.inputs.failing_class)).toBe(false);
  });

  it("the rules' memory reaches the next tick: after 3 REAL steward start attempts today the room gets start_exhausted (log_only) and the needs_hands message", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id, start_attempts: [failedAttempt(A, 9000), failedAttempt(A, 5000), failedAttempt(A, 3000)] }));
    await run(db.sql, T);
    expect(db.state.table.map((r) => [r.rule, r.action])).toEqual([["start_exhausted", "log_only"], ["start_exhausted", "message"]]);
    expect(db.state.table[1]!.params).toMatchObject({ needs_hands: true, kind: "start_exhausted" });
    expect(db.state.table[0]!.inputs).toMatchObject({ failing_class: "not_recording", attempts: 3 });
  });
});

// ---------------------------------------------------------------------------
describe("F2: two consecutive ticks a minute apart with the same state produce ONE row", () => {
  it("a room in start backoff (retry_after_s 240 -> 180 -> 120): one row, the countdown lives in inputs", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id, start_attempts: [{ status: "failed", created_at: new Date(T - 60_000).toISOString(), acked_at: new Date(T - 60_000).toISOString(), session_started: false, session_named: false }] }));
    expect((await run(db.sql, T)).decisions_written).toBe(1);
    expect((await run(db.sql, T + MIN)).decisions_written).toBe(0);
    expect((await run(db.sql, T + 2 * MIN)).decisions_written).toBe(0);
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]).toMatchObject({ rule: "not_recording", action: "log_only", params: {} });
    expect(db.state.table[0]!.inputs).toMatchObject({ retry_after_s: 240, attempts: 1 });
  });

  it("a late stop kept open all night (the shadow never stops it): the scribe_stop + message pair is written once, not once a minute", async () => {
    const db = fakeDb();
    const late = ist("22:00");
    senseWith((id, A) => healthy(A, { room_id: id, consult_open: true, consult_started_at: ago(A, 600) }));
    expect((await run(db.sql, late)).decisions_written).toBe(2);
    for (let m = 1; m <= 5; m++) expect((await run(db.sql, late + m * MIN)).decisions_written).toBe(0);
    expect(db.state.table).toHaveLength(2);
    expect(db.state.table.map((r) => r.action)).toEqual(["scribe_stop", "message"]);
  });
});

// ---------------------------------------------------------------------------
describe("F3: per-source timeouts and the INSERT reserve", () => {
  it("senseAll gets the per-source timeout from steward_config (default 6000) and a deadline of budget - 3 s", async () => {
    senseWith((id, A) => idle(A, { room_id: id }));
    const db = fakeDb();
    await run(db.sql, T, { now: () => 1_000_000 });
    expect(M.senseAll.mock.calls[0]![4]).toMatchObject({ sourceTimeoutMs: 6000, deadlineMs: 1_000_000 + 20_000 - 3000 });
    M.senseAll.mockClear();
    const db2 = fakeDb({ cfg: { source_timeout_ms: 2500 } });
    await run(db2.sql, T, { now: () => 5 });
    expect(M.senseAll.mock.calls[0]![4]).toMatchObject({ sourceTimeoutMs: 2500 });
  });

  it("sensing eats the budget (sources skipped, degraded): the tick STILL decides and writes", async () => {
    const db = fakeDb();
    let t = 0;
    M.senseAll.mockImplementation(async (_s: unknown, A: number, roster: Array<{ room_id: string }>, degraded: string[]) => {
      t += 18_500; // past the sense deadline (17 s) but inside the 20 s budget
      degraded.push("presence_poller:skipped", "kiosk_health:timeout");
      return new Map(roster.map((r) => [r.room_id, idle(A, { room_id: r.room_id })]));
    });
    const lock = okLock();
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock, now: () => t });
    expect(s.degraded).toEqual(expect.arrayContaining(["presence_poller:skipped", "kiosk_health:timeout", "steward_decisions:skipped"]));
    expect(s.decisions_written).toBe(1);
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]!.inputs).toMatchObject({ memory_degraded: true });
    expect(lock.released).toBe(1);
  });

  it("a decision-log read that never answers is cut at source_timeout_ms: degraded, tick continues, INSERT attempted", async () => {
    const db = fakeDb({ cfg: { source_timeout_ms: 500 }, hang: [/DISTINCT ON \(d\.room_id\)/] });
    senseWith((id, A) => idle(A, { room_id: id }));
    const t0 = Date.now();
    const s = await run(db.sql, T);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(s.degraded).toContain("steward_decisions:timeout");
    expect(s.decisions_written).toBe(1);
    expect(db.state.table[0]!.inputs).toMatchObject({ memory_degraded: true });
  });

  it("a sense that throws outright is 'sense' degraded and the tick still reaches the lease release", async () => {
    const db = fakeDb();
    M.senseAll.mockRejectedValue(new Error("x"));
    const lock = okLock();
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock });
    expect(s.degraded).toContain("sense");
    expect(s.decisions_written).toBe(0);
    expect(lock.released).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("F7: last_tick and the steward.tick log line", () => {
  it("the release carries {at, elapsed_ms, rooms, decisions_written, degraded, budget_hit}; one JSON line steward.tick is logged with the same fields", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id }));
    const lock = okLock();
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock });
    expect(lock.lastTick).toEqual({ at: new Date(T).toISOString(), elapsed_ms: s.elapsed_ms, rooms: 1, decisions_written: 1, degraded: [], budget_hit: false });
    const logged = (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).filter((l) => l.includes("steward.tick"));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0]!)).toMatchObject({ evt: "steward.tick", rooms: 1, decisions_written: 1, degraded: [], budget_hit: false });
    expect(logged[0]).not.toContain("OPD A");
  });

  it("leaseLock.release(lastTick) is ONE statement that releases the lease row and upserts last_tick, with bound parameters; without a tick it is the plain release", async () => {
    const seen: Array<{ text: string; v: unknown[] }> = [];
    const sql = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      seen.push({ text: s.join("?"), v });
      return [];
    }) as never;
    const lock = leaseLock(sql, { holder: "h1" });
    await lock.release({ at: "x", rooms: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toContain("UPDATE steward_config");
    expect(seen[0]!.text).toContain("INSERT INTO steward_config");
    expect(seen[0]!.v).toEqual(expect.arrayContaining(["loop_lease", "last_tick", "h1", JSON.stringify({ at: "x", rooms: 1 })]));
    await lock.release();
    expect(seen).toHaveLength(2);
    expect(seen[1]!.text).not.toContain("INSERT INTO");
  });
});

// ---------------------------------------------------------------------------
describe("F8: no rooms / schedule, no tick", () => {
  it("steward_config without a `rooms` row: the tick is skipped, 200-shaped {ok:false, reason:'config_unavailable'}, no lease, no roster read, no sense, no write", async () => {
    const db = fakeDb({ dropCfg: ["rooms"] });
    senseWith((id, A) => idle(A, { room_id: id }));
    const lock = okLock();
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock });
    expect(s).toMatchObject({ ok: false, reason: "config_unavailable", rooms: 0, decisions_written: 0, skipped_lock: false });
    expect(lock.acquired).toBe(0);
    expect(lock.released).toBe(0);
    expect(M.senseAll).not.toHaveBeenCalled();
    expect(db.state.calls).toEqual(["SELECT key, value FROM steward_config"]);
    expect(db.state.table).toHaveLength(0);
  });

  it("an unreadable steward_config (the read throws) is the same skip: the seed is never used for rooms or schedule", async () => {
    const db = fakeDb({ fail: [/FROM steward_config/] });
    senseWith((id, A) => idle(A, { room_id: id }));
    const lock = okLock();
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock });
    expect(s).toMatchObject({ ok: false, reason: "config_unavailable" });
    expect(s.degraded).toContain("steward_config");
    expect(lock.acquired).toBe(0);
    expect(db.state.table).toHaveLength(0);
  });

  it("a malformed schedule is the same skip; a normal tick says ok:true", async () => {
    const db = fakeDb({ cfg: { schedule: { clinic: { start: "7", end: "x" } } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    expect(await run(db.sql, T)).toMatchObject({ ok: false, reason: "config_unavailable" });
    const ok = fakeDb();
    expect(await run(ok.sql, T)).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
describe("(a) the caps count EXECUTED actions only", () => {
  const every = (db: ReturnType<typeof fakeDb>) => db.state.table.filter((r) => r.room_id !== null);
  for (const [label, cfg] of [["kill switch ON (the seed)", {}], ["kill switch OFF, shadow ON", { kill_switch: { on: false } }]] as const) {
    it(`${label}: 90 min of one-minute ticks on an unstarted room is scribe_start on every row that passes dedupe, never cap_reached`, async () => {
      const db = fakeDb({ cfg });
      senseWith((id, A) => idle(A, { room_id: id }));
      for (let m = 0; m <= 90; m++) await run(db.sql, T + m * MIN);
      const rows = every(db);
      expect(rows).toHaveLength(7); // 0, 15, 30, 45, 60, 75, 90
      expect(rows.every((r) => r.rule === "not_recording" && r.action === "scribe_start" && r.mode === "shadow")).toBe(true);
      expect(rows.some((r) => r.rule === "cap_reached" || r.rule === "fleet_hold")).toBe(false);
    });
  }

  it("executed rows (ok / failed) DO count: 4 real executed starts in the hour and the 5th is cap_reached; skipped rows do not", async () => {
    const db = fakeDb({ cfg: { kill_switch: { on: false }, caps: { actions_per_room_per_hour: 4, policy_cycle_per_profile_per_day: 1, start_retries: 9 } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    const put = (m: number, result: string) =>
      db.state.table.push({ id: db.state.nextId++, room_id: "room_a", ts: new Date(T - m * MIN).toISOString(), rule: "not_recording", action: "scribe_start", params: {}, result, mode: "live", inputs: { primary: true }, why: "", why_not: null, actor: "steward", machine: "HOST-A", window_kind: "clinic", inputs_hash: "x" });
    for (const m of [50, 40, 30, 20]) put(m, "skipped: already_recording session_id=x");
    await run(db.sql, T);
    expect(db.state.table[db.state.table.length - 1]).toMatchObject({ rule: "not_recording", action: "scribe_start" });
    db.state.table.length = 0;
    put(50, "ok: start_day acked command_id=c1");
    put(40, "failed: no ack from the kiosk command_id=c2");
    put(30, "ok: start_day acked command_id=c3");
    put(20, "failed: start_day failed command_id=c4");
    await run(db.sql, T);
    expect(db.state.table[db.state.table.length - 1]).toMatchObject({ rule: "cap_reached", action: "log_only", params: { wanted: "scribe_start" } });
  });
});

// ---------------------------------------------------------------------------
/** an unstarted kiosk-enrolled room that passes every live-start gate: heartbeat 30 s old, recorder ready with no session for 10 min */
const liveReady = (id: string, A: number) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 600) } });
const LIVE_ON = { start_day_live: { on: true } };

describe("(d) per-action shadow lift: executes only if kill off AND start_day_live AND global false AND actions[a] !== true", () => {
  const spyExec = () => ({ scribeStart: vi.fn(async () => ({ result: "ok: start_day acked command_id=c" })), scribeStop: vi.fn(), scribeRestart: vi.fn(), issueTicket: vi.fn(), message: vi.fn() });
  const ALL_TICKETS = Object.fromEntries(["wake", "open_pulse", "relaunch_chrome", "policy_cycle", "restart_recorder_app", "restart_kiosk_health"].map((a) => [`ticket:${a}`, true]));
  const lifted = { ...ALL_TICKETS, message: true, scribe_start: false };
  // room_a: no session (scribe_start); room_b: asleep 12 min (ticket:wake + message)
  const fleet = () =>
    senseWith((id, A) =>
      id === "room_a" ? liveReady(id, A) : idle(A, { room_id: id, machine: "HOST-B", reachable: { poller_ok_at: ago(A, 720), kh_heartbeat_at: ago(A, 720) } }),
    );
  const rooms = [{ room_id: "room_a", room_name: "A", hostname: "HOST-A" }, { room_id: "room_b", room_name: "B", hostname: "HOST-B" }];

  it("kill off, global false, tickets + message shadowed, scribe_start false: ONLY scribe_start executes — no ticket, no message", async () => {
    const db = fakeDb({ rooms, cfg: { kill_switch: { on: false }, ...LIVE_ON, shadow: { global: false, actions: lifted } } });
    fleet();
    const live = spyExec();
    const s = await run(db.sql, T, { executorFor: (l: boolean) => (l ? live : new ShadowExecutor()) });
    expect(live.scribeStart).toHaveBeenCalledTimes(1);
    expect(live.issueTicket).not.toHaveBeenCalled();
    expect(live.message).not.toHaveBeenCalled();
    expect(live.scribeStop).not.toHaveBeenCalled();
    const by = (a: string) => db.state.table.find((r) => r.action === a)!;
    expect(by("scribe_start")).toMatchObject({ room_id: "room_a", mode: "live", result: "ok: start_day acked command_id=c" });
    expect(by("ticket:wake")).toMatchObject({ mode: "shadow", result: "shadow: would ticket:wake" });
    expect(by("message")).toMatchObject({ mode: "shadow", result: "shadow: would message" });
    expect(s.degraded).not.toContain("live_executor");
  });

  it("the same config with shadow.global TRUE: nothing executes", async () => {
    const db = fakeDb({ rooms, cfg: { kill_switch: { on: false }, ...LIVE_ON, shadow: { global: true, actions: lifted } } });
    fleet();
    const live = spyExec();
    await run(db.sql, T, { executorFor: (l: boolean) => (l ? live : new ShadowExecutor()) });
    expect(Object.values(live).every((f) => f.mock.calls.length === 0)).toBe(true);
    const acts = db.state.table.filter((r) => r.action !== "none" && r.action !== "log_only");
    expect(acts.length).toBeGreaterThanOrEqual(3);
    expect(acts.every((r) => r.mode === "shadow" && String(r.result).startsWith("shadow: would "))).toBe(true);
  });

  it("the same config with the KILL SWITCH on: nothing executes, result kill_switch", async () => {
    const db = fakeDb({ rooms, cfg: { kill_switch: { on: true }, ...LIVE_ON, shadow: { global: false, actions: lifted } } });
    fleet();
    const live = spyExec();
    await run(db.sql, T, { executorFor: (l: boolean) => (l ? live : new ShadowExecutor()) });
    expect(Object.values(live).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(db.state.table.filter((r) => r.action !== "none" && r.action !== "log_only").every((r) => r.result === "kill_switch")).toBe(true);
  });

  it("an action that is not live-capable (scribe_stop here) or unnamed is SHADOW even with kill off, global false and no per-action entry", async () => {
    const db = fakeDb({ cfg: { kill_switch: { on: false }, shadow: { global: false, actions: {} } } });
    senseWith((id, A) => healthy(A, { room_id: id })); // 22:00 IST: outside the clinic window with a session open and no consult -> scribe_stop
    const live = spyExec();
    await run(db.sql, ist("22:00"), { executorFor: (l: boolean) => (l ? live : new ShadowExecutor()) });
    expect(db.state.table[0]).toMatchObject({ action: "scribe_stop", mode: "shadow", result: "shadow: would scribe_stop" });
    expect(Object.values(live).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("an unnamed lift never lifts: a per-action value that is not a boolean stays shadow (and the config is named invalid)", async () => {
    const db = fakeDb({ cfg: { kill_switch: { on: false }, ...LIVE_ON, shadow: { global: false, actions: { scribe_start: "false" } } } });
    senseWith((id, A) => liveReady(id, A));
    const live = spyExec();
    const s = await run(db.sql, T, { executorFor: (l: boolean) => (l ? live : new ShadowExecutor()) });
    expect(live.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", result: "shadow: would scribe_start" });
    expect(s.degraded).toContain("config:shadow");
  });
});

// ---------------------------------------------------------------------------
describe("(b) every decision row carries the reachability evidence actually sensed", () => {
  it("a scribe_start for a kiosk-enrolled room: numeric last_chunk_s, kh_heartbeat_s and poller_ok_s, plus ext_status, occupancy, sleep_marker (bool), at the top level of the row's inputs", async () => {
    const db = fakeDb();
    senseWith((id, A) => {
      const s = idle(A, { room_id: id, reachable: { poller_ok_at: ago(A, 45), kh_heartbeat_at: ago(A, 20), sleep_at: null } });
      s.recording.last_chunk_24h_at = ago(A, 2400);
      return s;
    });
    await run(db.sql, T);
    const r = db.state.table[0]!;
    expect(r).toMatchObject({ rule: "not_recording", action: "scribe_start" });
    expect(r.inputs).toMatchObject({ last_chunk_s: 2400, kh_heartbeat_s: 20, poller_ok_s: 45, ext_status: "ok", occupancy: "nobody", sleep_marker: false });
    expect((r.inputs.ages_s as Record<string, unknown>).kh_heartbeat_s).toBe(20);
  });

  it("the other rules and the guards use the same builder: wake, mic fault, cap_reached and ok rows all carry the keys; last_chunk_s is null only with no chunk at all", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id, reachable: { poller_ok_at: ago(A, 300), kh_heartbeat_at: ago(A, 300), sleep_at: ago(A, 600) } }));
    await run(db.sql, T);
    senseWith((id, A) => healthy(A, { room_id: id }));
    await run(db.sql, T + 20 * MIN);
    for (const r of db.state.table) {
      for (const k of ["last_chunk_s", "kh_heartbeat_s", "poller_ok_s", "ext_status", "occupancy", "sleep_marker"]) expect(r.inputs).toHaveProperty(k);
    }
    expect(db.state.table[0]!.inputs).toMatchObject({ kh_heartbeat_s: 300, poller_ok_s: 300, sleep_marker: true, last_chunk_s: null });
    expect(db.state.table[db.state.table.length - 1]!.inputs).toMatchObject({ last_chunk_s: 60, sleep_marker: false });
  });
});

// ---------------------------------------------------------------------------
describe("start_day_live and the live-start gates", () => {
  const spy = () => ({ scribeStart: vi.fn(async () => ({ result: "ok: start_day acked command_id=c" })), scribeStop: vi.fn(), scribeRestart: vi.fn(), issueTicket: vi.fn(), message: vi.fn() });
  const open = { kill_switch: { on: false }, shadow: { global: false, actions: {} } };
  const withSpy = (l: ReturnType<typeof spy>) => ({ executorFor: (live: boolean) => (live ? l : new ShadowExecutor()) });

  it("start_day_live absent (not seeded) or off: scribe_start is SHADOW even with kill off, global false and nothing held back; zero executor calls", async () => {
    for (const cfg of [{ ...open }, { ...open, start_day_live: { on: false } }, { ...open, start_day_live: "yes" }] as Array<Record<string, unknown>>) {
      const db = fakeDb({ cfg });
      senseWith((id, A) => liveReady(id, A));
      const l = spy();
      const s = await run(db.sql, T, withSpy(l));
      expect(l.scribeStart).not.toHaveBeenCalled();
      expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: "shadow: would scribe_start" });
      if (typeof cfg.start_day_live === "string") expect(s.degraded).toContain("config:start_day_live");
    }
  });

  it("start_day_live on but the KILL SWITCH on: nothing executes (kill_switch wins)", async () => {
    const db = fakeDb({ cfg: { ...open, kill_switch: { on: true }, ...LIVE_ON } });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    await run(db.sql, T, withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table[0]).toMatchObject({ result: "kill_switch" });
  });

  it("everything on: ONE live start through the executor, row mode live, every gate recorded in inputs", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    await run(db.sql, T, withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "live", result: "ok: start_day acked command_id=c" });
    expect(db.state.table[0]!.inputs).toMatchObject({ start_gate_fail: null, start_gates: { in_window: true, room_eligible: true, no_open_session: true, kiosk_health_fresh: true, recorder_ready: true }, kh_heartbeat_s: 30, recorder_ready_for_s: 600 });
  });

  it("a failing gate is shadow with the gate as the result and the executor is never called: no kiosk-health (ORB2) -> 'shadow: no_kiosk_health'", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    senseWith((id, A) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: null, kh_enrolled: false }, recording: { recorder_history: null } }));
    const l = spy();
    await run(db.sql, T, withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: "shadow: no_kiosk_health" });
    expect(db.state.table[0]!.inputs).toMatchObject({ start_gates: { kiosk_health_fresh: false, recorder_ready: false } });
  });

  for (const [name, mk, reason] of [
    ["heartbeat 181 s old", (id: string, A: number) => idle(A, { room_id: id, reachable: { poller_ok_at: ago(A, 20), kh_heartbeat_at: ago(A, 181) }, recording: { recorder_history: readyRecorder(A, 600) } }), "kh_heartbeat_stale"],
    ["recorder ready for 4:59", (id: string, A: number) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 299) } }), "recorder_ready_under_5m"],
    ["recorder not ready (session open on the recorder)", (id: string, A: number) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: { latest_at: ago(A, 20), latest_state: "recording", latest_session_open: "yes", ready_since: null, ready_samples: 0 } } }), "recorder_not_ready"],
  ] as const) {
    it(`gate: ${name} -> shadow: ${reason}, nothing sent`, async () => {
      const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
      senseWith(mk);
      const l = spy();
      await run(db.sql, T, withSpy(l));
      expect(l.scribeStart).not.toHaveBeenCalled();
      expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: `shadow: ${reason}` });
    });
  }

  it("a start that is allowed to go live is NOT swallowed by an earlier gated row with the same key: shadow row at ready 3:20, the live attempt two minutes later, then dedupe again", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    const l = spy();
    senseWith((id, A) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, A === T ? 200 : 320) } }));
    await run(db.sql, T, withSpy(l));
    expect(db.state.table[0]).toMatchObject({ result: "shadow: recorder_ready_under_5m" });
    await run(db.sql, T + 2 * MIN, withSpy(l)); // same (rule, action, params) 2 min later, now ready 5:20
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
    expect(db.state.table).toHaveLength(2);
    expect(db.state.table[1]).toMatchObject({ mode: "live", result: "ok: start_day acked command_id=c" });
    // the next minute the sense shows the attempt (queued, awaiting its session): the schedule holds the next one, so nothing is sent
    senseWith((id, A) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: ago(A, 30) }, recording: { recorder_history: readyRecorder(A, 400) }, start_attempts: [pendingAttempt(A, 60)] }));
    await run(db.sql, T + 3 * MIN, withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
  });

  it("F21: the retry the schedule allows is exempt from the 15-min dedupe: attempt 1 fails at T; at +1 min backoff holds; at +5:30 the retry goes out (same key, previous row 'failed:' 5 min old); a 'sending' or fresh 'skipped:' row still holds the key", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    const l = spy();
    l.scribeStart.mockResolvedValue({ result: "failed: no ack from the kiosk command_id=c1" });
    senseWith((id, A) => liveReady(id, A));
    await run(db.sql, T, withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
    expect(db.state.table[0]).toMatchObject({ mode: "live", result: "failed: no ack from the kiosk command_id=c1" });
    senseWith((id, A) => ({ ...liveReady(id, A), start_attempts: [failedAttempt(A, 60)] }));
    await run(db.sql, T + MIN, withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
    expect(db.state.table.at(-1)).toMatchObject({ rule: "not_recording", action: "log_only" });
    senseWith((id, A) => ({ ...liveReady(id, A), start_attempts: [failedAttempt(A, 330)] }));
    l.scribeStart.mockResolvedValue({ result: "ok: start_day acked command_id=c2" });
    await run(db.sql, T + 5.5 * MIN, withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(2);
    expect(db.state.table.at(-1)).toMatchObject({ action: "scribe_start", mode: "live", result: "ok: start_day acked command_id=c2" });
    // a row stuck at "sending" keeps the key for the 15 min (the schedule is read from bench_command, not from this row)
    const db2 = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    senseWith((id, A) => liveReady(id, A));
    db2.state.table.push({ id: db2.state.nextId++, room_id: "room_a", ts: new Date(T - 2 * MIN).toISOString(), rule: "not_recording", action: "scribe_start", params: {}, result: "sending", mode: "live", inputs: { primary: true }, why: "", why_not: null, actor: "steward", machine: "HOST-A", window_kind: "clinic", inputs_hash: "x" });
    const l2 = spy();
    await run(db2.sql, T, withSpy(l2));
    expect(l2.scribeStart).not.toHaveBeenCalled();
  });

  it("F19: every live send writes a 'sending' row first (own statement, same key, inputs.attempt_no) and updates THAT row by id; one row per attempt in the log", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    senseWith((id, A) => ({ ...liveReady(id, A), start_attempts: [failedAttempt(A, 400)] }));
    const seen: Array<string | null> = [];
    const l = spy();
    l.scribeStart.mockImplementation(async () => {
      seen.push(db.state.table[0]?.result ?? null); // the row is in the log while the send runs
      return { result: "ok: start_day acked command_id=c" };
    });
    const s = await run(db.sql, T, withSpy(l));
    expect(seen).toEqual(["sending"]);
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "live", result: "ok: start_day acked command_id=c" });
    expect(db.state.table[0]!.inputs).toMatchObject({ attempt_no: 2, primary: true });
    expect(db.state.table[0]!.inputs.call_ms).toBeTypeOf("number");
    expect(s.decisions_written).toBe(1);
    const inserts = db.state.calls.filter((c) => c.startsWith("INSERT INTO steward_decisions")).length;
    const updates = db.state.calls.filter((c) => c.startsWith("UPDATE steward_decisions")).length;
    expect([inserts, updates]).toEqual([1, 1]);
  });

  it("F19: a send that hangs: the 'sending' row stays, the tick still returns (degraded live_call_timeout), nothing else is lost", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON, live_call_timeout_ms: 1000 } });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    l.scribeStart.mockImplementation((() => new Promise(() => {})) as never);
    const t0 = Date.now();
    const s = await run(db.sql, T, withSpy(l));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
    expect(s.degraded).toContain("live_call_timeout");
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "live", result: "sending" });
    expect(db.state.table[0]!.inputs).toMatchObject({ attempt_no: 1 });
    expect(s.decisions_written).toBe(1);
  }, 15_000);

  it("F19: a send that finishes after the timeout updates its row (best effort)", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON, live_call_timeout_ms: 1000 } });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    l.scribeStart.mockImplementation((() => new Promise((r) => setTimeout(() => r({ result: "ok: start_day acked command_id=late" }), 1300))) as never);
    await run(db.sql, T, withSpy(l));
    expect(db.state.table[0]!.result).toBe("sending");
    await new Promise((r) => setTimeout(r, 600));
    expect(db.state.table[0]).toMatchObject({ result: "ok: start_day acked command_id=late", mode: "live" });
  }, 15_000);

  it("F19: no live send when the 'sending' row cannot be written (nothing is sent without its audit row)", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON }, fail: [/INSERT INTO steward_decisions/] });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    const s = await run(db.sql, T, withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(s.degraded).toContain("steward_decisions");
  });

  it("F19: under 6 s of budget left: no live send, the row says 'skipped: budget'", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    // a 5.5 s budget: less than the 6 s a live send needs
    const s = await run(db.sql, T, { ...withSpy(l), budgetMs: 5500 });
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(s.degraded).toContain("live_budget");
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "live", result: "skipped: budget" });
  });

  it("F2 (G1): 90 minutes of ticks with the device missing write exactly ONE alert row and waiting_for_mic rows; the device back closes the episode once; a new disappearance the same IST day does not alert again", async () => {
    const db = fakeDb({ cfg: { ...open, shadow: { global: true, actions: {} } } });
    let present: boolean | null = false;
    senseWith((id, A) => idle(A, { room_id: id, room_name: "Cardiology", audio: { default_input_present: present, devices_at: ago(A, 600), configured_device: "TONOR TM20" }, start_attempts: [failedAttempt(A, 3000)] }));
    for (let m = 0; m < 90; m++) await run(db.sql, T + m * MIN);
    const alerts = () => db.state.table.filter((r) => r.rule === "device_missing" && r.action === "alert");
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.params).toMatchObject({ room: "Cardiology", device: "TONOR TM20" });
    expect(db.state.table.some((r) => r.rule === "waiting_for_mic")).toBe(true);
    expect(db.state.table.some((r) => r.action === "scribe_start")).toBe(false);
    present = true;
    for (let m = 90; m < 95; m++) await run(db.sql, T + m * MIN);
    expect(db.state.table.filter((r) => r.rule === "device_missing" && r.action === "log_only" && (r.params as { state?: string }).state === "back")).toHaveLength(1);
    // tick 1 of the return is a marker row, tick 2 on is the normal start decision
    expect(db.state.table.filter((r) => r.rule === "waiting_for_mic" && (r.params as { mic_ticks?: number }).mic_ticks === 1)).toHaveLength(1);
    present = false;
    for (let m = 95; m < 100; m++) await run(db.sql, T + m * MIN);
    expect(alerts()).toHaveLength(1);
  });

  it("replay of the 9 Oct incident (live start path): end_day (mcp) acked 21:09 IST, tick at 21:14 IST -> start_gate_hold day_ended_by_operator, the executor is never called; the next IST day starts", async () => {
    const D = "2026-10-09";
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    const endedAt = new Date(ist("21:09", D)).toISOString();
    senseWith((id, A) => ({ ...liveReady(id, A), day: { operator_end_at: endedAt, session_today: true } }));
    const l = spy();
    await run(db.sql, ist("21:14", D), withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]).toMatchObject({ rule: "start_gate_hold", action: "log_only", params: { reason: "day_ended_by_operator" } });
    // 20:31 IST with a session that day and no operator end: held; with no session that day: goes
    senseWith((id, A) => ({ ...liveReady(id, A), day: { operator_end_at: null, session_today: true } }));
    await run(db.sql, ist("20:31", D), withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table.at(-1)).toMatchObject({ params: { reason: "late_start_blocked" } });
    senseWith((id, A) => ({ ...liveReady(id, A), day: { operator_end_at: null, session_today: false } }));
    await run(db.sql, ist("20:35", D), withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
    // the next IST morning: no gates apply
    senseWith((id, A) => ({ ...liveReady(id, A), day: undefined }));
    await run(db.sql, ist("08:00", "2026-10-10"), withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(2);
  });

  it("an unreadable day state (null) from 20:00 IST sends nothing", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    senseWith((id, A) => ({ ...liveReady(id, A), day: null }));
    const l = spy();
    await run(db.sql, ist("20:10"), withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table[0]).toMatchObject({ rule: "start_gate_hold", params: { reason: "day_state_unreadable" } });
  });

  it("a missing mic sends NO start, not even the first; 2 present ticks later the normal gates apply: the start waits for the 5-min recorder streak (no waiver)", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
    let present = false;
    senseWith((id, A) => ({ ...liveReady(id, A), audio: { ...liveReady(id, A).audio, default_input_present: present, devices_at: ago(A, 60), configured_device: "TONOR TM20" }, start_attempts: [] }));
    const l = spy();
    const t0 = ist("08:00");
    for (let m = 0; m < 10; m++) await run(db.sql, t0 + m * MIN, withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    expect(db.state.table.filter((r) => r.rule === "device_missing" && r.action === "alert")).toHaveLength(1);
    present = true;
    // a recorder that has been ready for only 40 s: held even after the 2 present ticks
    senseWith((id, A) => ({ ...liveReady(id, A), recording: { ...liveReady(id, A).recording, recorder_history: { latest_at: ago(A, 20), latest_state: "ready", latest_session_open: "no", ready_since: ago(A, 40), ready_samples: 2 } }, start_attempts: [] }));
    await run(db.sql, t0 + 10 * MIN, withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    await run(db.sql, t0 + 11 * MIN, withSpy(l));
    expect(l.scribeStart).not.toHaveBeenCalled();
    // the recorder has now been ready for 6 min: the start goes
    senseWith((id, A) => ({ ...liveReady(id, A), start_attempts: [] }));
    await run(db.sql, t0 + 12 * MIN, withSpy(l));
    expect(l.scribeStart).toHaveBeenCalledTimes(1);
  });

  describe("the switches are read again from steward_config immediately before each live send", () => {
    const flips: Array<[string, () => Record<string, unknown>]> = [
      ["kill_switch turned on", () => ({ kill_switch: { on: true } })],
      ["start_day_live turned off", () => ({ start_day_live: { on: false } })],
      ["start_day_live malformed", () => ({ start_day_live: "yes" })],
      ["start_day_live removed", () => ({ start_day_live: undefined })],
      ["shadow.global turned on", () => ({ shadow: { global: true, actions: {} } })],
      ["scribe_start held by name", () => ({ shadow: { global: false, actions: { scribe_start: true } } })],
    ];
    for (const [name, flip] of flips) {
      it(`${name} between the sense and the send: nothing is sent, the row says skipped: flag_off_at_send`, async () => {
        const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
        senseWith((id, A) => {
          Object.assign(db.state.cfg, flip()); // the operator flips it after the tick read its config
          return liveReady(id, A);
        });
        const l = spy();
        await run(db.sql, T, withSpy(l));
        expect(l.scribeStart).not.toHaveBeenCalled();
        expect(db.state.table).toHaveLength(1);
        expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "live", result: "skipped: flag_off_at_send" });
      });
    }
    it("the read fails: fail closed, nothing is sent (skipped: flag_unreadable_at_send)", async () => {
      const db = fakeDb({ cfg: { ...open, ...LIVE_ON }, fail: [/WHERE key = ANY/] });
      senseWith((id, A) => liveReady(id, A));
      const l = spy();
      await run(db.sql, T, withSpy(l));
      expect(l.scribeStart).not.toHaveBeenCalled();
      expect(db.state.table[0]).toMatchObject({ result: "skipped: flag_unreadable_at_send" });
    });
    it("unchanged switches: the send goes out (the read is one bound SELECT per send)", async () => {
      const db = fakeDb({ cfg: { ...open, ...LIVE_ON } });
      senseWith((id, A) => liveReady(id, A));
      const l = spy();
      await run(db.sql, T, withSpy(l));
      expect(l.scribeStart).toHaveBeenCalledTimes(1);
      expect(db.state.calls.filter((c) => c.includes("WHERE key = ANY")).length).toBe(1);
    });
  });

  it("F20: the hard never-live list in the loop: ORB2 / ORB3 / Home Office / room_scratch_* are never sent a live start, even with every gate green and a forced decision", async () => {
    for (const id of ["room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy"]) {
      const db = fakeDb({ cfg: { ...open, ...LIVE_ON }, rooms: [{ room_id: id, room_name: "X", hostname: "HOST-X" }] });
      senseWith((rid, A) => liveReady(rid, A));
      const l = spy();
      await run(db.sql, T, withSpy(l));
      expect(l.scribeStart, id).not.toHaveBeenCalled();
      const r = db.state.table.find((x) => x.action === "scribe_start");
      if (r) expect(r, id).toMatchObject({ mode: "shadow", result: "shadow: never_live_room" });
    }
  });

  it("the loop never calls stop / restart / ticket / message live", async () => {
    const db = fakeDb({ cfg: { ...open, ...LIVE_ON, shadow: { global: false, actions: {} } } });
    senseWith((id, A) => liveReady(id, A));
    const l = spy();
    await run(db.sql, T, withSpy(l));
    expect(l.scribeStop).not.toHaveBeenCalled();
    expect(l.scribeRestart).not.toHaveBeenCalled();
    expect(l.issueTicket).not.toHaveBeenCalled();
    expect(l.message).not.toHaveBeenCalled();
  });
});


describe("F44: fire then collect; a start acked after the in-tick wait is never a failure", () => {
  const open = { kill_switch: { on: false }, shadow: { global: false, actions: {} }, ...LIVE_ON };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `room_${"abcdefg"[i]}`);
  const roomsOf = (n: number) => ids(n).map((id, i) => ({ room_id: id, room_name: `OPD ${i + 1}`, hostname: `HOST-${i}` }));
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** a kiosk bus backed by the fake db's bench table: each start_day is acked (or failed) `latency(room)` ms after it is queued; the ack wait is the real shape (null at the timeout) */
  function kiosk(db: ReturnType<typeof fakeDb>, latency: (room: string) => number, outcome: (room: string) => { status: "acked" | "failed"; error: string | null } = () => ({ status: "acked", error: null }), ackTimeoutMs = 4000) {
    const sent: string[] = [];
    const deps: StartDeps = {
      getListener: async (roomId) => ({ room_id: roomId, tab_id: "t", last_poll_at: new Date(Date.now() - 2000), recording_session_id: null, paused: false }) as never,
      findActiveSession: async () => null,
      getRecentStartAttempts: async (roomId) => attemptsOf(db, roomId) as never,
      getStewardAttemptsToday: async (roomId) => attemptsOf(db, roomId) as never,
      decideStart,
      insertCommand: async ({ roomId }) => {
        const id = `cmd_${roomId}_${sent.length + 1}`;
        sent.push(roomId);
        db.state.bench.set(id, { id, status: "pending", error: null, created_at: new Date().toISOString(), room_id: roomId, acked_at: null } as never);
        const lat = latency(roomId);
        if (Number.isFinite(lat))
          setTimeout(() => {
            const o = outcome(roomId);
            Object.assign(db.state.bench.get(id)!, { status: o.status, error: o.error, acked_at: new Date().toISOString() });
          }, lat);
        return id;
      },
      waitForAck: async (id, o) => {
        const t0 = Date.now();
        while (Date.now() - t0 < (o.timeoutMs ?? 8000)) {
          const row = db.state.bench.get(id)!;
          if (row.status !== "pending") return { status: row.status, error: row.error, result: {} };
          await sleep(500);
        }
        return null;
      },
    };
    return { sent, executorFor: (live: boolean) => (live ? new LiveExecutor({ deps, ackTimeoutMs }) : new ShadowExecutor()) };
  }
  const attemptsOf = (db: ReturnType<typeof fakeDb>, roomId: string) =>
    [...db.state.bench.values()].filter((b) => (b as never as { room_id: string }).room_id === roomId).map((b) => ({ status: b.status, created_at: b.created_at, acked_at: (b as never as { acked_at: string | null }).acked_at ?? null, session_started: false, session_named: false }));
  /** the sense shows each room's bench attempts, as sense.ts does */
  const senseBench = (db: ReturnType<typeof fakeDb>) => senseWith((id, A) => ({ ...liveReady(id, A), start_attempts: attemptsOf(db, id) }));
  /** one tick at `offsetS` after T, with the clock where the test is */
  async function tick(db: ReturnType<typeof fakeDb>, k: ReturnType<typeof kiosk>, offsetS: number, advanceMs = 0, extra: Record<string, unknown> = {}) {
    vi.setSystemTime(T + offsetS * 1000);
    const p = run(db.sql, T + offsetS * 1000, { executorFor: k.executorFor, ...extra });
    await vi.advanceTimersByTimeAsync(advanceMs);
    return p;
  }
  const startRows = (db: ReturnType<typeof fakeDb>) => db.state.table.filter((r) => r.action === "scribe_start");
  const failedRows = (db: ReturnType<typeof fakeDb>) => db.state.table.filter((r) => outcomeOf(r.result) === "failed");

  beforeEach(() => vi.useFakeTimers({ now: T }));
  afterEach(() => vi.useRealTimers());

  it("two rooms, the kiosk acks AFTER the in-tick wait: both rows pending (not failed), the next tick settles both to 'ok ... (late)', zero failures, no resend", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(2) });
    const k = kiosk(db, () => 10_000); // ack at +10 s; the in-tick wait is 4 s
    senseBench(db);
    const s1 = await tick(db, k, 0, 6000);
    expect(s1.degraded).not.toContain("live_budget");
    expect(startRows(db).map((r) => r.result)).toEqual(["pending: sent, awaiting ack command_id=cmd_room_a_1", "pending: sent, awaiting ack command_id=cmd_room_b_2"]);
    expect(startRows(db).every((r) => r.mode === "live" && outcomeOf(r.result) === null)).toBe(true);
    await vi.advanceTimersByTimeAsync(8000); // the kiosk acks
    await tick(db, k, 60);
    expect(startRows(db).map((r) => r.result)).toEqual(["ok: start_day acked (late) command_id=cmd_room_a_1", "ok: start_day acked (late) command_id=cmd_room_b_2"]);
    expect(startRows(db)[0]!.inputs).toMatchObject({ late: true, pending_at: new Date(T).toISOString(), attempt_no: 1 });
    expect(failedRows(db)).toHaveLength(0);
    expect(k.sent).toHaveLength(2); // no second send
    for (const id of ids(2)) expect(startVerdict(attemptsOf(db, id), T + 60_000, 3).kind).toBe("pending"); // acked, waiting for its session: not a failure, no backoff
  });

  it("five rooms, 6 s ack latency each: all five are sent in the SAME tick, none 'skipped: budget', all acked in the tick", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(5) });
    const k = kiosk(db, () => 6000, undefined, 8000); // the executor's real ceiling for the in-tick wait is 8 s
    senseBench(db);
    const p = tick(db, k, 0, 9000);
    const s = await p;
    expect(k.sent).toEqual(ids(5));
    expect(startRows(db)).toHaveLength(5);
    expect(startRows(db).every((r) => r.result?.startsWith("ok: start_day acked command_id="))).toBe(true);
    expect(startRows(db).some((r) => r.result === "skipped: budget")).toBe(false);
    expect(s.degraded).not.toContain("live_budget");
    expect(s.decisions_written).toBe(5);
  });

  it("the kiosk reports FAILED: 'failed:' with the kiosk's error, the backoff applies (no resend one minute later)", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const k = kiosk(db, () => 1000, () => ({ status: "failed", error: "mic busy" }));
    senseBench(db);
    await tick(db, k, 0, 2000);
    expect(startRows(db)[0]!.result).toBe("failed: start_day failed (mic busy) command_id=cmd_room_a_1");
    await tick(db, k, 60);
    expect(k.sent).toHaveLength(1);
    expect(startVerdict(attemptsOf(db, "room_a"), T + 60_000, 3).kind).toBe("backoff");
  });

  it("the kiosk reports FAILED after the in-tick wait: pending first, then 'failed:' with the error on the next tick, backoff applied", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const k = kiosk(db, () => 10_000, () => ({ status: "failed", error: "mic busy" }));
    senseBench(db);
    await tick(db, k, 0, 6000);
    expect(startRows(db)[0]!.result).toMatch(/^pending/);
    await vi.advanceTimersByTimeAsync(8000);
    await tick(db, k, 60);
    expect(startRows(db)[0]!.result).toBe("failed: start_day failed (mic busy) command_id=cmd_room_a_1");
    expect(k.sent).toHaveLength(1);
    expect(startVerdict(attemptsOf(db, "room_a"), T + 60_000, 3).kind).toBe("backoff");
  });

  it("never acked: pending for 120 s, then 'failed: no ack after 120 s' and the backoff applies; nothing resent meanwhile", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const k = kiosk(db, () => Infinity);
    senseBench(db);
    await tick(db, k, 0, 6000);
    await tick(db, k, 60);
    await tick(db, k, 118);
    expect(startRows(db)[0]!.result).toMatch(/^pending/);
    expect(startVerdict(attemptsOf(db, "room_a"), T + 118_000, 3).kind).toBe("pending");
    await tick(db, k, 130);
    expect(startRows(db)[0]!.result).toBe("failed: no ack after 120 s command_id=cmd_room_a_1");
    expect(k.sent).toHaveLength(1);
    const v = startVerdict(attemptsOf(db, "room_a"), T + 130_000, 3);
    expect(v).toMatchObject({ kind: "backoff", retry_after_s: 290 }); // 120 s + 5 min, counted from the send
    // and the retry goes out once the backoff has run (attempt 2)
    await tick(db, k, 130 + 291, 6000);
    expect(k.sent).toHaveLength(2);
  });

  it("no double send while a start is pending, even when the sense cannot see it (the log row and the executor's own re-read both hold)", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const k = kiosk(db, () => Infinity);
    senseWith((id, A) => liveReady(id, A)); // blind: no start_attempts
    await tick(db, k, 0, 6000);
    for (const off of [60, 90, 119]) await tick(db, k, off);
    expect(k.sent).toHaveLength(1);
    expect(startRows(db)).toHaveLength(1);
  });

  it("a failed read of the pending rows does not end the tick: they stay pending, degraded names reconcile_pending", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1), fail: [/d\.result LIKE 'pending%'/] });
    const k = kiosk(db, () => 10_000);
    senseBench(db);
    const s = await tick(db, k, 0, 6000);
    expect(s.degraded).toContain("reconcile_pending");
    expect(startRows(db)[0]!.result).toMatch(/^pending/);
  });

  // ---- F44.1 ----------------------------------------------------------------------------------------------------------------------------------------------------------------
  const seedPending = (db: ReturnType<typeof fakeDb>, roomId: string, cmd: string, ackedAtMs: number | null) => {
    db.state.table.push({ id: db.state.nextId++, room_id: roomId, ts: new Date(T - 30_000).toISOString(), rule: "not_recording", action: "scribe_start", params: {}, result: `pending: sent, awaiting ack command_id=${cmd}`, mode: "live", inputs: { primary: true }, why: "seed", why_not: null, actor: "steward", machine: null, window_kind: "clinic", inputs_hash: "seed" });
    db.state.bench.set(cmd, { id: cmd, status: ackedAtMs ? "acked" : "pending", error: null, created_at: new Date(T - 30_000).toISOString(), room_id: roomId, acked_at: ackedAtMs ? new Date(ackedAtMs).toISOString() : null } as never);
  };

  it("R1: a slow reconcile shares ONE deadline: the log read starts inside it, never past senseDeadline, and a live send is not 'skipped: budget'", async () => {
    let logReadAt = -1;
    const db = fakeDb({
      cfg: { ...open, source_timeout_ms: 2000 },
      rooms: roomsOf(3),
      delay: [[/d\.result LIKE 'pending%'|FROM bench_command WHERE id = ANY|AND result LIKE 'pending%'/, 900]],
      onStmt: (t) => {
        if (t.includes("d.action <> 'none'")) logReadAt = Date.now() - T;
      },
    });
    seedPending(db, "room_a", "cmd_seed_a", T - 20_000);
    seedPending(db, "room_b", "cmd_seed_b", T - 20_000);
    const k = kiosk(db, () => 1000);
    senseBench(db);
    const s = await tick(db, k, 0, 12_000);
    // read (0.9 s) + bench read (0.9 s) + first UPDATE (0.9 s) would be 2.7 s unbounded; the shared 2 s deadline cuts the reconcile, so the log read starts at <= 2 s
    expect(logReadAt).toBeGreaterThanOrEqual(0);
    expect(logReadAt).toBeLessThanOrEqual(2100);
    expect(s.degraded).toContain("reconcile_pending");
    expect(s.elapsed_ms).toBeLessThan(20_000 - 3000 + 9000); // INSERT_RESERVE_MS 3 s; the send's own ack wait is the only thing beyond the sense deadline
    const c = startRows(db).filter((r) => r.room_id === "room_c");
    expect(c).toHaveLength(1);
    expect(c[0]!.result).not.toBe("skipped: budget");
    expect(s.degraded).not.toContain("live_budget");
  });

  it("R1: the log read gets only the time LEFT after the reconcile: a log read that hangs ends at senseDeadline, not at its stale full timeout", async () => {
    const db = fakeDb({ cfg: { ...open, source_timeout_ms: 15_000 }, rooms: roomsOf(1), hang: [/d\.action <> 'none'/], delay: [[/d\.result LIKE 'pending%'/, 4000]] });
    seedPending(db, "room_a", "cmd_seed_a", null);
    senseBench(db);
    const k = kiosk(db, () => Infinity);
    const s = await tick(db, k, 0, 30_000);
    expect(s.degraded).toContain("steward_decisions:timeout");
    expect(s.elapsed_ms).toBeLessThanOrEqual(17_000 + 200); // budget 20 s - INSERT_RESERVE 3 s; without the recompute the log read would run to 4 s + 15 s
  });

  it("R2: a retry marks the earlier still-pending start_day of that room expired first: never two non-terminal start_day commands for one room", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(2) });
    const k = kiosk(db, () => Infinity); // never acked
    const expired: Array<{ room: string; ids: string[] }> = [];
    // the kiosk deps with the R2 helper wired to the fake bench table (steward start_day, pending, older than the cutoff, that room only)
    const base = k.executorFor(true) as LiveExecutor;
    void base;
    const wrapped = (live: boolean) => {
      if (!live) return new ShadowExecutor();
      const ex = k.executorFor(true) as LiveExecutor;
      const deps = (ex as unknown as { opts: { deps: StartDeps } }).opts.deps;
      deps.expireStaleStarts = async (roomId, olderThanS) => {
        const ids: string[] = [];
        for (const b of db.state.bench.values()) {
          const row = b as never as { room_id: string; status: string; created_at: string };
          if (row.room_id === roomId && row.status === "pending" && Date.now() - Date.parse(row.created_at) > olderThanS * 1000) {
            row.status = "expired";
            ids.push(b.id);
          }
        }
        expired.push({ room: roomId, ids });
        return ids;
      };
      return ex;
    };
    const kk = { sent: k.sent, executorFor: wrapped };
    senseBench(db);
    await tick(db, kk, 0, 6000);
    expect(kk.sent).toEqual(["room_a", "room_b"]);
    const nonTerminal = (room: string) => [...db.state.bench.values()].filter((b) => (b as never as { room_id: string }).room_id === room && b.status === "pending").length;
    await tick(db, kk, 130);
    await tick(db, kk, 130 + 291, 6000); // the backoff has run: attempt 2 for both rooms
    expect(kk.sent).toEqual(["room_a", "room_b", "room_a", "room_b"]);
    expect(expired.map((e) => e.room)).toEqual(["room_a", "room_b"]);
    for (const e of expired) expect(e.ids).toHaveLength(1); // only the earlier command of THAT room
    for (const room of ["room_a", "room_b"]) expect(nonTerminal(room)).toBe(1); // the new one only
    expect([...db.state.bench.values()].filter((b) => b.status === "expired")).toHaveLength(2);
  });

  it("R2: when the earlier command cannot be expired nothing is sent ('skipped: start_expire_failed')", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const k = kiosk(db, () => Infinity);
    const failing = (live: boolean) => {
      if (!live) return new ShadowExecutor();
      const ex = k.executorFor(true) as LiveExecutor;
      (ex as unknown as { opts: { deps: StartDeps } }).opts.deps.expireStaleStarts = async () => {
        throw new Error("db down");
      };
      return ex;
    };
    senseBench(db);
    await tick(db, { sent: k.sent, executorFor: failing }, 0, 6000);
    await tick(db, { sent: k.sent, executorFor: failing }, 130);
    await tick(db, { sent: k.sent, executorFor: failing }, 130 + 291, 6000);
    expect(k.sent).toHaveLength(1);
    expect(startRows(db).at(-1)!.result).toBe("skipped: start_expire_failed");
  });

  it("R3: a start settled 'failed: no ack after 120 s' that the kiosk then acks becomes 'ok: start_day acked (late, after 120 s)' with inputs.late=true; a repeat changes nothing", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const k = kiosk(db, () => 20_000); // the ack comes after the row was settled failed (timer time, see below)
    senseBench(db);
    await tick(db, k, 0, 6000);
    await tick(db, k, 130);
    expect(startRows(db)[0]!.result).toBe("failed: no ack after 120 s command_id=cmd_room_a_1");
    await vi.advanceTimersByTimeAsync(20_000); // the kiosk acks now
    await tick(db, k, 210);
    expect(startRows(db)[0]!.result).toBe("ok: start_day acked (late, after 120 s) command_id=cmd_room_a_1");
    expect(startRows(db)[0]!.inputs).toMatchObject({ late: true, revised_from: "failed" });
    expect(failedRows(db)).toHaveLength(0);
    const before = JSON.stringify(startRows(db));
    await tick(db, k, 240);
    expect(JSON.stringify(startRows(db))).toBe(before);
  });

  it("R3: a failure older than 30 min, a command still unacked, and a command of another room are left alone; only the acked, same-room, recent one is revised", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(1) });
    const seed = (cmd: string, minAgo: number, benchRoom: string, status: string) => {
      db.state.table.push({ id: db.state.nextId++, room_id: "room_a", ts: new Date(T - minAgo * MIN).toISOString(), rule: "not_recording", action: "scribe_start", params: {}, result: `failed: no ack after 120 s command_id=${cmd}`, mode: "live", inputs: {}, why: "seed", why_not: null, actor: "steward", machine: null, window_kind: "clinic", inputs_hash: "seed" });
      db.state.bench.set(cmd, { id: cmd, status, error: null, created_at: new Date(T - minAgo * MIN).toISOString(), room_id: benchRoom } as never);
    };
    seed("cmd_old", 31, "room_a", "acked");
    seed("cmd_unacked", 5, "room_a", "pending");
    seed("cmd_other", 5, "room_other", "acked");
    seed("cmd_ok", 5, "room_a", "acked");
    senseWith((id, A) => idle(A, { room_id: id }));
    await run(db.sql, T);
    const byCmd = (c: string) => db.state.table.find((r) => (r.result ?? "").includes(`command_id=${c}`))!.result;
    expect(byCmd("cmd_old")).toMatch(/^failed: no ack after 120 s/);
    expect(byCmd("cmd_unacked")).toMatch(/^failed: no ack after 120 s/);
    expect(byCmd("cmd_other")).toMatch(/^failed: no ack after 120 s/);
    expect(byCmd("cmd_ok")).toBe("ok: start_day acked (late, after 120 s) command_id=cmd_ok");
  });

  it("R4: if something throws between the sends and the collect, every in-flight row is still settled: none is left 'sending'", async () => {
    const db = fakeDb({ cfg: open, rooms: roomsOf(2) });
    const k = kiosk(db, () => 1000);
    senseBench(db);
    // the clock throws once, on the read right after room_a's send is issued (the first read after its 'sending' row is its own t1; the next is the loop's budget check for room_b)
    let reads = 0;
    let thrown = false;
    const now = () => {
      if (!thrown && db.state.table.some((r) => r.result === "sending") && ++reads === 2) {
        thrown = true;
        throw new Error("clock fault");
      }
      return Date.now();
    };
    const s = await tick(db, k, 0, 6000, { now });
    expect(thrown).toBe(true);
    expect(s.degraded).toContain("tick");
    expect(k.sent).toEqual(["room_a"]);
    expect(db.state.table.filter((r) => r.result === "sending")).toHaveLength(0);
    expect(startRows(db)).toHaveLength(1);
    expect(startRows(db)[0]!.result).toMatch(/^(ok|pending)/);
  });

  it("F5: the decision-log read is capped at 3000 rows and says so when the cap is hit; below it, no warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDb({ rooms: roomsOf(1) });
    senseWith((id, A) => idle(A, { room_id: id }));
    const seed = (n: number) => {
      for (let i = 0; i < n; i++) db.state.table.push({ id: db.state.nextId++, room_id: "room_a", ts: new Date(T - 60_000 - i).toISOString(), rule: "seed", action: "log_only", params: { i }, result: null, mode: "shadow", inputs: {}, why: "s", why_not: null, actor: "steward", machine: null, window_kind: "clinic", inputs_hash: "s" });
    };
    seed(2999);
    await run(db.sql, T);
    expect(warn).not.toHaveBeenCalled();
    seed(1);
    await run(db.sql, T + 5 * MIN);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/LIMIT \(3000 rows\)/);
    expect(RECENT_ROWS_LIMIT).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// S5 (Rooms Live v1.7): session_died flapping. FIXTURE SOURCE: built from the FLEET spec's description of OPD 4 (room_ux92qpws, EHRC-CONSUL4s-Mac-mini-2) on 2026-10-08
// 12:40-12:58Z, NOT from real rows: the read-only role (~/.config/eta-audio/db.url) has no SELECT on steward_decisions. The spec says only that the decision alternated
// session_died/message and ok/none every 2-5 min; the run lengths below are one such alternation (every gap under 10 min). The loop is the real one (runSteward).
// ---------------------------------------------------------------------------
describe("S5: session_died flapping (OPD 4, 8 Oct 2026 12:40-12:58Z)", () => {
  const OPD4 = { room_id: "room_ux92qpws", room_name: "OPD 4", hostname: "EHRC-CONSUL4s-Mac-mini-2" };
  const T0 = Date.parse("2026-10-08T12:40:00Z");
  const seedRestart = (db: ReturnType<typeof fakeDb>, minAgo: number) =>
    db.state.table.push({ id: db.state.nextId++, room_id: OPD4.room_id, ts: new Date(T0 - minAgo * MIN).toISOString(), rule: "session_died", action: "scribe_restart", params: {}, result: "shadow: would scribe_restart", mode: "shadow", inputs: { primary: true }, why: "seed", why_not: null, actor: "steward", machine: null, window_kind: "clinic", inputs_hash: "seed" });
  /** tick minute m of the window; `diedAt` says which minutes have the dead-session condition */
  const play = async (db: ReturnType<typeof fakeDb>, diedAt: (m: number) => boolean, minutes: number) => {
    senseWith((id, A) => (diedAt(Math.round((A - T0) / MIN)) ? died(A, id) : healthy(A, { room_id: id })));
    for (let m = 0; m < minutes; m++) await run(db.sql, T0 + m * MIN);
  };
  const sd = (db: ReturnType<typeof fakeDb>) => db.state.table.filter((r) => r.rule === "session_died");
  const inRuns = (runs: Array<[number, number]>) => (m: number) => runs.some(([a, b]) => m >= a && m <= b);

  it("four dead-session runs separated by 2-3 min of ok are ONE episode: exactly one message", async () => {
    const db = fakeDb({ rooms: [OPD4] });
    seedRestart(db, 12); // scribe_restart sent 12 min before 12:40: the ladder is at its last rung
    await play(db, inRuns([[0, 2], [6, 8], [11, 14], [17, 18]]), 19);
    const msgs = sd(db).filter((r) => r.action === "message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.ts).toBe(new Date(T0).toISOString()); // the episode was already confirmed by the seeded restart row; it fires on the first tick
    // the later runs do not stay silent in the log: each re-confirms (1 tick) and then records that the message was already sent
    expect(sd(db).filter((r) => r.params.state === "message_sent").length).toBeGreaterThan(0);
    expect(sd(db).filter((r) => r.params.state === "confirming").length).toBeGreaterThanOrEqual(3);
    expect(sd(db).filter((r) => r.params.state === "cleared")).toHaveLength(3); // one closing row per ok gap
  });

  it("a one-tick blip never fires: the 1st tick only notes it, the next ok tick closes it", async () => {
    const db = fakeDb({ rooms: [OPD4] });
    await play(db, inRuns([[3, 3]]), 8);
    expect(sd(db).map((r) => [r.params.state, r.action])).toEqual([["confirming", "log_only"], ["cleared", "log_only"]]);
    expect(db.state.table.some((r) => r.action === "scribe_restart" || r.action === "message")).toBe(false);
  });

  it("two consecutive ticks fire (scribe_restart first); the message waits for the ladder (5 min) and is sent once", async () => {
    const db = fakeDb({ rooms: [OPD4] });
    await play(db, () => true, 40);
    const rows = sd(db);
    expect(rows[0]).toMatchObject({ action: "log_only", params: { state: "confirming" } });
    expect(rows[1]).toMatchObject({ action: "scribe_restart" });
    expect(rows.filter((r) => r.action === "message")).toHaveLength(1);
  });

  it("the room ok for 10 min ends the episode: a later death is a new episode with its own (one) message", async () => {
    const db = fakeDb({ rooms: [OPD4] });
    seedRestart(db, 8); // still inside the 30 min ladder memory at minute 21
    await play(db, inRuns([[0, 3], [20, 24]]), 26); // ok from minute 4 to 19 (16 min)
    const msgs = sd(db).filter((r) => r.action === "message");
    expect(msgs.map((r) => Math.round((Date.parse(r.ts) - T0) / MIN))).toEqual([0, 21]);
  });
});
