/**
 * lib/steward/input-failover.ts + the loop hook: webcam first, TONOR backup, automatic (9 Oct 2026). The pure rules are tested directly; the loop tests use the same
 * in-memory stand-in for the database as steward-startday.test.ts and an injected port that records every set_audio_input.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ago, healthy, ist } from "../support/steward-fixtures";
import type { RoomSense } from "@/lib/steward/sense";

const M = vi.hoisted(() => ({ senseAll: vi.fn() }));
vi.mock("@/lib/steward/sense", () => ({ senseAll: M.senseAll }));

import { runSteward, type LoopLock } from "@/lib/steward/loop";
import { DEFAULT_CONFIG, parseConfig } from "@/lib/steward/config";
import {
  ENUM_RULE,
  ALERT_RULE_INPUT,
  HOLD_RULE,
  SWITCH_RULE,
  classify,
  enumChange,
  evaluateInputFailover,
  failoverEligible,
  shouldArmFailover,
  zeroRunSince,
  type FailoverInput,
  type InputDevice,
  type InputPort,
  type InputState,
} from "@/lib/steward/input-failover";
import type { RecentAction } from "@/lib/steward/rules";

const MIN = 60_000;
const S = 1000;
const A0 = ist("10:00");
const C270: InputDevice = { name: "C270 HD WEBCAM", uid: "uid-c270", is_default: false };
const TONOR: InputDevice = { name: "TONOR TM20", uid: "uid-tonor", is_default: true };
const BUILTIN: InputDevice = { name: "MacBook Pro Microphone", uid: "uid-builtin", is_default: false };

const state = (current: string | null, devices: InputDevice[], app = "0.1.26"): InputState => ({ app_version: app, current_name: current, devices });
const row = (A: number, agoS: number, rule: string, params: Record<string, unknown>, outcome: RecentAction["outcome"] = "ok"): RecentAction => ({ ts: new Date(A - agoS * S).toISOString(), rule, action: "log_only", params, outcome, failing_class: null });
const sw = (A: number, agoS: number, reason: string, outcome: RecentAction["outcome"] = "ok"): RecentAction => row(A, agoS, SWITCH_RULE, { reason, to_uid: "x" }, outcome);

const input = (A: number, over: Partial<FailoverInput> = {}): FailoverInput => ({
  roomId: "room_o3",
  roomName: "OPD 3",
  A,
  session: { open: true, status: "recording", started_at: new Date(A - 60 * MIN).toISOString() },
  input: state("TONOR TM20", [C270, TONOR]),
  zeroSince: null,
  recent: [],
  ...over,
});

describe("zero run and device names", () => {
  const samples = (A: number, spec: Array<[number, number]>) => spec.map(([agoS, z]) => ({ t: A - agoS * S, z }));
  it("a quiet room is not zero: zero_ratio 0.001 gives no run", () => {
    expect(zeroRunSince(samples(A0, [[40, 0.001], [25, 0.002], [10, 0.001], [1, 0.001]]), A0)).toBeNull();
  });
  it("exact zeros: the trailing run starts at the first zero sample; a non-zero sample inside ends the earlier run", () => {
    const since = zeroRunSince(samples(A0, [[120, 0.9], [100, 1], [80, 1], [60, 0.99], [40, 1], [10, 1]]), A0);
    expect(since).toBe(A0 - 100 * S);
    expect(zeroRunSince(samples(A0, [[100, 1], [80, 0.3], [40, 1], [10, 1]]), A0)).toBe(A0 - 40 * S);
  });
  it("the newest sample must be <= 30 s old", () => {
    expect(zeroRunSince(samples(A0, [[100, 1], [60, 1], [35, 1]]), A0)).toBeNull();
    expect(zeroRunSince(samples(A0, [[100, 1], [60, 1], [29, 1]]), A0)).toBe(A0 - 100 * S);
  });
  it("only webcam and TONOR are ever classified", () => {
    expect(classify("C270 HD WEBCAM")).toBe("webcam");
    expect(classify("Logitech Webcam")).toBe("webcam");
    expect(classify("TONOR TM20")).toBe("tonor");
    expect(classify("MacBook Pro Microphone")).toBeNull();
    expect(classify("Bluetooth Headset")).toBeNull();
    expect(classify(null)).toBeNull();
  });
  it("rooms: OPD 1,3,4,5,6,7, Cardiology, Dietary; never ORB2, ORB3, Home Office, Audiometry, OPD 2 or dev/test", () => {
    const cfg = { ...DEFAULT_CONFIG };
    for (const n of ["OPD 1", "OPD 3", "OPD 4", "OPD 5", "OPD 6", "OPD 7", "Cardiology", "Dietary"]) expect(failoverEligible({ room_name: n, flags: [] }, cfg, "r")).toBe(true);
    for (const n of ["ORB2", "ORB3", "Home Office", "Audiometry testbed", "OPD 2", "Third Floor", "OPD A"]) expect(failoverEligible({ room_name: n, flags: [] }, cfg, "r")).toBe(false);
    expect(failoverEligible({ room_name: "OPD 3", flags: ["dev"] }, cfg, "r")).toBe(false);
    expect(failoverEligible({ room_name: "OPD 3", flags: [] }, { ...cfg, rooms: { r: { class: "clinic", flags: ["test"] } } as never }, "r")).toBe(false);
  });
  it("shouldArmFailover needs input_failover_live on AND the kill switch off; the key parses {on}; malformed is false + invalid", () => {
    expect(shouldArmFailover({ ...DEFAULT_CONFIG, input_failover_live: true, kill_switch: false })).toBe(true);
    expect(shouldArmFailover({ ...DEFAULT_CONFIG, input_failover_live: true, kill_switch: true })).toBe(false);
    expect(DEFAULT_CONFIG.input_failover_live).toBe(false);
    const rows = Object.entries(BASE_CFG()).map(([key, value]) => ({ key, value }));
    expect(parseConfig(rows).config.input_failover_live).toBe(false);
    expect(parseConfig([...rows, { key: "input_failover_live", value: { on: true } }]).config.input_failover_live).toBe(true);
    const bad = parseConfig([...rows, { key: "input_failover_live", value: "yes" }]);
    expect(bad.config.input_failover_live).toBe(false);
    expect(bad.invalid).toContain("input_failover_live");
  });
});

describe("rule 4: failover", () => {
  it("TONOR digital zero 95 s with the C270 enumerated: ONE switch to the C270", () => {
    const v = evaluateInputFailover(input(A0, { zeroSince: A0 - 95 * S }));
    expect(v).toMatchObject({ kind: "switch", reason: "failover_zero", to: { uid: "uid-c270" }, from: "TONOR TM20" });
  });
  it("zero for only 60 s: nothing yet", () => {
    expect(evaluateInputFailover(input(A0, { zeroSince: A0 - 60 * S })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { zeroSince: A0 - 89 * S })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { zeroSince: A0 - 90 * S })).kind).toBe("switch");
  });
  it("C270 digital zero 95 s with the TONOR enumerated: switch to the TONOR", () => {
    const v = evaluateInputFailover(input(A0, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince: A0 - 95 * S }));
    expect(v).toMatchObject({ kind: "switch", to: { uid: "uid-tonor" } });
  });
  it("C270 digital zero, no TONOR: no switch, ONE alert naming the device; the next tick is held (no second alert)", () => {
    const inp = input(A0, { input: state("C270 HD WEBCAM", [C270]), zeroSince: A0 - 95 * S });
    const v = evaluateInputFailover(inp);
    expect(v).toMatchObject({ kind: "alert", reason: "no_alternate", devices: ["C270 HD WEBCAM"] });
    const again = evaluateInputFailover({ ...inp, A: A0 + MIN, zeroSince: A0 - 95 * S, recent: [row(A0, 0, ALERT_RULE_INPUT, { reason: "no_alternate" }, null)] });
    expect(again).toMatchObject({ kind: "hold", reason: "held_after_alert" });
  });
  it("never selects a device that is neither webcam nor TONOR: only a built-in alongside -> no switch, alert", () => {
    const v = evaluateInputFailover(input(A0, { input: state("TONOR TM20", [TONOR, BUILTIN]), zeroSince: A0 - 95 * S }));
    expect(v).toMatchObject({ kind: "alert", reason: "no_alternate" });
  });
  it("the current device is no longer enumerated: switch to the other preferred device at once (no 90 s wait)", () => {
    const v = evaluateInputFailover(input(A0, { input: state("TONOR TM20", [C270]), zeroSince: null }));
    expect(v).toMatchObject({ kind: "switch", reason: "failover_vanished", to: { uid: "uid-c270" } });
  });
  it("a quiet room (zero_ratio 0.001, peak 0.01) triggers nothing", () => {
    const since = zeroRunSince([{ t: A0 - 40 * S, z: 0.001 }, { t: A0 - 5 * S, z: 0.001 }], A0);
    expect(evaluateInputFailover(input(A0, { zeroSince: since })).kind).toBe("none");
  });
  it("no session, a paused session, or no device list: nothing", () => {
    expect(evaluateInputFailover(input(A0, { session: { open: false, status: null, started_at: null }, zeroSince: A0 - 200 * S })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { session: { open: true, status: "paused", started_at: new Date(A0 - 3600_000).toISOString() }, zeroSince: A0 - 200 * S })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { input: null, zeroSince: A0 - 200 * S })).kind).toBe("none");
  });
  it("an app below 0.1.21 is held, never sent", () => {
    expect(evaluateInputFailover(input(A0, { zeroSince: A0 - 200 * S, appTooOld: true }))).toMatchObject({ kind: "hold", reason: "app_too_old" });
  });
});

describe("rule 3: session start", () => {
  it("first 15 min of the session, webcam enumerated, recorder on the TONOR: one switch to the webcam; not again in the same session", () => {
    const base = input(A0, { session: { open: true, status: "recording", started_at: new Date(A0 - 5 * MIN).toISOString() } });
    expect(evaluateInputFailover(base)).toMatchObject({ kind: "switch", reason: "session_start_webcam", to: { uid: "uid-c270" } });
    expect(evaluateInputFailover({ ...base, recent: [sw(A0, 60, "session_start_webcam")] }).kind).toBe("none");
  });
  it("already on the webcam, or no webcam enumerated, or later than 15 min into the session: nothing", () => {
    const early = { open: true, status: "recording" as const, started_at: new Date(A0 - 5 * MIN).toISOString() };
    expect(evaluateInputFailover(input(A0, { session: early, input: state("C270 HD WEBCAM", [C270, TONOR]) })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { session: early, input: state("TONOR TM20", [TONOR]) })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { input: state("TONOR TM20", [C270, TONOR]) })).kind).toBe("none");
  });
});

describe("rule 5: verify", () => {
  it("after a switch the tape is still zero 60 s later (+30 s ack grace): ONE alert, then no more switching until the devices change", () => {
    const recent = [sw(A0, 100, "failover_zero")];
    const zeroSince = A0 - 120 * S;
    const v = evaluateInputFailover(input(A0, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince, recent }));
    expect(v).toMatchObject({ kind: "alert", reason: "still_zero_after_switch" });
    if (v.kind === "alert") expect(v.devices).toEqual(["C270 HD WEBCAM", "C270 HD WEBCAM", "TONOR TM20"]);
    const withAlert = [...recent, row(A0, 0, ALERT_RULE_INPUT, { reason: "still_zero_after_switch" }, null)];
    for (const dt of [1, 5, 30]) {
      const later = evaluateInputFailover(input(A0 + dt * MIN, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince, recent: withAlert }));
      expect(later).toMatchObject({ kind: "hold", reason: "held_after_alert" });
    }
    // a device change event after the alert releases the hold (spacing still applies)
    const changed = [...withAlert, row(A0 + 2 * MIN, 0, ENUM_RULE, { uids: "a|b", webcam: true, tonor: true })];
    const rel = evaluateInputFailover(input(A0 + 20 * MIN, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince, recent: changed }));
    expect(rel).toMatchObject({ kind: "switch" });
  });
  it("D2: only a switch whose result starts with ok is verified: a failed insert (outcome failed), a shadow row and a row with no result never raise still_zero_after_switch", () => {
    const zeroSince = A0 - 120 * S;
    for (const outcome of ["failed", "shadow", null] as const) {
      const v = evaluateInputFailover(input(A0, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince, recent: [sw(A0, 100, "failover_zero", outcome)] }));
      expect(v.kind === "alert" && v.reason === "still_zero_after_switch", String(outcome)).toBe(false);
    }
    expect(evaluateInputFailover(input(A0, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince, recent: [sw(A0, 100, "failover_zero", "ok")] }))).toMatchObject({ kind: "alert", reason: "still_zero_after_switch" });
  });
  it("a switch that worked (tape no longer zero) raises nothing; a shadow switch is never verified", () => {
    expect(evaluateInputFailover(input(A0, { input: state("C270 HD WEBCAM", [C270, TONOR]), zeroSince: null, recent: [sw(A0, 100, "failover_zero")] })).kind).toBe("none");
    expect(evaluateInputFailover(input(A0, { input: state("TONOR TM20", [C270, TONOR]), zeroSince: A0 - 120 * S, recent: [sw(A0, 100, "failover_zero", "shadow")] })).kind).not.toBe("alert");
  });
  it("a new session releases the hold", () => {
    const alertAt = row(A0, 3000, ALERT_RULE_INPUT, { reason: "still_zero_after_switch" }, null);
    const newSession = { open: true, status: "recording" as const, started_at: new Date(A0 - 10 * MIN).toISOString() };
    const v = evaluateInputFailover(input(A0, { session: newSession, input: state("TONOR TM20", [C270, TONOR]), recent: [alertAt] }));
    expect(v).toMatchObject({ kind: "switch", reason: "session_start_webcam" });
  });
});

describe("rule 6: back to the webcam", () => {
  const onTonor = (A: number, recent: RecentAction[]): FailoverInput => input(A, { input: state("TONOR TM20", [C270, TONOR]), recent });
  it("C270 removed then present after the failover: switch back; no event: stays on the TONOR; removed and still absent: stays", () => {
    const f = sw(A0, 3000, "failover_zero");
    expect(evaluateInputFailover(onTonor(A0, [f])).kind).toBe("none");
    const removed = row(A0, 2000, ENUM_RULE, { uids: "uid-tonor", webcam: false, tonor: true });
    const back = row(A0, 1000, ENUM_RULE, { uids: "uid-c270|uid-tonor", webcam: true, tonor: true });
    expect(evaluateInputFailover(onTonor(A0, [f, removed])).kind).toBe("none");
    expect(evaluateInputFailover(onTonor(A0, [f, removed, back]))).toMatchObject({ kind: "switch", reason: "webcam_reenumerated", to: { uid: "uid-c270" } });
    // an enumeration row from BEFORE the failover does not count
    const before = row(A0, 4000, ENUM_RULE, { uids: "u", webcam: false, tonor: true });
    expect(evaluateInputFailover(onTonor(A0, [before, f, back])).kind).toBe("none");
  });
  it("a TONOR the recorder is on for any other reason is not moved mid-day", () => {
    const removed = row(A0, 2000, ENUM_RULE, { uids: "u", webcam: false, tonor: true });
    const back = row(A0, 1000, ENUM_RULE, { uids: "u2", webcam: true, tonor: true });
    expect(evaluateInputFailover(onTonor(A0, [removed, back])).kind).toBe("none");
  });
});

describe("rule 7: anti-flap", () => {
  const zero = (A: number, over: Partial<FailoverInput> = {}) => input(A, { zeroSince: A - 120 * S, ...over });
  it("the 5th switch of the IST day is refused (daily_cap)", () => {
    const four = [0, 1, 2, 3].map((i) => ({ ...sw(A0, 0, "failover_zero"), ts: new Date(ist("07:30") + i * 30 * MIN).toISOString() }));
    const v = evaluateInputFailover(zero(A0, { recent: four }));
    expect(v).toMatchObject({ kind: "hold", reason: "daily_cap" });
    const three = four.slice(0, 3);
    expect(evaluateInputFailover(zero(A0, { recent: three })).kind).toBe("switch");
  });
  it("the daily count resets at IST midnight", () => {
    const yesterday = [1, 2, 3, 4].map((i) => row(ist("23:00", "2026-10-05"), i * 60, SWITCH_RULE, { reason: "failover_zero" }));
    expect(evaluateInputFailover(zero(A0, { recent: yesterday })).kind).toBe("switch");
  });
  it("a switch 6 min after the last is refused (spacing); 10 min is allowed; a vanished device is exempt", () => {
    expect(evaluateInputFailover(zero(A0, { recent: [sw(A0, 6 * 60, "failover_zero")], zeroSince: A0 - 200 * S }))).toMatchObject({ kind: "hold", reason: "spacing" });
    expect(evaluateInputFailover(zero(A0, { recent: [sw(A0, 10 * 60, "failover_zero")], zeroSince: A0 - 200 * S })).kind).toBe("switch");
    const gone = evaluateInputFailover(input(A0, { input: state("TONOR TM20", [C270]), recent: [sw(A0, 6 * 60, "failover_zero")], zeroSince: null }));
    expect(gone).toMatchObject({ kind: "switch", reason: "failover_vanished" });
  });
  it("a new zero run is timed from its own start, not from before the last switch", () => {
    const cur = state("C270 HD WEBCAM", [C270, TONOR]);
    const v = evaluateInputFailover(input(A0, { input: cur, recent: [sw(A0, 11 * 60, "failover_zero")], zeroSince: A0 - 5 * MIN }));
    expect(v).toMatchObject({ kind: "switch", zero_s: 300 });
    // zero that began BEFORE the switch and never stopped is the verify alert, not a second switch
    const cont = evaluateInputFailover(input(A0, { input: cur, recent: [sw(A0, 11 * 60, "failover_zero")], zeroSince: A0 - 20 * MIN }));
    expect(cont).toMatchObject({ kind: "alert", reason: "still_zero_after_switch" });
  });
});

describe("fix-up 10 Oct: only live outcomes count toward the cap and the spacing; the session-start webcam switch is exempt from the spacing", () => {
  const zero = (A: number, over: Partial<FailoverInput> = {}) => input(A, { zeroSince: A - 120 * S, ...over });
  it("ruling 3: shadow and kill_switch rows do not count toward the 4/day cap or the 10-min spacing", () => {
    const shadow = [0, 1, 2, 3].map((i) => ({ ...sw(A0, 0, "failover_zero", "shadow"), ts: new Date(ist("07:30") + i * 30 * MIN).toISOString() }));
    expect(evaluateInputFailover(zero(A0, { recent: shadow })).kind).toBe("switch");
    expect(evaluateInputFailover(zero(A0, { recent: [sw(A0, 2 * 60, "failover_zero", "shadow")], zeroSince: A0 - 200 * S })).kind).toBe("switch");
    expect(evaluateInputFailover(zero(A0, { recent: [sw(A0, 2 * 60, "failover_zero", "shadow")], zeroSince: A0 - 200 * S }))).toMatchObject({ zero_s: 200 });
    // live rows still count: ok and failed
    const live = [0, 1, 2].map((i) => ({ ...sw(A0, 0, "failover_zero", "ok"), ts: new Date(ist("07:30") + i * 30 * MIN).toISOString() }));
    const four = [...live, { ...sw(A0, 0, "failover_zero", "failed"), ts: new Date(ist("09:00")).toISOString() }];
    expect(evaluateInputFailover(zero(A0, { recent: four }))).toMatchObject({ kind: "hold", reason: "daily_cap" });
    expect(evaluateInputFailover(zero(A0, { recent: [sw(A0, 6 * 60, "failover_zero", "failed")], zeroSince: A0 - 200 * S }))).toMatchObject({ kind: "hold", reason: "spacing" });
    // a mixed day: three shadow + three live rows = 3 live, still allowed
    const mixed = [...shadow.slice(0, 3), ...live];
    expect(evaluateInputFailover(zero(A0, { recent: mixed })).kind).toBe("switch");
  });
  it("ruling 3: a shadow session-start row still means the session had its session-start check (no repeat every tick)", () => {
    const start = (a: number) => new Date(a - 5 * MIN).toISOString();
    const cur = state("TONOR TM20", [C270, TONOR]);
    const first = evaluateInputFailover(input(A0, { session: { open: true, status: "recording", started_at: start(A0) }, input: cur }));
    expect(first).toMatchObject({ kind: "switch", reason: "session_start_webcam" });
    const again = evaluateInputFailover(input(A0, { session: { open: true, status: "recording", started_at: start(A0) }, input: cur, recent: [sw(A0, 60, "session_start_webcam", "shadow")] }));
    expect(again.kind).toBe("none");
  });
  it("ruling 4: the session-start webcam switch is not blocked by the spacing, but the cap still stops it", () => {
    const cur = state("TONOR TM20", [C270, TONOR]);
    const sess = { open: true, status: "recording" as const, started_at: new Date(A0 - 5 * MIN).toISOString() };
    // a live switch 3 min ago (before this session) would hold a failover for spacing; the session-start switch goes through
    const prior = sw(A0, 8 * 60, "failover_zero");
    expect(evaluateInputFailover(input(A0, { session: sess, input: cur, recent: [prior] }))).toMatchObject({ kind: "switch", reason: "session_start_webcam" });
    // the cap still applies: four live switches today
    const four = [0, 1, 2, 3].map((i) => ({ ...sw(A0, 0, "failover_zero"), ts: new Date(ist("07:30") + i * 30 * MIN).toISOString() }));
    expect(evaluateInputFailover(input(A0, { session: sess, input: cur, recent: four }))).toMatchObject({ kind: "hold", reason: "daily_cap" });
  });
  it("ruling 4: a session-start switch does not start the spacing clock for a later failover, but counts toward the cap", () => {
    const sess = { open: true, status: "recording" as const, started_at: new Date(A0 - 20 * MIN).toISOString() };
    const cur = state("C270 HD WEBCAM", [C270, TONOR]);
    const ss = sw(A0, 6 * 60, "session_start_webcam");
    // the webcam is dead 6 min after the session-start switch: the failover to the TONOR is not held for spacing
    const v = evaluateInputFailover(input(A0, { session: sess, input: cur, recent: [ss], zeroSince: A0 - 5 * MIN }));
    expect(v).toMatchObject({ kind: "switch", reason: "failover_zero", to: { name: "TONOR TM20" } });
    // three live failovers + the session-start switch = 4: the cap holds
    const three = [0, 1, 2].map((i) => ({ ...sw(A0, 0, "failover_zero"), ts: new Date(ist("07:30") + i * 30 * MIN).toISOString() }));
    expect(evaluateInputFailover(input(A0, { session: sess, input: cur, recent: [...three, ss], zeroSince: A0 - 5 * MIN }))).toMatchObject({ kind: "hold", reason: "daily_cap" });
  });
});

describe("enumeration memory", () => {
  it("a row is written only when the uid set changes", () => {
    const st = state("TONOR TM20", [C270, TONOR]);
    expect(enumChange(st, [])).toEqual({ uids: "uid-c270|uid-tonor", webcam: true, tonor: true, n: 2 });
    expect(enumChange(st, [row(A0, 60, ENUM_RULE, { uids: "uid-c270|uid-tonor" })])).toBeNull();
    expect(enumChange(state("TONOR TM20", [TONOR]), [row(A0, 60, ENUM_RULE, { uids: "uid-c270|uid-tonor" })])).toEqual({ uids: "uid-tonor", webcam: false, tonor: true, n: 1 });
    expect(enumChange(null, [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

type Stored = { id: number; room_id: string | null; ts: string; rule: string; action: string; params: Record<string, unknown>; result: string | null; mode: string; inputs: Record<string, unknown>; why: string; why_not: string | null; actor: string; machine: string | null; window_kind: string; inputs_hash: string };

function BASE_CFG(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kill_switch: { on: false },
    shadow: { global: true, actions: {} },
    schedule: { clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 }, ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 } },
    days: { mode: "every_day", closed: [] },
    caps: { actions_per_room_per_hour: 4, policy_cycle_per_profile_per_day: 1, start_retries: 3 },
    priority: { order: ["ot", "opd", "clinic"] },
    rooms: {},
    ...over,
  };
}

function fakeDb(o: { cfg?: Record<string, unknown>; name?: string; devices?: InputDevice[] | null; current?: string | null; app?: string; levels?: Array<{ ago: number; z: number }> } = {}) {
  const state2 = {
    cfg: o.cfg ?? BASE_CFG({ input_failover_live: { on: true } }),
    name: o.name ?? "OPD 3",
    devices: o.devices === undefined ? [C270, TONOR] : o.devices,
    current: o.current === undefined ? "TONOR TM20" : o.current,
    app: o.app ?? "0.1.26",
    levels: o.levels ?? [],
    table: [] as Stored[],
    nextId: 1,
    A: 0,
    reads: { install: 0, levels: 0 },
  };
  const sql = (async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("SELECT key, value FROM steward_config")) return Object.entries(state2.cfg).map(([key, value]) => ({ key, value }));
    if (text.includes("FROM room r")) return [{ room_id: "room_o3", room_name: state2.name, hostname: "HOST-O3", state_flags: null }];
    if (text.includes("DISTINCT ON (d.room_id)")) {
      const best = new Map<string, Stored>();
      for (const r of state2.table) if (r.room_id && r.inputs.primary === true) {
        const p = best.get(r.room_id);
        if (!p || r.ts > p.ts || (r.ts === p.ts && r.id > p.id)) best.set(r.room_id, r);
      }
      return [...best.values()];
    }
    if (text.includes("d.action <> 'none'")) return state2.table.filter((r) => r.room_id && r.action !== "none").sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : b.id - a.id)).map((r) => ({ ...r, failing_class: null }));
    if (text.includes("d.rule = 'fleet_incident'")) return [];
    if (text.includes("FROM room_install") && text.includes("input_devices")) {
      state2.reads.install++;
      return state2.devices === null ? [] : [{ room_id: "room_o3", input_device_name: state2.current, input_devices: state2.devices, app_version: state2.app }];
    }
    if (text.includes("FROM bench_level_sample")) {
      state2.reads.levels++;
      return state2.levels.map((l) => ({ room_id: "room_o3", sampled_at: new Date(state2.A - l.ago * S).toISOString(), zero_ratio: l.z }));
    }
    if (text.includes("INSERT INTO steward_decisions")) {
      const rows = JSON.parse(String(v[0])) as Array<Omit<Stored, "id" | "actor">>;
      return rows.map((r) => {
        const s: Stored = { ...r, id: state2.nextId++, actor: "steward" };
        state2.table.push(s);
        return { id: s.id };
      });
    }
    throw new Error(`fake db: unexpected statement ${text.slice(0, 80)}`);
  }) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
  return { sql, state: state2 };
}

const okLock = (): LoopLock => ({ acquire: async () => true, release: async () => {} });
const sessionSense = (A: number, startedAgoMin = 60): RoomSense =>
  healthy(A, { room_id: "room_o3", room_name: "OPD 3", recording: { session_open: true, session_id: "bs_1", session_status: "recording", session_started_at: new Date(A - startedAgoMin * MIN).toISOString(), last_chunk_at: ago(A, 5), recorder_status: null } }) as RoomSense;

function fakePort(o: { listening?: boolean; insert?: () => Promise<string> } = {}) {
  const calls = { insert: [] as Array<{ roomId: string; kind: string; args?: unknown; source?: string }> };
  const port: InputPort = {
    listening: async () => o.listening ?? true,
    tooOld: (v) => !v || v < "0.1.21",
    insertCommand: async (i) => {
      calls.insert.push(i);
      return o.insert ? o.insert() : "cmd_77";
    },
  };
  return { port, calls };
}
const tick = (db: ReturnType<typeof fakeDb>, port: InputPort, A: number, sense: (A: number) => RoomSense = (a) => sessionSense(a)) => {
  db.state.A = A;
  M.senseAll.mockImplementation(async (_s: unknown, a: number, roster: Array<{ room_id: string }>) => new Map(roster.map((r) => [r.room_id, sense(a)])));
  return runSteward(db.sql as never, { asOf: A, budgetMs: 20_000, lock: okLock(), inputPort: port });
};
const rules = (db: ReturnType<typeof fakeDb>, rule: string) => db.state.table.filter((r) => r.rule === rule);

beforeEach(() => {
  M.senseAll.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("the loop", () => {
  const ZERO95 = [{ ago: 95, z: 1 }, { ago: 60, z: 1 }, { ago: 30, z: 1 }, { ago: 5, z: 1 }];

  it("live: TONOR zero 95 s with the C270 enumerated -> ONE set_audio_input {device_uid} source steward; a decision row names both devices; the next minute does not send again", async () => {
    const db = fakeDb({ levels: ZERO95 });
    const { port, calls } = fakePort();
    await tick(db, port, A0);
    expect(calls.insert).toEqual([{ roomId: "room_o3", kind: "set_audio_input", args: { device_uid: "uid-c270" }, source: "steward" }]);
    const r = rules(db, SWITCH_RULE);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ mode: "live", action: "log_only", result: "ok: set_audio_input queued cmd_77", params: { reason: "failover_zero", to_name: "C270 HD WEBCAM", from_name: "TONOR TM20" } });
    expect(r[0]!.why).toContain("OPD 3");
    expect(rules(db, ENUM_RULE)).toHaveLength(1);
    await tick(db, port, A0 + MIN);
    await tick(db, port, A0 + 2 * MIN);
    expect(calls.insert).toHaveLength(1);
    expect(rules(db, SWITCH_RULE)).toHaveLength(1);
  });

  it("input_failover_live absent: a SHADOW row (would set_audio_input), zero commands; kill switch on: result kill_switch", async () => {
    for (const [cfg, result] of [[BASE_CFG(), "shadow: would set_audio_input"], [BASE_CFG({ input_failover_live: { on: true }, kill_switch: { on: true } }), "kill_switch"]] as const) {
      const db = fakeDb({ cfg, levels: ZERO95 });
      const { port, calls } = fakePort();
      await tick(db, port, A0);
      expect(calls.insert).toHaveLength(0);
      expect(rules(db, SWITCH_RULE)[0]).toMatchObject({ mode: "shadow", result });
    }
  });

  it("fix-up 2 (C): in shadow, the same would-switch (reason + target) is written at most once per 10 min; a different target is not swallowed", async () => {
    const db = fakeDb({ cfg: BASE_CFG(), levels: ZERO95 });
    const { port, calls } = fakePort();
    for (let m = 0; m < 10; m++) await tick(db, port, A0 + m * MIN);
    expect(calls.insert).toHaveLength(0);
    expect(rules(db, SWITCH_RULE)).toHaveLength(1);
    // the target changed (the webcam is gone, only the built-in-free TONOR list differs): a row for another uid is a new row
    const other = fakeDb({ cfg: BASE_CFG(), levels: ZERO95, devices: [TONOR, { name: "Other Webcam", uid: "uid-other", is_default: false }] });
    await tick(other, port, A0);
    expect(rules(other, SWITCH_RULE)).toHaveLength(1);
  });

  it("zero for 60 s only: no command; quiet room: no command", async () => {
    for (const levels of [[{ ago: 60, z: 1 }, { ago: 5, z: 1 }], [{ ago: 60, z: 0.001 }, { ago: 5, z: 0.001 }]]) {
      const db = fakeDb({ levels });
      const { port, calls } = fakePort();
      await tick(db, port, A0);
      expect(calls.insert).toHaveLength(0);
      expect(rules(db, SWITCH_RULE)).toHaveLength(0);
    }
  });

  it("rooms that are not on the list read nothing and send nothing (OPD 2, Third Floor, ORB3, Home Office)", async () => {
    for (const name of ["OPD 2", "Third Floor", "ORB3", "Home Office"]) {
      const db = fakeDb({ name, levels: ZERO95 });
      const { port, calls } = fakePort();
      await tick(db, port, A0);
      expect(calls.insert).toHaveLength(0);
      expect(db.state.reads).toEqual({ install: 0, levels: 0 });
      expect(rules(db, ENUM_RULE)).toHaveLength(0);
    }
  });

  it("the kiosk is not listening: nothing enqueued, a hold row not_listening; an old app is held, never sent", async () => {
    const a = fakeDb({ levels: ZERO95 });
    const pa = fakePort({ listening: false });
    await tick(a, pa.port, A0);
    expect(pa.calls.insert).toHaveLength(0);
    expect(rules(a, HOLD_RULE)[0]).toMatchObject({ params: { reason: "not_listening" } });
    const b = fakeDb({ levels: ZERO95, app: "0.1.20" });
    const pb = fakePort();
    await tick(b, pb.port, A0);
    expect(pb.calls.insert).toHaveLength(0);
    expect(rules(b, HOLD_RULE)[0]).toMatchObject({ params: { reason: "app_too_old" } });
  });

  it("an enqueue that throws is recorded as failed and counts as a switch (no retry storm)", async () => {
    const db = fakeDb({ levels: ZERO95 });
    const { port, calls } = fakePort({ insert: async () => { throw new Error("bus down"); } });
    await tick(db, port, A0);
    await tick(db, port, A0 + MIN);
    expect(calls.insert).toHaveLength(1);
    expect(rules(db, SWITCH_RULE)[0]!.result).toMatch(/^failed: bus down/);
  });

  it("the C270 zero, no TONOR: no command, ONE alert across minutes", async () => {
    const db = fakeDb({ devices: [C270], current: "C270 HD WEBCAM", levels: ZERO95 });
    const { port, calls } = fakePort();
    await tick(db, port, A0);
    await tick(db, port, A0 + MIN);
    await tick(db, port, A0 + 2 * MIN);
    expect(calls.insert).toHaveLength(0);
    expect(rules(db, ALERT_RULE_INPUT)).toHaveLength(1);
    expect(rules(db, ALERT_RULE_INPUT)[0]).toMatchObject({ params: { reason: "no_alternate" }, why_not: null });
    expect(rules(db, ALERT_RULE_INPUT)[0]!.why).toContain("C270 HD WEBCAM");
  });

  it("session start: the recorder on the TONOR, the C270 enumerated, session 3 min old -> one command to the C270, never repeated", async () => {
    const db = fakeDb({});
    const { port, calls } = fakePort();
    await tick(db, port, A0, (a) => sessionSense(a, 3));
    await tick(db, port, A0 + MIN, (a) => sessionSense(a, 4));
    expect(calls.insert).toHaveLength(1);
    expect(calls.insert[0]!.args).toEqual({ device_uid: "uid-c270" });
  });

  it("a recorder or Chrome is never stopped, paused or restarted: only set_audio_input is ever enqueued", async () => {
    const db = fakeDb({ levels: ZERO95 });
    const { port, calls } = fakePort();
    await tick(db, port, A0);
    expect(new Set(calls.insert.map((c) => c.kind))).toEqual(new Set(["set_audio_input"]));
    expect(db.state.table.some((r) => ["scribe_stop", "scribe_restart", "restart"].includes(r.action))).toBe(false);
  });
});
