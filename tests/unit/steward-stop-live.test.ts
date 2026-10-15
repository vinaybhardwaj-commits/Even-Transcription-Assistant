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
const dec = (over: { room_id?: string | null; late?: boolean; consult_open?: boolean | null; ext_status?: string | null } = {}): Decision =>
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
    inputs: { consult_open: over.consult_open === undefined ? false : over.consult_open, ext_status: over.ext_status === undefined ? "ok" : over.ext_status },
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

describe("FIX1 M1: the end-of-window stop applies only to a session open ACROSS the window end", () => {
  const D = (A: number, startedAgoS: number | null, over: Record<string, unknown> = {}) => decideRoom(healthy(A, { recording: { session_started_at: startedAgoS === null ? null : ago(A, startedAgoS) }, ...over } as never), DEFAULT_CONFIG, A, EMPTY_RECENT);
  const never = (ds: Decision[]) => { expect(ds.some((d) => d.action === "scribe_stop")).toBe(false); expect(ds.some((d) => d.params?.late === true)).toBe(false); };
  it("07:00 with a session from 06:55, 23:00 with a session from 22:50, and no session_started_at: log_only info, never scribe_stop, never late (consult open or not)", () => {
    for (const consult of [true, false]) {
      for (const [t, ago_] of [["07:00", 5 * 60], ["23:00", 10 * 60], ["22:00", null]] as const) {
        const A = ist(t);
        const ds = D(A, ago_, { consult_open: consult });
        never(ds);
        expect(ds[0], `${t} ${consult}`).toMatchObject({ rule: "end_of_window", action: "log_only", severity: "info" });
        expect(ds[0]!.why).toBe("session started outside the window; not stopped by the Steward");
      }
    }
  });
  it("a session from 09:00 with a consult open: 22:05 is the late stop (+ message); 21:35 is none (held)", () => {
    const late = D(ist("22:05"), 13 * 3600 + 5 * 60, { consult_open: true });
    expect(late.map((d) => d.action)).toEqual(["scribe_stop", "message"]);
    expect(late[0]!.params).toEqual({ late: true });
    expect(D(ist("21:35"), 12 * 3600 + 35 * 60, { consult_open: true })[0]).toMatchObject({ action: "none" });
  });
});

describe("FIX1 M2: a non-late stop needs consult_open false AND ext_status ok", () => {
  it("ext missing / no_tab / null with consult_open false: held at 21:35, the late stop at 22:00+; ext ok + consult false: a stop", () => {
    for (const status of ["missing", "no_tab", null]) {
      const mk2 = (A: number) => healthy(A, { consult_open: false, ext: { applicable: true, status, last_event_at: null, last_heartbeat_reason: null, no_tab: status === "no_tab" } } as never);
      const held = decideRoom(mk2(ist("21:35")), DEFAULT_CONFIG, ist("21:35"), EMPTY_RECENT)[0]!;
      expect(held, String(status)).toMatchObject({ action: "none" });
      expect(held.why_not).toContain("consult state unknown (extension");
      const late = decideRoom(mk2(ist("22:00")), DEFAULT_CONFIG, ist("22:00"), EMPTY_RECENT);
      expect(late[0], String(status)).toMatchObject({ action: "scribe_stop", params: { late: true } });
    }
    const ok = decideRoom(healthy(ist("21:35"), { consult_open: false }), DEFAULT_CONFIG, ist("21:35"), EMPTY_RECENT)[0]!;
    expect(ok).toMatchObject({ action: "scribe_stop", params: {} });
  });
  it("the executor refuses a non-late decision without ext_status ok, before any I/O; a late one still sends", async () => {
    for (const ext of ["missing", "no_tab", null]) {
      const { d, calls } = deps();
      expect((await go(d, dec({ ext_status: ext }))).result, String(ext)).toBe("skipped: consult_unknown_ext");
      expect(calls.insert).toHaveLength(0);
      expect(calls.listener + calls.active).toBe(0);
    }
    expect((await go(deps().d, dec({ late: true, consult_open: null, ext_status: null }))).result).toMatch(/^ok:/);
  });
});

describe("FIX1 L1/L2", () => {
  it("L1: an open session without started_at -> no send, no IST-midnight fallback", async () => {
    const { d, calls } = deps({ findActiveSession: async () => ({ id: "bs_1", status: "recording" } as never) });
    expect((await go(d)).result).toBe("skipped: no_session_start");
    expect(calls.insert).toHaveLength(0);
    expect(calls.attempts).toBe(0);
  });
  it("L2: the stale steward stops are expired before the FIRST send too (empty ledger)", async () => {
    const { d, calls } = deps();
    expect((await go(d)).result).toMatch(/^ok:/);
    expect(calls.expire).toBe(1);
    expect(calls.insert).toHaveLength(1);
  });
});
