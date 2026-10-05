/**
 * tools/pulse-watch/occupancy.mjs (OCCUPANCY_SQL + resolveMachines) — the extension 0.1.1 rules AGAINST A REAL POSTGRES, and in lockstep with the
 * TypeScript resolver (lib/encounter-windows/occupancy.ts) that the encounter-window cron uses.
 *
 * The two files state ONE rule set (the .mjs is V's read-side tool, copied to the MacBook Air; the .ts is the in-memory port). This suite loads
 * the same scenario events into pulse_presence_events, runs resolveMachines() through the s1-pg harness (values BOUND as untyped $n, like the Neon
 * driver), and asserts (a) the new behaviour, and (b) that the TypeScript resolver gives the same per-stream answer and the same page_name / instances.
 *
 * Rules under test: an ext `identity_stale` event (doctor_uid null, payload.cookie_uid = the stale cookie doctor) closes THAT doctor's stream like a
 * logout with out_reason stale_cookie; a row whose reason contains stale_cookie is never a doctor's activity; page_name = latest non-null page on the
 * machine's ext rows in the last 10 min; instances = distinct instance_ids reporting there. Time is fixed (asOf), so nothing depends on the clock.
 * Needs Docker (postgres:16); ETA_ALLOW_SKIP_E2E=1 accepts that it was not proven, like tests/unit/fleet-attention-sql.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";
import { byTimeThenId, machineSignals, normalizeEvent, resolveStreams, type NEvent } from "@/lib/encounter-windows/occupancy";
import type { PresenceEvent } from "@/lib/encounter-windows/types";
// the tool under test (plain ESM, no types)
import { resolveMachines } from "../../tools/pulse-watch/occupancy.mjs";

const A = makeFakeClinician(1); // the doctor the stale cookie names
const B = makeFakeClinician(2); // the doctor actually signed in
const UA = A.id;
const UB = B.id;
const PAGE = "Fakefirst";
const I1 = "a".repeat(32);
const I2 = "b".repeat(32);
const NOW = Date.parse("2026-10-05T07:00:00Z"); // 12:30 IST

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-occupancy-mjs");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — occupancy.mjs SQL against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/occupancy-mjs-sql.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

type Spec = { machine: string; event: string; minAgo: number; payload: Record<string, unknown> };
const specs: Spec[] = [];
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const row = (machine: string, event: string, minAgo: number, payload: Record<string, unknown> = {}): void => {
  specs.push({ machine, event, minAgo, payload: { event, tab_focus: false, ...payload } });
};
const loggedIn = (m: string, uid: string, dn: string, o: Record<string, unknown> = {}): void => {
  row(m, "login", 30, { doctor_uid: uid, display_name: dn, tab_focus: true, ...o });
  row(m, "heartbeat", 1, { doctor_uid: uid, display_name: dn, tab_focus: true, ...o });
};
const stale = (m: string, cookieUid: string, minAgo: number, o: Record<string, unknown> = {}): void =>
  row(m, "identity_stale", minAgo, { doctor_uid: null, display_name: null, reason: "stale_cookie", cookie_uid: cookieUid, cookie_name: "x", page_name: PAGE, instance_id: I1, tab_focus: true, ...o });

// scenario machines
const S_STALE = "M-STALE"; // A logged in, then identity_stale for A
loggedIn(S_STALE, UA, A.full_name);
stale(S_STALE, UA, 0.5);

const S_RELOGIN = "M-RELOGIN"; // stale, then a fresh login for A
loggedIn(S_RELOGIN, UA, A.full_name);
stale(S_RELOGIN, UA, 0.5);
row(S_RELOGIN, "login", 0.2, { doctor_uid: UA, display_name: A.full_name, tab_focus: true });

const S_AFTER = "M-ACTIVE-AFTER"; // stale, then plain activity: stays closed (like a logout)
loggedIn(S_AFTER, UA, A.full_name);
stale(S_AFTER, UA, 0.5);
row(S_AFTER, "active", 0.2, { doctor_uid: UA, display_name: A.full_name, tab_focus: true });

const S_NOTGEN = "M-NOT-GENUINE"; // login 60 min ago; only focused heartbeats since carry reason stale_cookie (and, defensively, a uid)
row(S_NOTGEN, "login", 60, { doctor_uid: UA, display_name: A.full_name, tab_focus: true });
for (let m = 55; m >= 1; m -= 5) row(S_NOTGEN, "heartbeat", m, { doctor_uid: UA, display_name: A.full_name, tab_focus: true, reason: "stale_cookie", page_name: PAGE, instance_id: I1 });

const S_TWO_INST = "M-TWO-INSTANCES"; // one doctor, two installs
row(S_TWO_INST, "login", 10, { doctor_uid: UA, display_name: A.full_name, tab_focus: true, instance_id: I1 });
row(S_TWO_INST, "login", 10, { doctor_uid: UA, display_name: A.full_name, tab_focus: false, instance_id: I2 });
row(S_TWO_INST, "heartbeat", 1, { doctor_uid: UA, display_name: A.full_name, tab_focus: true, instance_id: I1, page_name: PAGE });
row(S_TWO_INST, "heartbeat", 1, { doctor_uid: UA, display_name: A.full_name, tab_focus: false, instance_id: I2 });

const S_PAGE_ONLY = "M-PAGE-ONLY"; // no identity at all: only the greeting
row(S_PAGE_ONLY, "heartbeat", 1, { doctor_uid: null, display_name: null, reason: "absent_401", page_name: PAGE, instance_id: I1, tab_focus: true });
row(S_PAGE_ONLY, "heartbeat", 0.5, { doctor_uid: null, display_name: null, reason: "absent_401", page_name: null, instance_id: I1, tab_focus: true });

const S_OLD_PAGE = "M-OLD-PAGE"; // a greeting older than 10 minutes
row(S_OLD_PAGE, "heartbeat", 12, { doctor_uid: null, display_name: null, page_name: PAGE, instance_id: I1, tab_focus: true });
row(S_OLD_PAGE, "heartbeat", 3, { doctor_uid: null, display_name: null, instance_id: I1, tab_focus: true });

const S_TWO_DOCS = "M-TWO-DOCTORS"; // A (stale cookie) and B (really signed in): the stale closes only A
loggedIn(S_TWO_DOCS, UA, A.full_name);
loggedIn(S_TWO_DOCS, UB, B.full_name);
stale(S_TWO_DOCS, UA, 0.5);

const S_OLD13 = "M-OLD-13-FIELD"; // an old build: none of the 0.1.1 fields exist
loggedIn(S_OLD13, UB, B.full_name);

const MACHINES = [S_STALE, S_RELOGIN, S_AFTER, S_NOTGEN, S_TWO_INST, S_PAGE_ONLY, S_OLD_PAGE, S_TWO_DOCS, S_OLD13];

type SqlRow = { uid: string; out_reason: string | null; present: boolean };
type MachineRow = {
  machine: string; occupied: boolean; doctor_uid: string | null; out_reason: string | null; page_name: string | null; instances: number;
  occupant_display: unknown; sessions: SqlRow[];
};
let byMachine = new Map<string, MachineRow>();

/** The same events as the TypeScript resolver sees them after fetchEvents' flattening. */
const tsEvents = (machine: string): NEvent[] =>
  specs
    .filter((s) => s.machine === machine)
    .map((s, i): PresenceEvent => ({
      id: i + 1, source: "ext", machine, event: s.event, ts: at(s.minAgo),
      uid: (s.payload.doctor_uid as string | null | undefined) ?? null, dn: (s.payload.display_name as string | null | undefined) ?? null,
      focus: s.payload.tab_focus === true, reason: (s.payload.reason as string | null | undefined) ?? null,
      page: (s.payload.page_name as string | null | undefined) ?? null, inst: (s.payload.instance_id as string | null | undefined) ?? null,
      cookie_uid: (s.payload.cookie_uid as string | null | undefined) ?? null,
    }))
    .map((e) => normalizeEvent(e))
    .filter((e): e is NEvent => e !== null)
    .sort(byTimeThenId);

beforeAll(async () => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
  `);
  for (const f of ["0122_pulse_presence_events", "0123_eta_encounter_windows", "0124_encounter_windows_warehouse_attribution"]) pg.exec(noRecord(`db/migrations/${f}.sql`));
  const q = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  pg.exec(
    specs
      .map((s) => `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('ext', '${s.machine}', '${s.event}', '${at(s.minAgo)}', ${q(s.payload)}::jsonb);`)
      .join("\n"),
  );
  // the tool calls sql.query(text, params); the harness is a tag, so split the text at its $n placeholders (each is used once)
  const run = (text: string, params: unknown[]) => {
    const parts = text.split(/\$\d+/);
    return pg.sql(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
  };
  const sql = Object.assign((text: string, params: unknown[]) => run(text, params), { query: (text: string, params: unknown[]) => run(text, params) });
  const rows = (await resolveMachines(sql, { asOf: new Date(NOW).toISOString() })) as MachineRow[];
  byMachine = new Map(rows.map((r) => [r.machine, r]));
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

describe.runIf(HAVE_DOCKER)("resolveMachines (SQL) — extension 0.1.1", () => {
  const m = (name: string): MachineRow => {
    const r = byMachine.get(name);
    if (!r) throw new Error(`no row for ${name}`);
    return r;
  };
  const stream = (name: string, uid: string) => m(name).sessions.find((s) => s.uid === uid);

  it("every scenario machine resolved", () => {
    expect([...byMachine.keys()].sort()).toEqual([...MACHINES].sort());
  });

  it("identity_stale closes the cookie doctor's stream: out_reason stale_cookie, machine empty", () => {
    expect(m(S_STALE)).toMatchObject({ occupied: false, doctor_uid: null, out_reason: "stale_cookie", page_name: PAGE });
    expect(stream(S_STALE, UA)).toMatchObject({ present: false, out_reason: "stale_cookie" });
  });

  it("a later login re-opens it; plain activity after the stale event does not", () => {
    expect(m(S_RELOGIN)).toMatchObject({ occupied: true, doctor_uid: UA, out_reason: null });
    expect(m(S_AFTER)).toMatchObject({ occupied: false, out_reason: "stale_cookie" });
  });

  it("rows whose reason contains stale_cookie never keep a doctor alive (idle_timeout, not present)", () => {
    expect(m(S_NOTGEN)).toMatchObject({ occupied: false });
    expect(stream(S_NOTGEN, UA)).toMatchObject({ present: false, out_reason: "idle_timeout" });
  });

  it("the stale closes only the doctor it names", () => {
    expect(m(S_TWO_DOCS)).toMatchObject({ occupied: true, doctor_uid: UB });
    expect(stream(S_TWO_DOCS, UA)).toMatchObject({ present: false, out_reason: "stale_cookie" });
    expect(stream(S_TWO_DOCS, UB)).toMatchObject({ present: true });
  });

  it("page_name: latest non-null in the last 10 minutes, a later null never erases it, an older one is not reported", () => {
    expect(m(S_PAGE_ONLY)).toMatchObject({ page_name: PAGE, instances: 1, occupied: false, occupant_display: null });
    expect(m(S_PAGE_ONLY).out_reason).toBe("no_identity");
    expect(m(S_OLD_PAGE).page_name).toBeNull();
    expect(m(S_OLD13)).toMatchObject({ page_name: null, instances: 0, occupied: true, doctor_uid: UB });
  });

  it("page_name rides on occupant_display when there is a cookie identity; instances counts installs; all rows are kept (one stream, one occupant)", () => {
    expect(m(S_TWO_INST)).toMatchObject({ instances: 2, occupied: true, doctor_uid: UA, page_name: PAGE });
    expect(m(S_TWO_INST).sessions.filter((s) => s.uid === UA)).toHaveLength(1);
    expect(m(S_TWO_INST).occupant_display).toMatchObject({ source: "cookie", uid: UA, page_name: PAGE });
  });

  it("LOCKSTEP with lib/encounter-windows/occupancy.ts: same per-stream out_reason / present, same page_name and instances, on every scenario", () => {
    for (const name of MACHINES) {
      const es = tsEvents(name);
      const ts = new Map(resolveStreams(es, NOW).map((s) => [s.uid, { present: s.present, out_reason: s.out_reason }]));
      const sqlStreams = new Map(m(name).sessions.map((s) => [s.uid, { present: s.present, out_reason: s.out_reason }]));
      expect(sqlStreams, name).toEqual(ts);
      const sig = machineSignals(es, NOW);
      expect({ page_name: m(name).page_name, instances: m(name).instances }, name).toEqual(sig);
    }
  });
});
