/**
 * lib/steward/startday.ts + the loop hook: Steward LIVE for start_day only (7 Oct 2026). Every guard, the 3-attempt cap with 5/15/45 backoff, the device rule,
 * both kill switches, "already recording = success". The database is an in-memory stand-in (as in steward-loop.test.ts); the enqueue path is an injected port that
 * records every call, so "zero commands" is asserted on the port, not inferred.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ago, healthy, idle, ist } from "../support/steward-fixtures";
import type { RoomSense } from "@/lib/steward/sense";

const M = vi.hoisted(() => ({ senseAll: vi.fn() }));
vi.mock("@/lib/steward/sense", () => ({ senseAll: M.senseAll }));

import { runSteward, type LoopLock } from "@/lib/steward/loop";
import { DEFAULT_CONFIG, parseConfig } from "@/lib/steward/config";
import {
  ALERT_RULE,
  BACKOFF_MIN,
  MAX_ATTEMPTS_PER_DAY,
  NEVER_START_DAY_ROOMS,
  SKIP_RULE,
  attemptStart,
  attemptsToday,
  evaluateStartDay,
  micReturnSilent,
  recorderVerdict,
  shouldArm,
  type RecorderRow,
  type StartDayPort,
} from "@/lib/steward/startday";
import type { RecentAction } from "@/lib/steward/rules";

const MIN = 60_000;
const T = ist("10:00");
type Stored = { id: number; room_id: string | null; ts: string; rule: string; action: string; params: Record<string, unknown>; result: string | null; mode: string; inputs: Record<string, unknown>; why: string; why_not: string | null; actor: string; machine: string | null; window_kind: string; inputs_hash: string };

const BASE_CFG = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kill_switch: { on: false },
  shadow: { global: true, actions: {} },
  schedule: { clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 }, ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 } },
  days: { mode: "every_day", closed: [] },
  caps: { actions_per_room_per_hour: 4, policy_cycle_per_profile_per_day: 1, start_retries: 3 },
  priority: { order: ["ot", "opd", "clinic"] },
  rooms: {},
  start_day_live: { on: true },
  ...over,
});

function fakeDb(o: { cfg?: Record<string, unknown>; rooms?: Array<{ room_id: string; room_name: string; hostname: string | null }>; recorder?: RecorderRow[] | "throw"; inflight?: boolean; failLog?: boolean; deviceName?: string | null } = {}) {
  const state = {
    cfg: o.cfg ?? BASE_CFG(),
    rooms: o.rooms ?? [{ room_id: "room_a", room_name: "OPD A", hostname: "HOST-A" }],
    table: [] as Stored[],
    nextId: 1,
    recorder: o.recorder ?? ([] as RecorderRow[] | "throw"),
    inflight: o.inflight ?? false,
    deviceName: o.deviceName === undefined ? "USB Mic X" : o.deviceName,
    failLog: o.failLog ?? false,
  };
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT key, value FROM steward_config")) return Object.entries(state.cfg).map(([key, value]) => ({ key, value }));
    if (text.includes("FROM room r")) return state.rooms.map((r) => ({ ...r, state_flags: null }));
    if (text.includes("DISTINCT ON (d.room_id)")) {
      if (state.failLog) throw new Error("boom");
      const best = new Map<string, Stored>();
      for (const r of state.table) if (r.room_id && r.inputs.primary === true) {
        const p = best.get(r.room_id);
        if (!p || r.ts > p.ts || (r.ts === p.ts && r.id > p.id)) best.set(r.room_id, r);
      }
      return [...best.values()];
    }
    if (text.includes("d.action <> 'none'"))
      return state.table.filter((r) => r.room_id && r.action !== "none").sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id)).map((r) => ({ ...r, failing_class: (r.inputs.failing_class as string | undefined) ?? null }));
    if (text.includes("d.rule = 'fleet_incident'")) return [];
    if (text.includes("k.kind = 'recorder.status'")) {
      if (state.recorder === "throw") throw new Error("boom");
      return state.recorder;
    }
    if (text.includes("FROM bench_command c")) return state.inflight ? [{ x: 1 }] : [];
    if (text.includes("expected_device_name")) return state.deviceName === null ? [] : [{ expected_device_name: state.deviceName }];
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

const okLock = (): LoopLock => ({ acquire: async () => true, release: async () => {} });
const senseWith = (mk: (roomId: string, A: number) => RoomSense) =>
  M.senseAll.mockImplementation(async (_sql: unknown, A: number, roster: Array<{ room_id: string }>) => new Map(roster.map((r) => [r.room_id, mk(r.room_id, A)])));

/** ready for 6 min, newest row 1 min old */
const READY = (A: number): RecorderRow[] => [
  { received_at: ago(A, 60), state: "ready", session_open: "false" },
  { received_at: ago(A, 360), state: "ready", session_open: "false" },
];

type PortOpts = { session?: { id: string; status: string; started_at: string } | null; decide?: "send" | "already_recording" | "kiosk_not_listening" | "room_paused"; insert?: () => Promise<string> };
function fakePort(o: PortOpts = {}) {
  const calls = { insert: [] as Array<{ roomId: string; kind: string; args?: unknown; source?: string }>, find: 0, decide: 0 };
  const port: StartDayPort = {
    findActiveSession: async () => (calls.find++, o.session ?? null),
    getListener: async () => ({ room_id: "x" }),
    decideStart: () => {
      calls.decide++;
      const d = o.decide ?? "send";
      if (d === "send") return { action: "send", args: null };
      if (d === "already_recording") return { action: "already_recording", session_id: "bs_9" };
      return { action: "reject", error: d };
    },
    insertCommand: async (i) => {
      calls.insert.push(i);
      return o.insert ? o.insert() : "cmd_1";
    },
  };
  return { port, calls };
}

const tick = (db: ReturnType<typeof fakeDb>, port: StartDayPort, asOf: number) => runSteward(db.sql as never, { asOf, budgetMs: 20_000, lock: okLock(), startDayPort: port });
const rowsOf = (db: ReturnType<typeof fakeDb>) => db.state.table;
const live = (db: ReturnType<typeof fakeDb>) => rowsOf(db).filter((r) => r.mode === "live");

beforeEach(() => {
  M.senseAll.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the switches", () => {
  it("start_day_live off (absent or false): shadow behaviour exactly as today, zero commands, zero extra reads", async () => {
    for (const cfg of [(() => { const c = BASE_CFG(); delete c.start_day_live; return c; })(), BASE_CFG({ start_day_live: { on: false } })]) {
      const db = fakeDb({ cfg, recorder: READY(T) });
      const { port, calls } = fakePort();
      senseWith((id, A) => idle(A, { room_id: id }));
      await tick(db, port, T);
      expect(calls.insert).toHaveLength(0);
      expect(calls.find).toBe(0);
      expect(rowsOf(db)).toHaveLength(1);
      expect(rowsOf(db)[0]).toMatchObject({ rule: "not_recording", action: "scribe_start", mode: "shadow", result: "shadow: would scribe_start" });
    }
  });

  it("the global kill switch ON stops it even with start_day_live on: zero commands, row result kill_switch", async () => {
    const db = fakeDb({ cfg: BASE_CFG({ kill_switch: { on: true } }), recorder: READY(T) });
    const { port, calls } = fakePort();
    senseWith((id, A) => idle(A, { room_id: id }));
    await tick(db, port, T);
    expect(calls.insert).toHaveLength(0);
    expect(rowsOf(db)[0]).toMatchObject({ action: "scribe_start", mode: "shadow", result: "kill_switch" });
  });

  it("shouldArm needs start_day_live on AND the kill switch off; the config key parses {on} and a malformed value is false + invalid", () => {
    expect(shouldArm({ ...DEFAULT_CONFIG, start_day_live: true, kill_switch: false })).toBe(true);
    expect(shouldArm({ ...DEFAULT_CONFIG, start_day_live: true, kill_switch: true })).toBe(false);
    expect(shouldArm({ ...DEFAULT_CONFIG, start_day_live: false, kill_switch: false })).toBe(false);
    expect(DEFAULT_CONFIG.start_day_live).toBe(false);
    const rows = Object.entries(BASE_CFG()).map(([key, value]) => ({ key, value }));
    expect(parseConfig(rows).config.start_day_live).toBe(true);
    const without = rows.filter((r) => r.key !== "start_day_live");
    expect(parseConfig(without)).toMatchObject({ config: { start_day_live: false }, invalid: [] });
    for (const bad of [true, "yes", { on: "true" }, 1]) {
      const p = parseConfig([...without, { key: "start_day_live", value: bad }]);
      expect(p.config.start_day_live).toBe(false);
      expect(p.invalid).toContain("start_day_live");
    }
  });
});

describe("a live attempt", () => {
  it("all guards pass: ONE start_day through the bench-commands path (source steward), the row is mode live with the command id", async () => {
    const db = fakeDb({ recorder: READY(T) });
    const { port, calls } = fakePort();
    senseWith((id, A) => idle(A, { room_id: id }));
    const s = await tick(db, port, T);
    expect(calls.insert).toEqual([{ roomId: "room_a", kind: "start_day", args: undefined, source: "steward" }]);
    expect(live(db)).toHaveLength(1);
    expect(live(db)[0]).toMatchObject({ rule: "not_recording", action: "scribe_start", mode: "live", result: "ok: start_day queued cmd_1" });
    expect(s.decisions_written).toBe(1);
  });

  it("only start_day is ever enqueued: no other command kind, whatever the room does", async () => {
    const db = fakeDb({ recorder: READY(T) });
    const { port, calls } = fakePort();
    senseWith((id, A) => idle(A, { room_id: id }));
    await tick(db, port, T);
    senseWith((id, A) => healthy(A, { room_id: id }));
    await tick(db, port, T + 2 * MIN);
    senseWith((id, A) => healthy(A, { room_id: id, recording: { last_chunk_at: ago(A, 720) } }));
    await tick(db, port, T + 4 * MIN);
    expect(new Set(calls.insert.map((c) => c.kind))).toEqual(new Set(["start_day"]));
  });

  it("an attempt is not swallowed by the dedupe: a skip row, then two minutes later (ready >= 5 min) the live row", async () => {
    const db = fakeDb({ recorder: [{ received_at: ago(T, 120), state: "ready", session_open: "false" }] });
    const { port, calls } = fakePort();
    senseWith((id, A) => idle(A, { room_id: id }));
    await tick(db, port, T);
    expect(rowsOf(db)).toHaveLength(1);
    expect(rowsOf(db)[0]).toMatchObject({ rule: SKIP_RULE, action: "log_only", params: { reason: "recorder_ready_under_5min" }, mode: "shadow", result: "skipped: recorder_ready_under_5min" });
    expect(calls.insert).toHaveLength(0);
    db.state.recorder = [{ received_at: ago(T + 2 * MIN, 60), state: "ready", session_open: "false" }, { received_at: ago(T + 2 * MIN, 420), state: "ready", session_open: "false" }];
    await tick(db, port, T + 2 * MIN);
    expect(calls.insert).toHaveLength(1);
    expect(live(db)).toHaveLength(1);
  });
});

describe("guards (loop level)", () => {
  const cases: Array<[string, () => { db: ReturnType<typeof fakeDb>; sense: (id: string, A: number) => RoomSense; port?: PortOpts }, string]> = [
    ["kiosk-health heartbeat older than 3 min", () => ({ db: fakeDb({ recorder: READY(T) }), sense: (id, A) => idle(A, { room_id: id, reachable: { kh_heartbeat_at: ago(A, 200), poller_ok_at: ago(A, 30) } }) }), "kiosk_health_stale"],
    ["recorder ready for only 4 min", () => ({ db: fakeDb({ recorder: [{ received_at: ago(T, 240), state: "ready", session_open: "false" }] }), sense: (id, A) => idle(A, { room_id: id }) }), "recorder_ready_under_5min"],
    ["recorder state not ready", () => ({ db: fakeDb({ recorder: [{ received_at: ago(T, 60), state: "busy", session_open: "false" }, { received_at: ago(T, 600), state: "ready", session_open: "false" }] }), sense: (id, A) => idle(A, { room_id: id }) }), "recorder_not_ready"],
    ["recorder says a session is open", () => ({ db: fakeDb({ recorder: [{ received_at: ago(T, 60), state: "ready", session_open: "true" }, { received_at: ago(T, 600), state: "ready", session_open: "false" }] }), sense: (id, A) => idle(A, { room_id: id }) }), "recorder_not_ready"],
    ["recorder status unreadable", () => ({ db: fakeDb({ recorder: "throw" }), sense: (id, A) => idle(A, { room_id: id }) }), "recorder_status_unavailable"],
    ["no recorder status rows", () => ({ db: fakeDb({ recorder: [] }), sense: (id, A) => idle(A, { room_id: id }) }), "recorder_status_unavailable"],
    ["newest recorder status older than 7 min", () => ({ db: fakeDb({ recorder: [{ received_at: ago(T, 500), state: "ready", session_open: "false" }, { received_at: ago(T, 900), state: "ready", session_open: "false" }] }), sense: (id, A) => idle(A, { room_id: id }) }), "recorder_status_stale"],
    ["a start_day command is already in flight (Kiosk Bot, an earlier tick)", () => ({ db: fakeDb({ recorder: READY(T), inflight: true }), sense: (id, A) => idle(A, { room_id: id }) }), "start_in_flight"],
    ["the decision log cannot be read (attempt history unknown)", () => ({ db: fakeDb({ recorder: READY(T), failLog: true }), sense: (id, A) => idle(A, { room_id: id }) }), "decision_log_unavailable"],
    ["Home Office is never started live", () => ({ db: fakeDb({ recorder: READY(T), rooms: [{ room_id: "room_2qe955hy", room_name: "Home Office", hostname: "HOST-H" }] }), sense: (id, A) => idle(A, { room_id: id }) }), "dev_room"],
    ["ORB3 is never started live", () => ({ db: fakeDb({ recorder: READY(T), rooms: [{ room_id: "room_jwyrr4dc", room_name: "ORB3", hostname: "HOST-O" }] }), sense: (id, A) => idle(A, { room_id: id }) }), "dev_room"],
  ];
  for (const [name, mk, reason] of cases) {
    it(`${name} -> no command, one skip row (${reason})`, async () => {
      const { db, sense } = mk();
      const { port, calls } = fakePort();
      senseWith(sense);
      await tick(db, port, T);
      expect(calls.insert).toHaveLength(0);
      expect(rowsOf(db)).toHaveLength(1);
      expect(rowsOf(db)[0]).toMatchObject({ rule: SKIP_RULE, action: "log_only", mode: "shadow", params: { reason } });
      expect(rowsOf(db)[0]!.result).toBe(`skipped: ${reason}`);
    });
  }

  it("a room flagged dev/test in steward_config is not in the roster at all: no decision, no command", async () => {
    const db = fakeDb({ recorder: READY(T), cfg: BASE_CFG({ rooms: { room_a: { class: "clinic", flags: ["dev"] } } }) });
    const { port, calls } = fakePort();
    senseWith((id, A) => idle(A, { room_id: id }));
    await tick(db, port, T);
    expect(calls.insert).toHaveLength(0);
    expect(rowsOf(db)).toHaveLength(0);
  });

  it("the server says a session is open (Kiosk Bot started it between sensing and enqueue): success, nothing enqueued, not an attempt", async () => {
    const db = fakeDb({ recorder: READY(T) });
    const { port, calls } = fakePort({ session: { id: "bs_9", status: "recording", started_at: new Date(T).toISOString() }, decide: "already_recording" });
    senseWith((id, A) => idle(A, { room_id: id }));
    await tick(db, port, T);
    expect(calls.insert).toHaveLength(0);
    expect(calls.find).toBe(1);
    expect(rowsOf(db)[0]).toMatchObject({ rule: SKIP_RULE, params: { reason: "already_recording" }, mode: "shadow" });
    expect(attemptsToday(rowsOf(db).map(toRecent), T)).toHaveLength(0);
    // the next minute it may still start if the room really is idle: nothing was spent
    senseWith((id, A) => idle(A, { room_id: id }));
    const p2 = fakePort();
    db.state.recorder = READY(T + 20 * MIN);
    await tick(db, p2.port, T + 20 * MIN);
    expect(p2.calls.insert).toHaveLength(1);
  });

  it("the kiosk is not listening, or the room is paused: refused by decideStart, nothing enqueued, never an override", async () => {
    for (const decide of ["kiosk_not_listening", "room_paused"] as const) {
      const db = fakeDb({ recorder: READY(T) });
      const { port, calls } = fakePort({ decide });
      senseWith((id, A) => idle(A, { room_id: id }));
      await tick(db, port, T);
      expect(calls.insert).toHaveLength(0);
      expect(rowsOf(db)[0]).toMatchObject({ rule: SKIP_RULE, params: { reason: decide } });
    }
  });
});

const toRecent = (r: Stored): RecentAction => ({
  ts: r.ts,
  rule: r.rule,
  action: r.action,
  params: r.params,
  outcome: r.result?.startsWith("failed") ? "failed" : r.result?.startsWith("ok") ? "ok" : r.result?.startsWith("shadow") || r.result === "kill_switch" ? "shadow" : null,
  failing_class: null,
});

describe("attempt cap and backoff (5 / 15 / 45 min, 3 per IST day)", () => {
  it("1st at T, refused at +4, 2nd at +5, refused until +20, 3rd at +20, then the cap", async () => {
    const db = fakeDb({});
    const { port, calls } = fakePort();
    senseWith((id, A) => idle(A, { room_id: id }));
    const at = async (min: number) => {
      db.state.recorder = READY(T + min * MIN);
      await tick(db, port, T + min * MIN);
    };
    await at(0);
    expect(calls.insert).toHaveLength(1);
    await at(4);
    expect(calls.insert).toHaveLength(1);
    expect(rowsOf(db).at(-1)).toMatchObject({ rule: SKIP_RULE, params: { reason: "attempt_backoff_5m" } });
    await at(5);
    expect(calls.insert).toHaveLength(2);
    await at(19);
    expect(calls.insert).toHaveLength(2);
    expect(rowsOf(db).at(-1)).toMatchObject({ params: { reason: "attempt_backoff_15m" } });
    await at(20);
    expect(calls.insert).toHaveLength(3);
    await at(80);
    await at(300);
    expect(calls.insert).toHaveLength(MAX_ATTEMPTS_PER_DAY);
    expect(rowsOf(db).at(-1)).toMatchObject({ params: { reason: "attempt_cap_reached" } });
    expect(live(db)).toHaveLength(3);
    expect(BACKOFF_MIN).toEqual([5, 15, 45]);
  });

  it("an attempt whose command result is ok=false (the enqueue throws) counts as an attempt and starts the backoff", async () => {
    const db = fakeDb({});
    const failing = fakePort({ insert: async () => { throw new Error("bench bus down"); } });
    senseWith((id, A) => idle(A, { room_id: id }));
    db.state.recorder = READY(T);
    await tick(db, failing.port, T);
    expect(failing.calls.insert).toHaveLength(1);
    expect(live(db)[0]).toMatchObject({ mode: "live" });
    expect(live(db)[0]!.result).toMatch(/^failed: bench bus down/);
    db.state.recorder = READY(T + 3 * MIN);
    await tick(db, failing.port, T + 3 * MIN);
    expect(failing.calls.insert).toHaveLength(1);
    expect(rowsOf(db).at(-1)).toMatchObject({ params: { reason: "attempt_backoff_5m" } });
  });

  it("the daily cap resets at IST midnight: attempts of the previous IST day do not count", () => {
    const A = ist("08:00", "2026-10-07");
    const row = (ts: number): RecentAction => ({ ts: new Date(ts).toISOString(), rule: "not_recording", action: "scribe_start", params: {}, outcome: "ok", failing_class: null });
    const yesterday = [row(ist("23:59", "2026-10-06")), row(ist("23:58", "2026-10-06")), row(ist("21:00", "2026-10-06"))];
    expect(attemptsToday(yesterday, A)).toHaveLength(0);
    expect(attemptsToday([...yesterday, row(ist("00:00", "2026-10-07")), row(ist("07:45", "2026-10-07"))], A)).toHaveLength(2);
  });
});

describe("waiting_for_mic: never start an unplugged kiosk; start promptly when the mic returns", () => {
  const cfgOn = { ...DEFAULT_CONFIG, kill_switch: false, start_day_live: true };
  const absent = (id: string, A: number) => idle(A, { room_id: id, audio: { default_input_present: false } });
  const present = (id: string, A: number) => idle(A, { room_id: id, audio: { default_input_present: true } });
  const run = () => {
    const db = fakeDb({ deviceName: "USB Mic X" });
    const p = fakePort();
    const at = async (min: number, sense: typeof absent, base = T) => {
      senseWith(sense);
      db.state.recorder = READY(base + min * MIN);
      await tick(db, p.port, base + min * MIN);
    };
    return { db, ...p, at };
  };

  it("device missing at 07:31 with 0 attempts: waiting_for_mic, NO attempt, ONE alert; the second tick adds no alert", async () => {
    const { db, calls, at } = run();
    const t = ist("07:31");
    await at(0, absent, t);
    expect(calls.insert).toHaveLength(0);
    expect(calls.find).toBe(0);
    expect(rowsOf(db).filter((r) => r.rule === ALERT_RULE)).toHaveLength(1);
    const alert = rowsOf(db).find((r) => r.rule === ALERT_RULE)!;
    expect(alert).toMatchObject({ action: "log_only", params: { reason: "device_missing", device: "USB Mic X" } });
    expect(alert.why).toContain("OPD A");
    expect(alert.why).toContain("room_a");
    expect(alert.why).toContain("USB Mic X");
    expect(JSON.stringify(alert)).not.toContain("severity\":\"info");
    expect(rowsOf(db).find((r) => r.rule === SKIP_RULE)).toMatchObject({ params: { reason: "waiting_for_mic", mic_ticks: 0 }, result: "skipped: waiting_for_mic" });
    await at(1, absent, t);
    await at(2, absent, t);
    expect(rowsOf(db).filter((r) => r.rule === ALERT_RULE)).toHaveLength(1);
    expect(calls.insert).toHaveLength(0);
    expect(attemptsToday(rowsOf(db).map(toRecent), t + 2 * MIN)).toHaveLength(0);
  });

  it("the old device_missing attempt / hold paths are gone", async () => {
    const { db, calls, at } = run();
    await at(0, absent);
    await at(6, absent);
    await at(60, absent);
    expect(calls.insert).toHaveLength(0);
    const all = JSON.stringify(rowsOf(db));
    expect(all).not.toContain("device_missing_hold");
    expect(all).not.toContain("device_missing_after_attempt");
    expect(rowsOf(db).filter((r) => r.mode === "live")).toHaveLength(0);
  });

  it("mic present on 1 tick only is still waiting; 2 consecutive present ticks go (full recorder streak NOT required); a flap resets the count", async () => {
    const { db, calls, at } = run();
    await at(0, absent);
    await at(1, present);
    expect(calls.insert).toHaveLength(0);
    expect(rowsOf(db).at(-1)).toMatchObject({ rule: SKIP_RULE, params: { reason: "waiting_for_mic", mic_ticks: 1 } });
    await at(2, absent);                                      // flap: back to 0
    expect(rowsOf(db).at(-1)).toMatchObject({ params: { reason: "waiting_for_mic", mic_ticks: 0 } });
    await at(3, present);
    await at(4, present);
    expect(calls.insert).toHaveLength(1);
    expect(live(db)).toHaveLength(1);
    expect(live(db)[0]!.params).toEqual({ mic_return: true });
    expect(live(db)[0]!.inputs).toMatchObject({ mic_return: true });
  });

  it("a mic-return start skips the 5-min recorder streak when the newest recorder row is ready and <= 7 min old, but every other guard still applies", async () => {
    const { db, calls, port } = (() => { const d = fakeDb({}); return { db: d, ...fakePort() }; })();
    const fresh = (A: number): RecorderRow[] => [{ received_at: ago(A, 60), state: "ready", session_open: "false" }];
    const at = async (min: number, sense: (id: string, A: number) => RoomSense, rec: (A: number) => RecorderRow[]) => {
      senseWith(sense);
      db.state.recorder = rec(T + min * MIN);
      await tick(db, port, T + min * MIN);
    };
    await at(0, absent, fresh);
    await at(1, present, fresh);
    await at(2, present, (A) => [{ received_at: ago(A, 600), state: "ready", session_open: "false" }]);       // stale recorder row: held
    expect(calls.insert).toHaveLength(0);
    expect(rowsOf(db).at(-1)).toMatchObject({ params: { reason: "recorder_status_stale", mic_return: true } });
    await at(3, present, (A) => [{ received_at: ago(A, 60), state: "busy", session_open: "false" }]);           // not ready: held
    expect(calls.insert).toHaveLength(0);
    await at(4, present, fresh);                                                                               // confirmation survived the held ticks
    expect(calls.insert).toHaveLength(1);
  });

  it("at 21:31 the same two present ticks do not start: outside_start_window", () => {
    const A = ist("21:31");
    const waiting: RecentAction[] = [
      { ts: new Date(A - 2 * MIN).toISOString(), rule: SKIP_RULE, action: "log_only", params: { reason: "waiting_for_mic", mic_ticks: 1 }, outcome: null, failing_class: null },
    ];
    expect(evaluateStartDay({ sense: idle(A, { audio: { default_input_present: true } }), cfg: cfgOn, A, recent: waiting, recorder: READY(A) })).toMatchObject({ go: false, reason: "outside_start_window" });
    // and the same state inside the window goes
    const B = ist("21:29");
    const w2: RecentAction[] = [{ ...waiting[0]!, ts: new Date(B - 60_000).toISOString() }];
    expect(evaluateStartDay({ sense: idle(B, { audio: { default_input_present: true } }), cfg: cfgOn, A: B, recent: w2, recorder: READY(B) })).toMatchObject({ go: true, mic_return: true });
  });

  it("3 failed non-device attempts, then the device goes missing: waiting_for_mic wins over the cap and the backoff", () => {
    const A = T + 60 * MIN;
    const failed = (min: number): RecentAction => ({ ts: new Date(T + min * MIN).toISOString(), rule: "not_recording", action: "scribe_start", params: {}, outcome: "failed", failing_class: null });
    const recent = [failed(0), failed(5), failed(20)];
    const sense = idle(A, { audio: { default_input_present: false } });
    expect(evaluateStartDay({ sense, cfg: cfgOn, A, recent, recorder: READY(A) })).toMatchObject({ go: false, reason: "waiting_for_mic", alert: expect.any(Object) });
    // and with a backoff still running (last attempt 1 min ago) the device check still wins
    expect(evaluateStartDay({ sense, cfg: cfgOn, A, recent: [failed(59)], recorder: READY(A) })).toMatchObject({ reason: "waiting_for_mic" });
    // the mic back for 2 ticks: now the cap applies again
    const back = [...recent, { ts: new Date(A - MIN).toISOString(), rule: SKIP_RULE, action: "log_only", params: { reason: "waiting_for_mic", mic_ticks: 1 }, outcome: null, failing_class: null } as RecentAction];
    expect(evaluateStartDay({ sense: idle(A, { audio: { default_input_present: true } }), cfg: cfgOn, A, recent: back, recorder: READY(A) })).toMatchObject({ go: false, reason: "attempt_cap_reached", params: { mic_return: true } });
  });

  it("waiting ticks are not attempts: a returning room still has its full 3/day", async () => {
    const { db, calls, at } = run();
    for (let i = 0; i < 10; i++) await at(i, absent);
    await at(10, present);
    await at(11, present);                                   // 1st attempt
    expect(calls.insert).toHaveLength(1);
    expect(attemptsToday(rowsOf(db).map(toRecent), T + 11 * MIN)).toHaveLength(1);
    await at(16, present);                                   // backoff 5 min over: 2nd
    await at(31, present);                                   // 15 min over: 3rd
    expect(calls.insert).toHaveLength(3);
    await at(120, present);
    expect(calls.insert).toHaveLength(3);
    expect(rowsOf(db).at(-1)).toMatchObject({ params: { reason: "attempt_cap_reached" } });
  });

  it("the device rule reads the three signals the mic_fault rule uses", () => {
    const A = T;
    for (const audio of [{ default_input_present: false }, { usb_removed_recent: true }, { device_missing_flag: true }]) {
      const v = evaluateStartDay({ sense: idle(A, { audio }), cfg: cfgOn, A, recent: [], recorder: READY(A) });
      expect(v).toMatchObject({ go: false, reason: "waiting_for_mic", alert: { device: "input device (name not reported)" } });
    }
  });

  it("a USB removal keeps the room waiting even if the default input reads present", () => {
    const A = T;
    const v = evaluateStartDay({ sense: idle(A, { audio: { default_input_present: true, usb_removed_recent: true } }), cfg: cfgOn, A, recent: [], recorder: READY(A) });
    expect(v).toMatchObject({ go: false, reason: "waiting_for_mic" });
  });

  it("an unknown default_input (null) inside a waiting episode keeps waiting; outside an episode it is not a missing mic", () => {
    const A = T;
    const sense = idle(A, { audio: { default_input_present: null } });
    expect(evaluateStartDay({ sense, cfg: cfgOn, A, recent: [], recorder: READY(A) })).toMatchObject({ go: true, mic_return: false });
    const waiting: RecentAction[] = [{ ts: new Date(A - 2 * MIN).toISOString(), rule: SKIP_RULE, action: "log_only", params: { reason: "waiting_for_mic", mic_ticks: 0 }, outcome: null, failing_class: null }];
    expect(evaluateStartDay({ sense, cfg: cfgOn, A, recent: waiting, recorder: READY(A) })).toMatchObject({ go: false, reason: "waiting_for_mic" });
  });

  it("a day later the alert is allowed again (once per IST day)", () => {
    const A = ist("08:00", "2026-10-08");
    const yesterdayAlert: RecentAction[] = [{ ts: new Date(ist("08:00", "2026-10-07")).toISOString(), rule: ALERT_RULE, action: "log_only", params: { reason: "device_missing" }, outcome: null, failing_class: null }];
    expect(evaluateStartDay({ sense: idle(A, { audio: { default_input_present: false } }), cfg: cfgOn, A, recent: yesterdayAlert, recorder: READY(A) })).toMatchObject({ alert: { device: expect.any(String) } });
  });
});

describe("mic_returned_but_silent: the existing silent alert after a mic-return start", () => {
  const start = T;
  const attempt = (params: Record<string, unknown>): RecentAction => ({ ts: new Date(start).toISOString(), rule: "not_recording", action: "scribe_start", params, outcome: "ok", failing_class: null });
  const sense = (A: number, since: string | null, open = true) => healthy(A, { recording: { session_open: open }, audio: { silent_while_recording_since: since } });

  it("zero_ratio 1.0 for 2 min after a mic-return start: one log_only alert, nothing stopped", async () => {
    const db = fakeDb({});
    const { port, calls } = fakePort();
    senseWith(() => idle(T, {}));
    // a past mic-return start (the attempt row), then the recorder is open and silent
    const A1 = start + 2 * MIN + 10_000;
    db.state.table.push({ id: 900, room_id: "room_a", ts: new Date(start).toISOString(), rule: "not_recording", action: "scribe_start", params: { mic_return: true }, result: "ok: start_day queued cmd_1", mode: "live", inputs: { primary: true }, why: "", why_not: null, actor: "steward", machine: "HOST-A", window_kind: "clinic", inputs_hash: "x" });
    senseWith((id, A) => sense(A, new Date(start + 5_000).toISOString()) as RoomSense);
    await tick(db, port, A1);
    const alerts = rowsOf(db).filter((r) => r.rule === ALERT_RULE);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ action: "log_only", params: { reason: "mic_returned_but_silent" }, why_not: null });
    expect(calls.insert).toHaveLength(0);
    expect(rowsOf(db).some((r) => r.action === "scribe_stop" || r.action === "restart")).toBe(false);
    await tick(db, port, A1 + MIN);                         // no repeat
    expect(rowsOf(db).filter((r) => r.rule === ALERT_RULE && r.params.reason === "mic_returned_but_silent")).toHaveLength(1);
  });

  it("pure: not before 2 min, not for a normal start, not when the tape has sound, not when no session is open", () => {
    const since = new Date(start + 5_000).toISOString();
    const mr = [attempt({ mic_return: true })];
    expect(micReturnSilent(sense(start + 90_000, since), mr, start + 90_000)).toBeNull();
    expect(micReturnSilent(sense(start + 130_000, since), mr, start + 130_000)).toMatchObject({ silent_since: since });
    expect(micReturnSilent(sense(start + 130_000, since), [attempt({})], start + 130_000)).toBeNull();
    expect(micReturnSilent(sense(start + 130_000, null), mr, start + 130_000)).toBeNull();
    expect(micReturnSilent(sense(start + 130_000, since, false), mr, start + 130_000)).toBeNull();
    // silent only for the last 60 s: the first 2 minutes were not all zero
    expect(micReturnSilent(sense(start + 130_000, new Date(start + 70_000).toISOString()), mr, start + 130_000)).toBeNull();
  });
});

describe("phantom_session (shadow only)", () => {
  const phantom = (id: string, A: number) =>
    idle(A, { room_id: id, recording: { session_open: false, session_id: null, session_status: null, session_started_at: null, last_chunk_at: null, recorder_status: { state: "recording", session_open: true, received_at: ago(A, 30) } } });

  it("recorder says session_open but the server has none, 2 consecutive ticks: phantom_session log_only, no command", async () => {
    const db = fakeDb({ recorder: [] });
    const { port, calls } = fakePort();
    senseWith(phantom);
    await tick(db, port, T);
    expect(rowsOf(db).filter((r) => r.rule === "phantom_session")).toHaveLength(0);
    expect(rowsOf(db).filter((r) => r.rule === "phantom_session_candidate")).toHaveLength(1);
    await tick(db, port, T + MIN);
    const p = rowsOf(db).filter((r) => r.rule === "phantom_session");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ action: "log_only", mode: "shadow", room_id: "room_a" });
    await tick(db, port, T + 2 * MIN);                         // no repeat inside 15 min
    expect(rowsOf(db).filter((r) => r.rule === "phantom_session")).toHaveLength(1);
    expect(calls.insert).toHaveLength(0);
  });

  it("one tick is only a candidate; a healthy recorder or an open server session is nothing; works with start_day_live off", async () => {
    const db = fakeDb({ cfg: BASE_CFG({ start_day_live: { on: false } }), recorder: [] });
    const { port, calls } = fakePort();
    senseWith(phantom);
    await tick(db, port, T);
    expect(rowsOf(db).filter((r) => r.rule === "phantom_session")).toHaveLength(0);
    senseWith((id, A) => idle(A, { room_id: id }));
    await tick(db, port, T + MIN);
    senseWith((id, A) => healthy(A, { room_id: id, recording: { recorder_status: { state: "recording", session_open: true, received_at: ago(A, 30) } } }));
    await tick(db, port, T + 2 * MIN);
    expect(rowsOf(db).filter((r) => r.rule === "phantom_session")).toHaveLength(0);
    expect(calls.insert).toHaveLength(0);
  });
});

describe("the pure guards at their edges", () => {
  const cfg = { ...DEFAULT_CONFIG, kill_switch: false, start_day_live: true };
  const go = (A: number, over: Parameters<typeof idle>[1] = {}, recorder: RecorderRow[] | null = READY(A)) => evaluateStartDay({ sense: idle(A, over), cfg, A, recent: [], recorder });

  it("time window: 07:29:59 no, 07:30:00 yes, 21:29:59 yes, 21:30:00 no (IST, end exclusive)", () => {
    expect(go(ist("07:29", "2026-10-06", "59"))).toMatchObject({ go: false, reason: "outside_start_window" });
    expect(go(ist("07:30"))).toMatchObject({ go: true });
    expect(go(ist("21:29", "2026-10-06", "59"))).toMatchObject({ go: true });
    expect(go(ist("21:30"))).toMatchObject({ go: false, reason: "outside_start_window" });
  });
  it("the start window is 07:30-21:30 for an OT room too (its own schedule starts at 06:00)", () => {
    expect(go(ist("06:30"), { klass: "ot", kind: "ot" })).toMatchObject({ go: false, reason: "outside_start_window" });
  });
  it("the literal 07:30-21:30 applies even when the configured clinic window is wider", () => {
    const wide = { ...cfg, schedule: { ...cfg.schedule, clinic: { ...cfg.schedule.clinic, start: "06:00", end: "23:00" } } };
    for (const [hhmm, want] of [["07:29", false], ["07:30", true], ["21:29", true], ["21:30", false]] as const) {
      const A = ist(hhmm);
      expect(evaluateStartDay({ sense: idle(A), cfg: wide, A, recent: [], recorder: READY(A) }).go).toBe(want);
    }
  });
  it("a closed day is outside the window", () => {
    const A = ist("10:00");
    const v = evaluateStartDay({ sense: idle(A), cfg: { ...cfg, days: { mode: "every_day", closed: ["2026-10-06"] } }, A, recent: [], recorder: READY(A) });
    expect(v).toMatchObject({ go: false, reason: "outside_start_window" });
  });
  it("heartbeat: 180 s ok, 181 s stale, missing stale", () => {
    expect(go(T, { reachable: { kh_heartbeat_at: ago(T, 180) } })).toMatchObject({ go: true });
    expect(go(T, { reachable: { kh_heartbeat_at: ago(T, 181) } })).toMatchObject({ go: false, reason: "kiosk_health_stale" });
    expect(go(T, { reachable: { kh_heartbeat_at: null } })).toMatchObject({ go: false, reason: "kiosk_health_stale" });
  });
  it("recorder ready: exactly 5 min ok, 4:59 not; the streak is the newest run of ready rows", () => {
    const row = (s: number, state = "ready", so: string | boolean = "false"): RecorderRow => ({ received_at: ago(T, s), state, session_open: so });
    expect(recorderVerdict([row(60), row(300)], T)).toMatchObject({ ok: true });
    expect(recorderVerdict([row(60), row(299)], T)).toMatchObject({ ok: false, reason: "recorder_ready_under_5min" });
    expect(recorderVerdict([row(60), row(120, "busy"), row(900)], T)).toMatchObject({ ok: false, reason: "recorder_ready_under_5min" });
    expect(recorderVerdict([row(60, "ready", false), row(400, "ready", false)], T)).toMatchObject({ ok: true });
    expect(recorderVerdict([row(60, "READY ")], T)).toMatchObject({ ok: false });   // single row: no proof of 5 min
    expect(recorderVerdict([row(420), row(900)], T)).toMatchObject({ ok: true });  // newest exactly 7 min old
    expect(recorderVerdict([row(421), row(900)], T)).toMatchObject({ ok: false, reason: "recorder_status_stale" });
  });
  it("a sensed open session or unknown session never starts", () => {
    expect(go(T, { recording: { session_open: true } })).toMatchObject({ go: false, reason: "session_open" });
    expect(go(T, { recording: { session_open: null } })).toMatchObject({ go: false, reason: "session_unknown" });
  });
  it("the never-start list names ORB3 and Home Office", () => {
    expect(NEVER_START_DAY_ROOMS).toEqual(["room_jwyrr4dc", "room_2qe955hy"]);
    expect(go(T, { flags: ["TEST"] })).toMatchObject({ go: false, reason: "dev_room" });
  });
});

describe("attemptStart", () => {
  it("passes decideStart's args through and never overrides a pause", async () => {
    const seen: unknown[] = [];
    const port: StartDayPort = {
      findActiveSession: async () => null,
      getListener: async () => ({}),
      decideStart: (i) => (seen.push(i.overridePause), { action: "send", args: null }),
      insertCommand: async () => "c1",
    };
    expect(await attemptStart(port, "room_a", T)).toEqual({ counted: true, result: "ok: start_day queued c1" });
    expect(seen).toEqual([false]);
  });
});
