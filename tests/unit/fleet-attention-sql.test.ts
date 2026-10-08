/**
 * lib/fleet-attention.ts DB half + lib/room-watchdog.ts loadRecoveryEvidence/persistPlan — AGAINST A REAL POSTGRES.
 *
 * The rules are proven in fleet-attention.test.ts with plain objects. What a plain object cannot prove is that the SELECTs themselves run: row
 * comparisons, LATERAL joins, jsonb_to_recordset over a bound parameter, DISTINCT ON over unnest(), the ist_date index bounds. Every statement
 * here is sent through the s1-pg harness with BOUND, untyped parameters, the way the Neon driver sends them.
 *
 * The tables are minimal hand-written DDL carrying only the columns the queries read (the same approach as room-watchdog-outbox.test.ts), with the
 * REAL indexes copied from their migrations (0054 bench_session (room_id, started_at DESC); 0045 bench_chunk UNIQUE (session_id, source, idx); 0112
 * bench_level_sample (room_id, ist_date, sampled_at)), because the last describe asserts the queries use them. pulse_presence_events,
 * eta_encounter_windows, room_alert_state and room_alert_outbox are created from their real migrations.
 * Times are relative to the database's now(), so nothing here depends on the date or on clinic hours.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(1);
const DOC2 = makeFakeClinician(2);

type Sql = (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  rec: [] as Array<{ q: string; v: unknown[] }>,
}));
// Every statement the code under test sends is recorded (text with $n placeholders + the bound values) so the EXPLAIN test can replay it.
vi.mock("@/lib/db", () => ({
  sql: (s: TemplateStringsArray, ...v: unknown[]) => {
    let q = "";
    s.forEach((p, i) => { q += p + (i < v.length ? `$${i + 1}` : ""); });
    H.rec.push({ q, v });
    return H.sql!(s, ...v);
  },
}));
vi.mock("@/lib/bench", () => ({ listBenchSessions: async () => [] }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-fleet-attention");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — the fleet attention SELECTs run against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/fleet-attention-sql.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
    CREATE TABLE room_install (
      install_id text PRIMARY KEY, room_id text NOT NULL, hostname text, enrolled_at timestamptz, retired_at timestamptz,
      last_seen_at timestamptz, tape_advancing boolean, session_open boolean, disk_free_bytes bigint, state_flags jsonb);
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, status text NOT NULL DEFAULT 'recording', notes text);
    CREATE INDEX bench_session_room_started_idx ON bench_session (room_id, started_at DESC);
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, source text NOT NULL DEFAULT 'primary', idx int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz NOT NULL, size_bytes bigint, duration_ms int,
      CONSTRAINT bench_chunk_session_source_idx_key UNIQUE (session_id, source, idx));
    CREATE TABLE bench_level_sample (
      id bigserial PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, sampled_at timestamptz NOT NULL DEFAULT now(),
      peak real NOT NULL, avg real, zero_ratio real, session_open boolean NOT NULL DEFAULT false, tape_advancing boolean NOT NULL DEFAULT false,
      source text NOT NULL DEFAULT 'command_poll');
    CREATE INDEX bench_level_sample_room_day_time_idx ON bench_level_sample (room_id, ist_date, sampled_at);
    CREATE TABLE bench_command (id text PRIMARY KEY, room_id text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
      result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz);
    CREATE FUNCTION explain_json(q text) RETURNS text LANGUAGE plpgsql AS $f$
      DECLARE r text;
      BEGIN EXECUTE 'EXPLAIN (ANALYZE, FORMAT JSON) ' || q INTO r; RETURN r; END
    $f$;
  `);
  for (const f of ["0103_room_alert_state", "0119_room_alert_outbox", "0199_room_alert_outbox_session_reaped", "0122_pulse_presence_events", "0123_eta_encounter_windows", "0124_encounter_windows_warehouse_attribution", "0126_kiosk_health_events", "0127_kiosk_health_machine_received_idx"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  H.sql = pg.sql as Sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

let chunkIdx = 0;
beforeEach(() => {
  if (!HAVE_DOCKER) return;
  chunkIdx = 0;
  H.rec.length = 0;
  pg.exec(`
    TRUNCATE room_alert_outbox RESTART IDENTITY; TRUNCATE room_alert_state; TRUNCATE pulse_presence_events; TRUNCATE eta_encounter_windows; TRUNCATE kiosk_health_events;
    TRUNCATE bench_command; TRUNCATE bench_level_sample; TRUNCATE bench_chunk; TRUNCATE bench_session;
    DELETE FROM room_install; DELETE FROM room;
    INSERT INTO room (id, slug, name) VALUES ('r6', 'opd-6-x', 'OPD 6'), ('r4', 'opd-4-x', 'OPD 4'), ('r7', 'consul-4-x', 'CONSUL 4');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at) VALUES
      ('i6', 'r6', 'EHRC-OPD6’s Mac mini (2)', now() - interval '30 days'),
      ('i4', 'r4', 'EHRC-OPD4s-Mac-mini', now() - interval '30 days'),
      ('i7', 'r7', 'EHRC-CONSUL4s-Mac-mini', now() - interval '30 days');
  `);
});

const M6 = "EHRC-OPD6s-Mac-mini-2"; // normalizeHostname('EHRC-OPD6’s Mac mini (2)')
const M4 = "EHRC-OPD4s-Mac-mini";
const M7 = "EHRC-CONSUL4s-Mac-mini";

const ago = (interval: string) => `now() - interval '${interval}'`;
const presence = (source: "ext" | "poller", machine: string, event: string, when: string, payload = "{}") =>
  `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('${source}', '${machine}', '${event}', ${ago(when)}, '${payload}'::jsonb);`;
const session = (id: string, room: string, startedAgo: string, status = "recording", endedAgo?: string) =>
  `INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('${id}', '${room}', ${ago(startedAgo)}, ${endedAgo ? ago(endedAgo) : "NULL"}, '${status}');`;
/** A 5-minute (300 000 ms) chunk by default; `size` bytes. 3.4 MB is normal speech, 212 378 B / 300 s = 708 B/s is digital silence. */
const chunkRow = (id: string, sess: string, createdAgo: string, size: number | "NULL", source = "primary", durationMs: number | "NULL" = 300_000) =>
  `INSERT INTO bench_chunk (id, session_id, source, idx, created_at, started_at, size_bytes, duration_ms)
   VALUES ('${id}', '${sess}', '${source}', ${chunkIdx++}, ${ago(createdAgo)}, ${ago(createdAgo)} - interval '5 minutes', ${size}, ${durationMs});`;
/** Samples every `step` seconds from `fromAgo` to `toAgo`; peak/zero either constant or varying with the timestamp. */
const samples = (room: string, fromAgo: string, toAgo: string, mode: "frozen" | "moving", step = 5) => `
  INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
  SELECT '${room}', (t AT TIME ZONE 'Asia/Kolkata')::date, t,
         ${mode === "frozen" ? "0.0123" : "0.02 + (extract(epoch from t)::bigint % 9) * 0.004"},
         ${mode === "frozen" ? "0.31" : "0.1 + (extract(epoch from t)::bigint % 7) * 0.01"}, true, true
    FROM generate_series(${ago(fromAgo)}, ${ago(toAgo)}, interval '${step} seconds') t;`;

const attention = async () => (await import("@/lib/fleet-attention")).getFleetAttention();
const kindsOf = (r: { items: Array<{ room_id: string; kind: string }> }) => r.items.map((i) => `${i.room_id}:${i.kind}`).sort();
const minutesBetween = (a: string, b: number) => Math.abs(Date.parse(a) - b) / 60_000;

describe.runIf(HAVE_DOCKER)("getFleetAttention against postgres", () => {
  it("an empty, healthy fleet is an empty list, every source read, nothing degraded", async () => {
    const r = await attention();
    expect(r.items).toEqual([]);
    expect(r.rooms_checked).toBe(3);
    expect(r.degraded).toBeUndefined();
    expect(Number.isFinite(Date.parse(r.generated_at))).toBe(true);
  });

  // ---- R11-R17: the kiosk-health daemon's rules, through the real loader ----------------------------------------------------------------------

  it("kiosk health — a daemon drift row for a fleet Mac becomes a config_drift item on its room, with the per-machine summary on the response; nothing degraded", async () => {
    pg.exec(`INSERT INTO kiosk_health_events (received_at, machine, boot_id, seq, source, kind, ts, payload) VALUES
      (now() - interval '30 minutes', '${M6}', 'b', 1, 'daemon', 'drift', now() - interval '30 minutes', '{"field":"sleep","expected":0,"actual":10,"change":"initial"}'::jsonb),
      (now() - interval '20 seconds', '${M6}', 'b', 2, 'daemon', 'heartbeat', now() - interval '20 seconds', '{}'::jsonb);`);
    const r = await attention();
    expect(r.items.find((i) => i.room_id === "r6" && i.kind === "config_drift")).toMatchObject({ severity: "amber", machine: "EHRC-OPD6’s Mac mini (2)" });
    expect(r.kiosk_health?.[M6]).toMatchObject({ enrolled: true, drift_fields: ["sleep"], default_input_present: null, chrome_presence_ok: null });
    expect(r.degraded).toBeUndefined();
  });

  it("kiosk health — when the kiosk-health table cannot be read the source is marked degraded and the other items are untouched", async () => {
    pg.exec("DROP TABLE kiosk_health_events;");
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const r = await attention();
      expect(r.degraded).toContain("kiosk_health");
      expect(r.items).toEqual([]);
      expect(r.kiosk_health).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    } finally {
      pg.exec(noRecord("db/migrations/0126_kiosk_health_events.sql") + noRecord("db/migrations/0127_kiosk_health_machine_received_idx.sql"));
    }
  });

  // ---- R1 (a): a session is open, the screen is locked / the Mac unreachable, and there is no audio ---------------------------------------------

  it("R1(a) — ext `locked` (found under the NORMALISED machine name) + an open session + frozen levels + no chunk → red, 'Screen locked and no audio since'; a focused heartbeat clears it", async () => {
    pg.exec([
      presence("ext", M6, "heartbeat", "40 minutes", '{"tab_focus": true}'),
      presence("ext", M6, "locked", "30 minutes"),
      ...[25, 20, 15, 10, 5, 1].map((m) => presence("ext", M6, "heartbeat", `${m} minutes`, '{"tab_focus": false}')),
      session("bs6", "r6", "2 hours"),
      samples("r6", "20 minutes", "1 second", "frozen"),
    ].join("\n"));
    const r = await attention();
    expect(kindsOf(r)).toContain("r6:asleep");
    const item = r.items.find((i) => i.kind === "asleep")!;
    expect(item.severity).toBe("red");
    expect(item.machine).toBe("EHRC-OPD6’s Mac mini (2)");
    expect(item.detail).toContain("Screen locked and no audio since");
    expect(minutesBetween(item.since, Date.now() - 30 * 60_000)).toBeLessThan(1);
    // a focused heartbeat after the lock: the screen is not locked any more
    pg.exec(presence("ext", M6, "heartbeat", "30 seconds", '{"tab_focus": true}'));
    expect(kindsOf(await attention())).not.toContain("r6:asleep");
  });

  it("R1 — a locked screen with NO session open is NOT an item (OPD 5 on 5 Oct recorded all morning under a locked screen; DarkWake cannot be told from a locked idle Mac)", async () => {
    pg.exec([presence("ext", M6, "locked", "6 hours"), presence("poller", M6, "ok", "2 minutes", '{"locked": true}')].join("\n"));
    expect(kindsOf(await attention())).not.toContain("r6:asleep");
    // …and a locked screen under a session that IS delivering audio is not an item either (the OPD 5 case)
    pg.exec([session("bs6", "r6", "5 hours"), samples("r6", "30 minutes", "1 second", "moving"), chunkRow("c1", "bs6", "3 minutes", 3_400_000)].join("\n"));
    expect(kindsOf(await attention())).not.toContain("r6:asleep");
  });

  it("R1(a) — audio evidence clears it: it takes BOTH a chunk in the last 10 minutes and moving levels; either one missing leaves it red", async () => {
    pg.exec([presence("ext", M6, "locked", "30 minutes"), session("bs6", "r6", "2 hours")].join("\n"));
    // chunk but frozen levels
    pg.exec([samples("r6", "20 minutes", "1 second", "frozen"), chunkRow("c1", "bs6", "3 minutes", 3_400_000)].join("\n"));
    expect(kindsOf(await attention())).toContain("r6:asleep");
    // moving levels but the last chunk is 15 minutes old
    pg.exec(`TRUNCATE bench_level_sample; TRUNCATE bench_chunk;` + samples("r6", "20 minutes", "1 second", "moving") + chunkRow("c2", "bs6", "15 minutes", 3_400_000));
    expect(kindsOf(await attention())).toContain("r6:asleep");
    // both → cleared at once
    pg.exec(chunkRow("c3", "bs6", "2 minutes", 3_400_000));
    expect(kindsOf(await attention())).not.toContain("r6:asleep");
  });

  it("R1(a) — the poller's `locked: true` counts as locked, the same way", async () => {
    pg.exec([presence("poller", M4, "ok", "2 minutes", '{"locked": true}'), session("bs4", "r4", "2 hours"), samples("r4", "10 minutes", "1 second", "frozen")].join("\n"));
    expect(kindsOf(await attention())).toContain("r4:asleep");
  });

  // ---- R1 (b): the poller has not reached the Mac for 3 minutes -------------------------------------------------------------------------------

  it("R1(b) — the poller's newest row `unreachable` for >= 3 min, matched on the RAW hostname; since is where the current unreachable run began; a newer ok clears it", async () => {
    pg.exec([
      presence("poller", M4, "ok", "30 minutes", '{"locked": false}'),
      presence("poller", M4, "ok", "20 minutes", '{"locked": false}'),
      presence("poller", M4, "unreachable", "15 minutes", '{"locked": false}'),
      presence("poller", M4, "unreachable", "10 minutes", '{"locked": false}'),
      presence("poller", M4, "unreachable", "1 minute", '{"locked": false}'),
    ].join("\n"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r4:asleep"]);
    expect(r.items[0]!.detail).toContain("unreachable on the network since");
    expect(minutesBetween(r.items[0]!.since, Date.now() - 15 * 60_000)).toBeLessThan(1);
    pg.exec(presence("poller", M4, "ok", "10 seconds", '{"locked": false}'));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("R1(b) — not yet 3 minutes, or a poller row older than 10 minutes (the poller itself may be down), raises nothing", async () => {
    pg.exec([presence("poller", M4, "ok", "30 minutes"), presence("poller", M4, "unreachable", "2 minutes"), presence("poller", M4, "unreachable", "1 minute")].join("\n"));
    expect(await attention().then((x) => x.items)).toEqual([]);
    pg.exec(`TRUNCATE pulse_presence_events;` + [presence("poller", M4, "ok", "40 minutes"), presence("poller", M4, "unreachable", "22 minutes"), presence("poller", M4, "unreachable", "12 minutes")].join("\n"));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("R1(b) — an unreachable poller does not make a room red while its recording is demonstrably delivering audio", async () => {
    pg.exec([
      presence("poller", M6, "ok", "30 minutes"), presence("poller", M6, "unreachable", "10 minutes"), presence("poller", M6, "unreachable", "1 minute"),
      session("bs6", "r6", "2 hours"), samples("r6", "20 minutes", "1 second", "moving"), chunkRow("c1", "bs6", "3 minutes", 3_400_000),
    ].join("\n"));
    expect(kindsOf(await attention())).not.toContain("r6:asleep");
  });

  it("R1(b) — POLLER KEYS ACROSS THE 5 Oct RENAME: a run of `unreachable` rows that began under the short key (consul4) and continues under the full hostname is ONE run", async () => {
    pg.exec([
      presence("poller", "consul4", "ok", "60 minutes", '{"locked": false}'),
      presence("poller", "consul4", "unreachable", "40 minutes", '{"locked": false}'),
      presence("poller", "consul4", "unreachable", "30 minutes", '{"locked": false}'),
      presence("poller", M7, "unreachable", "20 minutes", '{"locked": false}'),
      presence("poller", M7, "unreachable", "10 minutes", '{"locked": false}'),
      presence("poller", M7, "unreachable", "1 minute", '{"locked": false}'),
    ].join("\n"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r7:asleep"]);
    expect(minutesBetween(r.items[0]!.since, Date.now() - 40 * 60_000)).toBeLessThan(1);
    // an `ok` under the SHORT key, newer than the unreachable run's start, ends the run: the newest row wins and `since` would restart
    pg.exec(presence("poller", "consul4", "ok", "30 seconds"));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  // ---- R2 / R3 --------------------------------------------------------------------------------------------------------------------------------

  it("R2 capture_frozen — finds where the identical run began (20 minutes ago); R3 silent_tape — two silent primary chunks BY RATE (708 B/s over 300 s)", async () => {
    pg.exec([
      session("bs6", "r6", "3 hours"),
      samples("r6", "40 minutes", "20 minutes 5 seconds", "moving"),
      samples("r6", "20 minutes", "1 second", "frozen"),
      chunkRow("c1", "bs6", "26 minutes", 3_400_000),
      chunkRow("c2", "bs6", "11 minutes", 212378),
      chunkRow("c3", "bs6", "6 minutes", 212378),
      chunkRow("c4", "bs6", "6 minutes", 212378, "backup"),
    ].join("\n"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:capture_frozen", "r6:silent_tape"]);
    const frozen = r.items.find((i) => i.kind === "capture_frozen")!;
    expect(minutesBetween(frozen.since, Date.now() - 20 * 60_000)).toBeLessThan(0.5);
    const silent = r.items.find((i) => i.kind === "silent_tape")!;
    expect(silent.detail).toContain("last 2 recording pieces");
  });

  it("R3 — short chunks never count (a 60 s piece of 20 000 B is 333 B/s but is too short to judge), a loud chunk breaks the run, and a chunk of unknown length is not silent", async () => {
    pg.exec([
      session("bs6", "r6", "3 hours"), samples("r6", "10 minutes", "1 second", "moving"),
      chunkRow("c1", "bs6", "9 minutes", 20_000, "primary", 60_000),
      chunkRow("c2", "bs6", "8 minutes", 20_000, "primary", 60_000),
      chunkRow("c3", "bs6", "7 minutes", 212378, "primary", "NULL"),
      chunkRow("c4", "bs6", "6 minutes", 212378),
      chunkRow("c5", "bs6", "5 minutes", 3_400_000),
    ].join("\n"));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("R2 — moving samples raise nothing; a session with no samples at all in 120 s raises, citing the last sample it knows of", async () => {
    pg.exec([session("bs6", "r6", "3 hours"), samples("r6", "30 minutes", "1 second", "moving"), chunkRow("c1", "bs6", "2 minutes", 3_400_000)].join("\n"));
    expect(await attention().then((x) => x.items)).toEqual([]);
    pg.exec(`TRUNCATE bench_level_sample;` + samples("r6", "30 minutes", "10 minutes", "moving"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:capture_frozen"]);
    expect(r.items[0]!.detail).toContain("No microphone level readings");
    expect(minutesBetween(r.items[0]!.since, Date.now() - 10 * 60_000)).toBeLessThan(0.5);
  });

  // ---- R4 / R6 / R7 ---------------------------------------------------------------------------------------------------------------------------

  it("R4 consult_without_tape — a live Pulse window with no chunk; a stale unclosed window is ignored", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, display_name, attribution, t_open, t_close, close_reason, quality, resolver_version)
      VALUES ('e1@m', 'm', 'r4', '${DOC.full_name}', 'rows', ${ago("20 minutes")}, NULL, 'open', 'unclosed', 'v'),
             ('e0@m', 'm', 'r4', 'Old', 'rows', ${ago("6 hours")}, NULL, 'open', 'unclosed', 'v'),
             ('e2@m', 'm', 'r6', '${DOC2.full_name}', 'rows', ${ago("3 hours")}, ${ago("2 hours")}, 'endConsult', 'clean', 'v');
    `);
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r4:consult_without_tape"]);
    expect(r.items[0]!.detail).toContain(DOC.label);
    // a recent chunk silences it
    pg.exec(session("bs4", "r4", "2 hours") + chunkRow("c1", "bs4", "3 minutes", 3_400_000) + samples("r4", "10 minutes", "1 second", "moving"));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("R4 names the consulting doctor (warehouse, 0124) when present, not the extension's display_name", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, display_name, consulting_doctor_name, attribution, t_open, t_close, close_reason, quality, resolver_version)
      VALUES ('e1@m', 'm', 'r4', '${DOC2.full_name}', '${DOC.full_name}', 'rows', ${ago("20 minutes")}, NULL, 'open', 'unclosed', 'v');
    `);
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r4:consult_without_tape"]);
    expect(r.items[0]!.detail).toContain(DOC.label);
    expect(r.items[0]!.detail).not.toContain(DOC2.label);
  });

  it("R4 says the session shows the cookie doctor, unverified, only when the warehouse and the extension name different doctors", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, doctor_uid, display_name, consulting_doctor_uid, consulting_doctor_name,
                                         attribution_source, doctor_mismatch, attribution, t_open, t_close, close_reason, quality, resolver_version)
      VALUES ('e1@m', 'm', 'r4', 'ux2', '${DOC2.full_name}', 'ux1', '${DOC.full_name}', 'warehouse', true, 'rows', ${ago("20 minutes")}, NULL, 'open', 'unclosed', 'v');
    `);
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r4:consult_without_tape"]);
    expect(r.items[0]!.detail).toContain(`${DOC.label} is consulting`);
    expect(r.items[0]!.detail).toContain(`The session shows ${DOC2.label}, unverified.`);
    // the same consult with agreeing doctors: named, nothing unverified
    pg.exec(`UPDATE eta_encounter_windows SET doctor_mismatch = false, doctor_uid = consulting_doctor_uid, display_name = consulting_doctor_name;`);
    const agree = await attention();
    expect(agree.items[0]!.detail).toContain(`${DOC.label} is consulting`);
    expect(agree.items[0]!.detail).not.toContain("unverified");
  });

  it("consultingDoctorForMachine / machineOccupancy — the real SELECTs: the LATEST warehouse consult of the IST day wins at any age; the 90-min window only labels it", async () => {
    const { consultingDoctorForMachine, machineOccupancy } = await import("@/lib/encounter-windows/occupant");
    const db = pg.sql as unknown as import("@/lib/encounter-windows").WindowsDb;
    // Fixed instants, so the IST-day boundary never depends on when the suite runs. asOf = 2026-10-05 12:30 IST; the IST day began 2026-10-04T18:30:00Z.
    const asOf = "2026-10-05T07:00:00.000Z";
    const w = (key: string, machine: string, uid: string, name: string, src: string, open: string, close: string | null) =>
      `('${key}', '${machine}', 'r4', ${src === "warehouse" ? `'${uid}'` : "NULL"}, ${src === "warehouse" ? `'${name}'` : "NULL"}, '${src}', 'rows', '${open}'::timestamptz, ${close ? `'${close}'::timestamptz` : "NULL"}, 'open', 'clean', 'v')`;
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, machine, room_id, consulting_doctor_uid, consulting_doctor_name, attribution_source, attribution, t_open, t_close, close_reason, quality, resolver_version)
      VALUES ${[
        w("a1@x", "mx", "u1", DOC.full_name, "warehouse", "2026-10-05T03:00:00Z", "2026-10-05T03:10:00Z"), // earlier today
        w("a2@x", "mx", "u2", DOC2.full_name, "warehouse", "2026-10-05T06:20:00Z", "2026-10-05T06:30:00Z"), // latest today, 40 min ago: wins, live
        w("b1@x", "my", "u1", DOC.full_name, "warehouse", "2026-10-05T05:55:00Z", "2026-10-05T06:05:00Z"), // 65 min ago
        w("b2@x", "my", "u2", DOC2.full_name, "extension", "2026-10-05T06:50:00Z", "2026-10-05T06:55:00Z"), // newer but NOT warehouse: ignored
        w("c1@x", "mz", "u1", DOC.full_name, "warehouse", "2026-10-05T04:00:00Z", null),                    // unclosed 3 h: live
        w("d1@x", "mw", "u1", DOC.full_name, "warehouse", "2026-10-05T02:00:00Z", null),                    // unclosed 5 h: returned, NOT live
        w("e1@x", "mv", "u1", DOC.full_name, "warehouse", "2026-10-04T17:00:00Z", "2026-10-04T17:10:00Z"), // 22:30 IST YESTERDAY: not today
        w("f1@x", "mu", "u1", DOC.full_name, "warehouse", "2026-10-04T19:00:00Z", "2026-10-04T19:10:00Z"), // 00:30 IST today: today
      ].join(",\n")};
    `);
    const one = (machine: string, when = asOf) => consultingDoctorForMachine(db, machine, when);
    expect(await one("mx")).toMatchObject({ uid: "u2", live: true });
    expect(await one("my")).toMatchObject({ uid: "u1", live: true }); // the extension-sourced newer row never hides or replaces the warehouse doctor
    expect(await one("mz")).toMatchObject({ uid: "u1", t_close: null, live: true });
    expect(await one("mw")).toMatchObject({ uid: "u1", t_close: null, live: false });
    expect(await one("mv")).toBeNull();
    expect(await one("mu")).toMatchObject({ uid: "u1", live: false });
    expect(await one("unknown-machine")).toBeNull();
    // as-of 05:00Z the earlier consult is the latest one that had opened
    expect(await one("mx", "2026-10-05T05:00:00.000Z")).toMatchObject({ uid: "u1", live: false });
    // machineOccupancy: stale cookie logins on mx (live consult) and mw (consult 5 h old) never replace the warehouse doctor
    const cookie = JSON.stringify({ doctor_uid: "cookie-uid", display_name: DOC.full_name });
    const hb = JSON.stringify({ doctor_uid: "cookie-uid", display_name: DOC.full_name, tab_focus: "true" });
    const ev = (machine: string, event: string, ts: string, payload: string) =>
      `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('ext', '${machine}', '${event}', '${ts}'::timestamptz, '${payload}'::jsonb);`;
    pg.exec(["mx", "mw"].map((m) => ev(m, "login", "2026-10-05T06:40:00Z", cookie) + ev(m, "heartbeat", "2026-10-05T06:59:00Z", hb)).join("\n"));
    const occ = await machineOccupancy(db, asOf);
    const by = (m: string) => occ.find((x) => x.machine === m);
    expect(by("mx")!.occupied).toBe(true);
    expect(by("mx")!.occupant_display).toMatchObject({ uid: "u2", name: DOC2.full_name, source: "warehouse", label: "consulting", cookie_uid: "cookie-uid", cookie_name: DOC.full_name, stale: true });
    expect(by("mw")!.occupant_display).toMatchObject({ uid: "u1", name: DOC.full_name, source: "warehouse", label: "last consult", consult_at: "2026-10-05T02:00:00.000Z", cookie_uid: "cookie-uid", stale: true });
    expect(by("my")!.occupant_display).toMatchObject({ uid: "u1", source: "warehouse", label: "consulting", cookie_uid: null }); // live, no extension session
    expect(by("mz")!.occupant_display).toMatchObject({ uid: "u1", label: "consulting" });
    expect(by("mu")!.occupant_display).toBeNull(); // consult today but old, and the room is empty
    expect(by("mv")).toBeUndefined(); // yesterday's consult only: not a machine today
  });

  it("R6 open_outbox — open until a chunk lands after the alert AND the levels moved since", async () => {
    const { degradedMessage } = await import("@/lib/room-watchdog");
    const body = degradedMessage("OPD 6", ["device_missing", "silent_while_recording"], new Date().toISOString()).text.replace(/'/g, "''");
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body, created_at)
             VALUES ('degraded', ARRAY['r6'], 'OPD 6', 'ok', 'degraded', 's', '${body}', ${ago("3 hours")}),
                    ('recovered', ARRAY['r6'], 'OPD 6', 'degraded', 'ok', 's', 'recovered', ${ago("10 minutes")});`);
    // (a) the false recovery: an outbox `recovered` row exists, but nothing proves audio
    let r = await attention();
    expect(kindsOf(r)).toEqual(["r6:open_outbox"]);
    expect(r.items[0]!.severity).toBe("red");
    expect(r.items[0]!.detail).toContain("no new recording has arrived since");
    // (b) a chunk but a frozen meter since the alert
    pg.exec(session("bs6", "r6", "2 hours", "ended") + chunkRow("c1", "bs6", "1 hour", 3_400_000) + samples("r6", "2 hours", "1 hour", "frozen", 60));
    r = await attention();
    expect(kindsOf(r)).toEqual(["r6:open_outbox"]);
    expect(r.items[0]!.detail).toContain("audio levels have not moved");
    // (c) the honest recovery: moving levels since (R6 clears on the FIRST evidence, by spec)
    pg.exec(`TRUNCATE bench_level_sample;` + samples("r6", "2 hours", "1 hour", "moving", 60));
    // (c1) Arch #20 DWELL: moving levels an hour ago are history. Nothing in the last 120 s, so the alert stands.
    expect(kindsOf(await attention())).toEqual(["r6:open_outbox"]);
    // (c2) the honest recovery: live, moving levels held through the last two minutes clear it
    pg.exec(samples("r6", "115 seconds", "0 seconds", "moving", 2));
    expect(await attention().then((x) => x.items)).toEqual([]);
    // (c3) tiny peaks with zero_ratio ~1 are not a recovery however many distinct values they have (OPD5, alerts 545-575)
    pg.exec(`TRUNCATE bench_level_sample; INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
             SELECT 'r6', (t AT TIME ZONE 'Asia/Kolkata')::date, t, 0.0001 + (extract(epoch from t)::bigint % 9) * 0.0004, 0.999, true, true
               FROM generate_series(${ago("115 seconds")}, ${ago("0 seconds")}, interval '2 seconds') t;`);
    expect(kindsOf(await attention())).toEqual(["r6:open_outbox"]);
  });

  it("R6 dwell SCOPE (F3): an alert that was NOT silent (device missing) clears on the old evidence; the dwell is for SILENT alerts only", async () => {
    const { degradedMessage } = await import("@/lib/room-watchdog");
    const body = degradedMessage("OPD 6", ["device_missing"], new Date().toISOString()).text.replace(/'/g, "''");
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body, created_at)
             VALUES ('degraded', ARRAY['r6'], 'OPD 6', 'ok', 'degraded', 's', '${body}', ${ago("3 hours")});`);
    pg.exec(session("bs6", "r6", "2 hours", "ended") + chunkRow("c1", "bs6", "1 hour", 3_400_000) + samples("r6", "2 hours", "1 hour", "moving", 60));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("R6 GATE — outbox alert + watchdog state ok + no session → NO item (Dietary closed for the day); state ok but a session open and no genuine recovery → item; state not ok → item", async () => {
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body, created_at)
             VALUES ('offline', ARRAY['r6'], 'OPD 6', 'ok', 'offline', 's', 'x', ${ago("30 hours")}),
                    ('recovered', ARRAY['r6'], 'OPD 6', 'offline', 'ok', 's', 'recovered', ${ago("29 hours")});
             INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'ok', ${ago("29 hours")});`);
    expect(await attention().then((x) => x.items)).toEqual([]);
    // a session opens (no chunk after the alert yet): the alert stands again
    pg.exec(session("bs6", "r6", "20 seconds"));
    expect(kindsOf(await attention())).toEqual(["r6:open_outbox"]);
    // session gone, but the watchdog state is not ok: the alert stands
    pg.exec(`TRUNCATE bench_session; UPDATE room_alert_state SET status = 'offline' WHERE room_id = 'r6';`);
    expect(kindsOf(await attention())).toEqual(["r6:open_outbox"]);
  });

  it("R6 — a chunk from a session that had ALREADY ended before the alert is not evidence (the session filter on the chunk EXISTS)", async () => {
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at) VALUES ('offline', ARRAY['r6'], 'OPD 6', 's', 'x', ${ago("3 hours")});`);
    pg.exec(session("old6", "r6", "9 hours", "ended", "5 hours") + chunkRow("c1", "old6", "2 hours", 3_400_000));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:open_outbox"]);
    expect(r.items[0]!.detail).toContain("no new recording has arrived since");
    // …but a session still open at the alert time that delivered a chunk after it is
    pg.exec(session("live6", "r6", "6 hours") + chunkRow("c2", "live6", "1 hour", 3_400_000) + samples("r6", "2 hours", "1 hour", "moving", 60) + samples("r6", "115 seconds", "0 seconds", "moving", 2));
    expect(kindsOf(await attention())).not.toContain("r6:open_outbox");
  });

  it("R6 — only the NEWEST offline/degraded alert counts, and an alert older than 7 days is history", async () => {
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at)
             VALUES ('offline', ARRAY['r4'], 'OPD 4', 's', 'old', ${ago("9 days")}),
                    ('offline', ARRAY['r6'], 'OPD 6', 's', 'x', ${ago("5 hours")}),
                    ('fleet_outage', ARRAY['r6','r4'], NULL, 's', 'x', ${ago("4 hours")});`);
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:open_outbox"]);
    expect(r.items[0]!.severity).toBe("red");
  });

  it("R7 stale_start — the newest failed start_day inside 60 minutes, quoting the ack reason; an older or acked one does not count", async () => {
    pg.exec(`
      INSERT INTO bench_command (id, room_id, kind, status, error, created_at, acked_at) VALUES
        ('k1', 'r6', 'start_day', 'failed', 'older failure', ${ago("50 minutes")}, ${ago("49 minutes")}),
        ('k2', 'r6', 'start_day', 'failed', 'tapewriter exited with status 1', ${ago("11 minutes")}, ${ago("10 minutes")}),
        ('k3', 'r4', 'start_day', 'failed', 'too old', ${ago("2 hours")}, ${ago("119 minutes")}),
        ('k4', 'r4', 'start_day', 'acked', NULL, ${ago("5 minutes")}, ${ago("4 minutes")}),
        ('k5', 'r4', 'end_day', 'failed', 'wrong kind', ${ago("5 minutes")}, ${ago("4 minutes")});
    `);
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:stale_start"]);
    expect(r.items[0]!.detail).toContain('"tapewriter exited with status 1"');
    // a session opened after the failure resolves it
    pg.exec(session("bs6", "r6", "5 minutes", "recording") + samples("r6", "4 minutes", "1 second", "moving"));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("Arch #21 R3 — a re-home session (started AFTER the alert) clears neither stale_start nor the reap alert; a real new session still does", async () => {
    pg.exec(`
      INSERT INTO bench_command (id, room_id, kind, status, error, created_at, acked_at) VALUES
        ('kr', 'r6', 'start_day', 'failed', 'tapewriter exited with status 1', ${ago("11 minutes")}, ${ago("10 minutes")});
      INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body, created_at)
        VALUES ('session_reaped', ARRAY['r6'], 'OPD 6', NULL, 'clinic_hours', 'reaped', 'OPD 6 session bs_old was ended by the system during clinic hours', ${ago("20 minutes")});
      INSERT INTO bench_session (id, room_id, started_at, ended_at, status, notes)
        VALUES ('bs_old', 'r6', ${ago("3 hours")}, ${ago("20 minutes")}, 'ended', 'auto-ended: no chunks >30m (reaper)'),
               ('bs_home', 'r6', ${ago("5 minutes")}, ${ago("4 minutes")}, 'ended', 're-homed after reap of bs_old');
    `);
    expect(kindsOf(await attention())).toEqual(["r6:session_reaped", "r6:stale_start"]);
    pg.exec(session("bs_new", "r6", "2 minutes", "recording") + samples("r6", "2 minutes", "1 second", "moving"));
    expect(kindsOf(await attention())).toEqual([]);
  });

  it("Arch #17 C1/C2 — a start the app ACCEPTED as deferred is stale_start after two minutes with no session; a late failure ack quotes its reason; any session after it clears it", async () => {
    const { ackCommand } = await import("@/lib/bench-commands");
    pg.exec(`INSERT INTO bench_command (id, room_id, kind, status, created_at) VALUES ('cmd_def', 'r6', 'start_day', 'pending', ${ago("6 minutes")});`);
    // the app's deferred ack: {ok:true, deferred:true}, no session
    expect(await ackCommand({ roomId: "r6", commandId: "cmd_def", ok: true, sessionId: null, error: null, applied: { deferred: true } })).toBe("acked");
    pg.exec(`UPDATE bench_command SET acked_at = ${ago("5 minutes")} WHERE id = 'cmd_def';`);
    let r = await attention();
    expect(kindsOf(r)).toEqual(["r6:stale_start"]);
    expect(r.items[0]!.detail).toContain("start deferred (waiting for the input device) and no recording has begun");
    // young deferred starts are not yet an alert (the wait is still allowed to finish)
    pg.exec(`UPDATE bench_command SET acked_at = ${ago("30 seconds")} WHERE id = 'cmd_def';`);
    expect(await attention().then((x) => x.items)).toEqual([]);
    pg.exec(`UPDATE bench_command SET acked_at = ${ago("5 minutes")} WHERE id = 'cmd_def';`);
    // the app's wait ended in failure: a failed ack on the SAME command, with the fixed reason
    expect(await ackCommand({ roomId: "r6", commandId: "cmd_def", ok: false, sessionId: null, error: "input_device_not_ready" })).toBe("failed");
    pg.exec(`UPDATE bench_command SET acked_at = ${ago("4 minutes")} WHERE id = 'cmd_def';`);
    r = await attention();
    expect(kindsOf(r)).toEqual(["r6:stale_start"]);
    expect(r.items[0]!.detail).toContain('"input_device_not_ready"');
    // any session that opens after the ack resolves it (accepted-then-started is success)
    pg.exec(session("bs_after", "r6", "2 minutes", "recording") + samples("r6", "2 minutes", "1 second", "moving"));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("a source that cannot be read is NAMED in `degraded` and its rules are skipped, never reported as all clear", async () => {
    pg.exec(`ALTER TABLE eta_encounter_windows RENAME TO eta_encounter_windows_gone;`);
    try {
      const r = await attention();
      expect(r.degraded).toEqual(["eta_encounter_windows"]);
      expect(r.items).toEqual([]);
    } finally {
      pg.exec(`ALTER TABLE eta_encounter_windows_gone RENAME TO eta_encounter_windows;`);
    }
  });
});

describe.runIf(HAVE_DOCKER)("loadRecoveryEvidence + persistPlan against postgres", () => {
  it("C1 (ARCH-14 refute): a room degraded for ANOTHER reason that then goes digital-silent is held to the dwell too (silent_alert from the level log, in the watchdog and in fleet attention)", async () => {
    const { loadRecoveryEvidence } = await import("@/lib/room-watchdog");
    const { degradedMessage } = await import("@/lib/room-watchdog");
    const body = degradedMessage("OPD 6", ["device_missing"], new Date().toISOString()).text.replace(/'/g, "''");
    pg.exec(`INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'degraded', ${ago("3 hours")});
             INSERT INTO room_alert_outbox (kind, room_ids, room_name, status_from, status_to, subject, body, created_at)
             VALUES ('degraded', ARRAY['r6'], 'OPD 6', 'ok', 'degraded', 's', '${body}', ${ago("3 hours")});`);
    pg.exec(session("bs6", "r6", "2 hours", "ended") + chunkRow("c1", "bs6", "1 hour", 3_400_000));
    const zeros = (count: number) => `INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
      SELECT 'r6', (t AT TIME ZONE 'Asia/Kolkata')::date, t, 0.0004, 1.0, true, true
        FROM generate_series(now() - interval '100 minutes', now() - interval '100 minutes' + (${count - 1} * interval '1 second'), interval '1 second') t;`;
    // the C270 comes back reading zeros (S15 shape), then three live-looking ticks in the last two minutes
    const ticks = `INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing) VALUES
      ('r6', (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '20 seconds', 0.03, 0.1, true, true),
      ('r6', (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '15 seconds', 0.05, 0.1, true, true),
      ('r6', (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '10 seconds', 0.04, 0.1, true, true);`;
    // 10 digital-silence samples: not an episode. The device-missing alert recovers as before (scope).
    pg.exec(zeros(10) + ticks);
    expect((await loadRecoveryEvidence()).get("r6")!.silent_alert).toBe(false);
    expect(await attention().then((x) => x.items)).toEqual([]);
    // 100 digital-silence samples since the alert (>= SILENT_POLLS): the alert is now held to the dwell, and 3 live ticks do not clear it
    pg.exec(`TRUNCATE bench_level_sample;` + zeros(100) + ticks);
    expect((await loadRecoveryEvidence()).get("r6")!.silent_alert).toBe(true);
    expect(kindsOf(await attention())).toEqual(["r6:open_outbox"]);
    // samples from BEFORE the alert began do not count
    pg.exec(`TRUNCATE bench_level_sample;` + `INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
      SELECT 'r6', (t AT TIME ZONE 'Asia/Kolkata')::date, t, 0.0004, 1.0, true, true
        FROM generate_series(now() - interval '5 hours', now() - interval '5 hours' + interval '99 seconds', interval '1 second') t;` + ticks);
    expect((await loadRecoveryEvidence()).get("r6")!.silent_alert).toBe(false);
  });

  it("the dwell's SQL: live = zero_ratio < 0.5 AND peak >= 0.005, counted over the last 120 s only; dead, floor-miss and NULL-ratio samples are not live; silent_alert follows the newest alert body", async () => {
    const { loadRecoveryEvidence, RECOVERY_LIVE_MAX_ZERO_RATIO, RECOVERY_LIVE_MIN_PEAK } = await import("@/lib/room-watchdog");
    expect([RECOVERY_LIVE_MAX_ZERO_RATIO, RECOVERY_LIVE_MIN_PEAK]).toEqual([0.5, 0.005]);
    pg.exec(`INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'degraded', ${ago("3 hours")});`);
    let n = 0;
    const rows: string[] = [];
    const add = (count: number, peak: number, zr: number | "NULL") => {
      for (let i = 0; i < count; i++) {
        n += 1;
        rows.push(`('r6', (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '${n} seconds', ${peak}, ${zr}, true, true)`);
      }
    };
    add(10, 0.02, 0.1);     // live
    add(3, 0.006, 0.1);     // live: above the 0.005 recovery floor (below the 0.01 fire floor)
    add(4, 0.004, 0.1);     // dead: under the recovery floor
    add(5, 0.02, 0.7);      // dead: zero_ratio 0.7 is not "well under" digital silence (kills 0.5 -> 0.99)
    add(5, 0.0003, 0.999);  // dead: the 545-575 flap shape
    add(2, 0.05, "NULL");   // dead: no ratio, no claim
    pg.exec(`INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing) VALUES ${rows.join(",")};`);
    // an old live sample outside the window must not count
    pg.exec(`INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
             VALUES ('r6', (now() AT TIME ZONE 'Asia/Kolkata')::date, now() - interval '5 minutes', 0.3, 0.0, true, true);`);
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at)
             VALUES ('degraded', ARRAY['r6'], 'OPD 6', 's', 'OPD 6 is polling but its capture looks degraded — digital silence on the capture (exact zeros, not a quiet room) — go and look', ${ago("3 hours")});`);
    let ev = (await loadRecoveryEvidence()).get("r6")!;
    expect(ev).toMatchObject({ live_samples: 13, total_samples: 29, silent_alert: true });
    // a DEVICE_MISSING-only degraded alert is not a silent one: the dwell does not apply to it
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at)
             VALUES ('degraded', ARRAY['r6'], 'OPD 6', 's', 'OPD 6 is polling but its capture looks degraded — a missing input device — go and look', ${ago("1 hour")});`);
    expect((await loadRecoveryEvidence()).get("r6")!.silent_alert).toBe(false);
    // an offline alert is not a silent one either
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at)
             VALUES ('offline', ARRAY['r6'], 'OPD 6', 's', 'OPD 6 has not polled', ${ago("30 minutes")});`);
    expect((await loadRecoveryEvidence()).get("r6")!.silent_alert).toBe(false);
    // the pre-Arch-14 wording still counts as silent
    pg.exec(`INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at)
             VALUES ('degraded', ARRAY['r6'], 'OPD 6', 's', 'OPD 6 is polling but its capture looks degraded — silence while recording — go and look', ${ago("10 minutes")});`);
    ev = (await loadRecoveryEvidence()).get("r6")!;
    expect(ev.silent_alert).toBe(true);
    // and the whole thing refuses this window (13 live of 29 is under the 20-sample floor)
    const { isGenuineRecovery } = await import("@/lib/room-watchdog");
    expect(isGenuineRecovery({ ...ev, chunk_after_alert: true })).toBe(false);
  });

  it("loadRecoveryEvidence reports, per non-ok room, a chunk after the alert and the distinct levels of the last 120 s", async () => {
    const { loadRecoveryEvidence } = await import("@/lib/room-watchdog");
    pg.exec(`
      INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'degraded', ${ago("3 hours")}), ('r4', 'ok', ${ago("3 hours")});
      ${session("bs6", "r6", "2 hours", "ended")}
      ${samples("r6", "100 seconds", "1 second", "frozen")}
    `);
    let m = await loadRecoveryEvidence();
    expect([...m.keys()]).toEqual(["r6"]);
    expect(m.get("r6")).toMatchObject({ chunk_after_alert: false, distinct_levels: 1, live_samples: 20, total_samples: 20 });
    // a chunk older than the alert does not count; one after it does
    pg.exec(chunkRow("c0", "bs6", "4 hours", 3_400_000));
    m = await loadRecoveryEvidence();
    expect(m.get("r6")!.chunk_after_alert).toBe(false);
    pg.exec(chunkRow("c1", "bs6", "1 hour", 3_400_000) + `TRUNCATE bench_level_sample;` + samples("r6", "100 seconds", "1 second", "moving"));
    m = await loadRecoveryEvidence();
    expect(m.get("r6")!.chunk_after_alert).toBe(true);
    expect(m.get("r6")!.distinct_levels).toBeGreaterThanOrEqual(2);
    // samples older than 120 s are outside the window
    pg.exec(`TRUNCATE bench_level_sample;` + samples("r6", "10 minutes", "5 minutes", "moving"));
    expect((await loadRecoveryEvidence()).get("r6")!.distinct_levels).toBe(0);
  });

  it("loadRecoveryEvidence — a chunk of a session that ended BEFORE the alert is not evidence", async () => {
    const { loadRecoveryEvidence } = await import("@/lib/room-watchdog");
    pg.exec(`INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'degraded', ${ago("3 hours")});`);
    pg.exec(session("old6", "r6", "9 hours", "ended", "5 hours") + chunkRow("c1", "old6", "1 hour", 3_400_000));
    expect((await loadRecoveryEvidence()).get("r6")!.chunk_after_alert).toBe(false);
    pg.exec(session("live6", "r6", "6 hours") + chunkRow("c2", "live6", "30 minutes", 3_400_000));
    expect((await loadRecoveryEvidence()).get("r6")!.chunk_after_alert).toBe(true);
  });

  it("CLOSE WITHOUT PROOF (F4, Arch #20) through persistPlan: a degraded room that polls clean with no session open is written to ok AND gets one recovery row; the next outage queues its alert", async () => {
    const { planWatchdogRun, persistPlan } = await import("@/lib/room-watchdog");
    const now = Date.now();
    pg.exec(`INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'degraded', ${ago("14 hours")});`);
    const clean = { last_seen_at: new Date(now - 5_000).toISOString(), tape_advancing: false, session_open: false, disk_free_bytes: 50_000_000_000, state_flags: [] as string[], open_session: null };
    const closeRun = planWatchdogRun([
      { room_id: "r6", room_name: "OPD 6", facts: clean, prior: { status: "degraded", since: "2026-10-05T05:00:00.000Z" }, muted: false, recovery_evidence: { chunk_after_alert: false, distinct_levels: 0 } },
    ], now);
    expect(closeRun.messages.map((m) => m.kind)).toEqual(["recovered"]);
    expect(await persistPlan(closeRun)).toBe(1);
    expect(await pg.sql`SELECT status FROM room_alert_state WHERE room_id = 'r6'`).toEqual([{ status: "ok" }]);
    expect(await pg.sql`SELECT kind, room_ids FROM room_alert_outbox`).toEqual([{ kind: "recovered", room_ids: ["r6"] }]);
    // next day: a new outage is an ok → degraded edge again, so it queues a message
    const later = now + 20 * 3_600_000;
    const next = planWatchdogRun([
      { room_id: "r6", room_name: "OPD 6", facts: { ...clean, last_seen_at: new Date(later - 5_000).toISOString(), session_open: true, tape_advancing: true, state_flags: ["DEVICE_MISSING"] }, prior: { status: "ok", since: new Date(now).toISOString() }, muted: false },
    ], later);
    expect(await persistPlan(next)).toBe(1);
    expect(await pg.sql`SELECT kind FROM room_alert_outbox ORDER BY id`).toEqual([{ kind: "recovered" }, { kind: "degraded" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// F3 — every read of the two big tables rides an index. Proven by EXPLAIN (ANALYZE) on the statements the loader ACTUALLY sent, at volume.
// ---------------------------------------------------------------------------------------------------------------------------------------------

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Index Name"?: string; "Index Cond"?: string; Filter?: string; "Actual Loops"?: number; Plans?: PlanNode[] };
const walk = (n: PlanNode, out: PlanNode[] = []): PlanNode[] => { out.push(n); for (const c of n.Plans ?? []) walk(c, out); return out; };
const lit = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  const s = Array.isArray(v) ? `{${v.map((e) => `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}` : String(v);
  return `'${s.replace(/'/g, "''")}'`;
};

describe.runIf(HAVE_DOCKER)("F3 — the bench_level_sample / bench_chunk reads never sequential-scan", () => {
  it("at volume (≈110k level samples, 3 days of history, 60 other rooms; ≈30k chunks), no statement the loader sends Seq Scans bench_level_sample or bench_chunk, and the level reads use the (room_id, ist_date, sampled_at) index", async () => {
    // the real rooms: 3 days of samples every 15 s; 60 decoy rooms: 3 days every 5 min; 300 decoy sessions of 100 chunks each
    pg.exec(`
      INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
      SELECT r, (t AT TIME ZONE 'Asia/Kolkata')::date, t, random(), random(), true, true
        FROM unnest(ARRAY['r4','r6','r7']) r, generate_series(now() - interval '3 days', now(), interval '15 seconds') t;
      INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, zero_ratio, session_open, tape_advancing)
      SELECT 'decoy' || d, (t AT TIME ZONE 'Asia/Kolkata')::date, t, random(), random(), true, true
        FROM generate_series(1, 60) d, generate_series(now() - interval '3 days', now(), interval '5 minutes') t;
      INSERT INTO bench_session (id, room_id, started_at, ended_at, status)
      SELECT 'ds' || s, 'decoy' || (s % 60), now() - (s || ' minutes')::interval * 9, now() - (s || ' minutes')::interval * 9 + interval '1 hour', 'ended'
        FROM generate_series(1, 300) s;
      INSERT INTO bench_chunk (id, session_id, source, idx, created_at, started_at, size_bytes, duration_ms)
      SELECT 'dc' || s || '_' || i, 'ds' || s, 'primary', i, now() - (s * 9 || ' minutes')::interval + (i || ' minutes')::interval, now() - (s * 9 || ' minutes')::interval, 3400000, 300000
        FROM generate_series(1, 300) s, generate_series(1, 100) i;
    `);
    // a frozen open session on r6 (so the per-room frozen-since read runs) with a recent chunk, an open alert (so the R6 read runs), a live window, a failed start
    pg.exec([
      `DELETE FROM bench_level_sample WHERE room_id = 'r6' AND sampled_at > ${ago("20 minutes")};`,
      session("bs6", "r6", "3 hours"), samples("r6", "20 minutes", "1 second", "frozen"), chunkRow("c1", "bs6", "3 minutes", 3_400_000),
      presence("ext", M6, "locked", "30 minutes"), presence("poller", M4, "unreachable", "12 minutes"), presence("poller", M4, "unreachable", "1 minute"),
      `INSERT INTO room_alert_outbox (kind, room_ids, room_name, subject, body, created_at) VALUES ('degraded', ARRAY['r4'], 'OPD 4', 's', 'x', ${ago("3 hours")});`,
      `INSERT INTO bench_command (id, room_id, kind, status, error, created_at, acked_at) VALUES ('k1', 'r4', 'start_day', 'failed', 'x', ${ago("11 minutes")}, ${ago("10 minutes")});`,
      `ANALYZE bench_level_sample; ANALYZE bench_chunk; ANALYZE bench_session;`,
    ].join("\n"));

    H.rec.length = 0;
    const r = await attention();
    expect(r.degraded).toBeUndefined();
    expect(kindsOf(r)).toContain("r6:capture_frozen"); // the frozen-since lookup ran
    expect(kindsOf(r)).toContain("r4:open_outbox"); // the R6 lookup ran

    const heavy = H.rec.filter((x) => /bench_level_sample|bench_chunk/.test(x.q));
    // level reads: the window, the newest-per-room, the R6 lookup, the frozen-since lookup; chunk reads: the 30-minute fleet read and R6's EXISTS
    expect(heavy.length).toBeGreaterThanOrEqual(5);
    const usedIndexes = new Set<string>();
    for (const { q, v } of heavy) {
      const text = q.replace(/\$(\d+)/g, (_m, n) => lit(v[Number(n) - 1]));
      const raw = (await pg.sql`SELECT explain_json(${text}) AS plan`) as Array<{ plan: string }>;
      const nodes = walk((JSON.parse(raw[0]!.plan) as Array<{ Plan: PlanNode }>)[0]!.Plan);
      const seq = nodes.filter((n) => n["Node Type"] === "Seq Scan" && (n["Relation Name"] === "bench_level_sample" || n["Relation Name"] === "bench_chunk"));
      expect(seq.map((n) => n["Relation Name"]), `Seq Scan in: ${q.replace(/\s+/g, " ").slice(0, 160)}`).toEqual([]);
      for (const n of nodes) if (n["Index Name"]) usedIndexes.add(n["Index Name"]);
      if (process.env.FA_EXPLAIN_DEBUG) console.log(q.replace(/\s+/g, " ").slice(0, 70), "=>", nodes.map((n) => `${n["Node Type"]}:${n["Relation Name"] ?? ""}${n["Index Name"] ? "@" + n["Index Name"] : ""}`).join(" | "));
    }
    expect(usedIndexes.has("bench_level_sample_room_day_time_idx")).toBe(true);
    expect([...usedIndexes].sort().join(",")).toContain("bench_chunk_session_source_idx_key"); // the chunk reads go through (session_id, source, idx)
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// R8 / R9 and lib/encounter-windows/ext-health.ts — the extension-health SELECTs against a real postgres.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const extHealthNow = async (asOf?: Date) => {
  const { extHealth } = await import("@/lib/encounter-windows/ext-health");
  const { sql } = await import("@/lib/db");
  return extHealth(sql as never, asOf ? { asOf } : {});
};
const POLLER_OK = (user = "console-a", chrome = true) => `{"state":"ok","chrome_running":${chrome},"console_user":"${user}"}`;
const extRow = (machine: string, event: string, when: string, payload = "{}") => presence("ext", machine, event, when, payload);

describe.runIf(HAVE_DOCKER)("extension health against postgres (R8 / R9)", () => {
  it("the 4 Oct Cardiology case: extension rows stop 25 h ago while the poller says ok + chrome_running = missing, RED on the attention list; a live current extension is ok; an unreachable poller is offline", async () => {
    pg.exec([
      // r7 — vanished extension
      extRow(M7, "heartbeat", "26 hours", '{"ext_version":"0.1.0.36"}'), extRow(M7, "active", "25 hours", '{"ext_version":"0.1.0.36"}'),
      presence("poller", M7, "ok", "30 seconds", POLLER_OK()), presence("poller", M7, "ok", "90 seconds", POLLER_OK()),
      // r6 — alive, current
      extRow(M6, "heartbeat", "10 seconds", '{"ext_version":"0.1.1.40","tab_focus":false}'), presence("poller", M6, "ok", "20 seconds", POLLER_OK("console-b")),
      // r4 — poller unreachable
      extRow(M4, "heartbeat", "9 hours", '{"ext_version":"0.1.0.36"}'), presence("poller", M4, "unreachable", "30 seconds", '{"state":"unreachable"}'),
    ].join("\n"));
    const rows = await extHealthNow();
    const by = Object.fromEntries(rows.map((r) => [r.room_id, r]));
    expect(by.r7).toMatchObject({ status: "missing", ext_version: "0.1.0.36", version_state: "behind", poller: { ok: true, chrome_running: true, console_user: "console-a" } });
    expect(by.r7!.ext_age_s).toBeGreaterThan(25 * 3600 - 5);
    expect(by.r6).toMatchObject({ status: "ok", version_state: "current", ext_version: "0.1.1.40" });
    expect(by.r4).toMatchObject({ status: "offline" });

    const r = await attention();
    expect(r.degraded).toBeUndefined();
    const item = r.items.find((i) => i.room_id === "r7" && i.kind === "extension_missing")!;
    expect(item).toBeDefined();
    expect(item.severity).toBe("red");
    expect(item.detail).toContain("CONSUL 4");
    expect(item.detail).toContain(M7);
    expect(item.detail).toContain("version 0.1.0.36");
    expect(item.action).toBe("Re-run the presence install on CONSUL 4 (policy file lost, usually after a reboot).");
    expect(kindsOf(r).filter((k) => k.includes("extension"))).toEqual(["r7:extension_missing"]);
  });

  it("no_tab: a tab_closed logout 30 minutes ago on a reachable Mac with Chrome running is not missing and raises nothing", async () => {
    pg.exec([
      extRow(M7, "heartbeat", "2 hours", '{"ext_version":"0.1.1.40"}'), extRow(M7, "logout", "30 minutes", '{"ext_version":"0.1.1.40","reason":"tab_closed"}'),
      presence("poller", M7, "ok", "30 seconds", POLLER_OK()),
    ].join("\n"));
    expect((await extHealthNow()).find((r) => r.room_id === "r7")).toMatchObject({ status: "no_tab" });
    expect(kindsOf(await attention()).filter((k) => k.includes("extension"))).toEqual([]);
  });

  it("behind: alive on 0.1.0.36 since 90 min ago (after an at-target row at 100 min, with a garbage version in the middle that must not break the cast) = behind, behind_since ~90 min, and ONE amber fleet-level R9 row", async () => {
    pg.exec([
      extRow(M6, "heartbeat", "110 minutes", '{"ext_version":"0.1.1.40"}'), extRow(M6, "heartbeat", "100 minutes", '{"ext_version":"0.1.1.40"}'),
      extRow(M6, "heartbeat", "90 minutes", '{"ext_version":"0.1.0.36"}'), extRow(M6, "heartbeat", "75 minutes", '{"ext_version":"junk"}'),
      extRow(M6, "heartbeat", "50 minutes", '{"ext_version":"0.1.0.36"}'), extRow(M6, "heartbeat", "20 seconds", '{"ext_version":"0.1.0.36"}'),
      extRow(M6, "heartbeat", "10 seconds", '{"tab_focus":false}'), // a row with no version at all
      presence("poller", M6, "ok", "20 seconds", POLLER_OK("console-b")),
    ].join("\n"));
    const row = (await extHealthNow()).find((r) => r.room_id === "r6")!;
    expect(row).toMatchObject({ status: "behind", ext_version: "0.1.0.36", version_state: "behind", behind_at_floor: false });
    const dbNow = Date.now();
    expect(minutesBetween(row.behind_since as string, dbNow - 90 * 60_000)).toBeLessThan(3);
    const item = (await attention()).items.find((i) => i.kind === "extension_behind")!;
    expect(item).toMatchObject({ room_id: "fleet", room_name: "Fleet", machine: null, severity: "amber" });
    expect(item.detail).toContain("1 room on old extension builds: OPD 6 (0.1.0.36); update to 0.1.1.40.");
    expect(item.detail).not.toContain("at least");
    expect(item.action).toContain("Update the Pulse Presence extension");
  });

  it("behind for under an hour raises nothing yet; a machine behind for the whole 2 h look-back is dated by its floor (a lower bound), says 'at least 2 h', and two such rooms are ONE row", async () => {
    pg.exec([
      extRow(M6, "heartbeat", "30 minutes", '{"ext_version":"0.1.1.40"}'), extRow(M6, "heartbeat", "20 minutes", '{"ext_version":"0.1.0.36"}'), extRow(M6, "heartbeat", "10 seconds", '{"ext_version":"0.1.0.36"}'),
      presence("poller", M6, "ok", "20 seconds", POLLER_OK("console-b")),
    ].join("\n"));
    expect(kindsOf(await attention()).filter((k) => k.includes("extension"))).toEqual([]);
    pg.exec(`TRUNCATE pulse_presence_events;` + [
      extRow(M6, "heartbeat", "3 hours", '{"ext_version":"0.1.0.30"}'), extRow(M6, "heartbeat", "119 minutes 30 seconds", '{"ext_version":"0.1.0.30"}'), extRow(M6, "heartbeat", "10 seconds", '{"ext_version":"0.1.0.36"}'),
      presence("poller", M6, "ok", "20 seconds", POLLER_OK("console-b")),
      extRow(M4, "heartbeat", "100 minutes", '{"ext_version":"0.1.0.33"}'), extRow(M4, "heartbeat", "10 seconds", '{"ext_version":"0.1.0.33"}'),
      presence("poller", M4, "ok", "20 seconds", POLLER_OK("console-b")),
    ].join("\n"));
    const rows = await extHealthNow();
    const r6 = rows.find((r) => r.room_id === "r6")!;
    expect(minutesBetween(r6.behind_since as string, Date.now() - 119.5 * 60_000)).toBeLessThan(3); // the 3-hour-old row is outside the window
    expect(r6.behind_at_floor).toBe(true);
    expect(rows.find((r) => r.room_id === "r4")).toMatchObject({ status: "behind", behind_at_floor: false });
    const r = await attention();
    expect(kindsOf(r).filter((k) => k.includes("extension"))).toEqual(["fleet:extension_behind"]);
    const item = r.items.find((i) => i.kind === "extension_behind")!;
    expect(item.detail).toBe("2 rooms on old extension builds: OPD 6 (0.1.0.36), OPD 4 (0.1.0.33); update to 0.1.1.40. Behind for at least 2 h.");
  });

  it("EXCLUDED machines (Home Office, ORB3, ORB2) never appear, even silent with an ok poller and Chrome running; the clinic Macs still do", async () => {
    pg.exec(`
      INSERT INTO room (id, slug, name) VALUES ('rh', 'home-office-x', 'Home Office'), ('ro3', 'orb3-x', 'ORB3'), ('ro2', 'orb2-x', 'ORB2');
      INSERT INTO room_install (install_id, room_id, hostname, enrolled_at) VALUES
        ('ih', 'rh', 'Vinay’s Mac mini', now() - interval '30 days'), ('io3', 'ro3', 'ORBOX3', now() - interval '30 days'), ('io2', 'ro2', 'vinay-orb2', now() - interval '30 days');
    ` + [
      presence("poller", "Vinays-Mac-mini", "ok", "30 seconds", POLLER_OK()), presence("poller", "ORBOX3", "ok", "30 seconds", POLLER_OK()), presence("poller", "vinay-orb2", "ok", "30 seconds", POLLER_OK()),
      presence("poller", M7, "ok", "30 seconds", POLLER_OK()),
    ].join("\n"));
    const rows = await extHealthNow();
    expect(rows.map((r) => r.room_id).sort()).toEqual(["r4", "r6", "r7"]);
    const r = await attention();
    expect(r.rooms_checked).toBe(6);
    expect(kindsOf(r).filter((k) => /^(rh|ro3|ro2):/.test(k) && k.includes("extension"))).toEqual([]);
    expect(kindsOf(r)).toContain("r7:extension_missing");
  });

  it("one read per presence table lookup, bound values only, and at volume (≈80k ext rows, ≈80k poller rows over 14 days) no statement Seq Scans pulse_presence_events — every read rides (machine, ts)", async () => {
    pg.exec(`
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      SELECT 'ext', m, 'heartbeat', t, '{"ext_version":"0.1.0.36","tab_focus":false}'::jsonb
        FROM unnest(ARRAY['${M6}', '${M4}', '${M7}', 'EHRC-DECOY1s-Mac-mini', 'EHRC-DECOY2s-Mac-mini', 'EHRC-DECOY3s-Mac-mini']) m,
             generate_series(now() - interval '3 days', now(), interval '5 minutes') t;
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      SELECT 'ext', m, 'heartbeat', t, '{"ext_version":"0.1.0.36","tab_focus":false}'::jsonb
        FROM unnest(ARRAY['${M6}', '${M7}']) m, generate_series(now() - interval '3 days', now() - interval '1 minute', interval '15 seconds') t;
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      SELECT 'poller', m, 'ok', t, '{"state":"ok","chrome_running":true,"console_user":"u"}'::jsonb
        FROM unnest(ARRAY['${M6}', '${M4}', '${M7}', 'EHRC-DECOY1s-Mac-mini', 'EHRC-DECOY2s-Mac-mini', 'EHRC-DECOY3s-Mac-mini']) m,
             generate_series(now() - interval '3 days', now(), interval '1 minute') t;
      DELETE FROM pulse_presence_events WHERE source = 'poller' AND machine = '${M4}' AND ts > now() - interval '5 minutes';
      INSERT INTO pulse_presence_events (source, machine, event, ts, payload)
      SELECT 'poller', '${M4}', 'ok', t, '{"state":"ok","chrome_running":false,"console_user":"u","idle_s":30}'::jsonb
        FROM generate_series(now() - interval '4 minutes', now(), interval '1 minute') t;
      ANALYZE pulse_presence_events;
    `);
    H.rec.length = 0;
    const rows = await extHealthNow();
    expect(rows.find((r) => r.room_id === "r6")!.status).toBe("behind");
    expect(rows.find((r) => r.room_id === "r4")!.status).toBe("no_chrome");
    const mine = H.rec.filter((x) => /ext_version|idle_s|chrome_down_since/.test(x.q) && /pulse_presence_events/.test(x.q));
    expect(mine.length).toBeGreaterThanOrEqual(4); // the three LATERAL lookups (one statement), the behind-since read, the Chrome-down read and the poller-history read
    for (const { q } of H.rec) {
      expect(q).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
      expect(q).not.toContain("EHRC-");
    }
    const usedIndexes = new Set<string>();
    let extScans = 0;
    for (const { q, v } of mine) {
      const text = q.replace(/\$(\d+)/g, (_m, n) => lit(v[Number(n) - 1]));
      const raw = (await pg.sql`SELECT explain_json(${text}) AS plan`) as Array<{ plan: string }>;
      const nodes = walk((JSON.parse(raw[0]!.plan) as Array<{ Plan: PlanNode }>)[0]!.Plan);
      if (process.env.FA_EXPLAIN_DEBUG) console.log(q.replace(/\s+/g, " ").slice(0, 70), "=>", nodes.map((n) => `${n["Node Type"]}:${n["Relation Name"] ?? ""}${n["Index Name"] ? "@" + n["Index Name"] : ""}`).join(" | "));
      const seq = nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "pulse_presence_events");
      expect(seq.length, `Seq Scan of pulse_presence_events in: ${q.replace(/\s+/g, " ").slice(0, 120)}`).toBe(0);
      for (const n of nodes) if (n["Index Name"]) usedIndexes.add(n["Index Name"]);
      // EXTENSION lookups scan ONE key per machine (the full hostname): equality on the machine's own name, one loop per fleet machine — never the
      // alias set (that triples the buffers read on every 30 s poll). The short poller keys are for poller lookups only.
      for (const n of nodes.filter((x) => x["Relation Name"] === "pulse_presence_events" && /'ext'/.test(`${x.Filter ?? ""} ${x["Index Cond"] ?? ""}`))) {
        extScans++;
        const cond = `${n["Index Cond"] ?? ""} ${n.Filter ?? ""}`;
        expect(cond, `ext lookup must use the machine name alone: ${cond}`).toMatch(/machine = (\(?m\.n|\w+\.n)\b/);
        expect(cond).not.toMatch(/k\.key|keys|ANY/);
        expect(n["Actual Loops"] ?? 0, "one loop per fleet machine (3 rooms), not one per spelling").toBeLessThanOrEqual(3);
      }
    }
    expect(extScans).toBeGreaterThanOrEqual(3); // newest event, newest version, behind-since
    expect(usedIndexes.has("pulse_presence_events_machine_ts_idx")).toBe(true);
  }, 180_000);
});

describe.runIf(HAVE_DOCKER)("extension health against postgres (no_chrome / R10, reboot flag)", () => {
  const pollerRow = (machine: string, event: string, when: string, payload: string) => presence("poller", machine, event, when, payload);

  it("no_chrome: poller ok + chrome_running=false (after chrome_running=true earlier) = no_chrome, chrome_down_since is where the false run began, AMBER R10 and NO R8 — a stale extension no longer reads as missing", async () => {
    pg.exec([
      extRow(M7, "heartbeat", "3 hours", '{"ext_version":"0.1.1.40"}'),
      pollerRow(M7, "ok", "3 hours", POLLER_OK()), pollerRow(M7, "ok", "50 minutes", POLLER_OK()),
      pollerRow(M7, "ok", "40 minutes", POLLER_OK("console-a", false)), pollerRow(M7, "ok", "20 minutes", POLLER_OK("console-a", false)), pollerRow(M7, "ok", "30 seconds", POLLER_OK("console-a", false)),
    ].join("\n"));
    const row = (await extHealthNow()).find((r) => r.room_id === "r7")!;
    expect(row).toMatchObject({ status: "no_chrome", poller: { ok: true, chrome_running: false } });
    expect(minutesBetween(row.chrome_down_since as string, Date.now() - 40 * 60_000)).toBeLessThan(2);
    const r = await attention();
    expect(r.degraded).toBeUndefined();
    const item = r.items.find((i) => i.room_id === "r7" && i.kind === "chrome_not_running");
    const istMin = Math.floor(((Date.now() + 19_800_000) % 86_400_000) / 60_000);
    if (istMin >= 8 * 60 + 1 && istMin < 21 * 60 + 29) {
      // R10 speaks only 08:00-21:30 IST (the unit tests pin the edges); the database's clock decides which branch this run takes.
      expect(item).toMatchObject({ severity: "amber", detail: "Chrome is not running on CONSUL 4; presence cannot report.", action: "Open Chrome on the kiosk (or wait for the Kiosk Bot)." });
      expect(minutesBetween(item!.since, Date.now() - 40 * 60_000)).toBeLessThan(2);
    } else if (istMin < 7 * 60 + 59 || istMin >= 21 * 60 + 31) {
      expect(item).toBeUndefined();
    }
    expect(kindsOf(r).filter((k) => k.startsWith("r7:") && k.includes("extension"))).toEqual([]);
  });

  it("missing stays RED when chrome_running=true, and a never-chrome-true history still resolves a start (24 h look-back)", async () => {
    pg.exec([extRow(M7, "heartbeat", "5 hours", '{"ext_version":"0.1.1.40"}'), pollerRow(M7, "ok", "30 seconds", POLLER_OK())].join("\n"));
    expect(kindsOf(await attention()).filter((k) => k.startsWith("r7:"))).toEqual(["r7:extension_missing"]);
    pg.exec(`TRUNCATE pulse_presence_events;` + [pollerRow(M7, "ok", "2 hours", POLLER_OK("console-a", false)), pollerRow(M7, "ok", "30 seconds", POLLER_OK("console-a", false))].join("\n"));
    const row = (await extHealthNow()).find((r) => r.room_id === "r7")!;
    expect(row.status).toBe("no_chrome");
    expect(minutesBetween(row.chrome_down_since as string, Date.now() - 2 * 3_600_000)).toBeLessThan(2);
  });

  it("rebooted_recently: unreachable 8 min and 6 min ago, back 5 min ago with idle_s 3 = flagged; R8's action names the IST time; a fresh blip with idle_s 4000 is not a reboot", async () => {
    pg.exec([
      extRow(M7, "heartbeat", "3 hours", '{"ext_version":"0.1.1.40"}'),
      pollerRow(M7, "ok", "20 minutes", '{"state":"ok","chrome_running":true,"idle_s":5000}'),
      pollerRow(M7, "unreachable", "8 minutes", '{"state":"unreachable"}'), pollerRow(M7, "unreachable", "6 minutes", '{"state":"unreachable"}'),
      pollerRow(M7, "ok", "5 minutes", '{"state":"ok","chrome_running":true,"idle_s":3}'), pollerRow(M7, "ok", "1 minute", '{"state":"ok","chrome_running":true,"idle_s":63}'),
      // r6: a blip with the console still idle for hours — not a restart
      extRow(M6, "heartbeat", "10 seconds", '{"ext_version":"0.1.1.40"}'),
      pollerRow(M6, "ok", "9 minutes", '{"state":"ok","chrome_running":true,"idle_s":4000}'), pollerRow(M6, "unreachable", "7 minutes", '{"state":"unreachable"}'),
      pollerRow(M6, "ok", "2 minutes", '{"state":"ok","chrome_running":true,"idle_s":4100}'),
    ].join("\n"));
    const rows = await extHealthNow();
    const r7 = rows.find((r) => r.room_id === "r7")!;
    expect(r7).toMatchObject({ status: "missing", rebooted_recently: true });
    expect(minutesBetween(r7.rebooted_at as string, Date.now() - 5 * 60_000)).toBeLessThan(1);
    expect(rows.find((r) => r.room_id === "r6")).toMatchObject({ rebooted_recently: false, rebooted_at: null });
    const hhmm = new Date(Date.parse(r7.rebooted_at as string) + 19_800_000).toISOString().slice(11, 16);
    const item = (await attention()).items.find((i) => i.room_id === "r7" && i.kind === "extension_missing")!;
    expect(item.action).toBe(`Re-run the presence install on CONSUL 4 (machine rebooted at ${hhmm}, policy file lost).`);
  });

  it("rebooted_recently from the idle drop alone (the Cardiology 14:09 pattern): the poller stays ok, idle_s falls 1088 -> 0 while the extension dies with the reboot = flagged, status missing, R8 names the time", async () => {
    pg.exec([
      extRow(M7, "active", "12 minutes 30 seconds", '{"ext_version":"0.1.1.40"}'), // the last extension row: 30 s before the drop
      pollerRow(M7, "ok", "14 minutes", '{"state":"ok","chrome_running":true,"idle_s":1028}'), pollerRow(M7, "ok", "13 minutes", '{"state":"ok","chrome_running":true,"idle_s":1088}'),
      pollerRow(M7, "ok", "12 minutes", '{"state":"ok","chrome_running":true,"idle_s":0}'), pollerRow(M7, "ok", "11 minutes", '{"state":"ok","chrome_running":true,"idle_s":30}'),
      pollerRow(M7, "ok", "30 seconds", '{"state":"ok","chrome_running":true,"idle_s":630}'),
      // r6: the same idle drop, but the extension kept talking for 6 more minutes — a user back at the desk, not a reboot
      extRow(M6, "heartbeat", "20 seconds", '{"ext_version":"0.1.1.40"}'), extRow(M6, "heartbeat", "6 minutes", '{"ext_version":"0.1.1.40"}'),
      pollerRow(M6, "ok", "14 minutes", '{"state":"ok","chrome_running":true,"idle_s":1028}'), pollerRow(M6, "ok", "12 minutes", '{"state":"ok","chrome_running":true,"idle_s":0}'),
    ].join("\n"));
    const rows = await extHealthNow();
    const r7 = rows.find((r) => r.room_id === "r7")!;
    expect(r7).toMatchObject({ status: "missing", rebooted_recently: true, poller: { idle_s: 630 } });
    expect(minutesBetween(r7.rebooted_at as string, Date.now() - 12 * 60_000)).toBeLessThan(1);
    expect(rows.find((r) => r.room_id === "r6")).toMatchObject({ rebooted_recently: false, rebooted_at: null });
    const hhmm = new Date(Date.parse(r7.rebooted_at as string) + 19_800_000).toISOString().slice(11, 16);
    expect((await attention()).items.find((i) => i.room_id === "r7" && i.kind === "extension_missing")!.action).toBe(`Re-run the presence install on CONSUL 4 (machine rebooted at ${hhmm}, policy file lost).`);
  });

  it("quiet vs missing: the same silent extension (last row 30 min ago); a console idle since before it went quiet = quiet and raises NOTHING, a console used after = missing, RED", async () => {
    pg.exec([
      extRow(M7, "heartbeat", "30 minutes", '{"ext_version":"0.1.1.40"}'), pollerRow(M7, "ok", "20 seconds", '{"state":"ok","chrome_running":true,"idle_s":1810}'),
      extRow(M6, "heartbeat", "30 minutes", '{"ext_version":"0.1.1.40"}'), pollerRow(M6, "ok", "20 seconds", '{"state":"ok","chrome_running":true,"idle_s":120}'),
    ].join("\n"));
    const rows = await extHealthNow();
    expect(rows.find((r) => r.room_id === "r7")).toMatchObject({ status: "quiet", poller: { idle_s: 1810 } });
    expect(rows.find((r) => r.room_id === "r6")).toMatchObject({ status: "missing", poller: { idle_s: 120 } });
    expect(kindsOf(await attention()).filter((k) => k.includes("extension"))).toEqual(["r6:extension_missing"]);
  });

  it("as_of REPLAY finds POLLER rows under every spelling (the pre-5-Oct short key consul4, the raw hostname) and ext rows under the full hostname; rows newer than as_of are ignored", async () => {
    pg.exec([
      // r7: poller under the short key, 3 h ago; ext under the canonical key
      pollerRow("consul4", "ok", "3 hours 20 seconds", '{"state":"ok","chrome_running":true,"idle_s":5}'), extRow(M7, "heartbeat", "3 hours 10 seconds", '{"ext_version":"0.1.1.40"}'),
      // r6: poller under the raw hostname spelling (smart apostrophe, "(2)"); ext under the canonical key (extension lookups use the full hostname only)
      pollerRow("EHRC-OPD6’s Mac mini (2)", "ok", "3 hours 20 seconds", '{"state":"ok","chrome_running":true}'), extRow(M6, "heartbeat", "3 hours 5 seconds", '{"ext_version":"0.1.0.36"}'),
      // everything newer than as_of: must not be seen
      pollerRow(M7, "unreachable", "1 minute", '{"state":"unreachable"}'), pollerRow(M4, "ok", "10 seconds", POLLER_OK()), extRow(M4, "heartbeat", "10 seconds", '{"ext_version":"0.1.1.40"}'),
    ].join("\n"));
    const asOf = new Date(Date.now() - 3 * 3_600_000);
    const rows = await extHealthNow(asOf);
    expect(rows.find((r) => r.room_id === "r7")).toMatchObject({ status: "ok", ext_version: "0.1.1.40", poller: { ok: true, chrome_running: true, idle_s: 5 } });
    expect(rows.find((r) => r.room_id === "r6")).toMatchObject({ status: "behind", ext_version: "0.1.0.36", poller: { ok: true } });
    expect(rows.find((r) => r.room_id === "r4")).toMatchObject({ status: "offline", last_ext_ts: null });
  });
});
