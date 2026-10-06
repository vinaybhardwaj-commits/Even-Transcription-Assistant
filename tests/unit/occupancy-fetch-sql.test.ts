/**
 * fetchEvents' SQL against a real postgres — the LOGIN RULE's poller rows (6 Oct 2026, F10 per-login windows).
 *
 * The login rule reads the poller's idle_s around each ext login. After the ext query (unchanged), fetchEvents issues ONE more query only when that read held an ext
 * `login`: a bound (machine, lo, hi) window PER LOGIN (login - 5 min .. login + 50 min, capped at the read end; overlapping windows of a Mac merged; every login, split by IST day when over 400 windows (F12);
 * a Mac's pre-5-Oct short key gets the same windows) LATERAL-joined to pulse_presence_events on (machine, ts) so each window is its own index range scan — source = 'poller', a payload with an idle_s — projecting machine,
 * ts and idle_s only. So the transfer is the rows inside the windows, not the whole read range for every Mac with a login. This suite loads one scenario and asserts what
 * comes back and that the ext side is exactly what keepFocusFlips keeps, then on a prod-shaped seed (16 Macs x 72 h of poller rows every 144 s, 46 logins) that the plan
 * is an index scan bounded by the window on both ends and that ~1k rows come back instead of ~29k. Needs Docker (postgres:16); ETA_ALLOW_SKIP_E2E=1 accepts that it was not proven.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { fetchEvents, keepFocusFlips, pollerRowsNearLogins, type PresenceEvent, type WindowsDb } from "@/lib/encounter-windows";
import { withLoginPollerRows } from "@/lib/encounter-windows/db";
import { makeFakeClinician } from "../support/fake-identity";
// the SQL resolver (plain ESM, no types)
// @ts-ignore TS7016: no declaration file for the .mjs
import { POLLS_SQL, pollWindows } from "../../tools/pulse-watch/occupancy.mjs";

const D1 = makeFakeClinician(1);
const D2 = makeFakeClinician(2);

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-occupancy-fetch");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

const T0 = Date.parse("2026-10-05T16:07:57Z");
const MIN = 60_000;
const at = (offMs: number) => new Date(T0 + offMs).toISOString();
const M6 = "EHRC-OPD6s-Mac-mini";
const M4 = "EHRC-CONSUL4s-Mac-mini"; // its poller rows before 5 Oct were keyed "consul4"
const M7 = "EHRC-OPD7s-Mac-mini"; // no login: its poller rows are never read

type Spec = { name: string; source: "ext" | "poller"; machine: string; event: string; off: number; payload: Record<string, unknown>; kept: boolean };
const specs: Spec[] = [
  { name: "login", source: "ext", machine: M6, event: "login", off: 0, payload: { doctor_uid: D1.id, display_name: D1.full_name, tab_focus: true }, kept: true },
  { name: "identity_stale (focus false)", source: "ext", machine: M6, event: "identity_stale", off: 0, payload: { reason: "stale_cookie", cookie_uid: "u1", tab_focus: false }, kept: true },
  { name: "background heartbeat (a focus FLIP true -> false: kept)", source: "ext", machine: M6, event: "heartbeat", off: 5 * MIN, payload: { doctor_uid: "u1", tab_focus: false }, kept: true },
  { name: "background heartbeat 2 (a repeat)", source: "ext", machine: M6, event: "heartbeat", off: 6 * MIN, payload: { doctor_uid: "u1", tab_focus: false }, kept: false },
  { name: "poller 6 min before (too early)", source: "poller", machine: M6, event: "ok", off: -6 * MIN, payload: { idle_s: 9 }, kept: false },
  { name: "poller 5 min before", source: "poller", machine: M6, event: "ok", off: -5 * MIN, payload: { idle_s: 13_324, locked: false }, kept: true },
  { name: "poller at the login", source: "poller", machine: M6, event: "ok", off: 0, payload: { idle_s: 13_330 }, kept: true },
  { name: "poller 50 min after", source: "poller", machine: M6, event: "ok", off: 50 * MIN, payload: { idle_s: 2 }, kept: true },
  { name: "poller 50 min + 1 s after (too late)", source: "poller", machine: M6, event: "ok", off: 50 * MIN + 1000, payload: { idle_s: 2 }, kept: false },
  { name: "poller without idle_s (unreachable)", source: "poller", machine: M6, event: "unreachable", off: 1 * MIN, payload: { state: "unreachable" }, kept: false },
  { name: "poller of a Mac with no login", source: "poller", machine: M7, event: "ok", off: 1 * MIN, payload: { idle_s: 3 }, kept: false },
  { name: "ext login of the legacy-key Mac", source: "ext", machine: M4, event: "login", off: 10 * MIN, payload: { doctor_uid: D2.id, display_name: D2.full_name, tab_focus: true }, kept: true },
  { name: "poller under the legacy short key", source: "poller", machine: "consul4", event: "ok", off: 10 * MIN - 20_000, payload: { idle_s: 4 }, kept: true },
  { name: "poller of the Mac with a (2) suffix hostname, no login", source: "poller", machine: "EHRC-CONSUL2s-Mac-mini-2", event: "ok", off: 10 * MIN, payload: { idle_s: 4 }, kept: false },
];

const toEvent = (s: Spec, i: number): PresenceEvent => ({
  id: i + 1, source: s.source, machine: s.machine, event: s.event, ts: at(s.off),
  uid: (s.payload.doctor_uid as string | undefined) ?? null, dn: (s.payload.display_name as string | undefined) ?? null,
  focus: s.payload.tab_focus === undefined ? null : s.payload.tab_focus === true, reason: (s.payload.reason as string | undefined) ?? null,
  cookie_uid: (s.payload.cookie_uid as string | undefined) ?? null, idle_s: (s.payload.idle_s as number | undefined) ?? null,
});

type Fetched = { id: number | string; source: string; machine: string; event: string; ts: unknown; idle_s?: unknown };
let fetched: Fetched[] = [];

/** a db tag that records the queries (text with ? for each bound value, and the values) and answers from the real postgres */
type Recorded = { strings: readonly string[]; vals: unknown[] };
const recording = (rec: Recorded[]): WindowsDb =>
  ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    rec.push({ strings: [...strings], vals });
    return pg.sql(strings, ...vals);
  }) as unknown as WindowsDb;

describe("REQUIRED PROOF — fetchEvents' poller-row load against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("Docker is not available: fetchEvents' SQL was NOT proven. Start Docker or set ETA_ALLOW_SKIP_E2E=1 to accept that.");
  });
});

describe.runIf(HAVE_DOCKER)("fetchEvents (SQL) — login rule rows", () => {
  const rec: Recorded[] = [];
  beforeAll(async () => {
    pg.start();
    pg.exec(`
      CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
      CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
    `);
    pg.exec(noRecord("db/migrations/0122_pulse_presence_events.sql"));
    const q = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
    pg.exec(
      specs
        .map((s) => `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('${s.source}', '${s.machine.replace(/'/g, "''")}', '${s.event}', '${at(s.off)}', ${q(s.payload)}::jsonb);`)
        .join("\n"),
    );
    fetched = (await fetchEvents(recording(rec), new Date(T0 - 60 * MIN), new Date(T0 + 60 * MIN))) as unknown as Fetched[];
  }, 240_000);
  afterAll(() => pg.stop());

  it("the ext rows are exactly what keepFocusFlips keeps (login + identity_stale + the focus flip), nothing else changed", () => {
    // pulse_presence_events ids are assigned in insert order, so spec i has id i + 1
    const keptExt = specs.map((s, i) => (s.source === "ext" && s.kept ? i + 1 : null)).filter((x): x is number => x !== null);
    expect(fetched.filter((r) => r.source === "ext").map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual(keptExt);
    const ts = keepFocusFlips(specs.map(toEvent).filter((e) => e.source === "ext")).map((e) => Number(e.id)).sort((a, b) => a - b);
    expect(ts).toEqual(keptExt);
  });

  it("poller rows read: only Macs with an ext login, only within [-5 min, +50 min] of it, only with an idle_s — on the canonical key or the legacy short key", () => {
    const poll = fetched.filter((r) => r.source === "poller");
    expect(poll.map((r) => [r.machine, Number(r.idle_s)]).sort()).toEqual(
      [[M6, 13_324], [M6, 13_330], [M6, 2], [M4, 4]].sort(),
    );
    // pollerRowsNearLogins is the same rule in TypeScript: handing it every poller row of the table keeps exactly these
    const ext = specs.map(toEvent).filter((e) => e.source === "ext");
    const every = specs.map(toEvent).filter((e) => e.source === "poller" && e.idle_s != null);
    expect(pollerRowsNearLogins(ext, every).map((e) => Number(e.idle_s)).sort((a, b) => a - b)).toEqual([2, 4, 13_324, 13_330]);
  });

  it("the whole read is two queries: the unchanged ext query, then ONE poller query (bound windows LATERAL per window on machine + ts, only machine/ts/idle_s)", () => {
    expect(rec).toHaveLength(2);
    const text = rec[1]!.strings.join("?");
    expect(text).toMatch(/SELECT e\.machine, e\.ts, e\.payload->>'idle_s' AS idle_s/);
    expect(text).toMatch(/unnest\(\?::text\[\], \?::timestamptz\[\], \?::timestamptz\[\]\)/);
    expect(text).toMatch(/JOIN LATERAL \(/);
    expect(text).toMatch(/e\.machine = w\.machine AND e\.ts BETWEEN w\.lo AND w\.hi/);
    expect(text).toMatch(/e\.source = 'poller'/);
    const [machines, los, his] = rec[1]!.vals as [string[], string[], string[]];
    expect(los).toHaveLength(machines.length);
    expect(his).toHaveLength(machines.length);
    // M6: login at 0 -> [-5 min, +50 min]; M4: login at +10 min -> [+5 min, +60 min], on the canonical key AND the legacy short key
    const wins = machines.map((m, k) => `${m} ${los[k]} ${his[k]}`).sort();
    expect(wins).toEqual([
      `${M6} ${at(-5 * MIN)} ${at(50 * MIN)}`,
      `${M4} ${at(5 * MIN)} ${at(60 * MIN)}`,
      `consul4 ${at(5 * MIN)} ${at(60 * MIN)}`,
    ].sort());
  });

  it("a read with no ext login issues exactly one query (no poller read at all)", async () => {
    const r2: Recorded[] = [];
    const rows = await fetchEvents(recording(r2), new Date(T0 + 10 * 24 * 60 * MIN), new Date(T0 + 10 * 24 * 60 * MIN + 60 * MIN));
    expect(r2).toHaveLength(1);
    expect(rows.every((r) => r.source !== "poller")).toBe(true);
  });
});

describe.runIf(HAVE_DOCKER)("fetchEvents' poller query — prod-shaped seed: per-login windows, index scan, ~1k rows (F10)", () => {
  const rec: Recorded[] = [];
  let transferred = 0; // rows the poller query returned
  let oldTransfer = 0; // rows the pre-F10 query (whole read range on every Mac with a login) would have returned
  let nLogins = 0;
  const loginsAll: Array<{ machine: string; off: number }> = [];
  const HOUR = 60 * MIN;
  const MACS = Array.from({ length: 16 }, (_, i) => `EHRC-PS${i + 1}s-Mac-mini`);
  beforeAll(async () => {
    pg.start();
    pg.exec(`
      CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
      CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
    `);
    pg.exec(noRecord("db/migrations/0122_pulse_presence_events.sql"));
    // 16 Macs x 72 h of poller rows every 144 s (~28.8k rows, the measured production density), then 46 logins: 40 spread over the 72 h, 6 relaunches 7 min after another one
    const logins: Array<{ machine: string; off: number }> = [];
    for (let k = 0; k < 40; k += 1) logins.push({ machine: MACS[k % 16]!, off: -(k * 100 * MIN) - ((k * 37) % 50) * MIN });
    for (let k = 0; k < 6; k += 1) logins.push({ machine: logins[k]!.machine, off: logins[k]!.off + 7 * MIN });
    nLogins = logins.length;
    loginsAll.push(...logins);
    pg.exec(`
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      SELECT 'poller', 'EHRC-PS' || m || 's-Mac-mini', 'ok', timestamptz '${at(0)}' - interval '72 hours' + (g * interval '144 seconds'), jsonb_build_object('idle_s', (g * 7) % 900)
        FROM generate_series(1, 16) m, generate_series(0, 1800) g;
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      VALUES ${logins.map((l) => `('ext', '${l.machine}', 'login', '${at(l.off)}', '{"doctor_uid":"x","tab_focus":true}')`).join(",\n")};
      ANALYZE pulse_presence_events;
    `);
    const db = ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      rec.push({ strings: [...strings], vals });
      const r = pg.sql(strings, ...vals);
      return Promise.resolve(r).then((rows) => {
        if (strings.join("?").includes("unnest")) transferred = (rows as unknown[]).length;
        return rows;
      });
    }) as unknown as WindowsDb;
    await fetchEvents(db, new Date(T0 - 72 * HOUR), new Date(T0));
    const old = await pg.sql`SELECT count(*)::int AS n FROM pulse_presence_events WHERE source = 'poller' AND machine LIKE 'EHRC-PS%' AND ts BETWEEN ${at(-72 * HOUR)}::timestamptz AND ${at(0)}::timestamptz AND payload ? 'idle_s'`;
    oldTransfer = Number((old as unknown as Array<{ n: number | string }>)[0]!.n);
  }, 240_000);
  afterAll(() => pg.stop());

  const explain = (): { plan: string; execMs: number } => {
    const { strings, vals } = rec[1]!;
    // the harness only runs SELECT-led statements, so EXPLAIN goes through psql directly: PREPARE the recorded text, EXPLAIN ANALYZE an EXECUTE with the recorded values
    let q = "";
    strings.forEach((x, i) => { q += x + (i < vals.length ? `$${i + 1}` : ""); });
    const lit = (v: unknown) => `'${(Array.isArray(v) ? `{${v.map((x) => `"${String(x)}"`).join(",")}}` : String(v)).replace(/'/g, "''")}'`;
    const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
      input: `PREPARE __e AS ${q};\nEXPLAIN (ANALYZE, FORMAT JSON) EXECUTE __e(${vals.map(lit).join(", ")});\n`, encoding: "utf8",
    });
    const j = JSON.parse(out) as Array<{ Plan: unknown; "Execution Time": number }>;
    return { plan: JSON.stringify(j[0]!.Plan), execMs: j[0]!["Execution Time"] };
  };

  it("the seed is prod-shaped: 46 logins, ~28.8k poller rows", () => {
    expect(nLogins).toBe(46);
    expect(oldTransfer).toBeGreaterThan(28_000);
  });

  it("EXPLAIN: the poller scan is an index scan carrying the machine key and BOTH ends of the login's window as its condition (no seq scan of the table)", () => {
    expect(rec).toHaveLength(2);
    const { plan, execMs } = explain();
    expect(plan).toMatch(/Index (Only )?Scan|Bitmap Index Scan/);
    expect(plan).not.toMatch(/Seq Scan[^}]*pulse_presence_events/);
    expect(plan).toMatch(/Nested Loop/);
    expect(plan).toMatch(/"Index Name":"pulse_presence_events_machine_ts_idx"/);
    expect(plan).toMatch(/"Index Cond":"\(\(machine = \w+\.machine\) AND \(ts >= \w+\.lo\) AND \(ts <= \w+\.hi\)\)"/);
    expect(execMs).toBeLessThan(1000);
    console.info(`[F10] poller query: execution ${execMs.toFixed(1)} ms; ${transferred} rows transferred vs ${oldTransfer} for the pre-F10 whole-range read`);
  });

  it("the SQL resolver's POLLS_SQL (occupancy.mjs) takes the same plan: a nested loop of index range scans on machine + both ends of the window, ~1k rows", () => {
    const by = new Map<string, number[]>();
    for (const l of loginsAll) by.set(l.machine, [...(by.get(l.machine) ?? []), T0 + l.off]);
    const windows = pollWindows(by, T0) as Array<{ machine: string; lo: string; hi: string }>;
    expect(windows.length).toBeLessThanOrEqual(60);
    const json = JSON.stringify(windows).replace(/'/g, "''");
    const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], {
      input: `PREPARE __m AS ${(POLLS_SQL as string)};\nEXPLAIN (ANALYZE, FORMAT JSON) EXECUTE __m('${json}');\n`, encoding: "utf8",
    });
    const j = JSON.parse(out) as Array<{ Plan: unknown; "Execution Time": number }>;
    const plan = JSON.stringify(j[0]!.Plan);
    expect(plan).toMatch(/Nested Loop/);
    expect(plan).toMatch(/"Index Name":"pulse_presence_events_machine_ts_idx"/);
    expect(plan).not.toMatch(/"Node Type":"Seq Scan"/);
    expect(plan).toMatch(/"Index Cond":"\(\(machine = \w+\.machine\) AND \(ts >= \(?\w+\.lo\)?(::timestamp with time zone)?\) AND \(ts <= /);
    const rows = Number(/"Actual Rows":(\d+)/.exec(plan)![1]);
    expect(rows).toBeGreaterThan(900);
    expect(rows).toBeLessThan(1200);
  });

  it("F10: total transfer is ~1k rows (the windows), not the ~29k of the whole read range", () => {
    expect(transferred).toBeGreaterThan(900); // 46 logins x ~23 rows (55 min every 144 s)
    expect(transferred).toBeLessThan(1200);
    expect(transferred * 20).toBeLessThan(oldTransfer);
  });

  it("withLoginPollerRows hands back only poller rows inside a login's [-5 min, +50 min] window on that Mac", async () => {
    const ext: PresenceEvent[] = [
      { id: 1, source: "ext", machine: MACS[0]!, event: "login", ts: at(-10 * HOUR), uid: "x" },
      { id: 2, source: "ext", machine: MACS[1]!, event: "login", ts: at(-20 * HOUR), uid: "y" },
    ];
    const rows = await withLoginPollerRows(pg.sql as unknown as WindowsDb, ext, T0 + 2 * HOUR);
    const poll = rows.filter((r) => r.source === "poller");
    // 55 min of 144 s rows = 22 or 23 rows per Mac
    expect(poll.length).toBeGreaterThanOrEqual(44);
    expect(poll.length).toBeLessThanOrEqual(46);
    expect(new Set(poll.map((r) => r.machine))).toEqual(new Set([MACS[0]!, MACS[1]!]));
    for (const r of poll) {
      const t = new Date(r.ts as string).getTime();
      const l = r.machine === MACS[0] ? T0 - 10 * HOUR : T0 - 20 * HOUR;
      expect(t).toBeGreaterThanOrEqual(l - 5 * MIN);
      expect(t).toBeLessThanOrEqual(l + 50 * MIN);
    }
  });
});
