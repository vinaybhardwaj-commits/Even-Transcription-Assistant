/**
 * tests/unit/jev-migrations-0106-0107.test.ts — REQUIRED PROOF (Refuter, 19 Sep): 0106
 * (jev_window_signal) and 0107 (jev_role_signal, edited for F4) apply cleanly, in numeric order,
 * against a real postgres:16 already carrying every migration through 0105 (J0's
 * jev_window_text) — the actual dependency 0106/0107 need (jev_window_signal.window_id and
 * jev_role_signal.window_id both REFERENCE bench_window(id), and 0107's own comment says it
 * "rolls forward from 0106").
 *
 * Also proves F4's edited 0107: prompt_version is NOT NULL, and the new `note` column exists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-migrations-0106-0107");

describe("REQUIRED PROOF — 0106 and 0107 apply after 0105, against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error(
      "REQUIRED PROOF NOT RUN: tests/unit/jev-migrations-0106-0107.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.",
    );
  });
});

describe.skipIf(!HAVE_DOCKER)("0106 (jev_window_signal) and 0107 (jev_role_signal, F4-edited) over a real 0001-0105 schema", () => {
  it("every migration through 0105 applies, then 0106, then 0107 — in that numeric order, cleanly", async () => {
    pg.start();
    try {
      pg.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      const files = readdirSync("db/migrations")
        .filter((f) => /^\d{4}_.+\.sql$/.test(f))
        .sort();
      const through105 = files.filter((f) => Number(f.slice(0, 4)) <= 105);
      const m106 = files.find((f) => f.startsWith("0106_"));
      const m107 = files.find((f) => f.startsWith("0107_"));
      expect(m106, "0106 is in the discovered set").toBeTruthy();
      expect(m107, "0107 is in the discovered set").toBeTruthy();

      // Build the real dependency chain: everything through 0105 (bench_window, jev_window_text),
      // in ascending numeric order, exactly as the runner's own discoverMigrations sweep would.
      for (const f of through105) {
        pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
      }
      const before = (await pg.sql`SELECT version FROM schema_migrations WHERE version = 105`) as Array<{ version: number }>;
      expect(before).toHaveLength(1);

      // THE ACT ITSELF: 0106 then 0107, in numeric order, on top of a real 0001-0105 schema.
      pg.exec(readFileSync(`db/migrations/${m106}`, "utf8"));
      pg.exec(readFileSync(`db/migrations/${m107}`, "utf8"));

      const applied = (await pg.sql`SELECT version, name FROM schema_migrations WHERE version IN (106, 107) ORDER BY version`) as Array<{ version: number; name: string }>;
      expect(applied).toEqual([
        { version: 106, name: "0106_jev_window_signal" },
        { version: 107, name: "0107_jev_role_signal" },
      ]);

      const windowSignalCols = (await pg.sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'jev_window_signal' ORDER BY column_name
      `) as Array<{ column_name: string }>;
      expect(windowSignalCols.map((c) => c.column_name)).toContain("window_id");

      // F4 (19 Sep): prompt_version is NOT NULL, and the new `note` column exists.
      const roleSignalCols = (await pg.sql`
        SELECT column_name, is_nullable FROM information_schema.columns
         WHERE table_name = 'jev_role_signal' AND column_name IN ('prompt_version', 'note')
         ORDER BY column_name
      `) as Array<{ column_name: string; is_nullable: string }>;
      expect(roleSignalCols).toEqual([
        { column_name: "note", is_nullable: "YES" },
        { column_name: "prompt_version", is_nullable: "NO" },
      ]);

      // Both migrations are idempotent, like every other migration in this repo: re-applying
      // changes nothing and does not error.
      pg.exec(readFileSync(`db/migrations/${m106}`, "utf8"));
      pg.exec(readFileSync(`db/migrations/${m107}`, "utf8"));
      const stillApplied = (await pg.sql`SELECT version FROM schema_migrations WHERE version IN (106, 107)`) as Array<{ version: number }>;
      expect(stillApplied).toHaveLength(2);
    } finally {
      pg.stop();
    }
  }, 300_000);
});
