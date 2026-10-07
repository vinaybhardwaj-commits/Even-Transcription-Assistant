/**
 * tests/unit/rooms-live-claim-pg.test.ts — REQUIRED PROOF: migration 0131 (rooms_live_claim), lib/rooms-live-claims.ts and the 7-day retention,
 * against a real postgres:16 (tests/support/s1-pg.ts, same harness as room-audio-0129-pg.test.ts). Values are BOUND, as with the Neon driver.
 *
 *   1. 0131 applies through the app's own splitSql, twice, and as raw psql; registers itself; indexes and table comment are as designed; no role grants.
 *   2. CHECK rejections: claimed_by empty / 65 chars, cleared_by empty / 65, state_at_claim 65, note 281, cleared_at < claimed_at. Boundary values pass.
 *   3. Helper: claim -> openClaims -> double claim (already_claimed, existing returned, nothing written) -> clear -> no_open_claim -> claim again (history kept).
 *      Invalid inputs are refused before any SQL. Scratch room ids are accepted.
 *   4. The partial unique index itself refuses a second open claim on one room, and allows a second open claim on another room.
 *   5. Retention through the real cron route: cleared > 7 d deleted; open > 7 d auto-cleared (not deleted); young rows untouched; counts reported; a second run deletes the auto-cleared ones.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

import { GET as retention } from "@/app/api/cron/kiosk-health-retention/route";
import { claim, clear, openClaims, isValidRoomId } from "@/lib/rooms-live-claims";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-rooms-live-claim-0131");
const mig = (n: string) => readFileSync(`db/migrations/${n}`, "utf8");
const sqlTag = (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v);

function loadSplitSql(): (body: string) => string[] {
  const src = readFileSync("app/api/run-migrations/route.ts", "utf8");
  const start = src.indexOf("function splitSql(");
  const end = src.indexOf("export async function POST");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function(`${js}\nreturn splitSql;`)() as (body: string) => string[];
}

function psql(text: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(String((e as { stderr?: unknown }).stderr ?? e));
  }
}
const fails = (text: string) => { let msg = ""; try { psql(text); } catch (e) { msg = (e as Error).message; } return msg; };

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

describe("REQUIRED PROOF — 0131 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/rooms-live-claim-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0131 rooms_live_claim over real postgres", () => {
  it("applies through splitSql twice and as raw psql, registers itself, has the designed indexes and no grants", () => {
    pg.start();
    H.sql = pg.sql as never;
    pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    // the retention route touches every table below, so they all exist
    for (const m of ["0123_eta_encounter_windows.sql", "0126_kiosk_health_events.sql", "0128_room_steward.sql", "0129_room_audio_state.sql"]) pg.exec(mig(m));

    const stmts = loadSplitSql()(mig("0131_rooms_live_claim.sql"));
    expect(stmts.length).toBeGreaterThanOrEqual(5);
    for (let pass = 0; pass < 2; pass += 1) psql(`BEGIN;\n${stmts.map((s) => `${s};`).join("\n")}\nCOMMIT;`);
    pg.exec(mig("0131_rooms_live_claim.sql"));
    expect(psql(`SELECT version || ':' || name FROM schema_migrations WHERE version = 131;`)).toBe("131:0131_rooms_live_claim");
    expect(psql(`SELECT count(*) FROM schema_migrations WHERE version = 131;`)).toBe("1");
    expect(psql(`SELECT indexname FROM pg_indexes WHERE tablename = 'rooms_live_claim' AND indexname NOT LIKE '%pkey' ORDER BY indexname;`).split("\n")).toEqual([
      "rooms_live_claim_one_open_idx", "rooms_live_claim_room_claimed_idx",
    ]);
    expect(psql(`SELECT indexdef FROM pg_indexes WHERE indexname = 'rooms_live_claim_one_open_idx';`)).toMatch(/UNIQUE INDEX .*\(room_id\) WHERE \(cleared_at IS NULL\)/);
    expect(psql(`SELECT obj_description('rooms_live_claim'::regclass);`)).toMatch(/no PHI/);
    expect(psql(`SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'rooms_live_claim' AND grantee = 'eta_audio_writer';`)).toBe("0");
    expect(mig("0131_rooms_live_claim.sql")).not.toMatch(/\bGRANT\b|\bCREATE ROLE\b/i);
  }, 240_000);

  it("CHECK constraints reject out-of-range values; boundary values pass", () => {
    const ins = (cols: string, vals: string) => `INSERT INTO rooms_live_claim (room_id, ${cols}) VALUES ('room_chk', ${vals});`;
    const a = "'a'";
    const rep = (n: number) => `'${"x".repeat(n)}'`;
    expect(fails(ins("claimed_by", "''"))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by", rep(65)))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by, cleared_at, cleared_by", `${a}, now(), ''`))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by, cleared_at, cleared_by", `${a}, now(), ${rep(65)}`))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by, state_at_claim", `${a}, ${rep(65)}`))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by, note", `${a}, ${rep(281)}`))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by, claimed_at, cleared_at", `${a}, now(), now() - interval '1 second'`))).toMatch(/violates check constraint/);
    expect(fails(ins("claimed_by", "NULL"))).toMatch(/null value in column "claimed_by"/);
    // boundaries: 64-char names, 64-char state, 280-char note, cleared_at = claimed_at
    expect(fails(`INSERT INTO rooms_live_claim (room_id, claimed_by, claimed_at, cleared_at, cleared_by, state_at_claim, note) VALUES ('room_chk', ${rep(64)}, '2026-10-06 04:00+00', '2026-10-06 04:00+00', ${rep(64)}, ${rep(64)}, ${rep(280)});`)).toBe("");
    psql(`DELETE FROM rooms_live_claim WHERE room_id = 'room_chk';`);
    expect(psql(`SELECT count(*) FROM rooms_live_claim;`)).toBe("0");
  });

  it("the partial unique index refuses a second open claim on a room, allows one on another room, and allows a new one after a clear", () => {
    psql(`INSERT INTO rooms_live_claim (room_id, claimed_by) VALUES ('room_u1', 'a');`);
    expect(fails(`INSERT INTO rooms_live_claim (room_id, claimed_by) VALUES ('room_u1', 'b');`)).toMatch(/duplicate key value violates unique constraint "rooms_live_claim_one_open_idx"/);
    psql(`INSERT INTO rooms_live_claim (room_id, claimed_by) VALUES ('room_u2', 'b');`);
    psql(`UPDATE rooms_live_claim SET cleared_at = now(), cleared_by = 'a' WHERE room_id = 'room_u1';`);
    psql(`INSERT INTO rooms_live_claim (room_id, claimed_by) VALUES ('room_u1', 'b');`);
    expect(psql(`SELECT count(*) FROM rooms_live_claim WHERE room_id = 'room_u1';`)).toBe("2");
    psql(`DELETE FROM rooms_live_claim;`);
  });

  it("helper: claim, openClaims, double claim, clear, no_open_claim, claim again; invalid input never reaches SQL", async () => {
    expect(await openClaims(sqlTag as never)).toEqual([]);
    const c1 = await claim(sqlTag as never, { room_id: "room_a1b2c3d4", claimed_by: "vinay", state_at_claim: "zero_all_day", note: "walk over" });
    expect(c1.ok).toBe(true);
    if (!c1.ok) throw new Error("unreachable");
    expect(c1.claim).toMatchObject({ room_id: "room_a1b2c3d4", claimed_by: "vinay", cleared_at: null, cleared_by: null, state_at_claim: "zero_all_day", note: "walk over" });
    expect(typeof c1.claim.claimed_at).toBe("string");

    const dup = await claim(sqlTag as never, { room_id: "room_a1b2c3d4", claimed_by: "someone-else" });
    expect(dup).toMatchObject({ ok: false, reason: "already_claimed", existing: { id: c1.claim.id, claimed_by: "vinay" } });
    expect(psql(`SELECT count(*) FROM rooms_live_claim WHERE room_id = 'room_a1b2c3d4';`)).toBe("1");

    const scratch = await claim(sqlTag as never, { room_id: "room_scratch_test-1", claimed_by: "bot" }); // optional fields omitted -> NULL
    expect(scratch).toMatchObject({ ok: true, claim: { state_at_claim: null, note: null } });
    expect((await openClaims(sqlTag as never)).map((r) => r.room_id)).toEqual(["room_a1b2c3d4", "room_scratch_test-1"]);

    const cl = await clear(sqlTag as never, { room_id: "room_a1b2c3d4", cleared_by: "kush" });
    expect(cl).toMatchObject({ ok: true, claim: { id: c1.claim.id, cleared_by: "kush" } });
    expect(cl.ok && typeof cl.claim.cleared_at).toBe("string");
    expect(await clear(sqlTag as never, { room_id: "room_a1b2c3d4", cleared_by: "kush" })).toEqual({ ok: false, reason: "no_open_claim" });
    expect(await clear(sqlTag as never, { room_id: "room_zzzzzzzz", cleared_by: "kush" })).toEqual({ ok: false, reason: "no_open_claim" });
    expect((await openClaims(sqlTag as never)).map((r) => r.room_id)).toEqual(["room_scratch_test-1"]);

    const again = await claim(sqlTag as never, { room_id: "room_a1b2c3d4", claimed_by: "kush" });
    expect(again.ok).toBe(true);
    expect(psql(`SELECT count(*) FROM rooms_live_claim WHERE room_id = 'room_a1b2c3d4';`)).toBe("2"); // history kept
    psql(`DELETE FROM rooms_live_claim;`);
  });

  it("helper validation: bad inputs are refused with the field named, before any statement", async () => {
    const spy = vi.fn(async () => []);
    const ok = { room_id: "room_a1b2c3d4", claimed_by: "v" };
    const bad = async (over: Record<string, unknown>) => claim(spy as never, { ...ok, ...over } as never);
    expect(await bad({ room_id: "room_A1B2C3D4" })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await bad({ room_id: "room_a1b2c3d" })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await bad({ room_id: "room_a1b2c3d45" })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await bad({ room_id: "room_a1b2c3d4'; DROP TABLE x;--" })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await bad({ room_id: "room_scratch_" })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await bad({ room_id: 5 })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await bad({ claimed_by: "" })).toEqual({ ok: false, reason: "invalid", field: "claimed_by" });
    expect(await bad({ claimed_by: "x".repeat(65) })).toEqual({ ok: false, reason: "invalid", field: "claimed_by" });
    expect(await bad({ claimed_by: undefined })).toEqual({ ok: false, reason: "invalid", field: "claimed_by" });
    expect(await bad({ state_at_claim: "x".repeat(65) })).toEqual({ ok: false, reason: "invalid", field: "state_at_claim" });
    expect(await bad({ note: "x".repeat(281) })).toEqual({ ok: false, reason: "invalid", field: "note" });
    expect(await bad({ note: 7 })).toEqual({ ok: false, reason: "invalid", field: "note" });
    expect(await clear(spy as never, { room_id: "nope", cleared_by: "v" })).toEqual({ ok: false, reason: "invalid", field: "room_id" });
    expect(await clear(spy as never, { room_id: "room_a1b2c3d4", cleared_by: "" })).toEqual({ ok: false, reason: "invalid", field: "cleared_by" });
    expect(spy).not.toHaveBeenCalled();
    expect(isValidRoomId("room_a1b2c3d4")).toBe(true);
    expect(isValidRoomId("room_scratch_x")).toBe(true);
    // boundary values reach the database and are accepted
    H.sql = pg.sql as never;
    const edge = await claim(sqlTag as never, { ...ok, claimed_by: "x".repeat(64), state_at_claim: "y".repeat(64), note: "z".repeat(280) });
    expect(edge.ok).toBe(true);
    psql(`DELETE FROM rooms_live_claim;`);
  });

  it("retention through the real cron route: cleared > 7 d deleted, open > 7 d auto-cleared (kept), young rows untouched; the next run deletes the auto-cleared", async () => {
    psql(`
      INSERT INTO rooms_live_claim (room_id, claimed_by, claimed_at, cleared_at, cleared_by) VALUES
        ('room_ret00001', 'a', now() - interval '9 days',  now() - interval '8 days', 'a'),
        ('room_ret00001', 'a', now() - interval '8 days',  now() - interval '7 days', 'a'),
        ('room_ret00002', 'a', now() - interval '3 days',  now() - interval '2 days', 'a'),
        ('room_ret00002', 'a', now() - interval '10 days', now() - interval '1 hour', 'a');
      INSERT INTO rooms_live_claim (room_id, claimed_by, claimed_at) VALUES
        ('room_ret00003', 'a', now() - interval '8 days'),
        ('room_ret00004', 'a', now() - interval '1 day');
    `);
    const run = async () => (await retention(new Request("https://x.test/api/cron/kiosk-health-retention", { headers: { authorization: "Bearer cron-pg" } }))).json();
    expect(await run()).toMatchObject({ budget_hit: false, rooms_live_claim_deleted: 3, rooms_live_claim_autocleared: 1 });
    // deleted: both 8-9 day cleared rows and the 10-day-old claim cleared an hour ago (claimed_at rule). kept: the 3-day cleared row, the auto-cleared row, the young open claim.
    expect(psql(`SELECT room_id || ' ' || coalesce(cleared_by, 'OPEN') FROM rooms_live_claim ORDER BY room_id;`).split("\n")).toEqual([
      "room_ret00002 a", "room_ret00003 retention", "room_ret00004 OPEN",
    ]);
    expect(await run()).toMatchObject({ rooms_live_claim_deleted: 1, rooms_live_claim_autocleared: 0 }); // the auto-cleared claim (claimed 8 d ago) goes on the next run
    expect(psql(`SELECT room_id FROM rooms_live_claim ORDER BY room_id;`).split("\n")).toEqual(["room_ret00002", "room_ret00004"]);
    expect(await run()).toMatchObject({ rooms_live_claim_deleted: 0, rooms_live_claim_autocleared: 0 });
    psql(`DELETE FROM rooms_live_claim;`);
  }, 120_000);

  it("teardown", () => { pg.stop(); });
});
