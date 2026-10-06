/**
 * tests/unit/room-audio-0129-pg.test.ts — REQUIRED PROOF: migration 0129 (room_audio_state, room_audio_day, role eta_audio_writer) and its
 * 12/36-month retention, against a real postgres:16 (tests/support/s1-pg.ts, same harness as steward-0128-pg.test.ts).
 *
 *   1. The migration survives the app's own splitSql (extracted from app/api/run-migrations/route.ts and run as-is): the DO $$ ... $$ block stays ONE
 *      statement, every statement runs, and applying twice (as the runner would on a re-run, and as raw psql) is idempotent.
 *   2. As eta_audio_writer (SET ROLE): INSERT, SELECT, DELETE on both tables, UPDATE on room_audio_day, SELECT on eta_encounter_windows work;
 *      SELECT on kiosk_health_events and steward_decisions is denied; INSERT/UPDATE on eta_encounter_windows and UPDATE on room_audio_state are denied.
 *   3. CHECK constraints reject an unknown state, an unknown source and ts_end <= ts_start.
 *   4. A room-day rewrite (DELETE + INSERT in one transaction) leaves exactly the new rows; a failing rewrite rolls back and keeps the old ones.
 *   5. Retention through the real cron route: room_audio_state > 12 months and room_audio_day > 36 months go (by ist_day), younger rows survive, counts reported.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { GET as retention } from "@/app/api/cron/kiosk-health-retention/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-room-audio-0129");

const mig = (n: string) => readFileSync(`db/migrations/${n}`, "utf8");
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.sql!(q, ...v)) as Array<Record<string, unknown>>;

/** The app's own splitSql, lifted out of the route source (it is not exported) and transpiled. */
function loadSplitSql(): (body: string) => string[] {
  const src = readFileSync("app/api/run-migrations/route.ts", "utf8");
  const start = src.indexOf("function splitSql(");
  const end = src.indexOf("export async function POST");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function(`${js}\nreturn splitSql;`)() as (body: string) => string[];
}

/** One psql session as the superuser or as eta_audio_writer; returns stdout, or throws with psql's stderr in the message. */
function psql(text: string, role?: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: role ? `SET ROLE ${role};\n${text}` : text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(String((e as { stderr?: unknown }).stderr ?? e));
  }
}
const asWriter = (text: string) => psql(text, "eta_audio_writer");
const denied = (text: string) => { let msg = ""; try { asWriter(text); } catch (e) { msg = (e as Error).message; } return msg; };

const SAVED = process.env.CRON_SECRET;
beforeEach(() => {
  process.env.CRON_SECRET = "cron-pg";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = SAVED;
  vi.restoreAllMocks();
});

describe("REQUIRED PROOF — 0129 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/room-audio-0129-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0129 room audio state over real postgres", () => {
  it("splitSql keeps the DO block whole; the migration applies through it, twice, and registers itself", () => {
    pg.start();
    H.sql = pg.sql as never;
    pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    pg.exec(mig("0123_eta_encounter_windows.sql")); // GRANT SELECT target
    pg.exec(mig("0126_kiosk_health_events.sql")); // a table the writer must NOT read
    pg.exec(mig("0128_room_steward.sql")); // steward_decisions, ditto

    const split = loadSplitSql();
    const stmts = split(mig("0129_room_audio_state.sql"));
    const doBlocks = stmts.filter((s) => /^DO \$\$/.test(s));
    expect(doBlocks).toHaveLength(1);
    expect(doBlocks[0]).toMatch(/CREATE ROLE eta_audio_writer NOLOGIN;\s*END IF;\s*END \$\$$/);
    // the runner sends every statement in one transaction, in order; do the same, twice
    for (let pass = 0; pass < 2; pass += 1) psql(`BEGIN;\n${stmts.map((s) => `${s};`).join("\n")}\nCOMMIT;`);
    pg.exec(mig("0129_room_audio_state.sql")); // and as raw psql
    expect(psql(`SELECT version || ':' || name FROM schema_migrations WHERE version = 129;`)).toBe("129:0129_room_audio_state");
    expect(psql(`SELECT rolname || ' login=' || rolcanlogin || ' super=' || rolsuper FROM pg_roles WHERE rolname = 'eta_audio_writer';`)).toBe("eta_audio_writer login=false super=false");
    expect(psql(`SELECT count(*) FROM pg_roles WHERE rolname = 'eta_audio_writer';`)).toBe("1");
    expect(readFileSync("db/migrations/0129_room_audio_state.sql", "utf8")).not.toMatch(/PASSWORD\s+'|WITH\s+LOGIN|\bLOGIN\s*;/i); // no secret, no login-capable role in git
    expect(psql(`SELECT indexname FROM pg_indexes WHERE tablename IN ('room_audio_state', 'room_audio_day') AND indexname NOT LIKE '%pkey' ORDER BY indexname;`).split("\n")).toEqual([
      "room_audio_day_day_idx", "room_audio_state_day_room_idx", "room_audio_state_room_end_idx", "room_audio_state_room_start_idx",
    ]);
    expect(psql(`SELECT obj_description('room_audio_state'::regclass);`)).toBe("Room audio-state intervals. Metadata only: no audio, no text.");
  }, 240_000);

  it("eta_audio_writer: INSERT, SELECT, DELETE on both tables, UPDATE on room_audio_day, SELECT on eta_encounter_windows", () => {
    const out = asWriter(`
      INSERT INTO room_audio_state (room_id, machine, source, ist_day, state, ts_start, ts_end, evidence, classifier_version)
        VALUES ('room_a', 'M1', 'kiosk', '2026-10-06', 'speech', '2026-10-06 04:00+00', '2026-10-06 04:10+00', '{"rms":0.02}', 'v1'),
               ('room_a', NULL, 'ot',    '2026-10-06', 'muted',  '2026-10-06 04:10+00', '2026-10-06 04:20+00', DEFAULT, 'v1');
      INSERT INTO room_audio_day (room_id, ist_day, min_present, classifier_version) VALUES ('room_a', '2026-10-06', 10, 'v1');
      UPDATE room_audio_day SET min_present = 20, n_consults = 1, written_at = now() WHERE room_id = 'room_a';
      SELECT count(*) FROM room_audio_state WHERE room_id = 'room_a';
      SELECT min_present || '/' || n_consults || '/' || min_off FROM room_audio_day WHERE room_id = 'room_a';
      SELECT count(*) FROM eta_encounter_windows;
      SELECT id FROM room_audio_state ORDER BY id LIMIT 1;
      DELETE FROM room_audio_state WHERE room_id = 'room_a';
      DELETE FROM room_audio_day WHERE room_id = 'room_a';
      SELECT (SELECT count(*) FROM room_audio_state) || '/' || (SELECT count(*) FROM room_audio_day);
    `).split("\n");
    expect(out.slice(0, 3)).toEqual(["2", "20/1/0", "0"]);
    expect(out[out.length - 1]).toBe("0/0");
    // the upsert the writer will really use
    expect(asWriter(`
      INSERT INTO room_audio_day (room_id, ist_day, min_gated, classifier_version) VALUES ('room_u', '2026-10-06', 5, 'v1')
        ON CONFLICT (room_id, ist_day) DO UPDATE SET min_gated = EXCLUDED.min_gated, classifier_version = EXCLUDED.classifier_version, written_at = now();
      INSERT INTO room_audio_day (room_id, ist_day, min_gated, classifier_version) VALUES ('room_u', '2026-10-06', 9, 'v2')
        ON CONFLICT (room_id, ist_day) DO UPDATE SET min_gated = EXCLUDED.min_gated, classifier_version = EXCLUDED.classifier_version, written_at = now();
      SELECT min_gated || '/' || classifier_version FROM room_audio_day WHERE room_id = 'room_u';
      DELETE FROM room_audio_day WHERE room_id = 'room_u';
    `)).toBe("9/v2");
  });

  it("eta_audio_writer: nothing else — kiosk_health_events and steward_decisions unreadable, eta_encounter_windows read-only, room_audio_state not updatable", () => {
    expect(denied(`SELECT count(*) FROM kiosk_health_events;`)).toMatch(/permission denied for table kiosk_health_events/);
    expect(denied(`SELECT count(*) FROM steward_decisions;`)).toMatch(/permission denied for table steward_decisions/);
    expect(denied(`SELECT count(*) FROM steward_config;`)).toMatch(/permission denied for table steward_config/);
    expect(denied(`INSERT INTO eta_encounter_windows (consult_key, machine, attribution, t_open, close_reason, quality, resolver_version) VALUES ('k@m', 'm', 'none', now(), 'open', 'unclosed', 'v');`)).toMatch(/permission denied for table eta_encounter_windows/);
    expect(denied(`UPDATE eta_encounter_windows SET quality = 'clean';`)).toMatch(/permission denied for table eta_encounter_windows/);
    expect(denied(`DELETE FROM eta_encounter_windows;`)).toMatch(/permission denied for table eta_encounter_windows/);
    expect(denied(`UPDATE room_audio_state SET state = 'speech';`)).toMatch(/permission denied for table room_audio_state/);
    expect(denied(`CREATE TABLE public.nope (x int);`)).toMatch(/permission denied for schema public/);
  });

  it("CHECK constraints reject an unknown state, an unknown source, ts_end <= ts_start (equal and earlier), and NULLs in NOT NULL columns", () => {
    const ins = (src: string, state: string, a: string, b: string) =>
      `INSERT INTO room_audio_state (room_id, source, ist_day, state, ts_start, ts_end, classifier_version) VALUES ('room_c', '${src}', '2026-10-06', '${state}', '${a}', '${b}', 'v1');`;
    expect(denied(ins("kiosk", "napping", "2026-10-06 04:00+00", "2026-10-06 04:05+00"))).toMatch(/violates check constraint/);
    expect(denied(ins("phone", "speech", "2026-10-06 04:00+00", "2026-10-06 04:05+00"))).toMatch(/violates check constraint/);
    expect(denied(ins("kiosk", "speech", "2026-10-06 04:05+00", "2026-10-06 04:05+00"))).toMatch(/violates check constraint/);
    expect(denied(ins("kiosk", "speech", "2026-10-06 04:05+00", "2026-10-06 04:00+00"))).toMatch(/violates check constraint/);
    expect(denied(`INSERT INTO room_audio_state (room_id, source, ist_day, state, ts_start, ts_end) VALUES ('room_c', 'kiosk', '2026-10-06', 'speech', now(), now() + interval '1 min');`)).toMatch(/null value in column "classifier_version"/);
    for (const st of ["recorder_off", "muted", "zero_all_day", "audio_present", "audio_gated", "withheld", "device_missing", "device_dead", "room_quiet", "speech", "consult"]) {
      expect(denied(ins("ot", st, "2026-10-06 04:00+00", "2026-10-06 04:05+00") + `DELETE FROM room_audio_state WHERE room_id = 'room_c';`)).toBe("");
    }
    expect(psql(`SELECT count(*) FROM room_audio_state WHERE room_id = 'room_c';`)).toBe("0");
  });

  it("a room-day rewrite (DELETE + INSERT in one transaction) leaves exactly the new rows; a failing rewrite rolls back and keeps the old ones", () => {
    const row = (room: string, day: string, state: string, a: string, b: string) =>
      `INSERT INTO room_audio_state (room_id, source, ist_day, state, ts_start, ts_end, classifier_version) VALUES ('${room}', 'kiosk', '${day}', '${state}', '${a}', '${b}', 'v1')`;
    asWriter([
      row("room_r", "2026-10-05", "speech", "2026-10-05 04:00+00", "2026-10-05 04:10+00") + ";",
      row("room_r", "2026-10-06", "muted", "2026-10-06 04:00+00", "2026-10-06 04:10+00") + ";",
      row("room_r", "2026-10-06", "speech", "2026-10-06 04:10+00", "2026-10-06 04:20+00") + ";",
      row("room_s", "2026-10-06", "speech", "2026-10-06 04:00+00", "2026-10-06 04:10+00") + ";",
    ].join("\n"));
    asWriter(`BEGIN;
      DELETE FROM room_audio_state WHERE room_id = 'room_r' AND ist_day = '2026-10-06';
      ${row("room_r", "2026-10-06", "consult", "2026-10-06 04:00+00", "2026-10-06 04:30+00")};
      COMMIT;`);
    expect(psql(`SELECT ist_day || ' ' || state FROM room_audio_state WHERE room_id = 'room_r' ORDER BY ts_start;`).split("\n")).toEqual(["2026-10-05 speech", "2026-10-06 consult"]);
    expect(psql(`SELECT count(*) FROM room_audio_state WHERE room_id = 'room_s';`)).toBe("1"); // another room, untouched
    // the rewrite's INSERT violates a CHECK: the DELETE rolls back with it
    expect(denied(`BEGIN;
      DELETE FROM room_audio_state WHERE room_id = 'room_r' AND ist_day = '2026-10-06';
      ${row("room_r", "2026-10-06", "speech", "2026-10-06 05:00+00", "2026-10-06 05:00+00")};
      COMMIT;`)).toMatch(/violates check constraint/);
    expect(psql(`SELECT ist_day || ' ' || state FROM room_audio_state WHERE room_id = 'room_r' ORDER BY ts_start;`).split("\n")).toEqual(["2026-10-05 speech", "2026-10-06 consult"]);
    psql(`DELETE FROM room_audio_state WHERE room_id IN ('room_r', 'room_s');`);
  });

  it("retention through the real cron route: state > 12 months and day > 36 months are deleted by ist_day; younger rows survive; counts are in the JSON", async () => {
    psql(`
      INSERT INTO room_audio_state (room_id, source, ist_day, state, ts_start, ts_end, classifier_version) VALUES
        ('rt', 'kiosk', current_date - interval '13 months',                'speech', now() - interval '13 months', now() - interval '13 months' + interval '1 min', 'v1'),
        ('rt', 'kiosk', current_date - interval '13 months' - interval '1 day', 'muted',  now() - interval '14 months', now() - interval '14 months' + interval '1 min', 'v1'),
        ('rt', 'ot',    current_date - interval '11 months',                'speech', now() - interval '11 months', now() - interval '11 months' + interval '1 min', 'v1'),
        ('rt', 'ot',    current_date - interval '1 day',                    'speech', now() - interval '1 day',     now() - interval '1 day' + interval '1 min',     'v1');
      INSERT INTO room_audio_day (room_id, ist_day, classifier_version) VALUES
        ('rt', (current_date - interval '37 months')::date, 'v1'),
        ('rt2', (current_date - interval '37 months')::date, 'v1'),
        ('rt', (current_date - interval '35 months')::date, 'v1'),
        ('rt', (current_date - interval '13 months')::date, 'v1'),
        ('rt', current_date, 'v1');
    `);
    const r = await retention(new Request("https://x.test/api/cron/kiosk-health-retention", { headers: { authorization: "Bearer cron-pg" } }));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ budget_hit: false, room_audio_state_deleted: 2, room_audio_day_deleted: 2 });
    expect(psql(`SELECT count(*) FROM room_audio_state WHERE room_id = 'rt';`)).toBe("2");
    expect(psql(`SELECT count(*) FROM room_audio_day WHERE room_id IN ('rt', 'rt2');`)).toBe("3");
    expect(psql(`SELECT count(*) FROM room_audio_day WHERE ist_day < current_date - interval '36 months';`)).toBe("0");
    // a second run finds nothing more
    const r2 = await retention(new Request("https://x.test/api/cron/kiosk-health-retention", { headers: { authorization: "Bearer cron-pg" } }));
    expect(await r2.json()).toMatchObject({ room_audio_state_deleted: 0, room_audio_day_deleted: 0 });
  }, 120_000);

  it("teardown", () => { pg.stop(); });
});
