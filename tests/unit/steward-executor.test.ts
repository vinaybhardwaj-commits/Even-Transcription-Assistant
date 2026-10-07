/**
 * lib/steward/executor.ts — the live scribe_start path. Same primitives as scribe_start_recording (lib/mcp/tools/bench.ts): decideStart, applyStartBackoff, insertCommand
 * (start_day), waitForAck — with the room's open session and the listener RE-READ at execution time. The database is a fake: no command is ever written for real here.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));

import { applyStartBackoff, decideStart, type StartAttempt } from "@/lib/bench-commands";
import { LiveExecutor, START_SOURCE, liveScribeStart, type StartDeps } from "@/lib/steward/executor";
import type { Decision } from "@/lib/steward/rules";

const NOW = new Date("2026-10-07T08:00:00Z");
const dec = (room_id: string | null = "room_a"): Decision =>
  ({ room_id, machine: "HOST-A", window_kind: "clinic", rule: "not_recording", action: "scribe_start", params: {}, why: "", why_not: null, severity: "warn", inputs_hash: "x", inputs: {} }) as Decision;
const listening = (over: Record<string, unknown> = {}) => ({ room_id: "room_a", tab_id: "t", last_poll_at: new Date(NOW.getTime() - 2000), recording_session_id: null, paused: false, ...over }) as never;
const failedAttempt = (minAgo: number): StartAttempt => ({ status: "failed", created_at: new Date(NOW.getTime() - minAgo * 60_000).toISOString(), acked_at: null, session_started: false, session_named: false });

function deps(over: Partial<StartDeps> = {}) {
  const calls = { insert: [] as Array<Record<string, unknown>>, wait: [] as Array<{ id: string; timeoutMs?: number }>, active: 0, listener: 0, attempts: 0 };
  const d: StartDeps = {
    getListener: async () => (calls.listener++, listening()),
    findActiveSession: async () => (calls.active++, null),
    getRecentStartAttempts: async () => (calls.attempts++, []),
    decideStart,
    applyStartBackoff,
    insertCommand: async (i) => (calls.insert.push(i as never), "cmd_1"),
    waitForAck: async (id, o) => (calls.wait.push({ id, timeoutMs: o.timeoutMs }), { status: "acked", error: null, result: {} }),
    ...over,
  };
  return { d, calls };
}
const go = (d: StartDeps, over: { ackTimeoutMs?: number } = {}) => liveScribeStart(dec(), d, { now: () => NOW, ...over });

describe("liveScribeStart — the bench start_day path", () => {
  it("a listening kiosk, no session, no failed attempts: ONE start_day command from source 'steward', ack waited, result ok", async () => {
    const { d, calls } = deps();
    const r = await go(d, { ackTimeoutMs: 4321 });
    expect(r.result).toBe("ok: start_day acked command_id=cmd_1");
    expect(calls.insert).toEqual([{ roomId: "room_a", kind: "start_day", args: undefined, source: START_SOURCE }]);
    expect(START_SOURCE).toBe("steward");
    expect(calls.wait).toEqual([{ id: "cmd_1", timeoutMs: 4321 }]);
  });

  it("EXECUTION-TIME RE-CHECK: the sense said no session, but the room has one open NOW -> nothing is sent (skipped: already_recording)", async () => {
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
    state.open = true; // a session opens between two ticks / between sense and execution
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

  it("start backoff: 2 failed start_day in the last hour -> room_failing, nothing is sent; 1 failed still sends; an unreadable attempt log fails CLOSED", async () => {
    const two = deps({ getRecentStartAttempts: async () => [failedAttempt(40), failedAttempt(10)] });
    const r2 = await go(two.d);
    expect(r2.result).toMatch(/^skipped: room_failing failed_attempts=2 retry_after_s=\d+$/);
    expect(two.calls.insert).toHaveLength(0);
    const one = deps({ getRecentStartAttempts: async () => [failedAttempt(10)] });
    expect((await go(one.d)).result).toMatch(/^ok:/);
    expect(one.calls.insert).toHaveLength(1);
    const broken = deps({ getRecentStartAttempts: async () => { throw new Error("db down"); } });
    expect((await go(broken.d)).result).toBe("skipped: start_attempts_unreadable");
    expect(broken.calls.insert).toHaveLength(0);
  });

  it("a command that is not acked is FAILED (it counts toward the retry memory and the cap); a failed ack is failed; skipped results are not", async () => {
    const none = deps({ waitForAck: async () => null });
    expect((await go(none.d)).result).toMatch(/^failed: no ack from the kiosk command_id=cmd_1$/);
    const bad = deps({ waitForAck: async () => ({ status: "failed", error: "mic busy", result: {} }) });
    expect((await go(bad.d)).result).toBe("failed: start_day failed (mic busy) command_id=cmd_1");
    const { outcomeOf } = await import("@/lib/steward/loop");
    expect(outcomeOf("ok: start_day acked command_id=c")).toBe("ok");
    expect(outcomeOf("failed: no ack from the kiosk command_id=c")).toBe("failed");
    expect(outcomeOf("skipped: already_recording session_id=x")).toBeNull();
    expect(outcomeOf("skipped: room_failing failed_attempts=2 retry_after_s=9")).toBeNull();
  });

  it("a decision with no room sends nothing; a bus error on insert propagates (the loop records it as blocked / shadow)", async () => {
    const { d, calls } = deps();
    expect((await liveScribeStart(dec(null), d, { now: () => NOW })).result).toBe("skipped: no_room");
    expect(calls.listener).toBe(0);
    const boom = deps({ insertCommand: async () => { throw new Error("bus_down"); } });
    await expect(go(boom.d)).rejects.toThrow("bus_down");
  });
});
