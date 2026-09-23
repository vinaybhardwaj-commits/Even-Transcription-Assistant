/**
 * tests/unit/jev-migration-0116.test.ts — REQUIRED PROOF: 0116 (jev_decision, J-CORE-2) applies
 * cleanly against a real postgres:16 already carrying every migration through 0115, and its
 * shape (columns, the subject_type CHECK, the natural-key unique index, idempotency) is right.
 *
 * No FK dependency of its own (subject_id is deliberately polymorphic, see the migration's own
 * column comment), but this still proves it on the REAL current schema, not a vacuum — the same
 * discipline tests/unit/jev-migrations-0106-0107.test.ts uses for 0106/0107.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-migration-0116");

describe("REQUIRED PROOF — 0116 applies after every migration through 0115, against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error(
      "REQUIRED PROOF NOT RUN: tests/unit/jev-migration-0116.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.",
    );
  });
});

describe.skipIf(!HAVE_DOCKER)("0116 (jev_decision) over a real 0001-0115 schema", () => {
  it("applies cleanly, records itself, has the right shape, and is idempotent", async () => {
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
      const through115 = files.filter((f) => Number(f.slice(0, 4)) <= 115);
      const m116 = files.find((f) => f.startsWith("0116_"));
      expect(m116, "0116 is in the discovered set").toBeTruthy();

      for (const f of through115) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));

      const before = (await pg.sql`SELECT version FROM schema_migrations WHERE version = 115`) as Array<{ version: number }>;
      expect(before).toHaveLength(1);

      // THE ACT ITSELF.
      pg.exec(readFileSync(`db/migrations/${m116}`, "utf8"));

      const applied = (await pg.sql`SELECT version, name FROM schema_migrations WHERE version = 116`) as Array<{ version: number; name: string }>;
      expect(applied).toEqual([{ version: 116, name: "0116_jev_decision" }]);

      const cols = (await pg.sql`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_name = 'jev_decision' ORDER BY column_name
      `) as Array<{ column_name: string; data_type: string; is_nullable: string }>;
      const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
      // No text column, per the kickoff — every column is either an id/label, a number, jsonb,
      // or a timestamp. `text` columns that DO exist are closed-vocabulary labels, never state.
      expect(Object.keys(byName).sort()).toEqual(
        ["answer", "confidence", "created_at", "id", "input_tokens", "latency_ms", "model", "prompt_version", "probabilities", "question_id", "subject_id", "subject_type"].sort(),
      );
      expect(byName.answer!.data_type).toBe("jsonb");
      expect(byName.probabilities!.data_type).toBe("jsonb");
      expect(byName.confidence!.data_type).toBe("real");
      expect(byName.id!.is_nullable).toBe("NO");
      expect(byName.subject_type!.is_nullable).toBe("NO");
      expect(byName.subject_id!.is_nullable).toBe("NO");
      expect(byName.question_id!.is_nullable).toBe("NO");
      expect(byName.prompt_version!.is_nullable).toBe("NO");
      expect(byName.model!.is_nullable).toBe("NO");
      // probabilities/confidence/latency_ms/input_tokens are all nullable (a noul answer has no
      // probabilities; a persist can precede knowing latency in principle) — never forced to 0.
      expect(byName.probabilities!.is_nullable).toBe("YES");
      expect(byName.confidence!.is_nullable).toBe("YES");

      // The CHECK on subject_type admits exactly the five values the kickoff named.
      for (const good of ["window", "turn", "note_sentence", "encounter", "collapse"]) {
        await pg.sql`
          INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer)
          VALUES (${`jd_${good}`}, ${good}, 's1', 'q1', 'v1', 'jev-x', '{"type":"noul","noul":0.5}'::jsonb)
        `;
      }
      await expect(
        pg.sql`
          INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer)
          VALUES ('jd_bad', 'bad_type', 's1', 'q1', 'v1', 'jev-x', '{"type":"noul","noul":0.5}'::jsonb)
        `,
      ).rejects.toThrow();

      // The natural-key unique index: a second row for the SAME (subject_type, subject_id,
      // question_id, prompt_version) conflicts — proving the upsert key insertJevDecisions relies
      // on actually exists, not just documented in a comment.
      await expect(
        pg.sql`
          INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, answer)
          VALUES ('jd_dup', 'window', 's1', 'q1', 'v1', 'jev-x', '{"type":"noul","noul":0.9}'::jsonb)
        `,
      ).rejects.toThrow();

      // Idempotent like every other migration in this repo: re-applying changes nothing, errors on nothing.
      pg.exec(readFileSync(`db/migrations/${m116}`, "utf8"));
      const stillApplied = (await pg.sql`SELECT version FROM schema_migrations WHERE version = 116`) as Array<{ version: number }>;
      expect(stillApplied).toHaveLength(1);
    } finally {
      pg.stop();
    }
  }, 120_000);
});
