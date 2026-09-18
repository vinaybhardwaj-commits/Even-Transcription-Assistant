/**
 * E20 rebase — WHAT TO VERIFY §1: migration order.
 *
 * Production has 0097, 0099, 0100, 0101 and 0102 applied. It does NOT have 0096 (E20). The runner
 * (app/api/run-migrations/route.ts, discoverMigrations) sorts every .sql file in db/migrations/
 * ASCENDING BY NUMBER and, for each, checks `appliedVersions.includes(m.version)` — membership in
 * `schema_migrations`, not position relative to what else is applied. Quoted, verbatim:
 *
 *     const all = discoverMigrations(); // .sort((a, b) => a.version - b.version)
 *     for (const m of all) {
 *       if (appliedVersions.includes(m.version)) { skipped.push(m.name); continue; }
 *       ... apply m ...
 *     }
 *
 * There is no check anywhere in that loop, or in discoverMigrations, that every LOWER-numbered
 * file has already been applied before a higher one runs, or the reverse. It applies whichever
 * unapplied file it meets, in ascending order, and skips whichever is already recorded. So on a
 * database that already has 0097-0102, a run of the migration endpoint reaches 0096 in its normal
 * ascending sweep, finds it unapplied, and attempts it — after 0093, before the now-skipped 0097.
 *
 * That answers the RUNNER's behaviour. It does not answer whether 0096's OWN SQL succeeds against
 * a schema that already carries 0097-0102's changes — that is a property of 0096's statements, not
 * of the runner, and is proven below against a real postgres:16 holding EVERY migration through
 * 0102 in the exact shape production has today: 0096 absent, everything else present.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e20-migration-order");

describe("REQUIRED PROOF — 0096 applies out of numeric order, against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e20-migration-order.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0096 over a 0097-0102 schema — production's real shape, not an empty database", () => {
  it("every migration through 0102 except 0096 applies cleanly, matching production's actual applied set, and 0096 then applies on top without error", async () => {
    pg.start();
    try {
      // The runner's own bootstrap statement, verbatim (route.ts:134-140).
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
      expect(files.some((f) => f.startsWith("0096_")), "0096 really is in the discovered set").toBe(true);
      expect(files.some((f) => f.startsWith("0102_")), "and 0102 really is too — the merge landed it").toBe(true);

      // Production's real state: every OTHER migration through 0102, 0096 held back. Each file
      // carries its own INSERT INTO schema_migrations (proven file-by-file in
      // tests/unit/migrations-self-record.test.ts), so this single loop both builds the schema
      // AND records exactly what production has recorded — nothing here asserts it, the files do.
      for (const f of files) {
        if (f.startsWith("0096_")) continue;
        pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
      }

      // THE PREMISE, PROVEN, NOT ASSUMED: 0097, 0099-0102 are in; 0096 is not.
      const before = (await pg.sql`SELECT version FROM schema_migrations WHERE version IN (96, 97, 99, 100, 101, 102) ORDER BY version`) as Array<{ version: number }>;
      expect(before.map((r) => r.version)).toEqual([97, 99, 100, 101, 102]);

      // THE ACT ITSELF: 0096, applied over that schema — out of numeric order relative to 0097-0102,
      // exactly as the runner's ascending-but-membership-only sweep would do it.
      pg.exec(readFileSync("db/migrations/0096_room_turn_speaker_losing_score.sql", "utf8"));

      const after = (await pg.sql`SELECT version, name FROM schema_migrations WHERE version = 96`) as Array<{ version: number; name: string }>;
      expect(after).toEqual([{ version: 96, name: "0096_room_turn_speaker_losing_score" }]);

      const cols = (await pg.sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'room_turn_speaker' AND column_name IN ('losing_clinician_id', 'losing_score', 'score_basis')
         ORDER BY column_name
      `) as Array<{ column_name: string }>;
      expect(cols.map((c) => c.column_name)).toEqual(["losing_clinician_id", "losing_score", "score_basis"]);

      const checks = (await pg.sql`
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'room_turn_speaker'::regclass
           AND conname IN ('room_turn_speaker_losing_only_no_match_ck', 'room_turn_speaker_losing_together_ck',
                            'room_turn_speaker_losing_score_ck', 'room_turn_speaker_score_basis_ck')
         ORDER BY conname
      `) as Array<{ conname: string }>;
      expect(checks.map((c) => c.conname)).toEqual([
        "room_turn_speaker_losing_only_no_match_ck",
        "room_turn_speaker_losing_score_ck",
        "room_turn_speaker_losing_together_ck",
        "room_turn_speaker_score_basis_ck",
      ]);

      // Idempotent, as every other migration here is: applying it a second time changes nothing
      // and does not error (ADD COLUMN IF NOT EXISTS, constraints guarded by name, ON CONFLICT DO NOTHING).
      pg.exec(readFileSync("db/migrations/0096_room_turn_speaker_losing_score.sql", "utf8"));
      const still = (await pg.sql`SELECT version FROM schema_migrations WHERE version = 96`) as Array<{ version: number }>;
      expect(still).toHaveLength(1);
    } finally {
      pg.stop();
    }
  }, 300_000);
});
