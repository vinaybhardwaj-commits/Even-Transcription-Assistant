/**
 * The LOGIN RULE of the occupancy resolver (6 Oct 2026) — a `login` opens presence only with console activity and no identity_stale; otherwise it is a
 * PENDING session that activity promotes (an identity_stale one promotes to a STALE-COOKIE stream: the page greeting, never the cookie doctor).
 *
 * WHY. Proven 5 Oct 2026, OPD 6, 21:37:57 IST: a Chrome relaunch on a leftover Google cookie emitted `login` (the cookie doctor) + `idle` + `identity_stale`
 * (the page greeting a different name) in the same second, while the tailnet poller showed 3.7 h (13,324 s) of console idle and nobody in the room. The resolver
 * opened occupancy for the cookie doctor and held it for up to 45 min. The presence-guard daemon now relaunches Chrome routinely, so this recurs.
 *
 * Pure in-memory resolver tests (no database); the SQL twin (tools/pulse-watch/occupancy.mjs) is proven in tests/unit/occupancy-login-rule-sql.test.ts and
 * fetchEvents' poller-row load in tests/unit/occupancy-fetch-sql.test.ts. People come from the fake-identity helper.
 */
import { describe, it, expect } from "vitest";
import {
  byTimeThenId, normalizeEvent, occupancyAt, resolveStreams, resolveStreamsDetailed, LOGIN_RULE, STALE_UNKNOWN_NAME, firstNameOf, pageNamesDoctor, type NEvent,
} from "@/lib/encounter-windows/occupancy";
import { computeWindows, pollerRowsNearLogins, fetchEvents, type PresenceEvent } from "@/lib/encounter-windows";
import { machineOccupancy, pendingLabel, staleOccupantLabel } from "@/lib/encounter-windows/occupant";
import type { WindowsDb } from "@/lib/encounter-windows";
import { MAX_LOGIN_WINDOWS, chunkPollerWindows, loginPollerWindows } from "@/lib/encounter-windows/db";
import { makeFakeClinician } from "../support/fake-identity";

const A = makeFakeClinician(1); // the cookie doctor of the leftover Google login
const B = makeFakeClinician(2); // a doctor who really signs in later
const UA = A.id;
const UB = B.id;
const M = "EHRC-OPD6s-Mac-mini";
const PAGE = "Fakefirst"; // the first name the page greets: a witness, never an identity

const T0 = Date.parse("2026-10-05T16:07:57Z"); // 5 Oct 21:37:57 IST — the OPD 6 relaunch
const S = 1000;
const MIN = 60_000;
const at = (offMs: number) => new Date(T0 + offMs).toISOString();

let nextId = 1;
const ext = (event: string, offMs: number, o: Partial<PresenceEvent> = {}): PresenceEvent => ({
  id: nextId++, source: "ext", machine: M, event, ts: at(offMs), uid: null, dn: null, focus: false, ...o,
});
const login = (offMs: number, uid = UA, dn = A.full_name, o: Partial<PresenceEvent> = {}) => ext("login", offMs, { uid, dn, focus: true, ...o });
const hb = (offMs: number, uid = UA) => ext("heartbeat", offMs, { uid, focus: true });
const stale = (offMs: number, o: Partial<PresenceEvent> = {}) => ext("identity_stale", offMs, { reason: "stale_cookie", cookie_uid: UA, page: PAGE, focus: true, ...o });
/** an event of the stale-cookie profile: the extension sends doctor_uid null and reason stale_cookie */
const sx = (event: string, offMs: number, o: Partial<PresenceEvent> = {}) => ext(event, offMs, { uid: null, reason: "stale_cookie", focus: true, ...o });
const poll = (offMs: number, idle: number | null, o: Partial<PresenceEvent> = {}): PresenceEvent => ({
  id: nextId++, source: "poller", machine: M, event: "ok", ts: at(offMs), idle_s: idle, ...o,
});
// the resolver takes ONE machine's events (poller rows are canonicalised onto the extension's machine key by normalizeEvent)
const norm = (evs: PresenceEvent[]): NEvent[] => evs.map(normalizeEvent).filter((x): x is NEvent => x !== null && x.machine === M).sort(byTimeThenId);
const occ = (evs: PresenceEvent[], offMs: number) => occupancyAt(norm(evs), T0 + offMs);
const streamOf = (evs: PresenceEvent[], offMs: number, uid: string | null = UA) => resolveStreams(norm(evs), T0 + offMs).find((s) => s.uid === uid);
const ghostOf = (evs: PresenceEvent[], offMs: number) => resolveStreams(norm(evs), T0 + offMs).find((s) => s.stale_cookie);

describe("OPD 6 21:37:57 — login + idle + identity_stale in one second, poller idle_s 13,324: PENDING, not present", () => {
  // the stale event has the LOWER id here, so the login is the stream's latest control event: the pre-rule resolver re-opened A
  const fixture = (): PresenceEvent[] => [
    poll(-30 * S, 13_324),
    stale(0),
    login(0),
    ext("idle", 0, { uid: UA, focus: true }),
    poll(30 * S, 13_384),
    hb(30 * S), hb(60 * S), hb(5 * MIN), hb(20 * MIN),
  ];

  it("not present at +1 s, +1 min and +20 min (focused heartbeats of the pending doctor do not open it)", () => {
    const evs = fixture();
    for (const off of [1 * S, 1 * MIN, 5 * MIN, 20 * MIN]) {
      expect(occ(evs, off)).toMatchObject({ n_present: 0, best: null });
      expect(streamOf(evs, off)?.present ?? false).toBe(false);
    }
  });

  it("reports pending {display_name, since = the login's time, reason identity_stale}; the grey label reads 'session: <name> (pending, no console activity)'", () => {
    const o = occ(fixture(), 1 * MIN);
    expect(o.pending).toEqual({ display_name: A.full_name, since: at(0), reason: "identity_stale" });
    expect(pendingLabel(o.pending)).toBe(`session: ${A.full_name} (pending, no console activity)`);
    expect(pendingLabel(null)).toBe("");
  });

  it("the same relaunch WITHOUT the identity_stale row is pending for the other reason: no_console_activity", () => {
    const evs = [poll(-30 * S, 13_324), login(0), ext("idle", 0, { uid: UA, focus: true }), hb(30 * S)];
    const o = occ(evs, 1 * MIN);
    expect(o).toMatchObject({ n_present: 0, best: null, pending: { display_name: A.full_name, since: at(0), reason: "no_console_activity" } });
  });

  it("control: the pre-rule behaviour (no poller row, no stale row) is a present doctor — the rule is what changed it", () => {
    expect(occ([login(0), ext("idle", 0, { uid: UA, focus: true })], 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
  });

  it("a pending session never reaches the windows: a consult attributed from it has no uid (stale) — and a poller-only promotion needs real input", () => {
    const evs = [
      poll(-30 * S, 13_324), stale(0), login(0), ext("idle", 0, { uid: UA, focus: true }), hb(30 * S), hb(40 * MIN),
      poll(50 * MIN, 13_324 + 3000),
      ext("encounter_open", 50 * MIN, { enc: "E1" }), ext("encounter_close", 55 * MIN, { enc: "E1" }),
    ];
    const rows = computeWindows(evs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attribution: "none", doctor_uid: null, display_name: null });
  });
});

describe("a login with console activity or without poller data opens presence as before", () => {
  it("OPD 5 20:36 — login with poller idle_s 0 -> present, nothing pending", () => {
    const t = Date.parse("2026-10-05T15:06:00Z"); // 5 Oct 20:36 IST
    const evs: PresenceEvent[] = [
      { id: nextId++, source: "poller", machine: M, event: "ok", ts: new Date(t - 20 * S).toISOString(), idle_s: 0 },
      { id: nextId++, source: "ext", machine: M, event: "login", ts: new Date(t).toISOString(), uid: UA, dn: A.full_name, focus: true },
    ];
    const o = occupancyAt(norm(evs), t + 10 * S);
    expect(o).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(o.pending).toBeUndefined();
  });

  it("login with NO poller data at all -> present (fail open, as before)", () => {
    expect(occ([login(0)], 5 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
  });

  it("F5: the nearest poller row within +-300 s decides (not +-120): a row 200 s away counts; none within 300 s -> fail open", () => {
    expect(occ([poll(-400 * S, 13_000), login(0)], 5 * S)).toMatchObject({ n_present: 1 }); // none within 300 s: fail open
    expect(occ([poll(-200 * S, 13_000), login(0)], 5 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } }); // 200 s away: evidence of idle
    expect(occ([poll(-200 * S, 0), login(0)], 5 * S)).toMatchObject({ n_present: 1 }); // 200 s away: evidence of activity
    expect(occ([poll(-300 * S, 13_000), login(0)], 5 * S)).toMatchObject({ n_present: 0 }); // 300 s is inside
    expect(occ([poll(-301 * S, 13_000), login(0)], 5 * S)).toMatchObject({ n_present: 1 }); // 301 s is not
    expect(occ([poll(301 * S, 13_000), login(0)], 5 * S)).toMatchObject({ n_present: 1 });
  });

  it("the NEAREST poller row decides: idle 600 passes, 601 fails; a closer busy row beats a farther idle one", () => {
    expect(occ([poll(-10 * S, 600), login(0)], 5 * S)).toMatchObject({ n_present: 1 });
    expect(occ([poll(-10 * S, 601), login(0)], 5 * S)).toMatchObject({ n_present: 0 });
    expect(occ([poll(-100 * S, 9_000), poll(5 * S, 3), login(0)], 10 * S)).toMatchObject({ n_present: 1 });
    expect(occ([poll(-5 * S, 9_000), poll(100 * S, 500), login(0)], 110 * S)).toMatchObject({ n_present: 0 });
  });

  it("an identity_stale within +-10 s makes it pending whatever the poller says; 11 s away does not", () => {
    const busy = poll(-5 * S, 0);
    // stale rows with cookie_uid null so they close no stream by themselves: only the login rule is under test
    const near = (off: number) => [busy, login(0), ext("identity_stale", off, { reason: "stale_cookie", cookie_uid: null, page: PAGE })];
    expect(occ(near(10 * S), 30 * S)).toMatchObject({ n_present: 0, pending: { reason: "identity_stale" } });
    expect(occ(near(-10 * S), 30 * S)).toMatchObject({ n_present: 0, pending: { reason: "identity_stale" } });
    expect(occ(near(11 * S), 30 * S)).toMatchObject({ n_present: 1 });
    expect(occ(near(-11 * S), 30 * S)).toMatchObject({ n_present: 1 });
  });

  it("poller rows with no idle_s (unreachable) say nothing; other machines' rows are not used", () => {
    expect(occ([poll(-10 * S, null, { event: "unreachable" }), login(0)], 5 * S)).toMatchObject({ n_present: 1 });
    expect(occ([poll(-10 * S, 13_000, { machine: "EHRC-OPD7s-Mac-mini" }), login(0)], 5 * S)).toMatchObject({ n_present: 1 }); // another Mac's row is not this machine's
  });

  it("poller rows keyed on the raw hostname or a pre-5-Oct short key land on the extension's machine", () => {
    expect(normalizeEvent(poll(0, 5, { machine: "EHRC-OPD6’s Mac mini" }))!.machine).toBe("EHRC-OPD6s-Mac-mini");
    expect(normalizeEvent(poll(0, 5, { machine: "EHRC-CONSUL2’s Mac mini (2)" }))!.machine).toBe("EHRC-CONSUL2s-Mac-mini-2");
    expect(normalizeEvent(poll(0, 5, { machine: "consul4" }))!.machine).toBe("EHRC-CONSUL4s-Mac-mini");
    expect(normalizeEvent(poll(0, 5, { idle_s: "42" }))!.idle).toBe(42);
    expect(normalizeEvent(poll(0, 5, { idle_s: null }))!.idle).toBeNull();
    expect(normalizeEvent(ext("login", 0, { uid: UA }))!.machine).toBe(M);
  });
});

describe("a pending session is promoted — from the promoting event's time — or stays pending", () => {
  const pendingBase = (): PresenceEvent[] => [poll(-30 * S, 13_324), login(0), ext("idle", 0, { uid: UA, focus: true })];

  it("promoted by an `active` at +3 min: not present before, present from +3 min (not from the login)", () => {
    const evs = [...pendingBase(), ext("active", 3 * MIN, { uid: UA, focus: true })];
    expect(occ(evs, 3 * MIN - 1 * S)).toMatchObject({ n_present: 0 });
    expect(occ(evs, 3 * MIN - 1 * S).pending).toMatchObject({ reason: "no_console_activity" });
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o).toMatchObject({ n_present: 1, best: { uid: UA, dn: A.full_name } });
    expect(o.pending).toBeUndefined();
    expect(streamOf(evs, 4 * MIN)).toMatchObject({ present: true, last_genuine_ts: T0 + 3 * MIN });
  });

  it("an `active` from the machine with no doctor on it (the twin profile) promotes too", () => {
    const evs = [...pendingBase(), ext("active", 3 * MIN, { uid: null })];
    expect(occ(evs, 3 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(streamOf(evs, 4 * MIN)).toMatchObject({ last_genuine_ts: T0 + 3 * MIN });
  });

  it("promoted by an encounter_open on the machine (a consult starting) — and the consult is attributed to the occupant from then", () => {
    const evs = [...pendingBase(), ext("encounter_open", 10 * MIN, { enc: "E1" }), ext("encounter_close", 20 * MIN, { enc: "E1" })];
    expect(occ(evs, 10 * MIN - 1 * S)).toMatchObject({ n_present: 0 });
    expect(occ(evs, 10 * MIN)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(computeWindows(evs)[0]).toMatchObject({ attribution: "occupant", doctor_uid: UA });
  });

  it("F4: a poller row after the login with idle_s < (poll ts - login ts) + 5 s proves console use: promoted at THAT poll's ts", () => {
    const evs = [...pendingBase(), poll(60 * S, 13_384), poll(2 * MIN, 4)];
    expect(occ(evs, 2 * MIN - 1 * S)).toMatchObject({ n_present: 0 });
    expect(occ(evs, 2 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(streamOf(evs, 3 * MIN)).toMatchObject({ last_genuine_ts: T0 + 2 * MIN });
  });

  it("F4 boundary: Δ = 60 s -> idle 64 promotes (input 4 s before the login, inside the 5 s slack), idle 65 does not; idle 31 promotes (input after the login)", () => {
    const base = (idle: number) => [poll(-30 * S, 13_324), login(0), poll(60 * S, idle)];
    expect(occ(base(64), 61 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(occ(base(31), 61 * S)).toMatchObject({ n_present: 1 });
    expect(occ(base(65), 61 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    expect(occ(base(13_000), 61 * S)).toMatchObject({ n_present: 0 });
  });

  it("F4 CONSUL7 03:49:39Z fixture: polls -16 s idle 57,782, +45 s idle 47, +105 s idle 0 -> pending at the login, promoted at the +45 s poll", () => {
    const C7 = "EHRC-CONSUL7s-Mac-mini";
    const lt = Date.parse("2026-10-06T03:49:39Z");
    const mk = (event: string, off: number, o: Partial<PresenceEvent> = {}): PresenceEvent => ({ id: nextId++, source: "ext", machine: C7, event, ts: new Date(lt + off).toISOString(), uid: null, dn: null, focus: false, ...o });
    const pl = (off: number, idle: number): PresenceEvent => ({ id: nextId++, source: "poller", machine: C7, event: "ok", ts: new Date(lt + off).toISOString(), idle_s: idle });
    const evs = [pl(-16 * S, 57_782), mk("login", 0, { uid: UA, dn: A.full_name, focus: true }), pl(45 * S, 47), pl(105 * S, 0)];
    const n = evs.map(normalizeEvent).filter((x): x is NEvent => x !== null).sort(byTimeThenId);
    const o0 = occupancyAt(n, lt + 44 * S);
    expect(o0).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    const o1 = occupancyAt(n, lt + 46 * S);
    expect(o1).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(resolveStreams(n, lt + 60 * S).find((s) => s.uid === UA)).toMatchObject({ last_genuine_ts: lt + 45 * S });
  });

  it("F4: poller promotion only within 45 min of the login", () => {
    const evs = [...pendingBase(), poll(44 * MIN, 13_324), poll(46 * MIN, 3)];
    expect(occ(evs, 46 * MIN + 1 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    expect(occ([...pendingBase(), poll(44 * MIN, 3)], 44 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
  });

  // F9: the promoting activity of ANOTHER (or no) doctor counts only within 45 min of the login; the login's own doctor at any time. These run 5 h before T0 so 3 h later is still before 00:00 IST.
  const L = -5 * 60 * MIN;
  const lateBase = (): PresenceEvent[] => [poll(L - 30 * S, 13_324), login(L), ext("idle", L, { uid: UA, focus: true })];
  const H3 = L + 3 * 60 * MIN;

  it("F9: a null-uid `active` (twin / stale-cookie profile) 3 h after the login promotes nothing; the same-uid `active` 3 h later does, from its own time", () => {
    const withNull = [...lateBase(), ext("active", H3, { uid: null })];
    expect(occ(withNull, H3 + 1 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity", since: at(L) } });
    const withSame = [...lateBase(), ext("active", H3, { uid: UA, focus: true })];
    expect(occ(withSame, H3 - 1 * S).n_present).toBe(0);
    expect(occ(withSame, H3 + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(streamOf(withSame, H3 + 1 * S)).toMatchObject({ last_genuine_ts: T0 + H3 });
  });

  it("F9: null-uid and other-uid activity promote within 45 min of the login (45 min inclusive, 45 min + 1 s not); an other doctor's own events never promote A late", () => {
    const edge = [...lateBase(), ext("active", L + 45 * MIN, { uid: null })];
    expect(occ(edge, L + 45 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    const past = [...lateBase(), ext("active", L + 45 * MIN + 1 * S, { uid: null })];
    expect(occ(past, L + 46 * MIN)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    const other = [...lateBase(), ext("active", H3, { uid: UB, dn: B.full_name, focus: true })];
    const o = occ(other, H3 + 1 * S);
    expect(o).toMatchObject({ n_present: 1, best: { uid: UB }, pending: { display_name: A.full_name } });
    expect(streamOf(other, H3 + 1 * S, UA)?.present ?? false).toBe(false);
  });

  it("F9: a null-uid encounter_open 3 h after the login does not promote it either (and the consult is attributed to nobody)", () => {
    const evs = [...lateBase(), ext("encounter_open", H3, { enc: "E9", uid: null }), ext("encounter_close", H3 + 5 * MIN, { enc: "E9", uid: null })];
    expect(occ(evs, H3 + 1 * S).n_present).toBe(0);
    expect(computeWindows(evs)[0]).toMatchObject({ attribution: "none", doctor_uid: null });
  });

  it("F3: NO 45-min expiry for the login's own doctor: still pending after 50 min of focused heartbeats; his consult at 49 min promotes from its own time", () => {
    const evs: PresenceEvent[] = [...pendingBase()];
    for (let m = 1; m <= 50; m += 1) evs.push(hb(m * MIN)); // an unattended Chrome keeps sending focused heartbeats
    for (const off of [1 * MIN, 20 * MIN, 44 * MIN, 45 * MIN, 46 * MIN, 50 * MIN]) {
      expect(occ(evs, off).n_present).toBe(0);
      expect(occ(evs, off).pending).toMatchObject({ reason: "no_console_activity", since: at(0) });
    }
    evs.push(ext("encounter_open", 49 * MIN, { enc: "E2", uid: UA }), ext("encounter_close", 52 * MIN, { enc: "E2", uid: UA }));
    expect(computeWindows(evs)[0]).toMatchObject({ doctor_uid: UA });
    expect(occ(evs, 49 * MIN - 1 * S).n_present).toBe(0);
    expect(streamOf(evs, 49 * MIN)).toMatchObject({ present: true, last_genuine_ts: T0 + 49 * MIN });
  });

  it("F3 Refuter scenario: an earlier logout in the lookback does not block a later promotion", () => {
    const evs = [
      poll(-2 * 60 * MIN, 2), login(-2 * 60 * MIN), ext("logout", -2 * 60 * MIN, { uid: UA }),
      poll(-30 * S, 13_324), login(0), ext("idle", 0, { uid: UA, focus: true }),
      ext("active", 2 * 60 * MIN, { uid: UA, focus: true }),
    ];
    expect(occ(evs, 2 * 60 * MIN - 1 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    expect(occ(evs, 2 * 60 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(streamOf(evs, 2 * 60 * MIN + 1 * S)).toMatchObject({ present: true, out_reason: null });
  });

  it("nightly cutoff: a pending session is discarded at 00:00 IST — a later `active` promotes nothing, and the pending line is gone", () => {
    const cut = Date.parse("2026-10-05T18:30:00Z") - T0; // 00:00 IST on 6 Oct, as an offset from T0
    const evs = [...pendingBase(), hb(60 * MIN), ext("active", cut + 1 * MIN, { uid: UA, focus: true })];
    expect(occ(evs, cut - 1 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    expect(occ(evs, cut + 1 * S)).toMatchObject({ n_present: 0 });
    expect(occ(evs, cut + 1 * S).pending).toBeUndefined();
    // the active AFTER the cutoff finds no pending session: it is that doctor's own ordinary activity, nothing promoted from the login
    expect(streamOf(evs, cut + 2 * MIN)).toMatchObject({ present: true, last_genuine_ts: T0 + cut + 1 * MIN });
    // and a poller reset after the cutoff promotes nothing either
    const evs2 = [...pendingBase(), poll(cut + 30 * S, 5)];
    expect(occ(evs2, cut + 40 * S)).toMatchObject({ n_present: 0 });
  });

  it("a logout discards it: nothing present, nothing pending, and a later `active` does not bring the login back", () => {
    const evs = [...pendingBase(), ext("logout", 5 * MIN, { uid: UA }), ext("active", 10 * MIN, { uid: UA, focus: true }), hb(11 * MIN)];
    const o = occ(evs, 12 * MIN);
    expect(o.pending).toBeUndefined();
    expect(streamOf(evs, 12 * MIN)).toMatchObject({ present: false, out_reason: "logout" });
  });

  it("a new login replaces it and is re-evaluated: with console activity it opens (and the old pending is gone)", () => {
    const evs = [...pendingBase(), poll(5 * MIN - 10 * S, 400), login(5 * MIN, UB, B.full_name)]; // 400 s idle: busy enough for a login, not a RESET of the first (needs idle < 295 s)
    const o = occ(evs, 6 * MIN);
    expect(o).toMatchObject({ n_present: 1, best: { uid: UB } });
    expect(o.pending).toBeUndefined();
    expect(streamOf(evs, 6 * MIN, UA)?.present ?? false).toBe(false);
  });

  it("a new login replaces it and, still without activity, is the new pending session (since = the new login)", () => {
    const evs = [...pendingBase(), poll(5 * MIN - 10 * S, 13_900), login(5 * MIN, UB, B.full_name)];
    expect(occ(evs, 6 * MIN)).toMatchObject({ n_present: 0, pending: { display_name: B.full_name, since: at(5 * MIN), reason: "no_console_activity" } });
  });

  it("after a replacement the NEW login's session has no expiry either: an active 40 min later promotes B", () => {
    const evs = [...pendingBase(), poll(20 * MIN - 10 * S, 13_900), login(20 * MIN, UB, B.full_name), ext("active", 60 * MIN, { uid: UB, focus: true })];
    expect(occ(evs, 50 * MIN).pending).toMatchObject({ display_name: B.full_name });
    expect(occ(evs, 61 * MIN)).toMatchObject({ n_present: 1, best: { uid: UB } });
  });

  it("promotion makes the doctor an ordinary stream again: it ages out like any other (idle_timeout 45 min after the promotion)", () => {
    const evs = [...pendingBase(), ext("active", 3 * MIN, { uid: UA, focus: true })];
    expect(streamOf(evs, 40 * MIN)).toMatchObject({ present: true });
    expect(streamOf(evs, 49 * MIN)).toMatchObject({ present: false, out_reason: "idle_timeout" });
  });
});

describe("F1: an identity_stale session that activity promotes is the PAGE's identity (uid null), never the cookie doctor", () => {
  const staleBase = (page: string | null = PAGE): PresenceEvent[] => [poll(-30 * S, 13_324), stale(0, { page }), login(0), ext("idle", 0, { uid: UA, focus: true })];

  it("Refuter 1: a stale-cookie `active` promotes -> present as the page greeting, uid null, stale_cookie; the cookie doctor A is NOT present", () => {
    const evs = [...staleBase(), sx("active", 3 * MIN)];
    expect(occ(evs, 3 * MIN - 1 * S)).toMatchObject({ n_present: 0, best: null, pending: { reason: "identity_stale" } });
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o.n_present).toBe(0); // F11: the page-name stream is the occupant, not a counted doctor
    expect(o.best).toEqual({ uid: null, dn: PAGE, stale_cookie: true, page_name: PAGE, cookie_name: A.full_name });
    expect(o.pending).toBeUndefined();
    expect(streamOf(evs, 4 * MIN, UA)?.present ?? false).toBe(false);
    expect(staleOccupantLabel(o.best)).toBe(`page: ${PAGE} (cookie ${A.full_name} stale)`);
    expect(ghostOf(evs, 4 * MIN)).toMatchObject({ uid: null, dn: PAGE, present: true, last_genuine_ts: T0 + 3 * MIN });
  });

  it("Refuter 2: a real doctor B's own `active` promotes the stale session; the cookie doctor A still never appears, and B is the occupant", () => {
    const evs = [...staleBase(), ext("active", 3 * MIN, { uid: UB, dn: B.full_name, focus: true })];
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o).toMatchObject({ n_present: 1, best: { uid: UB, dn: B.full_name } });
    expect(o.best).not.toHaveProperty("stale_cookie");
    expect(o.pending).toBeUndefined();
    expect(streamOf(evs, 4 * MIN, UA)?.present ?? false).toBe(false);
    expect(ghostOf(evs, 4 * MIN)).toBeUndefined();
  });

  it("Refuter 3: an OTP consult on the machine (warehouse doctor, no cookie identity): the occupant has uid null, so attribution is 'none' and the warehouse decides", () => {
    const evs = [...staleBase(), ext("encounter_open", 10 * MIN, { enc: "E1", uid: null }), ext("encounter_close", 20 * MIN, { enc: "E1", uid: null })];
    const o = occ(evs, 10 * MIN);
    expect(o).toMatchObject({ n_present: 0, best: { uid: null, stale_cookie: true, page_name: PAGE } });
    expect(computeWindows(evs)[0]).toMatchObject({ attribution: "none", doctor_uid: null, display_name: null, quality: "unattributed" });
  });

  it("an `active` under the cookie doctor A's own uid does not resurrect A (the extension flagged that cookie stale): the page identity stands", () => {
    const evs = [...staleBase(), ext("active", 3 * MIN, { uid: UA, dn: A.full_name, focus: true })];
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o).toMatchObject({ n_present: 0, best: { uid: null, stale_cookie: true, page_name: PAGE } });
    expect(streamOf(evs, 4 * MIN, UA)?.present ?? false).toBe(false);
  });

  it("no page_name on the identity_stale event -> 'unknown (stale cookie)', uid null", () => {
    const evs = [...staleBase(null), sx("active", 3 * MIN)];
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o.best).toEqual({ uid: null, dn: STALE_UNKNOWN_NAME, stale_cookie: true, page_name: null, cookie_name: A.full_name });
    expect(staleOccupantLabel(o.best)).toBe("unknown (stale cookie)");
    expect(STALE_UNKNOWN_NAME).toBe("unknown (stale cookie)");
  });

  it("a poller reset promotes an identity_stale session the same way (page identity, not A)", () => {
    const evs = [...staleBase(), poll(2 * MIN, 4)];
    expect(occ(evs, 2 * MIN + 1 * S).best).toMatchObject({ uid: null, dn: PAGE, stale_cookie: true });
    expect(streamOf(evs, 3 * MIN, UA)?.present ?? false).toBe(false);
  });

  it("a later login with a DIFFERENT identity replaces the stale-cookie stream (console busy: it opens)", () => {
    const evs = [...staleBase(), sx("active", 3 * MIN), poll(8 * MIN - 5 * S, 3), login(8 * MIN, UB, B.full_name)];
    expect(occ(evs, 5 * MIN).best).toMatchObject({ stale_cookie: true });
    const o = occ(evs, 9 * MIN);
    expect(o).toMatchObject({ n_present: 1, best: { uid: UB } });
    expect(ghostOf(evs, 9 * MIN)).toBeUndefined();
  });

  it("the stale-cookie stream is activity-bound like any stream: stale-profile heartbeats keep it, 45 min of nothing ends it (idle_timeout), logout by the cookie uid ends it", () => {
    const base = [...staleBase(), sx("active", 3 * MIN)];
    expect(ghostOf(base, 40 * MIN)).toMatchObject({ present: true });
    expect(ghostOf(base, 49 * MIN)).toMatchObject({ present: false, out_reason: "idle_timeout" });
    const kept = [...base, sx("heartbeat", 30 * MIN)];
    expect(ghostOf(kept, 60 * MIN)).toMatchObject({ present: true });
    const out = [...base, ext("logout", 10 * MIN, { uid: UA })];
    expect(ghostOf(out, 11 * MIN)).toMatchObject({ present: false, out_reason: "logout" });
    expect(occ(out, 11 * MIN)).toMatchObject({ n_present: 0, best: null });
  });

  it("a non-stale-reason pending (no_console_activity) still promotes the doctor himself, with his uid and name", () => {
    const evs = [poll(-30 * S, 13_324), login(0), sx("active", 3 * MIN)];
    expect(occ(evs, 3 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA, dn: A.full_name } });
  });
});

describe("F8: an identity_stale for a pending login's cookie uid — at ANY later time — makes it the page-name stream; the cookie doctor never becomes present", () => {
  const everPresent = (evs: PresenceEvent[], from: number, to: number, uid: string): boolean => {
    for (let o = from; o <= to; o += 30 * S) if (streamOf(evs, o, uid)?.present) return true;
    return false;
  };
  const GHOST = { uid: null, dn: PAGE, stale_cookie: true, page_name: PAGE, cookie_name: A.full_name };

  it("CONSUL7 fixture: login pending (idle 57,782), identity_stale at +42 s, a poll idle 47 at +45 s -> the PAGE-NAME stream is present; the cookie doctor was never present; an OTP consult is credited to nobody", () => {
    const evs = [poll(-16 * S, 57_782), login(0), stale(42 * S, { cookie_uid: UA, page: PAGE }), poll(45 * S, 47), poll(105 * S, 0)];
    expect(occ(evs, 30 * S)).toMatchObject({ n_present: 0, pending: { reason: "no_console_activity" } });
    expect(occ(evs, 44 * S)).toMatchObject({ n_present: 0, pending: { reason: "identity_stale", display_name: A.full_name } });
    const o = occ(evs, 46 * S);
    expect(o.n_present).toBe(0);
    expect(o.best).toEqual(GHOST);
    expect(o.pending).toBeUndefined();
    expect(ghostOf(evs, 2 * MIN)).toMatchObject({ uid: null, dn: PAGE, present: true, last_genuine_ts: T0 + 45 * S });
    expect(everPresent(evs, -1 * MIN, 30 * MIN, UA)).toBe(false);
    const withConsult = [...evs, ext("encounter_open", 10 * MIN, { enc: "E8", uid: null }), ext("encounter_close", 20 * MIN, { enc: "E8", uid: null })];
    expect(occ(withConsult, 10 * MIN)).toMatchObject({ n_present: 0, best: { uid: null, stale_cookie: true } });
    expect(computeWindows(withConsult)[0]).toMatchObject({ attribution: "none", doctor_uid: null, display_name: null });
  });

  it("the same, 3 h later: identity_stale arrives 3 h after the login; the cookie doctor's own `active` then promotes the PAGE identity, and a later heartbeat of the cookie uid does not bring him back", () => {
    const L = -5 * 60 * MIN;
    const H3 = L + 3 * 60 * MIN;
    const evs = [poll(L - 16 * S, 57_782), login(L), stale(H3, { cookie_uid: UA, page: PAGE }), poll(H3 + 3 * S, 47), ext("active", H3 + 5 * S, { uid: UA, focus: true }), hb(H3 + 2 * MIN, UA)];
    expect(occ(evs, H3 + 1 * S)).toMatchObject({ n_present: 0, pending: { reason: "identity_stale" } });
    expect(occ(evs, H3 + 4 * S)).toMatchObject({ n_present: 0, pending: { reason: "identity_stale" } }); // a poll 3 h after the login proves nothing (45 min window)
    const o = occ(evs, H3 + 6 * S);
    expect(o).toMatchObject({ n_present: 0 });
    expect(o.best).toEqual(GHOST);
    expect(o.pending).toBeUndefined();
    expect(occ(evs, H3 + 3 * MIN).best).toEqual(GHOST);
    expect(everPresent(evs, L - 1 * MIN, H3 + 10 * MIN, UA)).toBe(false);
    expect(ghostOf(evs, H3 + 3 * MIN)).toMatchObject({ present: true, last_genuine_ts: T0 + H3 + 5 * S });
  });

  it("an identity_stale 30 s after the login, promoted by the same-uid `active` at +3 min: page identity, never the cookie doctor (promote never writes a login over the later stale)", () => {
    const evs = [poll(-30 * S, 13_324), login(0), stale(30 * S), ext("active", 3 * MIN, { uid: UA, focus: true })];
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o.best).toEqual(GHOST);
    expect(everPresent(evs, 0, 10 * MIN, UA)).toBe(false);
  });

  it("an identity_stale for ANOTHER cookie uid does not convert the pending login", () => {
    const evs = [poll(-30 * S, 13_324), login(0), stale(30 * S, { cookie_uid: UB }), ext("active", 3 * MIN, { uid: UA, focus: true })];
    expect(occ(evs, 20 * S).pending).toMatchObject({ reason: "no_console_activity" });
    expect(occ(evs, 3 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA, dn: A.full_name } });
  });

  it("demotion: an identity_stale for a PRESENT doctor's cookie turns him into the page-name stream from the stale's own time (A present before, never after)", () => {
    const evs = [poll(-5 * S, 2), login(0), hb(20 * S), stale(42 * S, { cookie_uid: UA, page: PAGE }), hb(60 * S, UA)];
    expect(occ(evs, 41 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    const o = occ(evs, 43 * S);
    expect(o.n_present).toBe(0);
    expect(o.best).toEqual(GHOST);
    expect(ghostOf(evs, 43 * S)).toMatchObject({ present: true, last_genuine_ts: T0 + 42 * S });
    expect(streamOf(evs, 2 * MIN, UA)?.present ?? false).toBe(false);
    expect(occ(evs, 2 * MIN).best).toEqual(GHOST);
  });

  it("demotion leaves another present doctor alone and does not touch a doctor whose cookie is not the one named", () => {
    const evs = [poll(-5 * S, 2), login(0), login(10 * S, UB, B.full_name, { focus: true }), stale(42 * S, { cookie_uid: UA, page: PAGE })];
    const o = occ(evs, 60 * S);
    expect(o.n_present).toBe(1); // F11: B only — the demoted page-name stream is not counted (it is surfaced beside him)
    expect(streamOf(evs, 60 * S, UB)).toMatchObject({ present: true });
    expect(streamOf(evs, 60 * S, UA)?.present ?? false).toBe(false);
    expect(ghostOf(evs, 60 * S)).toMatchObject({ present: true, page_name: PAGE });
  });

  it("an identity_stale for a doctor who is NOT present (already out) creates nothing", () => {
    const evs = [poll(-5 * S, 2), login(0), ext("logout", 20 * S, { uid: UA }), stale(42 * S, { cookie_uid: UA, page: PAGE })];
    expect(occ(evs, 60 * S)).toMatchObject({ n_present: 0, best: null });
    expect(ghostOf(evs, 60 * S)).toBeUndefined();
  });
});

describe("F11: the page-name stream merges into the present doctor it names; otherwise it is the occupant only when alone and never counts as a doctor", () => {
  const SAME = `${PAGE} Fakelast`; // a doctor whose first name IS the page greeting
  const OTHER = "Otherfirst Fakelast";
  const dbFor = (events: PresenceEvent[]) =>
    fakeDb((q) => {
      if (/room_install/.test(q.text)) return [{ hostname: M, room_id: "room_6", slug: "opd-6" }];
      if (/FROM eta_encounter_windows/.test(q.text)) return [];
      if (/source = 'poller'/.test(q.text)) return events.filter((e) => e.source === "poller").map((e) => ({ machine: e.machine, ts: e.ts, idle_s: e.idle_s }));
      if (/pulse_presence_events/.test(q.text)) return events.filter((e) => e.source !== "poller");
      return [];
    });
  // A present, then B signs in, then A's cookie goes stale (page greeting PAGE): A is demoted to the page-name stream; B stays. Both profiles stay focused.
  const both = (bdn: string): PresenceEvent[] => [
    poll(-5 * S, 2), login(0), login(10 * S, UB, bdn, { focus: true }), hb(20 * S, UB), stale(42 * S, { cookie_uid: UA, page: PAGE }), sx("heartbeat", 50 * S), hb(55 * S, UB),
  ];

  it("firstNameOf / pageNamesDoctor: case-insensitive, NFC, a leading honorific is skipped, the WHOLE page_name must equal the first name", () => {
    expect(firstNameOf(`${PAGE} Fakelast`)).toBe(PAGE.toLowerCase());
    expect(firstNameOf(["Dr", PAGE, "Fakelast"].join(" "))).toBe(PAGE.toLowerCase());
    expect(firstNameOf(["Prof.", PAGE].join(" "))).toBe(PAGE.toLowerCase());
    expect(firstNameOf("   ")).toBe("");
    expect(firstNameOf(null)).toBe("");
    expect(pageNamesDoctor(PAGE.toUpperCase(), SAME)).toBe(true);
    expect(pageNamesDoctor(PAGE, ["Dr", PAGE.toUpperCase(), "Fakelast"].join(" "))).toBe(true);
    expect(pageNamesDoctor(`${PAGE} x`, SAME)).toBe(false);
    expect(pageNamesDoctor(PAGE.slice(0, 3), SAME)).toBe(false);
    expect(pageNamesDoctor(null, SAME)).toBe(false);
    expect(pageNamesDoctor("", SAME)).toBe(false);
    const composed = "Zoë";
    const decomposed = "Zoë";
    expect(composed.length).not.toBe(decomposed.length); // different code points, same text once NFC-normalised
    expect(pageNamesDoctor(decomposed, `${composed} Fakelast`)).toBe(true);
    expect(pageNamesDoctor(composed.toUpperCase(), `${decomposed} Fakelast`)).toBe(true);
  });

  it("MERGE: the page greeting is the first name of the present doctor B -> one doctor: n_present 1, B is the occupant, not ambiguous, no extra stale occupant", () => {
    const evs = both(SAME);
    expect(ghostOf(evs, 60 * S)).toMatchObject({ present: true, page_name: PAGE }); // the stream itself still exists in the stream resolver
    const o = occ(evs, 60 * S);
    expect(o).toMatchObject({ n_present: 1, ambiguous: false, best: { uid: UB, dn: SAME } });
    expect(o.stale).toBeUndefined();
    expect(computeWindows([...evs, ext("encounter_open", 70 * S, { enc: "E11", uid: null }), ext("encounter_close", 120 * S, { enc: "E11", uid: null })])[0]).toMatchObject({ attribution: "occupant", doctor_uid: UB, quality: "clean" });
  });

  it("MERGE with an honorific and other case in the doctor's display name still merges", () => {
    const o = occ(both(["Dr", PAGE.toUpperCase(), "Fakelast"].join(" ")), 60 * S);
    expect(o).toMatchObject({ n_present: 1, ambiguous: false, best: { uid: UB } });
    expect(o.stale).toBeUndefined();
  });

  it("NO MERGE: another doctor is present -> the page-name stream is out of n_present (1, not 2) and out of the AMBIGUOUS check (two focused profiles no longer tie); B is the occupant and the stream is surfaced beside him", () => {
    const evs = both(OTHER);
    expect(ghostOf(evs, 60 * S)).toMatchObject({ present: true, last_focus_flag: true });
    const o = occ(evs, 60 * S);
    expect(o).toMatchObject({ n_present: 1, ambiguous: false, rule: "single", best: { uid: UB, dn: OTHER } });
    expect(o.stale).toEqual({ uid: null, dn: PAGE, stale_cookie: true, page_name: PAGE, cookie_name: A.full_name });
    // the window beside it is not multi_doctor
    const w = computeWindows([...evs, ext("encounter_open", 70 * S, { enc: "E12", uid: null }), ext("encounter_close", 120 * S, { enc: "E12", uid: null })])[0];
    expect(w).toMatchObject({ attribution: "occupant", doctor_uid: UB, quality: "clean" });
  });

  it("ALONE: the page-name stream is the shown occupant (best), n_present 0, and the machine is still occupied", async () => {
    const evs = [poll(-30 * S, 13_324), stale(0), login(0), ext("idle", 0, { uid: UA, focus: true }), sx("active", 3 * MIN)];
    const o = occ(evs, 3 * MIN + 1 * S);
    expect(o).toMatchObject({ n_present: 0, rule: "single", ambiguous: false });
    expect(o.best).toEqual({ uid: null, dn: PAGE, stale_cookie: true, page_name: PAGE, cookie_name: A.full_name });
    expect(o.stale).toMatchObject({ page_name: PAGE });
    const rows = await machineOccupancy(dbFor(evs), T0 + 3 * MIN + 1 * S);
    expect(rows.find((r) => r.machine === M)).toMatchObject({ occupied: true, cookie_uid: null, stale_occupant: { page_name: PAGE, label: `page: ${PAGE} (cookie ${A.full_name} stale)` } });
  });

  it("machineOccupancy: a real occupant with an unmerged stream beside him -> occupied, cookie = B, stale_occupant = the page-name stream; merged -> no stale_occupant", async () => {
    const beside = (await machineOccupancy(dbFor(both(OTHER)), T0 + 60 * S)).find((r) => r.machine === M)!;
    expect(beside).toMatchObject({ occupied: true, ambiguous: false, cookie_uid: UB, stale_occupant: { page_name: PAGE } });
    const merged = (await machineOccupancy(dbFor(both(SAME)), T0 + 60 * S)).find((r) => r.machine === M)!;
    expect(merged).toMatchObject({ occupied: true, ambiguous: false, cookie_uid: UB, stale_occupant: null });
  });
});

describe("a doctor who is ALREADY present is unaffected by a spurious login", () => {
  const present = (): PresenceEvent[] => {
    const evs: PresenceEvent[] = [poll(-40 * MIN, 5), login(-30 * MIN)];
    for (let m = -29; m <= 10; m++) evs.push(hb(m * MIN));
    return evs;
  };

  it("a login with a 13,324 s poller reading, mid-consult, leaves the doctor present with no gap and nothing pending", () => {
    const evs = [...present(), poll(2 * MIN - 20 * S, 13_324), login(2 * MIN), poll(2 * MIN + 30 * S, 13_384)];
    for (let off = 2 * MIN - 10 * S; off <= 4 * MIN; off += 10 * S) {
      const o = occ(evs, off);
      expect(o, `present at +${off / S}s`).toMatchObject({ n_present: 1, best: { uid: UA } });
      expect(o.pending).toBeUndefined();
    }
  });

  it("the ignored login does not extend presence either: it is not genuine activity", () => {
    // the doctor's last real activity is the focused heartbeat at -1 min; a spurious login at +40 min (still inside their 45) must not refresh that clock
    const evs = [...present().filter((e) => (e.event !== "heartbeat" ? true : Date.parse(String(e.ts)) <= T0 - 1 * MIN)), poll(40 * MIN - 20 * S, 13_324), login(40 * MIN)];
    expect(occ(evs, 40 * MIN + 1 * S)).toMatchObject({ n_present: 1, best: { uid: UA } });
    expect(occ(evs, 40 * MIN + 1 * S).pending).toBeUndefined();
    expect(occ(evs, 46 * MIN)).toMatchObject({ n_present: 0 }); // 47 min after the last real activity; had the login counted, they would still be present
    expect(streamOf(evs, 46 * MIN)).toMatchObject({ out_reason: "idle_timeout", last_genuine_ts: T0 - 1 * MIN });
  });

  it("a genuine re-login (console busy) of a present doctor is processed normally", () => {
    const evs = [...present(), poll(2 * MIN - 20 * S, 3), login(2 * MIN)];
    expect(streamOf(evs, 2 * MIN + 1 * S)).toMatchObject({ present: true, last_genuine_ts: T0 + 2 * MIN });
  });

  it("another doctor's pending login does not disturb the present doctor, and is shown beside them", () => {
    const evs = [...present(), poll(2 * MIN - 20 * S, 13_324), login(2 * MIN, UB, B.full_name)];
    expect(occ(evs, 3 * MIN)).toMatchObject({ n_present: 1, best: { uid: UA }, pending: { display_name: B.full_name, reason: "no_console_activity" } });
  });
});

describe("the poller rows fetchEvents joins to the logins (F2) and the numbers of the rule", () => {
  it("pollerRowsNearLogins keeps poller rows only within 5 min before to 50 min after an ext login on the same Mac, and only with an idle_s", () => {
    const es: PresenceEvent[] = [
      login(0),
      hb(1 * S), // an ext row that is not a login
    ];
    const pl: PresenceEvent[] = [
      poll(-6 * MIN, 1), poll(-5 * MIN, 2), poll(0, 3), poll(50 * MIN, 4), poll(50 * MIN + 1 * S, 5),
      poll(10 * MIN, null), poll(10 * MIN, 7, { machine: "EHRC-OPD7s-Mac-mini" }),
      poll(10 * MIN, 9, { machine: "opd6" }), // an unknown short key is not this Mac
    ];
    expect(pollerRowsNearLogins(es, pl).map((e) => e.idle_s)).toEqual([2, 3, 4]);
    expect(pollerRowsNearLogins([hb(0)], [poll(0, 1)])).toEqual([]); // no login on the machine: no poller rows
  });

  it("pollerRowsNearLogins maps a pre-5-Oct short poller key onto the login's Mac", () => {
    const C = "EHRC-CONSUL4s-Mac-mini";
    const es: PresenceEvent[] = [{ id: nextId++, source: "ext", machine: C, event: "login", ts: at(0), uid: UA }];
    const near = pollerRowsNearLogins(es, [poll(10 * S, 5, { machine: "consul4" }), poll(10 * S, 6, { machine: C }), poll(10 * S, 7, { machine: "consul5" })]);
    expect(near.map((e) => e.idle_s)).toEqual([5, 6]);
  });

  it("the rule's numbers", () => {
    expect(LOGIN_RULE).toEqual({ staleWithinMs: 10_000, pollWithinMs: 5 * MIN, consoleIdleMaxS: 600, resetWindowMs: 45 * MIN, resetSlackS: 5 });
  });

  it("resolveStreamsDetailed returns the same streams as resolveStreams", () => {
    const evs = norm([poll(-30 * S, 13_324), login(0), login(60 * S, UB, B.full_name, { focus: true })]);
    expect(resolveStreamsDetailed(evs, T0 + 2 * MIN).streams).toEqual(resolveStreams(evs, T0 + 2 * MIN));
  });
});

type Q = { text: string; vals: unknown[] };
const fakeDb = (responder: (q: Q) => unknown): WindowsDb =>
  ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q: Q = { text: strings.join("?"), vals };
    return Object.assign(q, { then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(responder(q)).then(res, rej) });
  }) as unknown as WindowsDb;

describe("F2: fetchEvents reads the poller in ONE bounded query, only when an ext login was read, and joins in TypeScript", () => {
  it("no ext login -> exactly the one query it always issued", async () => {
    const seen: Q[] = [];
    const db = fakeDb((q) => (seen.push(q), [hb(0)]));
    const rows = await fetchEvents(db, new Date(T0), new Date(T0 + 10 * MIN));
    expect(seen).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("an ext login -> ONE more query: per-login (machine, lo, hi) windows joined to the poller rows by bound arrays, idle_s present; projects machine, ts, idle_s", async () => {
    const seen: Q[] = [];
    const extRows = [login(0), hb(1 * S)];
    const pollRows = [
      { machine: M, ts: at(-1 * MIN), idle_s: "13324" },
      { machine: M, ts: at(-30 * MIN), idle_s: "5" }, // outside the 5 min before: dropped by the TS join
      { machine: "opd6-unknown", ts: at(0), idle_s: "7" },
    ];
    const db = fakeDb((q) => (seen.push(q), /source = 'poller'/.test(q.text) ? pollRows : extRows));
    const rows = await fetchEvents(db, new Date(T0 - 5 * MIN), new Date(T0 + 10 * MIN));
    expect(seen).toHaveLength(2);
    const pq = seen[1]!;
    expect(pq.text).toMatch(/unnest\(\?::text\[\], \?::timestamptz\[\], \?::timestamptz\[\]\)/);
    expect(pq.text).toMatch(/JOIN LATERAL \(/);
    expect(pq.text).toMatch(/e\.machine = w\.machine AND e\.ts BETWEEN w\.lo AND w\.hi/);
    expect(pq.text).toMatch(/e\.source = 'poller'/);
    expect(pq.text).toMatch(/e\.payload \? 'idle_s'/);
    expect(pq.text).toMatch(/SELECT e\.machine, e\.ts, e\.payload->>'idle_s' AS idle_s/);
    // bound parameters: ONE window for the login — key (canonical spelling), login - 5 min, login + 50 min — never interpolated
    expect(pq.vals).toEqual([[M], [new Date(T0 - 5 * MIN).toISOString()], [new Date(T0 + 50 * MIN).toISOString()]]);
    const polls = rows.filter((r) => r.source === "poller");
    expect(polls.map((r) => r.idle_s)).toEqual(["13324"]);
    expect(rows.map((r) => r.event)).toEqual(["ok", "login", "heartbeat"]); // merged in ts order: the poller row first
  });

  it("F10: one window per login — overlapping windows of a Mac merge, a far-apart login gets its own, another Mac its own, a pre-5-Oct short key its own rows", async () => {
    const C4 = "EHRC-CONSUL4s-Mac-mini";
    const seen: Q[] = [];
    const lg = (machine: string, off: number): PresenceEvent => ({ id: nextId++, source: "ext", machine, event: "login", ts: at(off), uid: UA, dn: A.full_name, focus: true });
    const extRows = [lg(M, 0), lg(M, 10 * MIN), lg(M, 3 * 60 * MIN), lg(C4, 20 * MIN)];
    const db = fakeDb((q) => (seen.push(q), /source = 'poller'/.test(q.text) ? [] : extRows));
    await fetchEvents(db, new Date(T0 - 5 * MIN), new Date(T0 + 4 * 60 * MIN));
    const [machines, los, his] = seen[1]!.vals as [string[], string[], string[]];
    const wins = machines.map((m, k) => `${m} ${los[k]} ${his[k]}`).sort();
    const w = (m: string, lo: number, hi: number) => `${m} ${new Date(T0 + lo).toISOString()} ${new Date(T0 + hi).toISOString()}`;
    expect(wins).toEqual([
      w(M, -5 * MIN, 60 * MIN), // logins at 0 and +10 min: one merged window
      w(M, 3 * 60 * MIN - 5 * MIN, 3 * 60 * MIN + 50 * MIN),
      w(C4, 15 * MIN, 70 * MIN),
      w("consul4", 15 * MIN, 70 * MIN),
    ].sort());
    expect(machines.length).toBe(los.length);
    expect(machines.length).toBe(his.length);
  });

  const lgm = (machine: string, off: number): PresenceEvent => ({ id: nextId++, source: "ext", machine, event: "login", ts: at(off), uid: UA, dn: A.full_name, focus: true });
  const windowsOf = (q: Q): string[] => {
    const [machines, los, his] = q.vals as [string[], string[], string[]];
    return machines.map((m, k) => `${m} ${los[k]} ${his[k]}`);
  };

  it("F12: MAX_LOGIN_WINDOWS is 400; 120 logins over 4 days all fit ONE query and every login gets its window", async () => {
    expect(MAX_LOGIN_WINDOWS).toBe(400);
    const seen: Q[] = [];
    // 120 logins, 30 a day for 4 days (2 h apart: no overlap), the oldest first
    const logins = Array.from({ length: 120 }, (_, k) => lgm(M, -(Math.floor(k / 30) * 24 * 60 + (k % 30) * 40) * MIN));
    const db = fakeDb((q) => (seen.push(q), /source = 'poller'/.test(q.text) ? [] : logins));
    await fetchEvents(db, new Date(T0 - 5 * 24 * 60 * MIN), new Date(T0 + 10 * MIN));
    expect(seen).toHaveLength(2);
    const have = new Set(windowsOf(seen[1]!));
    for (const l of logins) {
      const t = new Date(l.ts as string).getTime();
      const covered = [...have].some((w) => { const [, lo, hi] = w.split(" "); return new Date(lo!).getTime() <= t - 5 * MIN && new Date(hi!).getTime() >= Math.min(t + 50 * MIN, T0 + 10 * MIN + 2 * 60 * MIN) - 0; });
      expect(covered, `login at ${l.ts}`).toBe(true);
    }
  });

  it("F12: more than 400 windows split the read by IST day — every login keeps a window; a day over the cap splits again", async () => {
    const seen: Q[] = [];
    // 900 logins on 4 days: 100 Macs x 9 logins, 2 h apart (no overlap), so 225 windows a day
    const logins: PresenceEvent[] = [];
    for (let d = 0; d < 4; d += 1) for (let k = 0; k < 225; k += 1) logins.push(lgm(`EHRC-X${k % 100}s-Mac-mini`, -(d * 24 * 60 + 60 + Math.floor(k / 100) * 120 + 1) * MIN));
    const db = fakeDb((q) => (seen.push(q), /source = 'poller'/.test(q.text) ? [] : logins));
    await fetchEvents(db, new Date(T0 - 5 * 24 * 60 * MIN), new Date(T0 + 10 * MIN));
    const pq = seen.slice(1);
    expect(pq.length).toBeGreaterThanOrEqual(4);
    const all = pq.flatMap(windowsOf);
    expect(all.length).toBe(900); // one window per login, none dropped, none repeated
    expect(new Set(all).size).toBe(900);
    for (const q of pq) expect((q.vals[0] as string[]).length).toBeLessThanOrEqual(MAX_LOGIN_WINDOWS);
    // the chunks do not mix IST days: each chunk's window starts fall in one IST day
    const IST = 19_800_000;
    for (const q of pq) expect(new Set((q.vals[1] as string[]).map((x) => Math.floor((new Date(x).getTime() + IST) / 86_400_000))).size).toBe(1);
  });

  it("F12: chunkPollerWindows — at most the cap in one query, a lone day over the cap splits at the cap, order is by day", () => {
    const w = (machine: string, lo: number) => ({ machine, lo: T0 + lo, hi: T0 + lo + 55 * MIN });
    expect(chunkPollerWindows([])).toEqual([]);
    const few = Array.from({ length: 400 }, (_, k) => w(`m${k}`, -k * MIN));
    expect(chunkPollerWindows(few)).toHaveLength(1);
    const oneDay = Array.from({ length: 1000 }, (_, k) => w(`m${k}`, -3 * 60 * MIN)); // 1000 windows, one IST day
    expect(chunkPollerWindows(oneDay).map((c) => c.length)).toEqual([400, 400, 200]);
    const twoDays = [...Array.from({ length: 300 }, (_, k) => w(`n${k}`, -30 * 60 * MIN)), ...Array.from({ length: 300 }, (_, k) => w(`p${k}`, -2 * 60 * MIN))];
    const ch = chunkPollerWindows(twoDays);
    expect(ch.map((c) => c.length)).toEqual([300, 300]);
    expect(ch[0]![0]!.machine).toBe("n0"); // the older day first
  });

  it("F12: loginPollerWindows merges overlapping windows of one Mac, keeps far-apart ones, adds the legacy short key", () => {
    const C4 = "EHRC-CONSUL4s-Mac-mini";
    const ws = loginPollerWindows([lgm(M, 0), lgm(M, 10 * MIN), lgm(M, 3 * 60 * MIN), lgm(C4, 20 * MIN)], T0 + 5 * 60 * MIN);
    expect(ws.map((x) => `${x.machine} ${x.lo - T0} ${x.hi - T0}`).sort()).toEqual(
      [`${M} ${-5 * MIN} ${60 * MIN}`, `${M} ${175 * MIN} ${230 * MIN}`, `${C4} ${15 * MIN} ${70 * MIN}`, `consul4 ${15 * MIN} ${70 * MIN}`].sort(),
    );
  });

  it("the windows' upper bounds never pass the read end", async () => {
    const seen: Q[] = [];
    const db = fakeDb((q) => (seen.push(q), /source = 'poller'/.test(q.text) ? [] : [login(0)]));
    await fetchEvents(db, new Date(T0 - 5 * MIN), new Date(T0 + 10 * MIN));
    for (const h of seen[1]!.vals[2] as string[]) expect(new Date(h).getTime()).toBeLessThanOrEqual(T0 + 10 * MIN + 2 * 60 * MIN);
  });
});

describe("machineOccupancy (the ?occupancy=1 API row) carries `pending` and `stale_occupant`", () => {
  const dbWith = (events: PresenceEvent[]) =>
    fakeDb((q) => {
      if (/room_install/.test(q.text)) return [{ hostname: M, room_id: "room_6", slug: "opd-6" }];
      if (/FROM eta_encounter_windows/.test(q.text)) return [];
      if (/source = 'poller'/.test(q.text)) return events.filter((e) => e.source === "poller").map((e) => ({ machine: e.machine, ts: e.ts, idle_s: e.idle_s }));
      if (/pulse_presence_events/.test(q.text)) return events.filter((e) => e.source !== "poller");
      return [];
    });

  it("a pending login: occupied false, no cookie occupant, pending {display_name, since, reason}; occupant_display unchanged (null: no identity is present)", async () => {
    const evs = [poll(-30 * S, 13_324), stale(0), login(0), ext("idle", 0, { uid: UA, focus: true }), hb(30 * S)];
    const [m] = await machineOccupancy(dbWith(evs), T0 + 2 * MIN);
    expect(m).toMatchObject({ machine: M, room_id: "room_6", occupied: false, cookie_uid: null, stale_occupant: null, occupant_display: null });
    expect(m!.pending).toEqual({ display_name: A.full_name, since: at(0), reason: "identity_stale" });
    expect(JSON.parse(JSON.stringify(m!.pending))).toEqual(m!.pending); // plain JSON for the API
  });

  it("promoted -> occupied, pending null; a Mac with only poller rows is not a machine row; no login rule in play -> pending null", async () => {
    const promoted = [poll(-30 * S, 13_324), login(0), ext("active", 3 * MIN, { uid: UA, focus: true })];
    const [m] = await machineOccupancy(dbWith(promoted), T0 + 4 * MIN);
    expect(m).toMatchObject({ occupied: true, cookie_uid: UA, pending: null, stale_occupant: null });
    const rows = await machineOccupancy(dbWith([...promoted, poll(0, 5, { machine: "EHRC-ONLYPOLLERs-Mac-mini" })]), T0 + 4 * MIN);
    expect(rows.map((r) => r.machine)).toEqual([M]);
    const [plain] = await machineOccupancy(dbWith([login(0), hb(30 * S)]), T0 + 1 * MIN);
    expect(plain).toMatchObject({ occupied: true, pending: null });
  });

  it("F1: a promoted identity_stale session shows 'page: <page_name> (cookie <name> stale)' — the cookie doctor is never cookie_uid/cookie_name or the display occupant", async () => {
    const evs = [poll(-30 * S, 13_324), stale(0), login(0), ext("idle", 0, { uid: UA, focus: true }), sx("active", 3 * MIN)];
    const [m] = await machineOccupancy(dbWith(evs), T0 + 4 * MIN);
    expect(m).toMatchObject({ occupied: true, cookie_uid: null, cookie_name: null, occupant_display: null, pending: null });
    expect(m!.stale_occupant).toEqual({ page_name: PAGE, cookie_name: A.full_name, label: `page: ${PAGE} (cookie ${A.full_name} stale)` });
  });

  it("F1: the same with no page_name reads 'unknown (stale cookie)'", async () => {
    const evs = [poll(-30 * S, 13_324), stale(0, { page: null }), login(0), sx("active", 3 * MIN)];
    const [m] = await machineOccupancy(dbWith(evs), T0 + 4 * MIN);
    expect(m!.stale_occupant).toMatchObject({ page_name: null, label: "unknown (stale cookie)" });
    expect(m!.cookie_uid).toBeNull();
  });
});
