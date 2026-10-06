/**
 * The LOGIN RULE in tools/pulse-watch/occupancy.mjs (the SQL resolver V runs from his MacBook Air) AGAINST A REAL POSTGRES, in lockstep with the
 * TypeScript resolver (lib/encounter-windows/occupancy.ts) that the encounter-window cron uses. See tests/unit/occupancy-login-rule.test.ts for the rule.
 *
 * Each scenario is one machine with its own clock: the same extension + poller rows are loaded into pulse_presence_events, resolveMachines() runs through
 * the s1-pg harness (values BOUND as untyped $n, each once, like the Neon driver), and the TypeScript resolver reads the same rows in memory. Per machine
 * the PRESENT streams (a doctor's uid, or `stale:<page>` for the stale-cookie stream) and the PENDING session must agree, and both must equal the stated
 * expectation (so lockstep cannot hide a shared mistake). Needs Docker (postgres:16); ETA_ALLOW_SKIP_E2E=1 accepts that it was not proven.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";
import { byTimeThenId, normalizeEvent, occupancyAt, resolveStreamsDetailed, firstNameOf, pageNamesDoctor, type NEvent } from "@/lib/encounter-windows/occupancy";
import { staleOccupantLabel } from "@/lib/encounter-windows/occupant";
import type { PresenceEvent } from "@/lib/encounter-windows/types";
// the tool under test (plain ESM, no types)
// @ts-ignore TS7016: no declaration file for the .mjs
import { resolveMachines, pendingLabel, staleOccupantLabel as mjsStaleLabel, firstNameOf as mjsFirstName, pageNamesDoctor as mjsPageNames, pollWindows, chunkWindows, MAX_LOGIN_WINDOWS } from "../../tools/pulse-watch/occupancy.mjs";

const A = makeFakeClinician(1);
const B = makeFakeClinician(2);
const UA = A.id;
const UB = B.id;
const PAGE = "Fakefirst";
const ASOF = Date.parse("2026-10-05T16:30:00Z"); // 22:00 IST
const S = 1000;
const MIN = 60_000;
const HOUR = 60 * MIN;

type Row = { source: "ext" | "poller"; event: string; off: number; machine?: string; payload: Record<string, unknown> };
type Scenario = {
  name: string; asOfOff: number; rows: Row[];
  /** the present streams (doctor uid, or stale:<page>) and the pending session the rule must produce */
  present: string[]; pending: { display_name: string | null; since: number; reason: string } | null;
  /** the stale-cookie occupant label the machine row must show (default: none) */
  staleLabel?: string;
  /** F11, the machine row: counted doctors, the ambiguity flag and the occupant (a doctor's uid, `stale:<page>` for the page-name stream, or null) — both resolvers must give it */
  occ?: { n: number; ambiguous: boolean; best: string | null };
};
const login = (off: number, uid = UA, dn = A.full_name): Row => ({ source: "ext", event: "login", off, payload: { doctor_uid: uid, display_name: dn, tab_focus: true } });
const hb = (off: number, uid = UA): Row => ({ source: "ext", event: "heartbeat", off, payload: { doctor_uid: uid, tab_focus: true } });
const idle = (off: number, uid = UA): Row => ({ source: "ext", event: "idle", off, payload: { doctor_uid: uid, tab_focus: true } });
const active = (off: number, uid: string | null = UA): Row => ({ source: "ext", event: "active", off, payload: { doctor_uid: uid, tab_focus: true } });
const stale = (off: number, page: string | null = PAGE): Row => ({ source: "ext", event: "identity_stale", off, payload: { reason: "stale_cookie", cookie_uid: UA, page_name: page, tab_focus: true } });
/** an event of the stale-cookie profile: doctor_uid null, reason stale_cookie */
const sx = (event: string, off: number): Row => ({ source: "ext", event, off, payload: { doctor_uid: null, reason: "stale_cookie", tab_focus: true } });
const logout = (off: number, uid = UA): Row => ({ source: "ext", event: "logout", off, payload: { doctor_uid: uid, tab_focus: false } });
const poll = (off: number, idle_s: number, machine?: string): Row => ({ source: "poller", event: "ok", off, ...(machine ? { machine } : {}), payload: { idle_s, locked: false } });
const enc = (event: "encounter_open" | "encounter_close", off: number): Row => ({ source: "ext", event, off, payload: { encounter_id: "E1", tab_focus: true } });
const hbs = (from: number, to: number, step = MIN, uid = UA): Row[] => { const r: Row[] = []; for (let o = from; o <= to; o += step) r.push(hb(o, uid)); return r; };
const pend = (since: number, reason: string, dn = A.full_name) => ({ display_name: dn, since, reason });
const GHOST = `stale:${PAGE}`;
const GHOST_LABEL = `page: ${PAGE} (cookie ${A.full_name} stale)`;
const SAMEFIRST = `${PAGE} Fakelast`; // a doctor whose first name is the page greeting
const OTHERFIRST = "Otherfirst Fakelast";

const scenarios: Scenario[] = [
  { name: "SC1 OPD 6: login+idle+identity_stale in one second, poller idle 13,324", asOfOff: 20 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), poll(30 * S, 13_384), hb(30 * S), hb(5 * MIN), hb(19 * MIN)],
    present: [], pending: pend(0, "identity_stale") },
  { name: "SC2 no identity_stale, poller idle 13,324", asOfOff: 10 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), hb(30 * S), hb(5 * MIN)],
    present: [], pending: pend(0, "no_console_activity") },
  { name: "SC3 OPD 5 20:36: login with poller idle 0", asOfOff: 2 * MIN,
    rows: [poll(-20 * S, 0), login(0), hb(30 * S)], present: [UA], pending: null },
  { name: "SC4 login with no poller data at all", asOfOff: 2 * MIN, rows: [login(0), hb(30 * S)], present: [UA], pending: null },
  { name: "SC5 pending promoted by `active` at +3 min", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), active(3 * MIN)], present: [UA], pending: null },
  { name: "SC6 `active` of an unnamed profile promotes", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), active(3 * MIN, null)], present: [UA], pending: null },
  { name: "SC7 pending promoted by a poller idle reset (Δ 120 s, idle 4)", asOfOff: 3 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), poll(60 * S, 13_384), poll(2 * MIN, 4)], present: [UA], pending: null },
  { name: "SC8 F3: not promoted, heartbeats keep coming: still pending at 50 min (no 45-min expiry)", asOfOff: 50 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), ...hbs(MIN, 49 * MIN)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC9 still pending at 40 min", asOfOff: 40 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), ...hbs(MIN, 39 * MIN)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC10 pending then logout, then active", asOfOff: 12 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), logout(5 * MIN), active(10 * MIN), hb(11 * MIN)], present: [], pending: null },
  { name: "SC11 a present doctor gets a spurious login (poller idle 13,324): stays present", asOfOff: 4 * MIN,
    rows: [poll(-40 * MIN, 5), login(-30 * MIN), ...hbs(-29 * MIN, 4 * MIN), poll(2 * MIN - 20 * S, 13_324), login(2 * MIN), poll(2 * MIN + 30 * S, 13_384)],
    present: [UA], pending: null },
  { name: "SC12 a new login with console activity replaces the pending one", asOfOff: 6 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), poll(5 * MIN - 10 * S, 400), login(5 * MIN, UB, B.full_name), hb(5 * MIN + 30 * S, UB)], present: [UB], pending: null },
  { name: "SC13 a new login without activity is the new pending session", asOfOff: 6 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), poll(5 * MIN - 10 * S, 13_900), login(5 * MIN, UB, B.full_name)], present: [], pending: pend(5 * MIN, "no_console_activity", B.full_name) },
  { name: "SC14 promoted by an encounter_open of an unnamed row", asOfOff: 11 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), enc("encounter_open", 10 * MIN)], present: [UA], pending: null },
  { name: "SC15 a failing login whose doctor was never seen: pending, machine still listed", asOfOff: 1 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0)], present: [], pending: pend(0, "no_console_activity") },
  // F1: the identity_stale session promotes to the PAGE's identity, never the cookie doctor
  { name: "SC16 F1 stale `active` promotes -> stale-cookie stream (page greeting, uid null), not the cookie doctor", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), sx("active", 3 * MIN)], present: [GHOST], pending: null, staleLabel: GHOST_LABEL, occ: { n: 0, ambiguous: false, best: GHOST } },
  { name: "SC17 F1 a real doctor B's `active` promotes the stale session: B is the occupant, A never", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), { source: "ext", event: "active", off: 3 * MIN, payload: { doctor_uid: UB, display_name: B.full_name, tab_focus: true } }],
    present: [UB], pending: null },
  { name: "SC18 F1 an OTP consult (encounter_open of an unnamed row) promotes: stale-cookie stream", asOfOff: 11 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), enc("encounter_open", 10 * MIN)], present: [GHOST], pending: null, staleLabel: GHOST_LABEL },
  { name: "SC19 F1 no page_name on the identity_stale event: 'unknown (stale cookie)'", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0, null), login(0), idle(0), sx("active", 3 * MIN)], present: ["stale:"], pending: null, staleLabel: "unknown (stale cookie)" },
  { name: "SC20 F1 a later login with a different identity replaces the stale-cookie stream", asOfOff: 10 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), sx("active", 3 * MIN), poll(8 * MIN - 5 * S, 3), login(8 * MIN, UB, B.full_name), hb(9 * MIN, UB)], present: [UB], pending: null },
  { name: "SC21 F3 an earlier logout in the lookback does not block a later promotion", asOfOff: 2 * HOUR + 5 * MIN,
    rows: [poll(-3 * HOUR, 2), login(-3 * HOUR), logout(-2 * HOUR), poll(-30 * S, 13_324), login(0), idle(0), active(2 * HOUR)], present: [UA], pending: null },
  { name: "SC22 F4 CONSUL7 fixture shape: polls -16 s 57,782, +45 s 47, +105 s 0 -> promoted at the +45 s poll", asOfOff: 3 * MIN,
    rows: [poll(-16 * S, 57_782), login(0), poll(45 * S, 47), poll(105 * S, 0)], present: [UA], pending: null },
  { name: "SC23 F4 the same fixture read 30 s after the login: still pending", asOfOff: 30 * S,
    rows: [poll(-16 * S, 57_782), login(0), poll(45 * S, 47), poll(105 * S, 0)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC24 F4 poller promotion only within 45 min: a reset at +46 min does not promote", asOfOff: 47 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), poll(44 * MIN, 13_324), poll(46 * MIN, 3)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC25 F4 boundary: Δ 60 s, idle 64 promotes", asOfOff: 2 * MIN, rows: [poll(-30 * S, 13_324), login(0), poll(60 * S, 64)], present: [UA], pending: null },
  { name: "SC26 F4 boundary: Δ 60 s, idle 65 does not", asOfOff: 2 * MIN, rows: [poll(-30 * S, 13_324), login(0), poll(60 * S, 65)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC27 F5 a poller row 200 s away with idle 0 counts as console activity", asOfOff: 2 * MIN, rows: [poll(-200 * S, 0), login(0), hb(30 * S)], present: [UA], pending: null },
  { name: "SC28 F5 a poller row 200 s away with idle 13,000 makes it pending", asOfOff: 2 * MIN, rows: [poll(-200 * S, 13_000), login(0), hb(30 * S)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC29 F5 a poller row 301 s away is no evidence: fail open", asOfOff: 2 * MIN, rows: [poll(-301 * S, 13_000), login(0), hb(30 * S)], present: [UA], pending: null },
  { name: "SC30 nightly cutoff discards a pending session (login 22:30 IST, read 22:00 IST next day)", asOfOff: 23 * HOUR + 30 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), hb(HOUR)], present: [], pending: null },
  { name: "SC31 F3 pending persists for 3 hours without promotion (still before the cutoff)", asOfOff: 3 * HOUR,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), ...hbs(HOUR, 3 * HOUR - MIN, HOUR)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC32 stale-cookie stream ages out 45 min after its last activity", asOfOff: 60 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), sx("active", 3 * MIN)], present: [], pending: null },
  { name: "SC33 stale-profile heartbeats keep the stale-cookie stream present", asOfOff: 60 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), sx("active", 3 * MIN), sx("heartbeat", 30 * MIN)], present: [GHOST], pending: null, staleLabel: GHOST_LABEL },
  { name: "SC34 a logout by the cookie uid ends the stale-cookie stream", asOfOff: 12 * MIN,
    rows: [poll(-30 * S, 13_324), stale(0), login(0), idle(0), sx("active", 3 * MIN), logout(10 * MIN)], present: [], pending: null },
  { name: "SC35 a no_console_activity session is promoted by a stale-profile `active` (the doctor himself)", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), sx("active", 3 * MIN)], present: [UA], pending: null },
  // F8: an identity_stale for a pending login's cookie uid — at ANY later time — turns it into the page-name stream; a present doctor's cookie going stale demotes him
  { name: "SC36 F8 CONSUL7 fixture: login pending, identity_stale +42 s, poll idle 47 at +45 s -> the page-name stream is present, never the cookie doctor", asOfOff: 3 * MIN,
    rows: [poll(-16 * S, 57_782), login(0), stale(42 * S), poll(45 * S, 47), poll(105 * S, 0)], present: [GHOST], pending: null, staleLabel: GHOST_LABEL },
  { name: "SC37 F8 the same fixture read at +44 s: pending, reason identity_stale (the stale arrived 42 s after the login)", asOfOff: 44 * S,
    rows: [poll(-16 * S, 57_782), login(0), stale(42 * S), poll(45 * S, 47), poll(105 * S, 0)], present: [], pending: pend(0, "identity_stale") },
  { name: "SC38 F8 identity_stale 3 h after the login, then the cookie uid's own `active`: page identity, a later cookie-uid heartbeat does not bring A back", asOfOff: 3 * HOUR + 3 * MIN,
    rows: [poll(-16 * S, 57_782), login(0), stale(3 * HOUR), poll(3 * HOUR + 3 * S, 47), active(3 * HOUR + 5 * S), hb(3 * HOUR + 2 * MIN)], present: [GHOST], pending: null, staleLabel: GHOST_LABEL },
  { name: "SC39 F8 the same, read before the promoting `active`: pending, reason identity_stale (a poll 3 h in promotes nothing)", asOfOff: 3 * HOUR + 4 * S,
    rows: [poll(-16 * S, 57_782), login(0), stale(3 * HOUR), poll(3 * HOUR + 3 * S, 47), active(3 * HOUR + 5 * S), hb(3 * HOUR + 2 * MIN)], present: [], pending: pend(0, "identity_stale") },
  { name: "SC40 F8 demotion: a PRESENT doctor's cookie goes stale -> the page-name stream from then on", asOfOff: 2 * MIN,
    rows: [poll(-5 * S, 2), login(0), hb(20 * S), stale(42 * S), hb(60 * S)], present: [GHOST], pending: null, staleLabel: GHOST_LABEL },
  { name: "SC41 F8 an identity_stale for ANOTHER cookie uid does not convert the pending login", asOfOff: 4 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), { source: "ext", event: "identity_stale", off: 30 * S, payload: { reason: "stale_cookie", cookie_uid: UB, page_name: PAGE, tab_focus: true } }, active(3 * MIN)],
    present: [UA], pending: null },
  { name: "SC42 F8 an identity_stale for a doctor already logged out creates nothing", asOfOff: 60 * S,
    rows: [poll(-5 * S, 2), login(0), logout(20 * S), stale(42 * S)], present: [], pending: null },
  // F9: another (or no) doctor's activity promotes only within 45 min of the login; the login's own doctor at any time
  { name: "SC43 F9 a null-uid `active` 3 h after the login promotes nothing", asOfOff: 3 * HOUR + MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), active(3 * HOUR, null)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC44 F9 the same-uid `active` 3 h after the login promotes", asOfOff: 3 * HOUR + MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), active(3 * HOUR, UA)], present: [UA], pending: null },
  { name: "SC45 F9 a null-uid `active` exactly 45 min after the login promotes", asOfOff: 46 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), active(45 * MIN, null)], present: [UA], pending: null },
  { name: "SC46 F9 a null-uid `active` 45 min + 1 s after the login does not", asOfOff: 46 * MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), active(45 * MIN + S, null)], present: [], pending: pend(0, "no_console_activity") },
  { name: "SC47 F9 a null-uid encounter_open 3 h after the login promotes nothing", asOfOff: 3 * HOUR + MIN,
    rows: [poll(-30 * S, 13_324), login(0), idle(0), enc("encounter_open", 3 * HOUR)], present: [], pending: pend(0, "no_console_activity") },
  // F11: A present, B signs in, A's cookie goes stale (page greeting PAGE) -> A is demoted to the page-name stream; B stays; both profiles focused
  { name: "SC48 F11 the page greeting is the first name of the present doctor B: merged — one counted doctor, B the occupant, not ambiguous, no stale occupant", asOfOff: 70 * S,
    rows: [poll(-5 * S, 2), login(0), login(10 * S, UB, SAMEFIRST), hb(20 * S, UB), stale(42 * S), sx("heartbeat", 50 * S), hb(55 * S, UB)],
    present: [GHOST, UB], pending: null, occ: { n: 1, ambiguous: false, best: UB } },
  { name: "SC49 F11 another doctor B is present: the page-name stream is out of the count and of the AMBIGUOUS check; B is the occupant, the stream is surfaced beside him", asOfOff: 70 * S,
    rows: [poll(-5 * S, 2), login(0), login(10 * S, UB, OTHERFIRST), hb(20 * S, UB), stale(42 * S), sx("heartbeat", 50 * S), hb(55 * S, UB)],
    present: [GHOST, UB], pending: null, staleLabel: GHOST_LABEL, occ: { n: 1, ambiguous: false, best: UB } },
  { name: "SC50 F11 the page-name stream ALONE is the occupant with no counted doctor", asOfOff: 70 * S,
    rows: [poll(-5 * S, 2), login(0), hb(20 * S), stale(42 * S), sx("heartbeat", 50 * S)],
    present: [GHOST], pending: null, staleLabel: GHOST_LABEL, occ: { n: 0, ambiguous: false, best: GHOST } },
];
const machineOf = (i: number) => `EHRC-SC${i + 1}s-Mac-mini`;
const baseOf = (sc: Scenario) => ASOF - sc.asOfOff;

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-occupancy-login-rule");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

type MRow = {
  machine: string; occupied: boolean; sessions: Array<{ uid: string; present: boolean }>;
  pending: { display_name: string | null; since: string; reason: string } | null; ext_alive: boolean; ambiguous: boolean;
  doctor_uid: string | null; display_name: string | null; stale_occupant: { page_name: string | null; cookie_name: string | null; label: string } | null;
};
let byMachine = new Map<string, MRow>();
const tsEvents: Map<string, PresenceEvent[]> = new Map();

beforeAll(async () => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
  `);
  for (const f of ["0122_pulse_presence_events", "0123_eta_encounter_windows", "0124_encounter_windows_warehouse_attribution"]) pg.exec(noRecord(`db/migrations/${f}.sql`));
  const q = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  const inserts: string[] = [];
  scenarios.forEach((sc, i) => {
    const m = machineOf(i);
    const evs: PresenceEvent[] = [];
    // insertion order = id order = the (ts, id) tie-break in both resolvers; ids are global, so number them as the table will
    for (const r of sc.rows) {
      const ts = new Date(baseOf(sc) + r.off).toISOString();
      const machine = r.machine ?? m;
      inserts.push(`INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('${r.source}', '${machine.replace(/'/g, "''")}', '${r.event}', '${ts}', ${q(r.payload)}::jsonb);`);
      const p = r.payload;
      evs.push({
        id: inserts.length, source: r.source, machine, event: r.event, ts,
        uid: (p.doctor_uid as string | null | undefined) ?? null, dn: (p.display_name as string | undefined) ?? null, enc: (p.encounter_id as string | undefined) ?? null,
        focus: p.tab_focus === true, reason: (p.reason as string | undefined) ?? null, page: (p.page_name as string | undefined) ?? null,
        cookie_uid: (p.cookie_uid as string | undefined) ?? null, idle_s: (p.idle_s as number | undefined) ?? null,
      });
    }
    tsEvents.set(m, evs);
  });
  pg.exec(inserts.join("\n"));
  // the tool calls sql.query(text, params); the harness is a tag, so split the text at its $n placeholders (each is used once, in order)
  const run = (text: string, params: unknown[]) => {
    const parts = text.split(/\$\d+/);
    return pg.sql(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
  };
  const sql = Object.assign((text: string, params: unknown[]) => run(text, params), { query: (text: string, params: unknown[]) => run(text, params) });
  const rows = (await resolveMachines(sql, { asOf: new Date(ASOF).toISOString() })) as MRow[];
  byMachine = new Map(rows.map((r) => [r.machine, r]));
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

describe("REQUIRED PROOF — the login rule in occupancy.mjs SQL against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("Docker is not available: the login rule in occupancy.mjs was NOT proven. Start Docker or set ETA_ALLOW_SKIP_E2E=1 to accept that.");
  });
});

describe.runIf(HAVE_DOCKER)("login rule — occupancy.mjs (SQL) in lockstep with lib/encounter-windows/occupancy.ts", () => {
  scenarios.forEach((sc, i) => {
    it(sc.name, () => {
      const m = machineOf(i);
      const row = byMachine.get(m);
      expect(row, `machine ${m} resolved`).toBeDefined();
      const sqlPresent = row!.sessions.filter((s) => s.present).map((s) => s.uid).sort();
      const sqlPending = row!.pending;
      // TypeScript on the same rows
      const evs = (tsEvents.get(m) ?? []).map(normalizeEvent).filter((x): x is NEvent => x !== null && x.machine === m).sort(byTimeThenId);
      const ts = resolveStreamsDetailed(evs, ASOF);
      const tsPresent = ts.streams.filter((s) => s.present).map((s) => s.uid ?? `stale:${s.page_name ?? ""}`).sort();
      const want = sc.pending ? { display_name: sc.pending.display_name, since: new Date(baseOf(sc) + sc.pending.since).toISOString(), reason: sc.pending.reason } : null;
      expect(sqlPresent, "SQL present").toEqual([...sc.present].sort());
      expect(tsPresent, "TS present").toEqual([...sc.present].sort());
      expect(sqlPending, "SQL pending").toEqual(want);
      expect(ts.pending, "TS pending").toEqual(want);
      expect(row!.occupied).toBe(sc.present.length > 0);
      // the stale-cookie occupant (page identity, never the cookie doctor): same label from both resolvers; doctor_uid/display_name null whenever it is shown
      const best = occupancyAt(evs, ASOF).best;
      const tsLabel = best?.stale_cookie ? staleOccupantLabel(best) : null;
      const tsOcc = occupancyAt(evs, ASOF);
      const tsStale = tsOcc.stale ? staleOccupantLabel(tsOcc.stale) : null; // the page-name stream, as the occupant or beside the real one
      expect(tsStale, "TS stale label").toBe(sc.staleLabel ?? null);
      expect(tsLabel === null || tsLabel === tsStale, "TS best stale label is the stale stream").toBe(true);
      expect(row!.stale_occupant?.label ?? null, "SQL stale label").toBe(sc.staleLabel ?? null);
      if (sc.staleLabel && !sc.occ) expect(row!.doctor_uid).toBeNull();
      if (sc.occ) {
        const ofBest = (b: { uid: string | null; page_name?: string | null; stale_cookie?: true } | null) => (b ? (b.stale_cookie ? `stale:${b.page_name ?? ""}` : b.uid) : null);
        expect(tsOcc.n_present, "TS n_present").toBe(sc.occ.n);
        expect(tsOcc.ambiguous, "TS ambiguous").toBe(sc.occ.ambiguous);
        expect(ofBest(tsOcc.best), "TS occupant").toBe(sc.occ.best);
        expect(row!.ambiguous, "SQL ambiguous").toBe(sc.occ.ambiguous);
        expect(row!.doctor_uid ?? (row!.stale_occupant && sc.occ.best?.startsWith("stale:") ? sc.occ.best : null), "SQL occupant").toBe(sc.occ.best);
        expect(row!.occupied, "SQL occupied").toBe(sc.occ.best !== null);
        expect(row!.sessions.filter((x) => x.present && !x.uid.startsWith("stale:")).length, "SQL doctors present").toBeGreaterThanOrEqual(sc.occ.n);
      }
    });
  });

  it("the machine's own signals ignore the login rule: an ignored heartbeat still shows the extension alive (ext_alive) on a pending machine", () => {
    // SC15's last extension row is the idle at +0 and asOf is +1 min: alive (<= 180 s) even though its login row is ignored
    expect(byMachine.get(machineOf(14))!.ext_alive).toBe(true);
  });

  it("pendingLabel and staleOccupantLabel render the grey lines", () => {
    expect(pendingLabel(byMachine.get(machineOf(0))!.pending)).toBe(`session: ${A.full_name} (pending, no console activity)`);
    expect(pendingLabel(null)).toBe("");
    expect(mjsStaleLabel({ page_name: PAGE, cookie_name: A.full_name })).toBe(GHOST_LABEL);
    expect(mjsStaleLabel({ page_name: null, cookie_name: A.full_name })).toBe("unknown (stale cookie)");
    expect(mjsStaleLabel(null)).toBe("");
  });
});

describe("F11/F12 helpers of occupancy.mjs agree with the TypeScript ones", () => {
  it("firstNameOf / pageNamesDoctor give the TypeScript answers on the same inputs (case, NFC, honorific, whole page_name)", () => {
    const names = [`${PAGE} Fakelast`, ["Dr", PAGE.toUpperCase(), "Fakelast"].join(" "), ["Prof.", PAGE].join(" "), "   ", "", null, "Zoë Fakelast", "Zoë Fakelast"];
    for (const n of names) expect(mjsFirstName(n), String(n)).toBe(firstNameOf(n));
    const pages = [PAGE, PAGE.toUpperCase(), `${PAGE} x`, PAGE.slice(0, 3), null, "", "Zoë", "Zoë"];
    for (const p of pages) for (const n of names) expect(mjsPageNames(p, n), `${p} / ${n}`).toBe(pageNamesDoctor(p, n));
  });

  it("F12: pollWindows gives EVERY login a window (no cap), merged per Mac; chunkWindows splits only above 400, by IST day, then at the cap", () => {
    expect(MAX_LOGIN_WINDOWS).toBe(400);
    const T = Date.parse("2026-10-05T10:00:00Z");
    // 120 logins over 4 days, 30 a day, 2 h apart: 120 windows
    const by = new Map<string, number[]>([["EHRC-OPD6s-Mac-mini", Array.from({ length: 120 }, (_, k) => T - Math.floor(k / 30) * 24 * HOUR - (k % 30) * 2 * HOUR / 2)]]);
    const ws = pollWindows(by, T + HOUR) as Array<{ machine: string; lo: string; hi: string }>;
    const covered = (t: number) => ws.some((w) => new Date(w.lo).getTime() <= t - 5 * MIN && new Date(w.hi).getTime() >= Math.min(t + 50 * MIN, T + HOUR));
    for (const t of by.get("EHRC-OPD6s-Mac-mini")!) expect(covered(t), new Date(t).toISOString()).toBe(true);
    expect(chunkWindows(ws)).toHaveLength(1);
    // 900 windows over 4 days (225 a day, distinct Macs) -> 4 chunks by day; 1000 in one day -> 400, 400, 200
    const w = (m: string, lo: number) => ({ machine: m, lo: new Date(lo).toISOString(), hi: new Date(lo + 55 * MIN).toISOString() });
    const nine = Array.from({ length: 900 }, (_, k) => w(`m${k}`, T - Math.floor(k / 225) * 24 * HOUR - 60 * MIN));
    const c = chunkWindows(nine);
    expect(c.map((x: unknown[]) => x.length)).toEqual([225, 225, 225, 225]);
    expect(c[0][0].machine).toBe("m675"); // the oldest day first
    expect(chunkWindows(Array.from({ length: 1000 }, (_, k) => w(`m${k}`, T - HOUR))).map((x: unknown[]) => x.length)).toEqual([400, 400, 200]);
    expect(chunkWindows([])).toEqual([]);
  });
});
