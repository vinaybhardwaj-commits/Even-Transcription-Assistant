/**
 * Pulse Presence extension 0.1.1 — the resolver's use of its signals (identity_stale, stale_cookie rows, page_name, instance_id).
 *
 * WHY. Pulse never clears its Google session cookie, so the extension's cookie-authed identity can name the PREVIOUS doctor. 0.1.1 compares it with the
 * greeting on the page and, on a mismatch, emits `identity_stale` (doctor_uid null, cookie_uid = the stale identity) and sends every later row with
 * doctor_uid null + reason `stale_cookie` + page_name. The resolver must (1) close the stale doctor's stream like a logout, (2) never read a
 * stale_cookie row as that doctor's activity, (3) surface the greeting as page_name, (4) count install instances without double-counting anything.
 * Pure in-memory resolver tests: no database. The SQL twin of these rules is proven in tests/unit/occupancy-mjs-sql.test.ts.
 * People come from the fake-identity helper (tests/unit/no-identity-literals.test.ts).
 */
import { describe, it, expect } from "vitest";
import { byTimeThenId, isStaleReason, machineSignals, normalizeEvent, occupancyAt, resolveStreams, type NEvent } from "@/lib/encounter-windows/occupancy";
import { computeWindows, type PresenceEvent, type WindowsDb } from "@/lib/encounter-windows";
import { buildOccupantDisplay, machineOccupancy } from "@/lib/encounter-windows/occupant";
import { classifyExtEvent, resolveLockState } from "@/lib/fleet-attention";
import { makeFakeClinician } from "../support/fake-identity";

const A = makeFakeClinician(1); // the doctor the stale cookie names
const B = makeFakeClinician(2); // the doctor actually signed in
const UA = A.id;
const UB = B.id;
const PAGE = "Fakefirst"; // the greeting's first name: a witness, never a doctor_uid
const I1 = "a".repeat(32);
const I2 = "b".repeat(32);

const NOW = Date.parse("2026-10-05T07:00:00Z"); // 12:30 IST
const M = "EHRC-OPD6s-Mac-mini";
const agoIso = (min: number) => new Date(NOW - min * 60_000).toISOString();
let nextId = 1;
const ev = (event: string, minAgo: number, o: Partial<PresenceEvent> = {}): PresenceEvent => ({
  id: nextId++, source: "ext", machine: M, event, ts: agoIso(minAgo), uid: null, dn: null, focus: false, ...o,
});
const norm = (evs: PresenceEvent[]): NEvent[] =>
  evs.map(normalizeEvent).filter((x): x is NEvent => x !== null).sort(byTimeThenId);
const stream = (evs: PresenceEvent[], uid: string) => resolveStreams(norm(evs), NOW).find((s) => s.uid === uid);

/** Doctor A logged in 30 min ago, focused heartbeat 1 min ago: one present stream. */
const aLoggedIn = (): PresenceEvent[] => [
  ev("login", 30, { uid: UA, dn: A.full_name, focus: true }),
  ev("heartbeat", 1, { uid: UA, dn: A.full_name, focus: true }),
];
/** The 0.1.1 identity_stale event naming doctor A's cookie identity. */
const staleA = (minAgo: number, o: Partial<PresenceEvent> = {}): PresenceEvent =>
  ev("identity_stale", minAgo, { reason: "stale_cookie", cookie_uid: UA, page: PAGE, inst: I1, focus: true, ...o });

describe("identity_stale closes the cookie doctor's stream exactly like a logout", () => {
  it("control: without the stale event doctor A is present", () => {
    expect(stream(aLoggedIn(), UA)).toMatchObject({ present: true, out_reason: null });
  });

  it("an identity_stale for (machine, cookie_uid) -> that stream is out with out_reason stale_cookie; the machine is empty", () => {
    const evs = [...aLoggedIn(), staleA(0.5)];
    expect(stream(evs, UA)).toMatchObject({ present: false, out_reason: "stale_cookie", dn: A.full_name });
    expect(occupancyAt(norm(evs), NOW)).toMatchObject({ n_present: 0, best: null });
  });

  it("is a control event like a logout: genuine activity after it does NOT re-open the stream, a later login DOES", () => {
    const afterActive = [...aLoggedIn(), staleA(0.5), ev("active", 0.2, { uid: UA, focus: true }), ev("heartbeat", 0.1, { uid: UA, focus: true })];
    expect(stream(afterActive, UA)).toMatchObject({ present: false, out_reason: "stale_cookie" });
    const reopened = [...aLoggedIn(), staleA(0.5), ev("login", 0.2, { uid: UA, dn: A.full_name, focus: true })];
    expect(stream(reopened, UA)).toMatchObject({ present: true, out_reason: null });
  });

  it("an explicit logout after the stale event wins in time order, and vice versa", () => {
    const logoutLast = [...aLoggedIn(), staleA(0.5), ev("logout", 0.2, { uid: UA, focus: false })];
    expect(stream(logoutLast, UA)).toMatchObject({ out_reason: "logout" });
    const staleLast = [...aLoggedIn(), ev("logout", 0.5, { uid: UA }), staleA(0.2)];
    expect(stream(staleLast, UA)).toMatchObject({ out_reason: "stale_cookie" });
  });

  it("closes only the doctor it names: B's stream on the same machine stays present and becomes the occupant", () => {
    const evs = [
      ...aLoggedIn(),
      ev("login", 5, { uid: UB, dn: B.full_name, focus: true }),
      ev("heartbeat", 0.8, { uid: UB, dn: B.full_name, focus: true }),
      staleA(0.5),
    ];
    expect(stream(evs, UA)).toMatchObject({ present: false, out_reason: "stale_cookie" });
    expect(stream(evs, UB)).toMatchObject({ present: true, out_reason: null });
    expect(occupancyAt(norm(evs), NOW)).toMatchObject({ n_present: 1, best: { uid: UB } });
  });

  it("an identity_stale with no cookie_uid, or from a non-extension source, closes nothing", () => {
    expect(stream([...aLoggedIn(), staleA(0.5, { cookie_uid: null })], UA)).toMatchObject({ present: true });
    expect(stream([...aLoggedIn(), staleA(0.5, { source: "poller" })], UA)).toMatchObject({ present: true });
  });

  it("an event older than the stale one on the same stream is superseded; a stale from yesterday-evening does not leak past a fresh login", () => {
    const evs = [staleA(50), ...aLoggedIn()]; // stale first, then the 30-min-old login re-opens
    expect(stream(evs, UA)).toMatchObject({ present: true, out_reason: null });
  });
});

describe("rows whose reason contains stale_cookie never count as that doctor's genuine activity", () => {
  it("isStaleReason: stale_cookie alone or inside a set; no other reason", () => {
    expect(isStaleReason("stale_cookie")).toBe(true);
    expect(isStaleReason("absent_401,stale_cookie")).toBe(true);
    for (const r of [null, "", "identity_unreadable", "absent_401", "invalid_no_doctor", "name_absent_500", "name_unreadable", "name_invalid", "idle_timeout"]) {
      expect(isStaleReason(r), String(r)).toBe(false);
    }
  });

  it("normalizeEvent nulls the doctor on a stale_cookie row (uid, name) and keeps the new fields", () => {
    const n = normalizeEvent(ev("heartbeat", 1, { uid: UA, dn: A.full_name, reason: "stale_cookie", page: PAGE, inst: I1, focus: true }))!;
    expect(n).toMatchObject({ uid: null, dn: null, reason: "stale_cookie", page: PAGE, inst: I1, focus: true });
    const s = normalizeEvent(staleA(1))!;
    expect(s).toMatchObject({ event: "identity_stale", uid: null, cookie: UA, page: PAGE, inst: I1 });
    expect(normalizeEvent(ev("heartbeat", 1, { uid: UA, dn: A.full_name }))).toMatchObject({ uid: UA, dn: A.full_name, cookie: null, page: null, inst: null });
  });

  it("a doctor whose only recent focused heartbeats are stale_cookie rows is timed out (idle_timeout), not kept alive", () => {
    const evs: PresenceEvent[] = [ev("login", 60, { uid: UA, dn: A.full_name, focus: true })];
    for (let m = 55; m >= 1; m -= 5) evs.push(ev("heartbeat", m, { uid: UA, dn: A.full_name, focus: true, reason: "stale_cookie", page: PAGE }));
    expect(stream(evs, UA)).toMatchObject({ present: false, out_reason: "idle_timeout" });
  });

  it("the real shape (doctor_uid null) creates no stream at all, with or without a login before it", () => {
    const nullRows = [ev("heartbeat", 3, { reason: "stale_cookie", page: PAGE, focus: true }), ev("heartbeat", 1, { reason: "stale_cookie", page: PAGE, focus: true })];
    expect(resolveStreams(norm(nullRows), NOW)).toEqual([]);
  });

  it("other reasons are NOT special: a focused heartbeat with name_absent_500 still counts for its doctor", () => {
    const evs = [ev("login", 60, { uid: UA, dn: A.full_name, focus: true }), ev("heartbeat", 1, { uid: UA, dn: A.full_name, focus: true, reason: "name_absent_500" })];
    expect(stream(evs, UA)).toMatchObject({ present: true });
  });

  it("encounter attribution: a consult row carrying a stale_cookie uid is not 'rows' evidence; the same row without the reason is", () => {
    const mk = (reason: string | null): PresenceEvent[] => [
      ev("encounter_open", 20, { enc: "enc-1", uid: UA, dn: A.full_name, reason, focus: true }),
      ev("encounter_close", 10, { enc: "enc-1", uid: UA, dn: A.full_name, reason, focus: true }),
    ];
    expect(computeWindows(mk(null), { asOf: NOW })[0]).toMatchObject({ attribution: "rows", doctor_uid: UA });
    expect(computeWindows(mk("stale_cookie"), { asOf: NOW })[0]).toMatchObject({ attribution: "none", doctor_uid: null, display_name: null });
  });

  it("encounter rows under stale identity (doctor_uid null) still pair and close by encounter_id", () => {
    const rows = computeWindows(
      [ev("encounter_open", 20, { enc: "enc-2", reason: "stale_cookie", page: PAGE }), ev("encounter_close", 10, { enc: "enc-2", reason: "stale_cookie", page: PAGE })],
      { asOf: NOW },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ consult_uid: "enc-2", close_reason: "endConsult", doctor_uid: null });
  });
});

describe("page_name and instances", () => {
  it("page_name = the latest non-null page_name within 10 minutes; a later null never erases it", () => {
    const evs = [
      ev("heartbeat", 8, { page: "Fakeone" }),
      ev("heartbeat", 4, { page: null }),
      ev("heartbeat", 2, { page: "Faketwo" }),
      ev("heartbeat", 1, { page: null }),
    ];
    expect(machineSignals(norm(evs), NOW).page_name).toBe("Faketwo");
  });

  it("a page_name older than 10 minutes is not reported; one just inside is", () => {
    expect(machineSignals(norm([ev("heartbeat", 12, { page: PAGE })]), NOW).page_name).toBeNull();
    expect(machineSignals(norm([ev("heartbeat", 9.5, { page: PAGE })]), NOW).page_name).toBe(PAGE);
    expect(machineSignals(norm([ev("heartbeat", 12, { page: PAGE })]), NOW, { pageMin: 15 }).page_name).toBe(PAGE);
  });

  it("only the extension's rows speak for the page; events after asOf are not read", () => {
    expect(machineSignals(norm([ev("heartbeat", 2, { page: PAGE, source: "resolver" })]), NOW).page_name).toBeNull();
    expect(machineSignals(norm([ev("heartbeat", -2, { page: PAGE })]), NOW).page_name).toBeNull();
  });

  it("instances = distinct instance_ids in the window; rows without one add nothing; an old instance is not counted", () => {
    const evs = [ev("heartbeat", 1, { inst: I1 }), ev("heartbeat", 1.5, { inst: I1 }), ev("active", 2, { inst: I2 }), ev("heartbeat", 3, { inst: null }), ev("heartbeat", 30, { inst: "c".repeat(32) })];
    expect(machineSignals(norm(evs), NOW).instances).toBe(2);
    expect(machineSignals(norm([ev("heartbeat", 1, { inst: null })]), NOW).instances).toBe(0);
  });

  it("two installs reporting the SAME doctor keep every row and yield ONE stream and ONE occupant (nothing is double-counted)", () => {
    const evs = [
      ev("login", 10, { uid: UA, dn: A.full_name, focus: true, inst: I1 }),
      ev("login", 10, { uid: UA, dn: A.full_name, focus: false, inst: I2 }),
      ev("heartbeat", 1, { uid: UA, dn: A.full_name, focus: true, inst: I1 }),
      ev("heartbeat", 1, { uid: UA, dn: A.full_name, focus: false, inst: I2 }),
    ];
    const streams = resolveStreams(norm(evs), NOW);
    expect(streams).toHaveLength(1);
    expect(occupancyAt(norm(evs), NOW)).toMatchObject({ n_present: 1, best: { uid: UA }, instances: 2 });
  });

  it("occupancyAt carries page_name/instances; a window with no stale/absent events behaves as before (old 13-field rows: null, 0)", () => {
    expect(occupancyAt(norm(aLoggedIn()), NOW)).toMatchObject({ n_present: 1, best: { uid: UA }, page_name: null, instances: 0 });
  });
});

// ---------------------------------------------------------------- display
describe("machineOccupancy / buildOccupantDisplay carry page_name and instances", () => {
  type Q = { text: string };
  function occDb(events: PresenceEvent[], windows: Array<Record<string, unknown>> = []): WindowsDb {
    const tag = ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const q: Q = { text: strings.join("?") };
      const out = /room_install/.test(q.text) ? [{ hostname: M, room_id: "room_6", slug: "opd-6" }]
        : /FROM eta_encounter_windows/.test(q.text) ? windows
        : /pulse_presence_events/.test(q.text) ? events
        : [];
      return Object.assign(q, { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(out).then(res, rej) });
    }) as unknown as WindowsDb;
    return tag;
  }
  const winRow = () => ({
    machine: M, consult_key: "E1@m", t_open: agoIso(30), t_close: agoIso(20), consulting_doctor_uid: UB, consulting_doctor_name: B.full_name,
  });

  it("buildOccupantDisplay: page_name rides on a warehouse and a cookie display; null when absent; blank is null", () => {
    expect(buildOccupantDisplay({ uid: UB, name: B.full_name }, { uid: UA, name: A.full_name }, PAGE)).toMatchObject({ source: "warehouse", stale: true, page_name: PAGE });
    expect(buildOccupantDisplay(null, { uid: UA, name: A.full_name }, PAGE)).toMatchObject({ source: "cookie", page_name: PAGE });
    expect(buildOccupantDisplay(null, { uid: UA, name: A.full_name })).toMatchObject({ page_name: null });
    expect(buildOccupantDisplay({ uid: UB, name: B.full_name }, null, "  ")).toMatchObject({ page_name: null });
  });

  it("stale cookie doctor + a live warehouse consult: the display is the warehouse doctor and the page name sits alongside", async () => {
    const evs = [...aLoggedIn(), staleA(0.5)];
    const [m] = await machineOccupancy(occDb(evs, [winRow()]), NOW);
    expect(m).toMatchObject({ machine: M, occupied: false, cookie_uid: null, page_name: PAGE, instances: 1 });
    expect(m!.occupant_display).toMatchObject({ source: "warehouse", uid: UB, cookie_uid: null, stale: false, page_name: PAGE });
  });

  it("no warehouse doctor and no cookie identity: occupant_display stays null and the machine row carries the page name (the 'page: <name>' line)", async () => {
    const evs = [ev("heartbeat", 1, { reason: "absent_401", page: PAGE, inst: I1, focus: true })];
    const [m] = await machineOccupancy(occDb(evs), NOW);
    expect(m).toMatchObject({ occupied: false, cookie_uid: null, occupant_display: null, page_name: PAGE, instances: 1 });
  });

  it("two installs on one machine: instances = 2 on the machine row, informational only (still one occupant)", async () => {
    const evs = [
      ev("login", 10, { uid: UA, dn: A.full_name, focus: true, inst: I1 }),
      ev("heartbeat", 1, { uid: UA, dn: A.full_name, focus: true, inst: I1 }),
      ev("heartbeat", 1, { uid: UA, dn: A.full_name, focus: false, inst: I2 }),
    ];
    const [m] = await machineOccupancy(occDb(evs), NOW);
    expect(m).toMatchObject({ occupied: true, cookie_uid: UA, instances: 2 });
  });
});

// ---------------------------------------------------------------- fleet attention
describe("fleet attention is unaffected by 0.1.1 events (it keys on the machine, never on an instance)", () => {
  const e = (event: string, minAgo: number, tab_focus?: boolean | string | null) => ({ event, ts: agoIso(minAgo), ...(tab_focus === undefined ? {} : { tab_focus }) });

  it("identity_stale says nothing about the screen", () => {
    expect(classifyExtEvent(e("identity_stale", 1, true))).toBeNull();
    expect(resolveLockState([e("identity_stale", 1, true)], null)).toEqual({ down: false, since: null, by: null });
  });

  it("a stale-state focused heartbeat is still 'awake', and duplicate rows from two installs give the same lock state as one", () => {
    expect(classifyExtEvent(e("heartbeat", 1, true))).toBe("awake");
    const one = [e("locked", 10), e("heartbeat", 1, true)];
    const two = [...one, e("locked", 10), e("heartbeat", 1, true), e("identity_stale", 1, true)];
    expect(resolveLockState(two, null)).toEqual(resolveLockState(one, null));
    const lockedLast = [e("heartbeat", 10, true), e("locked", 1)];
    expect(resolveLockState([...lockedLast, ...lockedLast], null)).toEqual(resolveLockState(lockedLast, null));
  });
});
