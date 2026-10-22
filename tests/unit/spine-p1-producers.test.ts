/** SPINE-P1: GET /api/cron/encounter-shadow, the producer orchestration and the `producers` gate. Runners are mocked at the module boundary. Synthetic ids only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ cfg: vi.fn(), days: vi.fn(), acoustic: vi.fn(), timeline: vi.fn(), leave: vi.fn(), blindDay: vi.fn(), tlFlag: vi.fn(), gate: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: (..._a: unknown[]) => M.cfg() }));
vi.mock("@/lib/room-access/room-days-for-date", () => ({ listRoomDaysForDate: M.days }));
vi.mock("@/lib/encounter-clock/shadow-io", () => ({ runShadowForRoomDay: M.acoustic }));
vi.mock("@/lib/encounter-clock/shadow-v3", () => ({ runTimelineShadowForRoomDay: M.timeline }));
vi.mock("@/lib/encounter-clock/shadow-leave", () => ({ runTimelineLeaveForRoomDay: M.leave }));
vi.mock("@/lib/room-access/check", () => ({ roomDayIsBlind: M.blindDay }));
vi.mock("@/lib/encounter-clock/flag", async () => {
  const f = await vi.importActual<typeof import("@/lib/flags")>("@/lib/flags");
  return { encounterTimelineShadowEnabled: () => f.parseFlag("ENCOUNTER_TIMELINE_SHADOW"), encounterGateDiarEnabled: () => f.parseFlag("ENCOUNTER_GATE_DIAR") };
});

import { GET } from "@/app/api/cron/encounter-shadow/route";
import { parseProducersMode } from "@/lib/spine/config";
import { runProducers, parseMax, DEFAULT_MAX, STOP_AFTER_MS, type RoomDayRef } from "@/lib/spine/producers";

const SAVED = { c: process.env.CRON_SECRET, t: process.env.ENCOUNTER_TIMELINE_SHADOW, g: process.env.ENCOUNTER_GATE_DIAR, m: process.env.SPINE_PRODUCERS_MAX };
const day = (n: number): RoomDayRef => ({ id: `rd_test${n}`, room_id: `room_test${n}`, ist_date: "2026-10-22" });
const req = (auth: string | null = "Bearer cron_test") => new Request("https://x.test/api/cron/encounter-shadow", { headers: auth ? { authorization: auth } : {} });
const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };

beforeEach(() => {
  process.env.CRON_SECRET = "cron_test"; delete process.env.ENCOUNTER_TIMELINE_SHADOW; delete process.env.ENCOUNTER_GATE_DIAR; delete process.env.SPINE_PRODUCERS_MAX;
  M.cfg.mockReset().mockResolvedValue([{ key: "producers", value: "shadow" }]);
  M.days.mockReset().mockResolvedValue([day(1), day(2)]);
  M.acoustic.mockReset().mockResolvedValue({ ok: true });
  M.timeline.mockReset().mockResolvedValue({ ok: true });
  M.leave.mockReset().mockResolvedValue({ ok: true });
  M.blindDay.mockReset().mockResolvedValue(false);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { restore("CRON_SECRET", SAVED.c); restore("ENCOUNTER_TIMELINE_SHADOW", SAVED.t); restore("ENCOUNTER_GATE_DIAR", SAVED.g); restore("SPINE_PRODUCERS_MAX", SAVED.m); vi.restoreAllMocks(); });

describe("auth", () => {
  it("503 when CRON_SECRET is unset, 401 on a missing or wrong bearer; nothing is read or run", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req())).status).toBe(503);
    process.env.CRON_SECRET = "cron_test";
    expect((await GET(req(null))).status).toBe(401);
    expect((await GET(req("Bearer wrong"))).status).toBe(401);
    expect(M.cfg).not.toHaveBeenCalled();
    expect(M.acoustic).not.toHaveBeenCalled();
  });
});

describe("producers gate", () => {
  it.each([
    ["missing", []],
    ["off", [{ key: "producers", value: "off" }]],
    ["malformed", [{ key: "producers", value: "banana" }]],
    ["number", [{ key: "producers", value: 1 }]],
    ["kill_switch on", [{ key: "kill_switch", value: true }, { key: "producers", value: "shadow" }]],
    ["kill_switch malformed", [{ key: "kill_switch", value: "no" }, { key: "producers", value: "shadow" }]],
  ])("%s -> skipped off, no room-day listed, no runner called", async (_n, rows) => {
    M.cfg.mockResolvedValue(rows);
    const r = await GET(req());
    expect(await r.json()).toEqual({ skipped: "off" });
    expect(M.days).not.toHaveBeenCalled();
    expect(M.acoustic).not.toHaveBeenCalled();
    expect(M.timeline).not.toHaveBeenCalled();
  });
  it("parseProducersMode reads shadow, live, {mode}, text-encoded jsonb, and an explicit kill_switch=false", () => {
    expect(parseProducersMode([{ key: "producers", value: "shadow" }])).toBe("shadow");
    expect(parseProducersMode([{ key: "producers", value: "live" }])).toBe("live");
    expect(parseProducersMode([{ key: "producers", value: { mode: "shadow" } }])).toBe("shadow");
    expect(parseProducersMode([{ key: "producers", value: "\"shadow\"" }])).toBe("shadow");
    expect(parseProducersMode([{ key: "kill_switch", value: false }, { key: "producers", value: "shadow" }])).toBe("shadow");
    expect(parseProducersMode([{ key: "kill_switch", value: { on: true } }, { key: "producers", value: "shadow" }])).toBe("off");
  });
});

describe("producers run", () => {
  it("acoustic for each room-day with the voice.ts arguments; timeline off by default; counts only", async () => {
    const body = await (await GET(req())).json();
    expect(M.acoustic.mock.calls.map((c) => c[0])).toEqual([{ room_id: "room_test1", room_day_id: "rd_test1", ist_date: "2026-10-22" }, { room_id: "room_test2", room_day_id: "rd_test2", ist_date: "2026-10-22" }]);
    expect(M.timeline).not.toHaveBeenCalled();
    expect(body).toEqual({ mode: "shadow", room_days: 2, acoustic_ok: 2, acoustic_err: 0, timeline_ok: 0, timeline_err: 0, leave_ok: 0, leave_err: 0, blind_skipped: 0, timeline_enabled: false, timeline_flag_invalid: 0 });
  });
  it("a blind room-day is never run (static pair or placement)", async () => {
    M.blindDay.mockImplementation(async (id: string) => id === "rd_test1");
    process.env.ENCOUNTER_TIMELINE_SHADOW = "on";
    const body = await (await GET(req())).json();
    expect(body.blind_skipped).toBe(1);
    expect(M.acoustic).toHaveBeenCalledTimes(1);
    expect(M.acoustic.mock.calls[0]![0].room_day_id).toBe("rd_test2");
    expect(M.timeline).toHaveBeenCalledTimes(1);
  });
  it("a blind-check failure fails closed (counted blind, nothing run)", async () => {
    M.blindDay.mockRejectedValue(new Error("db down"));
    const body = await (await GET(req())).json();
    expect(body.blind_skipped).toBe(2);
    expect(M.acoustic).not.toHaveBeenCalled();
  });
  it.each(["1", "true", "YES", " on "])("timeline runs when the flag is %j, with gate_diar from its flag", async (v) => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = v; process.env.ENCOUNTER_GATE_DIAR = "1";
    const body = await (await GET(req())).json();
    expect(M.timeline.mock.calls.map((c) => c[0])).toEqual([
      { room_id: "room_test1", room_day_id: "rd_test1", ist_date: "2026-10-22", gate_diar: true },
      { room_id: "room_test2", room_day_id: "rd_test2", ist_date: "2026-10-22", gate_diar: true },
    ]);
    expect(body.timeline_enabled).toBe(true);
    expect(body.timeline_ok).toBe(2);
  });
  it("leave runs with the voice.ts arguments when the flag is truthy, after v3", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "1"; process.env.ENCOUNTER_GATE_DIAR = "1";
    const body = await (await GET(req())).json();
    expect(M.leave.mock.calls.map((c) => c[0])).toEqual([
      { room_id: "room_test1", room_day_id: "rd_test1", ist_date: "2026-10-22", gate_diar: true },
      { room_id: "room_test2", room_day_id: "rd_test2", ist_date: "2026-10-22", gate_diar: true },
    ]);
    expect(M.timeline.mock.invocationCallOrder[0]).toBeLessThan(M.leave.mock.invocationCallOrder[0]);
    expect(body).toMatchObject({ leave_ok: 2, leave_err: 0 });
  });
  it("a leave throw or failure is counted; acoustic and v3 still run for every day", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "1";
    M.leave.mockRejectedValueOnce(new Error("boom rd_test1")).mockResolvedValueOnce({ ok: false, error: "no_anchors" });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ acoustic_ok: 2, timeline_ok: 2, leave_ok: 0, leave_err: 2 });
    expect(M.leave).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n")).not.toMatch(/rd_test|boom/);
  });
  it("a blind day gets no leave call", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "1";
    M.blindDay.mockResolvedValueOnce(true);
    await GET(req());
    expect(M.leave).toHaveBeenCalledTimes(1);
    expect(M.leave.mock.calls[0][0].room_day_id).toBe("rd_test2");
  });
  it.each(["0", "off", ""])("timeline does not run when the flag is %j", async (v) => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = v;
    await GET(req());
    expect(M.timeline).not.toHaveBeenCalled();
    expect(M.leave).not.toHaveBeenCalled();
    expect(M.acoustic).toHaveBeenCalledTimes(2);
  });
  it("an unrecognised flag value: acoustic still runs, timeline skipped, counted", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "enabled";
    const r = await GET(req());
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(M.acoustic).toHaveBeenCalledTimes(2);
    expect(M.timeline).not.toHaveBeenCalled();
    expect(M.leave).not.toHaveBeenCalled();
    expect(body).toMatchObject({ acoustic_ok: 2, timeline_enabled: false, timeline_flag_invalid: 1 });
  });
  it("counts failures per runner, one log line per class, with no id in the log", async () => {
    process.env.ENCOUNTER_TIMELINE_SHADOW = "1";
    M.acoustic.mockResolvedValueOnce({ ok: false, error: "no_recorded_audio" }).mockRejectedValueOnce(new Error("boom rd_test2"));
    M.timeline.mockResolvedValue({ ok: false, error: "jev_disabled" });
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ acoustic_ok: 0, acoustic_err: 2, timeline_ok: 0, timeline_err: 2 });
    const logs = vi.mocked(console.error).mock.calls.map((c) => c.join(" "));
    expect(logs).toHaveLength(3);
    expect(logs.join("\n")).not.toMatch(/rd_test|room_test|boom/);
  });
  it("500 with a code only when the day list itself fails", async () => {
    M.days.mockRejectedValue(new Error("x"));
    const r = await GET(req());
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: { code: "ENCOUNTER_SHADOW_FAILED" } });
  });
  it("SPINE_PRODUCERS_MAX bounds the room-days per run", async () => {
    M.days.mockResolvedValue([day(1), day(2), day(3), day(4)]);
    process.env.SPINE_PRODUCERS_MAX = "3";
    const body = await (await GET(req())).json();
    expect(body.room_days).toBe(3);
    expect(M.acoustic).toHaveBeenCalledTimes(3);
  });
});

describe("runProducers bounds", () => {
  const base = (now: () => number) => ({ now, isBlind: async () => false, acoustic: vi.fn(async () => ({ ok: true })), timeline: vi.fn(async () => ({ ok: true })), leave: vi.fn(async () => ({ ok: true })), timelineEnabled: () => false, gateDiar: () => false });
  it("default max is 12; a bad SPINE_PRODUCERS_MAX falls back to it", () => {
    expect(DEFAULT_MAX).toBe(12);
    for (const v of [undefined, "", "0", "-1", "abc", "1.5", "999"]) expect(parseMax(v), String(v)).toBe(12);
    expect(parseMax(" 5 ")).toBe(5);
  });
  it("stops starting new room-days after 45 s on a fake clock, finishing the one in flight", async () => {
    let t = 1_000_000;
    const deps = base(() => t);
    deps.acoustic = vi.fn(async () => { t += 20_000; return { ok: true }; });
    const c = await runProducers([day(1), day(2), day(3), day(4), day(5)], 12, deps);
    expect(STOP_AFTER_MS).toBe(45_000);
    expect(c.room_days).toBe(3);   // starts at 0 s, 20 s, 40 s; at 60 s it stops
    expect(deps.acoustic).toHaveBeenCalledTimes(3);
  });
  it("a thrown gate_diar flag counts as an invalid timeline flag too", async () => {
    const deps = { ...base(() => 0), timelineEnabled: () => true, gateDiar: () => { throw new Error("bad"); } };
    const c = await runProducers([day(1)], 12, deps);
    expect(c.timeline_flag_invalid).toBe(1);
    expect(deps.timeline).not.toHaveBeenCalled();
    expect(c.acoustic_ok).toBe(1);
  });
});

describe("vercel.json", () => {
  it("schedules the cron every 15 minutes", async () => {
    const { readFileSync } = await import("node:fs");
    const v = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(v.crons).toContainEqual({ path: "/api/cron/encounter-shadow", schedule: "*/15 * * * *" });
  });
});
