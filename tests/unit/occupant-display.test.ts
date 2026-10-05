/**
 * lib/encounter-windows/occupant.ts — the "who is in the room" display prefers the warehouse consulting doctor over the extension's cookie identity.
 *
 * Pure rules (buildOccupantDisplay) plus the two readers (consultingDoctorForMachine, machineOccupancy) behind a fake Neon tag. The SQL itself runs
 * against a real postgres in tests/unit/fleet-attention-sql.test.ts. Doctors come from the fake-identity helper (no identity literals in tests).
 */
import { describe, it, expect } from "vitest";
import { buildOccupantDisplay, consultingDoctorForMachine, machineOccupancy, WAREHOUSE_WINDOW_MIN } from "@/lib/encounter-windows/occupant";
import type { PresenceEvent } from "@/lib/encounter-windows/types";
import type { WindowsDb } from "@/lib/encounter-windows";
import { makeFakeClinician } from "../support/fake-identity";

const A = makeFakeClinician(1); // the warehouse doctor
const B = makeFakeClinician(2); // the extension's cookie doctor
const UA = A.id;
const UB = B.id;

describe("buildOccupantDisplay", () => {
  it("warehouse doctor present, cookie agrees -> warehouse, not stale", () => {
    expect(buildOccupantDisplay({ uid: UA, name: A.full_name }, { uid: UA, name: A.full_name })).toEqual({
      uid: UA, name: A.full_name, source: "warehouse", cookie_uid: UA, cookie_name: A.full_name, stale: false,
    });
  });

  it("warehouse doctor present, cookie names someone else -> warehouse wins, stale true, cookie kept for the dim second line", () => {
    expect(buildOccupantDisplay({ uid: UA, name: A.full_name }, { uid: UB, name: B.full_name })).toEqual({
      uid: UA, name: A.full_name, source: "warehouse", cookie_uid: UB, cookie_name: B.full_name, stale: true,
    });
  });

  it("warehouse doctor present, no cookie identity -> warehouse, not stale (nothing to disagree with)", () => {
    expect(buildOccupantDisplay({ uid: UA, name: A.full_name }, null)).toMatchObject({ source: "warehouse", cookie_uid: null, cookie_name: null, stale: false });
  });

  it("no warehouse doctor -> the cookie identity with source 'cookie', never stale", () => {
    expect(buildOccupantDisplay(null, { uid: UB, name: B.full_name })).toEqual({
      uid: UB, name: B.full_name, source: "cookie", cookie_uid: UB, cookie_name: B.full_name, stale: false,
    });
    // a warehouse row with no uid is no warehouse doctor
    expect(buildOccupantDisplay({ uid: null, name: A.full_name }, { uid: UB, name: B.full_name })).toMatchObject({ source: "cookie", uid: UB });
  });

  it("neither -> null", () => {
    expect(buildOccupantDisplay(null, null)).toBeNull();
    expect(buildOccupantDisplay({ uid: null, name: null }, { uid: null, name: null })).toBeNull();
  });
});

// ---------------------------------------------------------------- fake Neon tag
type Q = { text: string; vals: unknown[] };
function fakeDb(responder: (q: Q) => unknown) {
  const issued: Q[] = [];
  const tag = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q: Q = { text: strings.join("?"), vals };
    issued.push(q);
    return Object.assign(q, { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(responder(q)).then(res, rej) });
  }) as unknown as WindowsDb;
  return { db: tag, issued };
}

const NOW = Date.parse("2026-10-05T07:00:00Z"); // 12:30 IST
const MACH = "EHRC-CONSUL7s-Mac-mini";
const agoIso = (min: number) => new Date(NOW - min * 60_000).toISOString();
const winRow = (over: Record<string, unknown> = {}) => ({
  machine: MACH, consult_key: "E1@m", t_open: agoIso(30), t_close: agoIso(20),
  consulting_doctor_uid: UA, consulting_doctor_name: A.full_name, attribution_source: "warehouse", ...over,
});

describe("consultingDoctorForMachine", () => {
  it("returns the warehouse doctor of the machine's newest consult, and binds the machine and the instant (no string-built SQL)", async () => {
    const { db, issued } = fakeDb(() => [winRow()]);
    const r = await consultingDoctorForMachine(db, MACH, NOW);
    expect(r).toMatchObject({ uid: UA, name: A.full_name, t_open: agoIso(30), t_close: agoIso(20), consult_key: "E1@m" });
    expect(issued).toHaveLength(1);
    expect(issued[0]!.vals).toContain(MACH);
    expect(issued[0]!.vals).toContain(new Date(NOW).toISOString());
    expect(issued[0]!.vals).toContain(WAREHOUSE_WINDOW_MIN);
    expect(issued[0]!.text).toMatch(/FROM eta_encounter_windows/);
    expect(issued[0]!.text).toMatch(/ORDER BY w\.machine, w\.t_open DESC/);
  });

  it("is null when the newest consult is not warehouse-attributed, or names no doctor", async () => {
    expect(await consultingDoctorForMachine(fakeDb(() => [winRow({ attribution_source: "extension" })]).db, MACH, NOW)).toBeNull();
    expect(await consultingDoctorForMachine(fakeDb(() => [winRow({ attribution_source: "none", consulting_doctor_uid: null })]).db, MACH, NOW)).toBeNull();
    expect(await consultingDoctorForMachine(fakeDb(() => [winRow({ consulting_doctor_uid: null })]).db, MACH, NOW)).toBeNull();
  });

  it("is null when no consult is near asOf, and an unclosed window reads t_close null", async () => {
    expect(await consultingDoctorForMachine(fakeDb(() => []).db, MACH, NOW)).toBeNull();
    const open = await consultingDoctorForMachine(fakeDb(() => [winRow({ t_close: null })]).db, MACH, NOW);
    expect(open?.t_close).toBeNull();
  });

  it("normalises the machine spelling and rejects a bad asOf", async () => {
    const { db, issued } = fakeDb(() => []);
    await consultingDoctorForMachine(db, "EHRC-CONSUL7’s Mac mini", NOW);
    expect(issued[0]!.vals).toContain("EHRC-CONSUL7s-Mac-mini");
    await expect(consultingDoctorForMachine(db, MACH, "not-a-time")).rejects.toThrow(/bad asOf/);
  });
});

// ---------------------------------------------------------------- machineOccupancy
let nextId = 1;
const ext = (machine: string, event: string, minAgo: number, uid: string | null, dn: string | null, focus = true): PresenceEvent => ({
  id: nextId++, source: "ext", machine, event, ts: agoIso(minAgo), uid, dn, focus,
});
/** A doctor logged in 20 min ago with a focused heartbeat 1 min ago: one present stream. */
const loggedIn = (machine: string, uid: string, dn: string): PresenceEvent[] => [ext(machine, "login", 20, uid, dn), ext(machine, "heartbeat", 1, uid, dn, true)];

function occDb(events: PresenceEvent[], windows: Array<Record<string, unknown>>) {
  return fakeDb((q) =>
    /room_install/.test(q.text) ? [{ hostname: MACH, room_id: "room_7", slug: "opd-7" }]
    : /FROM eta_encounter_windows/.test(q.text) ? windows
    : /pulse_presence_events/.test(q.text) ? events
    : [],
  ).db;
}

describe("machineOccupancy", () => {
  it("warehouse doctor within 90 min -> display is the warehouse doctor; a different cookie login is marked stale", async () => {
    const [m] = await machineOccupancy(occDb(loggedIn(MACH, UB, B.full_name), [winRow()]), NOW);
    expect(m).toMatchObject({ machine: MACH, room_id: "room_7", occupied: true, cookie_uid: UB, cookie_name: B.full_name });
    expect(m!.occupant_display).toEqual({ uid: UA, name: A.full_name, source: "warehouse", cookie_uid: UB, cookie_name: B.full_name, stale: true });
    expect(m!.consulting).toMatchObject({ uid: UA });
  });

  it("the cookie doctor is the warehouse doctor -> display warehouse, stale false", async () => {
    const [m] = await machineOccupancy(occDb(loggedIn(MACH, UA, A.full_name), [winRow()]), NOW);
    expect(m!.occupant_display).toMatchObject({ source: "warehouse", uid: UA, stale: false });
  });

  it("no warehouse consult -> the cookie display, source 'cookie', not stale", async () => {
    const [m] = await machineOccupancy(occDb(loggedIn(MACH, UB, B.full_name), []), NOW);
    expect(m!.consulting).toBeNull();
    expect(m!.occupant_display).toEqual({ uid: UB, name: B.full_name, source: "cookie", cookie_uid: UB, cookie_name: B.full_name, stale: false });
  });

  it("a machine with a warehouse consult but no live extension session still shows the warehouse doctor", async () => {
    const [m] = await machineOccupancy(occDb([], [winRow()]), NOW);
    expect(m).toMatchObject({ machine: MACH, occupied: false, cookie_uid: null, cookie_name: null });
    expect(m!.occupant_display).toMatchObject({ source: "warehouse", uid: UA, cookie_uid: null, stale: false });
  });

  it("a logged-out cookie stream is not a cookie identity: nothing to display without a warehouse doctor", async () => {
    const evs = [...loggedIn(MACH, UB, B.full_name), ext(MACH, "logout", 0.5, UB, B.full_name, false)];
    const [m] = await machineOccupancy(occDb(evs, []), NOW);
    expect(m!.occupied).toBe(false);
    expect(m!.occupant_display).toBeNull();
  });
});
