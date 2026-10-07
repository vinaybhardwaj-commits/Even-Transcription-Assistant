/**
 * lib/steward/executor.ts — the live scribe_start path. Same primitives as scribe_start_recording (lib/mcp/tools/bench.ts): decideStart, insertCommand (start_day), waitForAck —
 * with the room's open session and the listener RE-READ at execution time, plus the daily schedule (lib/steward/start-schedule.ts). The database is a fake: no command is written for real here.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));

import { decideStart, type StartAttempt } from "@/lib/bench-commands";
import { LIVE_COMMAND_KIND, LiveExecutor, START_SOURCE, liveScribeStart, type StartDeps } from "@/lib/steward/executor";
import type { Decision } from "@/lib/steward/rules";

const NOW = new Date("2026-10-07T08:00:00Z");
const MIN = 60_000;
const dec = (room_id: string | null = "room_a", action = "scribe_start"): Decision =>
  ({ room_id, machine: "HOST-A", window_kind: "clinic", rule: "not_recording", action, params: {}, why: "", why_not: null, severity: "warn", inputs_hash: "x", inputs: {} }) as Decision;
const listening = (over: Record<string, unknown> = {}) => ({ room_id: "room_a", tab_id: "t", last_poll_at: new Date(NOW.getTime() - 2000), recording_session_id: null, paused: false, ...over }) as never;
const attempt = (minAgo: number, over: Partial<StartAttempt> = {}): StartAttempt => ({ status: "failed", created_at: new Date(NOW.getTime() - minAgo * MIN).toISOString(), acked_at: null, session_started: false, session_named: false, ...over });

function deps(over: Partial<StartDeps> = {}) {
  const calls = { insert: [] as Array<Record<string, unknown>>, wait: [] as Array<{ id: string; timeoutMs?: number }>, active: 0, listener: 0, today: 0, recent: 0 };
  const d: StartDeps = {
    getListener: async () => (calls.listener++, listening()),
    findActiveSession: async () => (calls.active++, null),
    getRecentStartAttempts: async () => (calls.recent++, []),
    getStewardAttemptsToday: async () => (calls.today++, []),
    decideStart,
    insertCommand: async (i) => (calls.insert.push(i as never), "cmd_1"),
    waitForAck: async (id, o) => (calls.wait.push({ id, timeoutMs: o.timeoutMs }), { status: "acked", error: null, result: {} }),
    ...over,
  };
  return { d, calls };
}
const go = (d: StartDeps, over: { ackTimeoutMs?: number; maxAttempts?: number } = {}) => liveScribeStart(dec(), d, { now: () => NOW, ...over });

describe("liveScribeStart — the bench start_day path", () => {
  it("a listening kiosk, no session, no attempts today: ONE start_day command from source 'steward', ack waited, result ok", async () => {
    const { d, calls } = deps();
    const r = await go(d, { ackTimeoutMs: 4321 });
    expect(r.result).toBe("ok: start_day acked command_id=cmd_1");
    expect(calls.insert).toEqual([{ roomId: "room_a", kind: "start_day", args: undefined, source: START_SOURCE }]);
    expect(START_SOURCE).toBe("steward");
    expect(calls.wait).toEqual([{ id: "cmd_1", timeoutMs: 4321 }]);
  });

  it("EXECUTION-TIME RE-CHECK: the sense said no session, but the room has one open NOW (Kiosk Bot started it) -> success, nothing is sent, not an attempt", async () => {
    const { d, calls } = deps({ findActiveSession: async () => ({ id: "bs_77", status: "recording", started_at: NOW.toISOString() }) });
    const r = await go(d);
    expect(r.result).toBe("skipped: already_recording session_id=bs_77");
    expect(calls.insert).toHaveLength(0);
    expect(calls.wait).toHaveLength(0);
  });

  it("the re-check reads the listener and the session when the executor RUNS, every call (not once at construction)", async () => {
    const state = { open: false };
    const { d, calls } = deps({ findActiveSession: async () => (state.open ? { id: "bs_1", status: "recording", started_at: NOW.toISOString() } : null) });
    const ex = new LiveExecutor({ deps: d, now: () => NOW });
    expect((await ex.scribeStart(dec())).result).toMatch(/^ok:/);
    state.open = true;
    expect((await ex.scribeStart(dec())).result).toMatch(/^skipped: already_recording/);
    expect(calls.insert).toHaveLength(1);
    expect(calls.listener).toBe(2);
  });

  it("a paused session or a listener-paused room is never started over (no override), a kiosk that is not listening is never sent a command", async () => {
    const a = deps({ findActiveSession: async () => ({ id: "bs_p", status: "paused", started_at: NOW.toISOString() }) });
    expect((await go(a.d)).result).toBe("skipped: room_paused");
    const b = deps({ getListener: async () => listening({ paused: true }) });
    expect((await go(b.d)).result).toBe("skipped: room_paused");
    const c = deps({ getListener: async () => listening({ last_poll_at: new Date(NOW.getTime() - 60_000) }) });
    expect((await go(c.d)).result).toBe("skipped: kiosk_not_listening");
    const e = deps({ getListener: async () => null });
    expect((await go(e.d)).result).toBe("skipped: kiosk_not_listening");
    for (const x of [a, b, c, e]) expect(x.calls.insert).toHaveLength(0);
  });

  it("a start_day of ANY source younger than 4 min (Kiosk Bot may be starting the room) is in flight: nothing is sent", async () => {
    const young = deps({ getRecentStartAttempts: async () => [attempt(3, { status: "pending" })] });
    expect((await go(young.d)).result).toBe("skipped: start_in_flight");
    expect(young.calls.insert).toHaveLength(0);
    const old = deps({ getRecentStartAttempts: async () => [attempt(10, { status: "acked", acked_at: new Date(NOW.getTime() - 9 * MIN).toISOString(), session_started: true })] });
    expect((await go(old.d)).result).toMatch(/^ok:/);
  });

  it("the daily schedule: after the 1st failed attempt 5 min, after the 2nd 15 min, a 4th never; a pending attempt holds; an unreadable log fails CLOSED", async () => {
    const at = (a: StartAttempt[]) => deps({ getStewardAttemptsToday: async () => a });
    expect((await go(at([attempt(4)]).d)).result).toMatch(/^skipped: start_backoff attempts=1 retry_after_s=60$/);
    expect((await go(at([attempt(5)]).d)).result).toMatch(/^ok:/);
    expect((await go(at([attempt(100), attempt(14)]).d)).result).toMatch(/^skipped: start_backoff attempts=2 retry_after_s=60$/);
    expect((await go(at([attempt(100), attempt(15)]).d)).result).toMatch(/^ok:/);
    const three = at([attempt(300), attempt(200), attempt(100)]);
    expect((await go(three.d)).result).toBe("skipped: start_exhausted attempts=3");
    expect(three.calls.insert).toHaveLength(0);
    expect((await go(at([attempt(1, { status: "pending" })]).d)).result).toBe("skipped: start_pending attempts=1");
    const broken = deps({ getStewardAttemptsToday: async () => { throw new Error("db down"); } });
    expect((await go(broken.d)).result).toBe("skipped: start_attempts_unreadable");
    expect(broken.calls.insert).toHaveLength(0);
    // the cap follows config (caps.start_retries)
    expect((await go(at([attempt(300), attempt(200)]).d, { maxAttempts: 2 })).result).toBe("skipped: start_exhausted attempts=2");
  });

  it("a command that is not acked is FAILED (it counts toward the cap and the schedule); a failed ack is failed; skipped results are not", async () => {
    const none = deps({ waitForAck: async () => null });
    expect((await go(none.d)).result).toMatch(/^failed: no ack from the kiosk command_id=cmd_1$/);
    const bad = deps({ waitForAck: async () => ({ status: "failed", error: "mic busy", result: {} }) });
    expect((await go(bad.d)).result).toBe("failed: start_day failed (mic busy) command_id=cmd_1");
    const { outcomeOf } = await import("@/lib/steward/loop");
    expect(outcomeOf("ok: start_day acked command_id=c")).toBe("ok");
    expect(outcomeOf("failed: no ack from the kiosk command_id=c")).toBe("failed");
    expect(outcomeOf("skipped: already_recording session_id=x")).toBeNull();
    expect(outcomeOf("skipped: start_backoff attempts=1 retry_after_s=9")).toBeNull();
  });

  it("a decision with no room sends nothing; a bus error on insert propagates (the loop records it as blocked / shadow and nothing was queued)", async () => {
    const { d, calls } = deps();
    expect((await liveScribeStart(dec(null), d, { now: () => NOW })).result).toBe("skipped: no_room");
    expect(calls.listener).toBe(0);
    const boom = deps({ insertCommand: async () => { throw new Error("bus_down"); } });
    await expect(go(boom.d)).rejects.toThrow("bus_down");
  });
});

describe("the live executor can only emit start_day — never stop, restart, pause, a ticket or a message", () => {
  it("every other executor method throws without touching the bus; the only kind ever queued is start_day", async () => {
    const { d, calls } = deps();
    const ex = new LiveExecutor({ deps: d, now: () => NOW });
    for (const m of ["scribeStop", "scribeRestart", "issueTicket", "message"] as const) await expect((async () => ex[m](dec("room_a", m)))()).rejects.toThrow("live executor not enabled");
    expect(calls.insert).toHaveLength(0);
    expect(calls.listener + calls.active + calls.today + calls.recent).toBe(0);
    await ex.scribeStart(dec());
    await go(deps({ getStewardAttemptsToday: async () => [attempt(10)] }).d);
    expect(calls.insert.map((i) => i.kind)).toEqual(["start_day"]);
    expect(LIVE_COMMAND_KIND).toBe("start_day");
  });

  it("whatever the room looks like, the only kind queued is start_day (listener / session / attempts permutations)", async () => {
    const kinds = new Set<unknown>();
    const listeners = [listening(), listening({ paused: true }), null, listening({ recording_session_id: "bs_x" })];
    const sessions = [null, { id: "bs_1", status: "recording", started_at: "x" }, { id: "bs_2", status: "paused", started_at: "x" }];
    const histories: StartAttempt[][] = [[], [attempt(10)], [attempt(1, { status: "pending" })], [attempt(300), attempt(200), attempt(100)]];
    for (const l of listeners) for (const s of sessions) for (const h of histories) {
      const { d } = deps({ getListener: async () => l as never, findActiveSession: async () => s, getStewardAttemptsToday: async () => h, insertCommand: async (i) => (kinds.add(i.kind), "cmd_x") });
      await go(d);
    }
    expect([...kinds]).toEqual(["start_day"]);
  });

  it("structural guard: executor.ts contains no other bench command kind", () => {
    const src = readFileSync("lib/steward/executor.ts", "utf8");
    for (const k of ["end_day", "pause_day", "resume_day", "restart_engine", "close_orphan", "set_audio_input", "check_update_now", "report_diag", "self_test"]) expect(src.includes(k), k).toBe(false);
  });
});
