/** OREF adversarial (Opus refute, ported in R3 and adapted: v3 removed, acoustic hourly) — SPINE-P1: GET /api/cron/encounter-shadow, the producer orchestration and the `producers` gate. Runners are mocked at the module boundary. Synthetic ids only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ cfg: vi.fn(), days: vi.fn(), acoustic: vi.fn(), timeline: vi.fn(), leave: vi.fn(), blindDay: vi.fn(), tlFlag: vi.fn(), gate: vi.fn(), staticBlind: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: (..._a: unknown[]) => M.cfg() }));
vi.mock("@/lib/room-access/room-days-for-date", () => ({ listRoomDaysForDate: M.days }));
vi.mock("@/lib/encounter-clock/shadow-io", () => ({ runShadowForRoomDay: M.acoustic }));
vi.mock("@/lib/encounter-clock/shadow-v3", () => ({ runTimelineShadowForRoomDay: M.timeline }));   // R3: never called
vi.mock("@/lib/encounter-clock/shadow-leave", () => ({ runTimelineLeaveForRoomDay: M.leave }));
vi.mock("@/lib/room-access/check", () => ({ roomDayIsBlind: M.blindDay }));
vi.mock("@/lib/rubrics/blind-room-days", () => ({ isBlindRoomDay: (d: string, r: string) => M.staticBlind(d, r) }));
vi.mock("@/lib/encounter-clock/flag", async () => {
  const f = await vi.importActual<typeof import("@/lib/flags")>("@/lib/flags");
  return { encounterTimelineShadowEnabled: () => f.parseFlag("ENCOUNTER_TIMELINE_SHADOW"), encounterGateDiarEnabled: () => f.parseFlag("ENCOUNTER_GATE_DIAR") };
});

import { GET } from "@/app/api/cron/encounter-shadow/route";
import { runProducers, type RoomDayRef } from "@/lib/spine/producers";

// 06:30Z = 12:00 IST: acoustic due, tick index even (a 2-day list is not rotated)
const DUE_AT = "2026-10-22T06:30:00Z";
const DUE_MS = Date.parse(DUE_AT);
const SAVED = { c: process.env.CRON_SECRET, t: process.env.ENCOUNTER_TIMELINE_SHADOW, g: process.env.ENCOUNTER_GATE_DIAR, m: process.env.SPINE_PRODUCERS_MAX };
const day = (n: number): RoomDayRef => ({ id: `rd_test${n}`, room_id: `room_test${n}`, ist_date: "2026-10-22" });
const req = () => new Request("https://x.test/api/cron/encounter-shadow", { headers: { authorization: "Bearer cron_test" } });
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
beforeEach(() => {
  process.env.CRON_SECRET = "cron_test"; delete process.env.ENCOUNTER_TIMELINE_SHADOW; delete process.env.ENCOUNTER_GATE_DIAR; delete process.env.SPINE_PRODUCERS_MAX;
  M.cfg.mockReset().mockResolvedValue([{ key: "producers", value: "shadow" }]);
  M.days.mockReset().mockResolvedValue([day(1), day(2)]);
  for (const f of [M.acoustic, M.timeline, M.leave]) f.mockReset().mockResolvedValue({ ok: true });
  M.blindDay.mockReset().mockResolvedValue(false);
  M.staticBlind.mockReset().mockReturnValue(false);
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(DUE_AT));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { restore("CRON_SECRET", SAVED.c); restore("ENCOUNTER_TIMELINE_SHADOW", SAVED.t); restore("ENCOUNTER_GATE_DIAR", SAVED.g); restore("SPINE_PRODUCERS_MAX", SAVED.m); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("oref gate", () => {
  it.each([["off", [{ key: "producers", value: "off" }]], ["missing", []], ["kill", [{ key: "kill_switch", value: true }, { key: "producers", value: "live" }]], ["null", [{ key: "producers", value: null }]], ["array", [{ key: "producers", value: ["shadow"] }]], ["SHADOW caps", [{ key: "producers", value: "SHADOW" }]]])("%s: exactly ONE config read, no day list, no runner", async (_n, rows) => {
    M.cfg.mockResolvedValue(rows);
    expect(await (await GET(req())).json()).toEqual({ skipped: "off" });
    expect(M.cfg).toHaveBeenCalledTimes(1);
    expect(M.days).not.toHaveBeenCalled();
    for (const f of [M.acoustic, M.timeline, M.leave, M.blindDay]) expect(f).not.toHaveBeenCalled();
  });
  it("live runs like shadow, one config read, mode echoed", async () => {
    M.cfg.mockResolvedValue([{ key: "producers", value: "live" }]);
    const b = await (await GET(req())).json();
    expect(b).toMatchObject({ mode: "live", acoustic_ok: 2 });
    expect(M.cfg).toHaveBeenCalledTimes(1);
  });
  it("a config read failure is a 500 and runs nothing", async () => {
    M.cfg.mockRejectedValue(new Error("x"));
    expect((await GET(req())).status).toBe(500);
    expect(M.acoustic).not.toHaveBeenCalled();
  });
});

describe("oref parity with voice.ts", () => {
  it("static blind list (isBlindRoomDay(ist_date, room_id)) refuses before any runner, with the right argument order", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "1";
    M.staticBlind.mockImplementation((d: string, r: string) => d === "2026-10-22" && r === "room_test1");
    const b = await (await GET(req())).json();
    expect(b.blind_skipped).toBe(1);
    expect(M.timeline).not.toHaveBeenCalled();
    for (const f of [M.acoustic, M.leave]) { expect(f).toHaveBeenCalledTimes(1); expect(f.mock.calls[0]![0].room_day_id).toBe("rd_test2"); }
  });
  it("roomDayIsBlind is asked with the room_day id", async () => {
    await GET(req());
    expect(M.blindDay.mock.calls.map((c) => c[0])).toEqual(["rd_test1", "rd_test2"]);
  });
  it("gate_diar defaults to false for leave", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "yes";
    await GET(req());
    expect(M.leave.mock.calls.every((c) => c[0].gate_diar === false)).toBe(true);
  });
  it("an acoustic throw on day 1 never stops leave on day 1 nor day 2", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "1";
    M.acoustic.mockRejectedValueOnce(new Error("boom"));
    const b = await (await GET(req())).json();
    expect(b).toMatchObject({ acoustic_ok: 1, acoustic_err: 1, leave_ok: 2, room_days: 2 });
  });
  it("DIVERGENCE (documented): an invalid ENCOUNTER_GATE_DIAR with timeline OFF is not evaluated (voice.ts would fail the call)", async () => {
    process.env.ENCOUNTER_GATE_DIAR = "maybe";
    const b = await (await GET(req())).json();
    expect(b).toMatchObject({ acoustic_ok: 2, timeline_flag_invalid: 0 });
  });
});

describe("oref IST date and bounds", () => {
  it("the date is IST: 18:29Z is still the 22nd, 18:30Z is the 23rd", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T18:29:59Z")); await GET(req());   // not due: the date logic is independent of acoustic
    vi.setSystemTime(new Date("2026-10-22T18:30:00Z")); await GET(req());
    expect(M.days.mock.calls.map((c) => c[0])).toEqual(["2026-10-22", "2026-10-23"]);
  });
  it("exactly 45 000 ms elapsed stops; 44 999 does not", async () => {
    const mk = (step: number) => { let t = DUE_MS; return { now: () => t, isBlind: async () => false, acoustic: async () => { t += step; return { ok: true }; }, leave: async () => ({ ok: true }), timelineEnabled: () => false, gateDiar: () => false }; };
    expect((await runProducers([day(1), day(2), day(3)], 12, mk(45_000))).room_days).toBe(1);
    expect((await runProducers([day(1), day(2), day(3)], 12, mk(44_999))).room_days).toBe(2);
  });
  it("max is a hard cap even when every day throws", async () => {
    const deps = { now: () => DUE_MS, isBlind: async () => false, acoustic: vi.fn(async () => { throw new Error("x"); }), leave: vi.fn(), timelineEnabled: () => false, gateDiar: () => false };
    const c = await runProducers([day(1), day(2), day(3), day(4)], 2, deps as never);
    expect(c).toMatchObject({ room_days: 2, acoustic_err: 2 });
    expect(c.classes).toEqual(["acoustic:threw"]);
  });
  it("timeline flag invalid is counted once per run, not per day", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "enabled";
    M.days.mockResolvedValue([day(1), day(2), day(3)]);
    const b = await (await GET(req())).json();
    expect(b).toMatchObject({ timeline_flag_invalid: 1, acoustic_ok: 3 });
    expect(vi.mocked(console.error).mock.calls.length).toBe(1);
  });
});
