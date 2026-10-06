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
function fakeDb(opts: { cfg?: Record<string, unknown>; rooms?: Array<{ room_id: string; room_name: string; hostname: string | null }>; fail?: Array<RegExp> } = {}) {
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
  const state = { cfg, rooms: opts.rooms ?? [{ room_id: "room_a", room_name: "OPD A", hostname: "HOST-A" }], table: [] as Stored[], calls: [] as string[], nextId: 1 };
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("?");
    state.calls.push(text.replace(/\s+/g, " ").trim().slice(0, 60));
    for (const re of opts.fail ?? []) if (re.test(text)) throw new Error("boom");
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
    if (text.includes("d.action <> 'none'")) return state.table.filter((r) => r.room_id && r.action !== "none").sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id));
    if (text.includes("d.rule = 'fleet_incident'")) return state.table.filter((r) => r.room_id === null && r.rule === "fleet_incident").sort((a, b) => (a.ts < b.ts ? 1 : -1));
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

const okLock = (): LoopLock & { acquired: number; released: number } => {
  const l = { acquired: 0, released: 0, acquire: async () => (l.acquired++, true), release: async () => void l.released++ };
  return l;
};

/** senseAll mock: every roster room gets `mk(room, A)`. */
const senseWith = (mk: (roomId: string, A: number) => RoomSense) =>
  M.senseAll.mockImplementation(async (_sql: unknown, A: number, roster: Array<{ room_id: string }>) => new Map(roster.map((r) => [r.room_id, mk(r.room_id, A)])));

const T = ist("10:00");
const MIN = 60_000;
const run = (sql: ReturnType<typeof fakeDb>["sql"], asOf: number, extra: Record<string, unknown> = {}) => runSteward(sql as never, { asOf, budgetMs: 20_000, lock: okLock(), ...extra });

beforeEach(() => {
  M.senseAll.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
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
    senseWith((id, A) => healthy(A, { room_id: id, reachable: { poller_ok_at: ago(A, 700), kh_heartbeat_at: ago(A, 700) } }));
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
    expect(db.state.calls).toEqual([]);
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
    expect(s.degraded).toContain("tick");
    expect(l2.released).toBe(1);

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
    const s = await runSteward(db.sql as never, { asOf: T, budgetMs: 20_000, lock, now: () => (t += 7000) });
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

  it("an unreadable config falls back to the seed with the kill switch ON and is named; an invalid key is named", async () => {
    const db = fakeDb({ fail: [/FROM steward_config/] });
    senseWith((id, A) => idle(A, { room_id: id }));
    const s = await run(db.sql, T);
    expect(s.degraded).toContain("steward_config");
    expect(s.kill_switch).toBe(true);
    expect(db.state.table[0]!.result).toBe("kill_switch");

    const db2 = fakeDb({ cfg: { caps: { actions_per_room_per_hour: "x" } } });
    senseWith((id, A) => idle(A, { room_id: id }));
    expect((await run(db2.sql, T)).degraded).toContain("config:caps");
  });

  it("an unreadable roster ends the tick with rooms 0; an unreadable decision log skips the write (it would only repeat rows)", async () => {
    senseWith((id, A) => idle(A, { room_id: id }));
    const a = fakeDb({ fail: [/FROM room r/] });
    expect(await run(a.sql, T)).toMatchObject({ rooms: 0, decisions_written: 0 });
    const b = fakeDb({ fail: [/DISTINCT ON \(d\.room_id\)/] });
    const s = await run(b.sql, T);
    expect(s.degraded).toContain("steward_decisions");
    expect(s.decisions_written).toBe(0);
    expect(b.state.table).toHaveLength(0);
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

  it("3 rooms failing the same way: each per-room action is held, ONE fleet decision is written; the next tick writes nothing new", async () => {
    const db = fakeDb({ rooms: ["a", "b", "c"].map((x) => ({ room_id: `room_${x}`, room_name: x, hostname: `H${x}` })) });
    senseWith((id, A) => idle(A, { room_id: id }));
    const s = await run(db.sql, T);
    expect(s.fleet_incidents).toBe(1);
    const per = db.state.table.filter((r) => r.room_id);
    expect(per.map((r) => [r.rule, r.action])).toEqual([["fleet_hold", "log_only"], ["fleet_hold", "log_only"], ["fleet_hold", "log_only"]]);
    const fleet = db.state.table.filter((r) => r.room_id === null);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ rule: "fleet_incident", action: "message", window_kind: "fleet", result: "kill_switch" });
    expect(fleet[0]!.params).toMatchObject({ class: "not_recording", count: 3 });

    expect((await run(db.sql, T + 2 * MIN)).decisions_written).toBe(0);
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
