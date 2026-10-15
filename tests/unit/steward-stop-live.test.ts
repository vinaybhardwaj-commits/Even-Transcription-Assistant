/**
 * The live scribe_stop (15 Oct, V GO via fable): liveScribeStop mirrors liveScribeStart over the end_day verb scribe_stop_recording sends. The database is a fake: no command is written for real.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));

import type { StartAttempt } from "@/lib/bench-commands";
import { DEFAULT_CONFIG, LIVE_CAPABLE_ACTIONS, LIVE_IMPLEMENTED_ACTIONS, actionMode, type Config } from "@/lib/steward/config";
import { LiveExecutor, STOP_COMMAND_KIND, START_SOURCE, dispatch, liveScribeStop, type StopDeps } from "@/lib/steward/executor";
import { EMPTY_RECENT, decideRoom, type Decision, type RecentAction } from "@/lib/steward/rules";
import { ago, healthy, ist } from "../support/steward-fixtures";

const NOW = new Date("2026-10-07T16:00:00Z");
const MIN = 60_000;
const dec = (over: { room_id?: string | null; late?: boolean; consult_open?: boolean | null } = {}): Decision =>
  ({
    room_id: over.room_id === undefined ? "room_a" : over.room_id,
    machine: "HOST-A",
    window_kind: "clinic",
    rule: "end_of_window",
    action: "scribe_stop",
    params: over.late ? { late: true } : {},
    why: "",
    why_not: null,
    severity: "info",
    inputs_hash: "x",
    inputs: { consult_open: over.consult_open === undefined ? false : over.consult_open },
  }) as Decision;
const listening = () => ({ room_id: "room_a", tab_id: "t", last_poll_at: new Date(NOW.getTime() - 2000), recording_session_id: "bs_1", paused: false }) as never;
const session = { id: "bs_1", status: "recording", started_at: new Date(NOW.getTime() - 3 * 3600_000).toISOString() };
const attempt = (minAgo: number, over: Partial<StartAttempt> = {}): StartAttempt => ({ status: "failed", created_at: new Date(NOW.getTime() - minAgo * MIN).toISOString(), acked_at: new Date(NOW.getTime() - minAgo * MIN).toISOString(), session_started: false, session_named: false, ...over });

function deps(over: Partial<StopDeps> = {}) {
  const calls = { insert: [] as Array<Record<string, unknown>>, expire: 0, listener: 0, active: 0, attempts: 0 };
  const d: StopDeps = {
    getListener: async () => (calls.listener++, listening()),
    findActiveSession: async () => (calls.active++, session),
    getStewardStopAttempts: async () => (calls.attempts++, []),
    expireStaleStops: async () => (calls.expire++, []),
    insertCommand: async (i) => (calls.insert.push(i as never), "cmd_s1"),
    waitForAck: async () => ({ status: "acked", error: null, result: {} }),
    ...over,
  };
  return { d, calls };
}
const go = (d: StopDeps, dd: Decision = dec(), maxAttempts?: number) => liveScribeStop(dd, d, { now: () => NOW, maxAttempts });

describe("T1: liveScribeStop sends ONE end_day from source 'steward'", () => {
  it("an open session, a listening kiosk, no earlier stop: exactly one end_day, ack waited, result ok", async () => {
    const { d, calls } = deps();
    const r = await go(d);
    expect(r.result).toBe("ok: end_day acked command_id=cmd_s1");
    expect(calls.insert).toEqual([{ roomId: "room_a", kind: "end_day", source: START_SOURCE }]);
    expect(STOP_COMMAND_KIND).toBe("end_day");
  });
  it("a second tick for the same still-open session: a stop is pending or in backoff -> no send; after the retries cap -> exhausted, no send", async () => {
    let a = deps({ getStewardStopAttempts: async () => [attempt(1, { status: "pending", acked_at: null })] });
    expect((await go(a.d)).result).toMatch(/^skipped: stop_pending/);
    a = deps({ getStewardStopAttempts: async () => [attempt(2)] });
    expect((await go(a.d)).result).toMatch(/^skipped: stop_backoff attempts=1 retry_after_s=\d+/);
    a = deps({ getStewardStopAttempts: async () => [attempt(30)] });
    expect((await go(a.d)).result).toMatch(/^ok:/); // past the 5 min backoff: one resend
    expect(a.calls.expire).toBe(1); // the stale pending stop is expired first
    a = deps({ getStewardStopAttempts: async () => [attempt(300), attempt(200), attempt(100)] });
    expect((await go(a.d)).result).toBe("skipped: stop_exhausted attempts=3");
    for (const x of [a]) expect(x.calls.insert).toHaveLength(0);
  });
  it("no ack in the tick is a sent-and-failed row (counts for the caps), a failed ack too; no open session = already stopped, nothing sent", async () => {
    expect((await go(deps({ waitForAck: async () => null }).d)).result).toBe("failed: end_day no ack in the tick command_id=cmd_s1");
    expect((await go(deps({ waitForAck: async () => ({ status: "failed", error: "x", result: {} }) }).d)).result).toBe("failed: end_day failed (x) command_id=cmd_s1");
    const none = deps({ findActiveSession: async () => null });
    expect((await go(none.d)).result).toBe("skipped: no_open_session");
    expect(none.calls.insert).toHaveLength(0);
    const deaf = deps({ getListener: async () => null });
    expect((await go(deaf.d)).result).toBe("skipped: kiosk_not_listening");
    expect(deaf.calls.insert).toHaveLength(0);
  });
  it("the rules say stop not acknowledged (warn, log_only) once caps.start_retries stops were sent for the open session", () => {
    const A = ist("21:35");
    const stop = (secAgo: number): RecentAction => ({ ts: ago(A, secAgo), rule: "end_of_window", action: "scribe_stop", params: {}, outcome: "failed" });
    const three = { room: [stop(900), stop(600), stop(100)], fleet: { failing: {}, hold: {} } };
    const d = decideRoom(healthy(A), DEFAULT_CONFIG, A, three)[0]!;
    expect(d).toMatchObject({ action: "log_only", severity: "warn", params: { wanted: "scribe_stop" } });
    expect(d.why).toContain("stop not acknowledged");
    const two = { room: [stop(600), stop(100)], fleet: { failing: {}, hold: {} } };
    expect(decideRoom(healthy(A), DEFAULT_CONFIG, A, two)[0]!.action).toBe("scribe_stop");
  });
});

describe("T2/T3: the switches and the never-live rooms", () => {
  const cfg = (over: Partial<Config> & { actions?: Record<string, boolean> } = {}): Config => ({ ...DEFAULT_CONFIG, shadow: { global: false, actions: over.actions ?? {} }, kill_switch: over.kill_switch ?? false, start_day_live: false, ...(over.caps ? { caps: over.caps } : {}) });
  it("kill switch, global shadow, action shadow -> not live (the loop then runs ShadowExecutor: zero sends); all open -> live without start_day_live", () => {
    expect(actionMode(cfg({ kill_switch: true }), "scribe_stop")).toBe("kill_switch");
    expect(actionMode({ ...cfg(), shadow: { global: true, actions: {} } }, "scribe_stop")).toBe("shadow");
    expect(actionMode(cfg({ actions: { scribe_stop: true } }), "scribe_stop")).toBe("shadow");
    expect(actionMode(cfg(), "scribe_stop")).toBe("live");
    expect(actionMode(cfg(), "scribe_restart")).toBe("shadow");
  });
  it("the hard never-live rooms are refused inside the executor before anything is read or sent", async () => {
    for (const id of ["room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy", "room_scratch_ab12"]) {
      const { d, calls } = deps();
      expect((await go(d, dec({ room_id: id }))).result, id).toBe("skipped: never_live_room");
      expect(calls.insert).toHaveLength(0);
      expect(calls.listener + calls.active + calls.attempts).toBe(0);
    }
    expect((await go(deps().d, dec({ room_id: null }))).result).toBe("skipped: no_room");
  });
});

describe("T4: never stop with a consult open", () => {
  it("consult_open true or null and not late -> zero sends; late:true -> one send", async () => {
    for (const c of [true, null] as const) {
      const { d, calls } = deps();
      expect((await go(d, dec({ consult_open: c }))).result).toMatch(/^skipped: consult_/);
      expect(calls.insert).toHaveLength(0);
      expect(calls.listener + calls.active).toBe(0);
    }
    const late = deps();
    expect((await go(late.d, dec({ late: true, consult_open: true }))).result).toMatch(/^ok:/);
    expect(late.calls.insert).toHaveLength(1);
  });
});

describe("T5: the hourly cap counts stops with starts", () => {
  it("start + stop + ticket executed rows reach actions_per_room_per_hour (4): the next scribe_stop is logged, not taken", () => {
    const A = ist("21:35");
    const r = (action: string, secAgo: number): RecentAction => ({ ts: ago(A, secAgo), rule: "r", action, params: {}, outcome: "ok" });
    const full = { room: [r("scribe_start", 3000), r("scribe_stop", 2000), r("ticket:wake", 1000), r("scribe_stop", 300)], fleet: { failing: {}, hold: {} } };
    // the session began 3 h ago, so the 3 stop rows... only 2 are stops: below start_retries (3), so the CAP is what holds it
    const d = decideRoom(healthy(A), DEFAULT_CONFIG, A, full)[0]!;
    expect(d).toMatchObject({ rule: "cap_reached", action: "log_only", params: { wanted: "scribe_stop" } });
    expect(decideRoom(healthy(A), DEFAULT_CONFIG, A, EMPTY_RECENT)[0]!.action).toBe("scribe_stop");
  });
});

describe("the executor wiring", () => {
  it("scribe_stop is live-capable and implemented; scribe_restart and message are not implemented; dispatch reaches liveScribeStop", async () => {
    expect(LIVE_CAPABLE_ACTIONS).toContain("scribe_stop");
    expect([...LIVE_IMPLEMENTED_ACTIONS]).toEqual(["scribe_start", "scribe_stop"]);
    expect(LIVE_CAPABLE_ACTIONS).not.toContain("scribe_restart");
    const { d, calls } = deps();
    const ex = new LiveExecutor({ stopDeps: d, now: () => NOW });
    expect((await dispatch(ex, dec()))?.result).toMatch(/^ok:/);
    expect(calls.insert).toHaveLength(1);
    await expect(Promise.resolve().then(() => ex.scribeRestart(dec()))).rejects.toThrow("live executor not enabled");
  });
});
