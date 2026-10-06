/**
 * lib/steward/loop.ts — the shadow loop, with an in-memory stand-in for the database and a controlled sense: dedupe, lock, budget, kill switch / shadow / live-blocked,
 * degraded sources, fleet incidents, processing order. Real SQL is proven in steward-pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ago, healthy, idle, ist } from "../support/steward-fixtures";
import type { RoomSense } from "@/lib/steward/sense";

const M = vi.hoisted(() => ({ senseAll: vi.fn() }));
vi.mock("@/lib/steward/sense", () => ({ senseAll: M.senseAll }));

import { DEDUPE_REFRESH_MS, leaseLock, outcomeOf, runSteward, type LoopLock } from "@/lib/steward/loop";
import { LiveExecutor, ShadowExecutor, dispatch } from "@/lib/steward/executor";
import type { Decision } from "@/lib/steward/rules";

type Stored = { id: number; room_id: string | null; ts: string; rule: string; action: string; params: Record<string, unknown>; result: string | null; mode: string; inputs: Record<string, unknown>; why: string; why_not: string | null; actor: string; machine: string | null; window_kind: string; inputs_hash: string };

/** A fake of the Neon tag that answers exactly the statements the loop sends. */
function fakeDb(opts: { cfg?: Record<string, unknown>; dropCfg?: string[]; rooms?: Array<{ room_id: string; room_name: string; hostname: string | null }>; fail?: Array<RegExp>; hang?: Array<RegExp> } = {}) {
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
  const state = { cfg, rooms: opts.rooms ?? [{ room_id: "room_a", room_name: "OPD A", hostname: "HOST-A" }], table: [] as Stored[], calls: [] as string[], nextId: 1 };
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("?");
    state.calls.push(text.replace(/\s+/g, " ").trim().slice(0, 60));
    for (const re of opts.fail ?? []) if (re.test(text)) throw new Error("boom");
    for (const re of opts.hang ?? []) if (re.test(text)) return new Promise(() => {});
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
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock, now: () => (t += 5000) });
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

  it("asking for LIVE reaches the stub, which throws: the row stays shadow, the result says blocked, 'live_executor' is degraded", async () => {
    const db = fakeDb({ cfg: { kill_switch: { on: false }, shadow: { global: false, actions: {} } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    const s = await run(db.sql, T);
    expect(db.state.table[0]).toMatchObject({ action: "scribe_start", mode: "shadow" });
    expect(db.state.table[0]!.result).toContain("live executor not enabled in P0");
    expect(s.degraded).toContain("live_executor");
    // a per-action override works the same way
    const db2 = fakeDb({ cfg: { kill_switch: { on: false }, shadow: { global: true, actions: { scribe_start: false } } } });
    await run(db2.sql, T);
    expect(db2.state.table[0]!.result).toContain("blocked");
  });

  it("the executors: Shadow records, Live throws, dispatch routes by action and ignores none/log_only", async () => {
    const d = (action: string) => ({ action, params: {} }) as unknown as Decision;
    const sh = new ShadowExecutor();
    expect(await dispatch(sh, d("scribe_restart"))).toEqual({ result: "shadow: would scribe_restart" });
    expect(await dispatch(sh, d("ticket:wake"))).toEqual({ result: "shadow: would ticket:wake" });
    expect(await dispatch(sh, d("message"))).toEqual({ result: "shadow: would message" });
    expect(await dispatch(sh, d("none"))).toBeNull();
    expect(await dispatch(sh, d("log_only"))).toBeNull();
    for (const a of ["scribe_start", "scribe_stop", "scribe_restart", "ticket:wake", "message"]) await expect(dispatch(new LiveExecutor(), d(a))).rejects.toThrow("live executor not enabled in P0");
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
    const s = await run(db.sql, T);
    expect(s.fleet_incidents).toBe(1);
    const per = db.state.table.filter((r) => r.room_id);
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

  it("the rules' memory reaches the next tick: after 3 recorded starts the room gets the needs_hands message", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id }));
    await run(db.sql, T);
    await run(db.sql, T + 16 * MIN);
    await run(db.sql, T + 32 * MIN);
    expect(db.state.table.map((r) => r.action)).toEqual(["scribe_start", "scribe_start", "scribe_start"]);
    await run(db.sql, T + 48 * MIN);
    expect(db.state.table[3]).toMatchObject({ action: "message", rule: "not_recording" });
    expect(db.state.table[3]!.params).toMatchObject({ needs_hands: true });
  });
});

// ---------------------------------------------------------------------------
describe("F2: two consecutive ticks a minute apart with the same state produce ONE row", () => {
  it("a room in room_failing backoff (retry_after_s 1800 -> 1740): one row, the countdown lives in inputs", async () => {
    const db = fakeDb();
    senseWith((id, A) => idle(A, { room_id: id, start_backoff: { failed_attempts: 2, retry_after_s: 1800 - Math.round((A - T) / 1000) } }));
    expect((await run(db.sql, T)).decisions_written).toBe(1);
    expect((await run(db.sql, T + MIN)).decisions_written).toBe(0);
    expect((await run(db.sql, T + 2 * MIN)).decisions_written).toBe(0);
    expect(db.state.table).toHaveLength(1);
    expect(db.state.table[0]).toMatchObject({ rule: "not_recording", action: "log_only", params: {} });
    expect(db.state.table[0]!.inputs).toMatchObject({ retry_after_s: 1800, failed_attempts: 2 });
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
