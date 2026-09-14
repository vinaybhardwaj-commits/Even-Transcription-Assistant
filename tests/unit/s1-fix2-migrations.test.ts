/**
 * S1 FIX2 — migrations 0091 and 0092, applied VERBATIM (their schema_migrations line included) to a real
 * postgres:16, twice. A re-run must not error and must change nothing the first run did not.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer, UnrecognisedStatementError } from "../support/s1-pg";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-s1-migrations");
const file = (f: string) => readFileSync(`db/migrations/${f}.sql`, "utf8");
const noRecord = (f: string) => file(f).replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — 0091 and 0092 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/s1-fix2-migrations.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec("CREATE TABLE schema_migrations (version int PRIMARY KEY, name text); CREATE TABLE bench_session (id text PRIMARY KEY, room_id text);");
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

describe.skipIf(!HAVE_DOCKER)("0091 — the gemini stt_engine row is disabled", () => {
  const engines = async () =>
    (await pg.sql`SELECT id, enabled, fanout_enabled FROM stt_engine ORDER BY id`) as Array<{ id: string; enabled: boolean; fanout_enabled: boolean }>;

  it("the premise: 0073 seeds gemini ENABLED", async () => {
    pg.exec(noRecord("0018_stt_engine"));
    pg.exec(noRecord("0073_gemini_stt_engine"));
    expect((await engines()).find((e) => e.id === "gemini")).toMatchObject({ enabled: true });
  });

  it("applied twice: gemini disabled, every other row unchanged, recorded once, no error", async () => {
    const before = await engines();
    pg.exec(file("0091_disable_gemini_stt_engine"));
    const once = await engines();
    pg.exec(file("0091_disable_gemini_stt_engine"));
    const twice = await engines();

    expect(once.find((e) => e.id === "gemini")).toMatchObject({ enabled: false, fanout_enabled: false });
    expect(once.filter((e) => e.id !== "gemini"), "no other engine moves").toEqual(before.filter((e) => e.id !== "gemini"));
    expect(twice, "a re-run changes nothing").toEqual(once);
    expect(await pg.sql`SELECT version, name FROM schema_migrations WHERE version = 91`).toEqual([{ version: 91, name: "0091_disable_gemini_stt_engine" }]);
  });

  it("the header names the gate, both line references, and re-enabling the row AND the gate together", () => {
    const src = file("0091_disable_gemini_stt_engine");
    for (const s of ["GEMINI_STT", "lib/mcp/tools/health.ts:116", "lib/stt/adapters/gemini.ts:345", "UPDATE stt_engine SET enabled = true WHERE id = 'gemini'", "never one alone"]) {
      expect(src, s).toContain(s);
    }
  });
});

describe.skipIf(!HAVE_DOCKER)("0092 — bench_window.auto_drain_refused_at / _reason", () => {
  it("applied twice to 0057's table: two nullable columns of the right types, existing rows untouched, recorded once", async () => {
    pg.exec(noRecord("0057_bench_window"));
    pg.exec("INSERT INTO bench_session VALUES ('sess_m', 'room_1'); INSERT INTO bench_window (id, session_id, start_ms, end_ms, source_mic) VALUES ('bw_m', 'sess_m', 0, 900000, 'primary');");
    pg.exec(file("0092_bench_window_auto_drain_refusal"));
    pg.exec(file("0092_bench_window_auto_drain_refusal"));

    const cols = await pg.sql`SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
                               WHERE table_name = 'bench_window' AND column_name LIKE 'auto_drain_refused%' ORDER BY column_name`;
    expect(cols).toEqual([
      { column_name: "auto_drain_refused_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      { column_name: "auto_drain_refused_reason", data_type: "text", is_nullable: "YES", column_default: null },
    ]);
    expect(await pg.sql`SELECT auto_drain_refused_at, auto_drain_refused_reason FROM bench_window WHERE id = 'bw_m'`).toEqual([{ auto_drain_refused_at: null, auto_drain_refused_reason: null }]);
    expect(await pg.sql`SELECT version, name FROM schema_migrations WHERE version = 92`).toEqual([{ version: 92, name: "0092_bench_window_auto_drain_refusal" }]);
  });
});

describe.skipIf(!HAVE_DOCKER)("the harness itself (FIX3b C12) — what it cannot classify THROWS, never returns no rows", () => {
  it("a leading comment or parenthesis throws a named error; the same query without it returns its row", async () => {
    await expect(pg.sql`-- a comment first
      SELECT 1::int AS one`).rejects.toThrow(UnrecognisedStatementError);
    await expect(pg.sql`(SELECT 1::int AS one)`).rejects.toThrow(UnrecognisedStatementError);
    await expect(pg.sql`/* block */ SELECT 1::int AS one`).rejects.toThrow(UnrecognisedStatementError);
    expect(await pg.sql`SELECT 1::int AS one`, "the control: not every statement is refused").toEqual([{ one: 1 }]);
  });

  it("a first word it does not know throws too; the known ones still run", async () => {
    await expect(pg.sql`VALUES (1)`).rejects.toThrow(/cannot classify/);
    await expect(pg.sql`TABLE schema_migrations`).rejects.toThrow(UnrecognisedStatementError);
    expect(await pg.sql`WITH t AS (SELECT 2::int AS two) SELECT two FROM t`).toEqual([{ two: 2 }]);
  });

  it("WITH … INSERT … SELECT with no RETURNING is EXECUTED whole — its main statement is the INSERT, not the last SELECT", async () => {
    pg.exec("CREATE TABLE IF NOT EXISTS harness_probe (n int);");
    expect(await pg.sql`WITH src AS (SELECT ${41}::int + 1 AS n) INSERT INTO harness_probe (n) SELECT n FROM src`).toEqual([]);
    expect(await pg.sql`SELECT n FROM harness_probe`, "the row landed").toEqual([{ n: 42 }]);
    expect(await pg.sql`WITH src AS (SELECT 7::int AS n) INSERT INTO harness_probe (n) SELECT n FROM src RETURNING n`, "and with RETURNING it answers").toEqual([{ n: 7 }]);
  });
});
