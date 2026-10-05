/**
 * lib/fleet-attention.ts DB half + lib/room-watchdog.ts loadRecoveryEvidence — AGAINST A REAL POSTGRES.
 *
 * The rules are proven in fleet-attention.test.ts with plain objects. What a plain object cannot prove is that the SELECTs themselves run: row
 * comparisons, LATERAL joins, jsonb_to_recordset over a bound parameter, DISTINCT ON over unnest(), the ist_date index bounds. Every statement
 * here is sent through the s1-pg harness with BOUND, untyped parameters, the way the Neon driver sends them.
 *
 * The tables are minimal hand-written DDL carrying only the columns the queries read (the same approach as room-watchdog-outbox.test.ts), except
 * pulse_presence_events, eta_encounter_windows, room_alert_state and room_alert_outbox, which are created from their real migrations.
 * Times are relative to the database's now(), so nothing here depends on the date or on clinic hours.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(1);
const DOC2 = makeFakeClinician(2);

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
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
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz, status text NOT NULL DEFAULT 'recording');
    CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, source text NOT NULL DEFAULT 'primary',
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz NOT NULL, size_bytes bigint);
    CREATE TABLE bench_level_sample (
      id bigserial PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, sampled_at timestamptz NOT NULL DEFAULT now(),
      peak real NOT NULL, avg real, zero_ratio real, session_open boolean NOT NULL DEFAULT false, tape_advancing boolean NOT NULL DEFAULT false,
      source text NOT NULL DEFAULT 'command_poll');
    CREATE INDEX bench_level_sample_room_day_time_idx ON bench_level_sample (room_id, ist_date, sampled_at);
    CREATE TABLE bench_command (id text PRIMARY KEY, room_id text NOT NULL, kind text NOT NULL, status text NOT NULL DEFAULT 'pending',
      result jsonb, error text, created_at timestamptz NOT NULL DEFAULT now(), acked_at timestamptz);
  `);
  for (const f of ["0103_room_alert_state", "0119_room_alert_outbox", "0122_pulse_presence_events", "0123_eta_encounter_windows"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

beforeEach(() => {
  if (!HAVE_DOCKER) return;
  pg.exec(`
    TRUNCATE room_alert_outbox RESTART IDENTITY; TRUNCATE room_alert_state; TRUNCATE pulse_presence_events; TRUNCATE eta_encounter_windows;
    TRUNCATE bench_command; TRUNCATE bench_level_sample; TRUNCATE bench_chunk; TRUNCATE bench_session;
    DELETE FROM room_install; DELETE FROM room;
    INSERT INTO room (id, slug, name) VALUES ('r6', 'opd-6-x', 'OPD 6'), ('r4', 'opd-4-x', 'OPD 4');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at) VALUES
      ('i6', 'r6', 'EHRC-OPD6’s Mac mini (2)', now() - interval '30 days'),
      ('i4', 'r4', 'EHRC-OPD4s-Mac-mini', now() - interval '30 days');
  `);
});

const ago = (interval: string) => `now() - interval '${interval}'`;
const presence = (source: "ext" | "poller", machine: string, event: string, when: string, payload = "{}") =>
  `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('${source}', '${machine}', '${event}', ${ago(when)}, '${payload}'::jsonb);`;
const session = (id: string, room: string, startedAgo: string, status = "recording") =>
  `INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('${id}', '${room}', ${ago(startedAgo)}, '${status}');`;
const chunkRow = (id: string, sess: string, createdAgo: string, size: number | "NULL", source = "primary") =>
  `INSERT INTO bench_chunk (id, session_id, source, created_at, started_at, size_bytes) VALUES ('${id}', '${sess}', '${source}', ${ago(createdAgo)}, ${ago(createdAgo)} - interval '5 minutes', ${size});`;
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
    expect(r.rooms_checked).toBe(2);
    expect(r.degraded).toBeUndefined();
    expect(Number.isFinite(Date.parse(r.generated_at))).toBe(true);
  });

  it("R1 asleep — ext `locked` found under the NORMALISED machine name (curly apostrophe and (2) in the hostname); heartbeats after it do not clear it", async () => {
    pg.exec([
      presence("ext", "EHRC-OPD6s-Mac-mini-2", "heartbeat", "40 minutes", '{"tab_focus": true}'),
      presence("ext", "EHRC-OPD6s-Mac-mini-2", "locked", "30 minutes"),
      ...[25, 20, 15, 10, 5, 1].map((m) => presence("ext", "EHRC-OPD6s-Mac-mini-2", "heartbeat", `${m} minutes`, '{"tab_focus": false}')),
    ].join("\n"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:asleep"]);
    expect(minutesBetween(r.items[0]!.since, Date.now() - 30 * 60_000)).toBeLessThan(1);
    expect(r.items[0]!.machine).toBe("EHRC-OPD6’s Mac mini (2)");
    // a focused heartbeat after the lock clears it
    pg.exec(presence("ext", "EHRC-OPD6s-Mac-mini-2", "heartbeat", "30 seconds", '{"tab_focus": true}'));
    // (during clinic hours R5 may now fire for the Mac that just woke — that is correct and clock-dependent, so assert only on R1)
    expect(kindsOf(await attention())).not.toContain("r6:asleep");
  });

  it("R1 asleep — poller rows matched on the RAW hostname; since is where the current unreachable run began", async () => {
    const raw = "EHRC-OPD4s-Mac-mini";
    pg.exec([
      presence("poller", raw, "ok", "30 minutes", '{"locked": false}'),
      presence("poller", raw, "ok", "20 minutes", '{"locked": false}'),
      presence("poller", raw, "unreachable", "15 minutes", '{"locked": false}'),
      presence("poller", raw, "unreachable", "10 minutes", '{"locked": false}'),
      presence("poller", raw, "unreachable", "1 minute", '{"locked": false}'),
    ].join("\n"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r4:asleep"]);
    expect(minutesBetween(r.items[0]!.since, Date.now() - 15 * 60_000)).toBeLessThan(1);
    // the Mac comes back: a newer ok clears it
    pg.exec(presence("poller", raw, "ok", "10 seconds", '{"locked": false}'));
    expect(await attention().then((x) => x.items)).toEqual([]);
  });

  it("R1 asleep — poller locked=true counts", async () => {
    pg.exec(presence("poller", "EHRC-OPD4s-Mac-mini", "ok", "2 minutes", '{"locked": true}'));
    expect(kindsOf(await attention())).toEqual(["r4:asleep"]);
  });

  it("R2 capture_frozen — finds where the identical run began (20 minutes ago), R3 silent_tape — two silent primary chunks", async () => {
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

  it("R2 — moving samples raise nothing; a session with no samples at all in 120 s raises, citing the last sample it knows of", async () => {
    pg.exec([session("bs6", "r6", "3 hours"), samples("r6", "30 minutes", "1 second", "moving"), chunkRow("c1", "bs6", "2 minutes", 3_400_000)].join("\n"));
    expect(await attention().then((x) => x.items)).toEqual([]);
    pg.exec(`TRUNCATE bench_level_sample;` + samples("r6", "30 minutes", "10 minutes", "moving"));
    const r = await attention();
    expect(kindsOf(r)).toEqual(["r6:capture_frozen"]);
    expect(r.items[0]!.detail).toContain("No microphone level readings");
    expect(minutesBetween(r.items[0]!.since, Date.now() - 10 * 60_000)).toBeLessThan(0.5);
  });

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

  it("R6 open_outbox — open until a chunk lands after the alert AND the levels moved since", async () => {
    const { degradedMessage } = await import("@/lib/room-watchdog");
    const body = degradedMessage("OPD 6", ["device_missing"], new Date().toISOString()).text.replace(/'/g, "''");
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
    // (c) the honest recovery: moving levels since
    pg.exec(`TRUNCATE bench_level_sample;` + samples("r6", "2 hours", "1 hour", "moving", 60));
    expect(await attention().then((x) => x.items)).toEqual([]);
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

describe.runIf(HAVE_DOCKER)("loadRecoveryEvidence against postgres", () => {
  it("reports, per non-ok room, a chunk after the alert and the distinct levels of the last 120 s", async () => {
    const { loadRecoveryEvidence } = await import("@/lib/room-watchdog");
    pg.exec(`
      INSERT INTO room_alert_state (room_id, status, since) VALUES ('r6', 'degraded', ${ago("3 hours")}), ('r4', 'ok', ${ago("3 hours")});
      ${session("bs6", "r6", "2 hours", "ended")}
      ${samples("r6", "100 seconds", "1 second", "frozen")}
    `);
    let m = await loadRecoveryEvidence();
    expect([...m.keys()]).toEqual(["r6"]);
    expect(m.get("r6")).toEqual({ chunk_after_alert: false, distinct_levels: 1 });
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
});
