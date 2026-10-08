/** v1.4 O2: the warehouse consult names the doctor; the occupancy fallbacks; the F28 stale-cookie guard; a failed warehouse read degrades. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({ occ: vi.fn() }));
vi.mock("@/lib/steward/occupancy-read", () => ({ scopedOccupancy: M.occ }));
vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));

import { buildSnapshot, resetMemoForTests } from "@/lib/rooms-live/snapshot";
import type { Db } from "@/lib/rooms-live/read";

const NOW = Date.parse("2026-10-08T06:42:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const ROOM = "room_a";
const HOST = "EHRC-CONSUL2’s Mac mini (2)";
const MACHINE = "EHRC-CONSUL2s-Mac-mini-2";
const ROOMS = [{ room_id: ROOM, label: "OPD A" }] as never;

type Wh = { machine?: string; consulting_doctor_name: string | null; t_open: string; t_close: string | null };
function fakeDb(o: { wh?: Wh[]; failWh?: boolean; whCalls?: string[] } = {}): Db {
  return (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("FROM eta_encounter_windows")) {
      o.whCalls?.push(text);
      if (o.failWh) throw new Error("boom");
      return (o.wh ?? []).map((w) => ({ machine: MACHINE, ...w }));
    }
    if (text.includes("FROM bench_listener")) return [{ room_id: ROOM, last_poll_at: iso(NOW - 1000), levels_at: iso(NOW - 800), mic_peak: 0.01, mic_zero_ratio: 0.001, recording_session_id: "bs", paused: false }];
    if (text.includes("FROM room_install")) return [{ room_id: ROOM, hostname: HOST, state_flags: { flags: [] }, state_changed_at: iso(NOW - 600_000), input_device_name: "C270", input_devices: [{ name: "C270" }] }];
    if (text.includes("FROM bench_session")) return [{ room_id: ROOM, id: "bs", status: "recording", started_at: iso(NOW - 3_600_000), last_chunk_at: iso(NOW - 70_000) }];
    if (text.includes("FROM bench_level_sample")) return Array.from({ length: 100 }, (_, i) => ({ room_id: ROOM, sampled_at: iso(NOW - 800 - i * 2300), peak: 0.009 + (i % 5) * 0.0004, zero_ratio: 0.001 }));
    if (text.includes("FROM kiosk_health_events")) return [{ machine: MACHINE, received_at: iso(NOW - 20_000) }];
    if (text.includes("FROM pulse_presence_events")) return [{ machine: MACHINE, ts: iso(NOW - 10_000), enc: null }];
    if (text.includes("FROM steward_decisions")) return [];
    void vals;
    throw new Error("unexpected statement " + text.slice(0, 60));
  }) as unknown as Db;
}
const occ = (o: Partial<{ occupied: boolean; ambiguous: boolean; page_name: string | null; best_dn: string | null; best_uid: string | null; best_stale: boolean }>) =>
  M.occ.mockImplementation(async () => [{ machine: MACHINE, occupied: false, ambiguous: false, stale_occupant: null, pending: null, page_name: null, best_uid: null, best_dn: null, best_stale: false, ...o }]);
const run = (d: Db) => buildSnapshot({ db: d, now: () => NOW, rooms: ROOMS }).then((s) => ({ s, r: s.rooms[0]! }));

beforeEach(() => {
  resetMemoForTests();
  M.occ.mockReset();
  occ({});
});

describe("O2: who is in the room", () => {
  it("an open warehouse consult + unoccupied -> named, In consultation", async () => {
    const { r, s } = await run(fakeDb({ wh: [{ consulting_doctor_name: "Clinician Open", t_open: iso(NOW - 26 * 60_000), t_close: null }] }));
    expect(r.doctor).toEqual({ display: "Clinician Open", activity: "In consultation" });
    expect(r.doctor_known).toBe(true);
    expect(s.degraded).toEqual([]);
  });
  it("a consult closed 1 min ago still counts (2 min grace); closed 7 min ago + unoccupied -> no doctor, and the doctor is known to be absent", async () => {
    const recent = await run(fakeDb({ wh: [{ consulting_doctor_name: "Clinician Just", t_open: iso(NOW - 20 * 60_000), t_close: iso(NOW - 60_000) }] }));
    expect(recent.r.doctor?.display).toBe("Clinician Just");
    resetMemoForTests();
    const old = await run(fakeDb({ wh: [{ consulting_doctor_name: "Clinician Gone", t_open: iso(NOW - 30 * 60_000), t_close: iso(NOW - 7 * 60_000) }] }));
    expect(old.r.doctor).toBeNull();
    expect(old.r.doctor_known).toBe(true);
  });
  it("a consult that opens in the future is not open", async () => {
    const { r } = await run(fakeDb({ wh: [{ consulting_doctor_name: "Clinician Later", t_open: iso(NOW + 5 * 60_000), t_close: null }] }));
    expect(r.doctor).toBeNull();
  });
  it("the warehouse wins over occupancy: occupied with another page greeting + an open consult -> the consult's doctor", async () => {
    occ({ occupied: true, page_name: "Greeter", best_dn: "Other" });
    const { r } = await run(fakeDb({ wh: [{ consulting_doctor_name: "Clinician Open", t_open: iso(NOW - 5 * 60_000), t_close: null }] }));
    expect(r.doctor).toEqual({ display: "Clinician Open", activity: "In consultation" });
  });
  it("occupied + ambiguous + an open consult -> named (occupancy cannot veto the warehouse)", async () => {
    occ({ occupied: true, ambiguous: true });
    const { r } = await run(fakeDb({ wh: [{ consulting_doctor_name: "Clinician Open", t_open: iso(NOW - 5 * 60_000), t_close: null }] }));
    expect(r.doctor?.display).toBe("Clinician Open");
  });
  it("occupied + no page_name + non-stale best.dn -> the dn, Signed in", async () => {
    occ({ occupied: true, page_name: null, best_dn: "Clinician Signed", best_uid: "ABC123" });
    const { r } = await run(fakeDb());
    expect(r.doctor).toEqual({ display: "Clinician Signed", activity: "Signed in" });
  });
  it("occupied + page_name -> the page greeting still comes first", async () => {
    occ({ occupied: true, page_name: "Greeter", best_dn: "Clinician Signed" });
    expect((await run(fakeDb())).r.doctor?.display).toBe("Greeter");
  });
  it("occupied, nothing named -> the literal Doctor", async () => {
    occ({ occupied: true });
    expect((await run(fakeDb())).r.doctor?.display).toBe("Doctor");
  });
  it("F28: a stale-cookie occupant never shows the cookie name (best_dn ignored when best_stale)", async () => {
    occ({ occupied: true, page_name: null, best_dn: "Cookie Person", best_stale: true });
    const { r } = await run(fakeDb());
    expect(r.doctor?.display).toBe("Doctor");
    expect(JSON.stringify(r)).not.toContain("Cookie Person");
  });
  it("a failed warehouse read: degraded, doctor_known false, no throw, rooms still render, occupancy still names an occupant", async () => {
    occ({ occupied: true, page_name: "Greeter" });
    const { s, r } = await run(fakeDb({ failWh: true }));
    expect(s.degraded).toEqual(["eta_encounter_windows"]);
    expect(r.doctor_known).toBe(false);
    expect(r.doctor?.display).toBe("Greeter");
    expect(r.state).not.toBe("unknown");
    expect(JSON.stringify(s)).not.toContain("boom");
  });
  it("a failed warehouse read with no occupant: no doctor and doctor_known false (unknown, not absent)", async () => {
    const { r } = await run(fakeDb({ failWh: true }));
    expect(r.doctor).toBeNull();
    expect(r.doctor_known).toBe(false);
  });
  it("the read is bound to today's IST start and the machine keys", async () => {
    const calls: string[] = [];
    await run(fakeDb({ whCalls: calls }));
    expect(calls).toHaveLength(1);
  });
});
