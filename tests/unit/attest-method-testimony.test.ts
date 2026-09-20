/**
 * tests/unit/attest-method-testimony.test.ts — 0111 widens `method`, and the grade still travels.
 *
 * V's ruling, 19 Sep 2026: the cheapest first attested clinician-day is a room's own occupant
 * attesting their own day, and 0109's CHECK of ('pin') refuses exactly that. 0111 admits it under a
 * SECOND NAME so nothing weaker than a verified PIN can ever be counted as one.
 *
 * These run the real migration files against a real Postgres, in order, because the thing under
 * test IS the SQL: a CHECK constraint cannot be proved by a unit test of TypeScript.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { execFileSync } from "node:child_process";

/**
 * `dockerAvailable()` only asks `docker version`, which the daemon answers even when it cannot
 * START anything. On 20 Sep the Mini's data volume hit 99% and containerd's metadata store went
 * read-only: `docker version` succeeded, `docker run` failed, and the fixture crashed in beforeAll
 * instead of reporting that the proof had not run. This asks the stronger question.
 */
function dockerCanRun(): boolean {
  if (!dockerAvailable()) return false;
  try {
    execFileSync("docker", ["run", "--rm", "postgres:16", "true"], { stdio: "pipe", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

const HAVE_DOCKER = dockerCanRun();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-attest-method");

/** The migration body without its bookkeeping row — schema_migrations does not exist in the fixture. */
const noRecord = (sql: string) => sql.replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

/** 0109 lives on vinay/attest-capture, which is not merged; read it from git rather than copy it. */
const M0109 = () =>
  execFileSync("git", ["show", "vinay/attest-capture:db/migrations/0109_room_clinician_attestation.sql"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });
const M0111 = () => readFileSync("db/migrations/0111_attestation_method_testimony.sql", "utf8");

describe("REQUIRED PROOF — the constraint is exercised against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: needs Docker for postgres:16, or ETA_ALLOW_SKIP_E2E=1.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(noRecord(M0109()));
  pg.exec(noRecord(M0111()));
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

const insert = (id: string, method: string) => `
  INSERT INTO room_clinician_attestation
    (id, room_id, clinician_id, session_id, started_at, expires_at, method, pin_presented)
  VALUES ('${id}', 'room_t', 'doc_t', NULL,
          '2026-09-18T09:00:00Z'::timestamptz, '2026-09-18T13:00:00Z'::timestamptz,
          '${method}', ${method === "pin"});`;

describe.runIf(HAVE_DOCKER)("0111 — two grades of evidence, and nothing else", () => {
  it("still accepts a verified PIN presentation", async () => {
    pg.exec(insert("att_pin", "pin"));
    const r = (await pg.sql`SELECT method FROM room_clinician_attestation WHERE id = 'att_pin'`) as Array<{ method: string }>;
    expect(r[0]!.method).toBe("pin");
  });

  it("now accepts occupant testimony — the row 0109 refused", async () => {
    pg.exec(insert("att_testimony", "occupant_testimony"));
    const r = (await pg.sql`
      SELECT method, pin_presented FROM room_clinician_attestation WHERE id = 'att_testimony'
    `) as Array<{ method: string; pin_presented: boolean | string }>;
    expect(r[0]!.method).toBe("occupant_testimony");
    // and it is NOT recorded as a PIN presentation
    expect(String(r[0]!.pin_presented)).toMatch(/^(false|f)$/);
  });

  it("refuses any third grade — the widening is exactly two values, not 'anything goes'", () => {
    expect(() => pg.exec(insert("att_guess", "voice_match"))).toThrow();
    expect(() => pg.exec(insert("att_guess2", "inferred"))).toThrow();
    expect(() => pg.exec(insert("att_guess3", ""))).toThrow();
  });

  it("a reader that means VERIFIED still gets only the PIN row", async () => {
    const v = (await pg.sql`SELECT count(*)::int AS n FROM room_clinician_attestation WHERE method = 'pin'`) as Array<{ n: number }>;
    const a = (await pg.sql`SELECT count(*)::int AS n FROM room_clinician_attestation`) as Array<{ n: number }>;
    expect(v[0]!.n).toBe(1);
    expect(a[0]!.n).toBe(2);
  });

  it("is re-runnable: applying 0111 twice leaves one constraint and the same two values", async () => {
    pg.exec(noRecord(M0111()));
    const c = (await pg.sql`
      SELECT count(*)::int AS n FROM pg_constraint
       WHERE conname = 'room_clinician_attestation_method_ck'
    `) as Array<{ n: number }>;
    expect(c[0]!.n).toBe(1);
    expect(() => pg.exec(insert("att_guess4", "voice_match"))).toThrow();
    pg.exec(insert("att_testimony2", "occupant_testimony"));
  });

  it("REFUSES LOUDLY when 0109 has not run: it does not quietly record itself as applied", () => {
    pg.exec(`DROP TABLE room_clinician_attestation;`);
    expect(() => pg.exec(noRecord(M0111()))).toThrow(/requires 0109/);
    // restore for any later run in this container
    pg.exec(noRecord(M0109()));
    pg.exec(noRecord(M0111()));
  });
});

describe("the file and its bookkeeping agree", () => {
  it("the filename's number is the version it records", () => {
    const body = M0111();
    expect(body).toMatch(/VALUES \(111, '0111_attestation_method_testimony'\)/);
  });
});
