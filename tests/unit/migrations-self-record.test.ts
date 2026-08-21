/**
 * Every migration must record itself.
 *
 * The runner (app/api/run-migrations/route.ts) does NOT write the schema_migrations row.
 * Each file writes its own, inside the same Neon HTTP transaction as its DDL, so a file
 * that omits that line is re-attempted on every single invocation of the runner — for ever.
 *
 * That is not cosmetic. The apply loop returns 500 on the FIRST file that throws and stops,
 * so a permanently-unrecorded file sitting near the front of the queue means one transient
 * fault on it silently blocks every later migration from ever applying. Six files (25, 32,
 * 33, 34, 35, 36) were in exactly that state; production was repaired by hand on 21 Aug 2026
 * and these assertions are what stops a seventh.
 *
 * The rule, for EVERY file in db/migrations/ named NNNN_name.sql:
 *   1. it contains an INSERT INTO schema_migrations,
 *   2. that INSERT names the version integer parsed from the filename,
 *   3. and it names the full filename stem, including the NNNN_ prefix.
 *
 * There is no exception list, on purpose. 0009 used to record itself as 'tagged_transcript'
 * (no prefix) with a quoted '0009' version; it was brought into line with the convention
 * rather than exempted. That rewrite is a no-op against production: the version 9 row is
 * already there, ON CONFLICT DO NOTHING never rewrites a stored name, and the runner's skip
 * check keys on the version INTEGER only, never the name.
 *
 * No database and no mocks — this reads the .sql files off disk.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const DIR = path.join(process.cwd(), "db", "migrations");

/** The runner's own discovery regex (route.ts discoverMigrations), verbatim. */
const FILE_RE = /^(\d{4})_(.+)\.sql$/;

type Migration = { file: string; version: number; stem: string; body: string };

const migrations: Migration[] = fs
  .readdirSync(DIR)
  .filter((f) => FILE_RE.test(f))
  .sort()
  .map((file) => ({
    file,
    version: parseInt(FILE_RE.exec(file)![1]!, 10),
    stem: file.replace(/\.sql$/, ""),
    body: fs.readFileSync(path.join(DIR, file), "utf8"),
  }));

/**
 * The self-recording statement, from `INSERT` to the terminating `;`. House style splits it
 * over three lines, so this is matched across newlines rather than line by line.
 */
const RECORD_RE = /INSERT\s+INTO\s+schema_migrations\b[\s\S]*?;/i;

describe("db/migrations — every migration records itself", () => {
  it("there are migrations to check at all (a silent empty sweep would prove nothing)", () => {
    expect(migrations.length).toBeGreaterThan(40);
  });

  it.each(migrations.map((m) => [m.file, m] as const))(
    "%s — records itself with its own version and its own name",
    (_file, m) => {
      const stmt = RECORD_RE.exec(m.body)?.[0];

      // 1. the statement exists at all
      expect(stmt, `${m.file} has no INSERT INTO schema_migrations — the runner will re-attempt it for ever`).toBeTruthy();

      // 2. it names THIS version, as a bare integer (no quotes, no leading zeros)
      const values = /VALUES\s*\(\s*([^,\s]+)\s*,\s*'([^']*)'\s*\)/i.exec(stmt!);
      expect(values, `${m.file}: cannot read (version, name) out of ${JSON.stringify(stmt)}`).toBeTruthy();
      expect(values![1], `${m.file} must record version ${m.version} as a bare integer`).toBe(String(m.version));

      // 3. it names the filename stem, prefix included
      expect(values![2], `${m.file} must record its name as '${m.stem}'`).toBe(m.stem);
    },
  );

  it("no two files claim the same version, and the versions match the filenames", () => {
    const seen = new Map<number, string>();
    for (const m of migrations) {
      expect(seen.has(m.version), `version ${m.version} claimed by both ${seen.get(m.version)} and ${m.file}`).toBe(false);
      seen.set(m.version, m.file);
      expect(m.stem.startsWith(String(m.version).padStart(4, "0") + "_")).toBe(true);
    }
  });

  it("the six repaired files each carry exactly one recording line, and their DDL is untouched", () => {
    let total = 0;
    for (const version of [25, 32, 33, 34, 35, 36]) {
      const m = migrations.find((x) => x.version === version);
      expect(m, `migration ${version} is missing from db/migrations/`).toBeTruthy();
      // exactly one — an appended line must never have been added twice
      expect(m!.body.match(/INSERT\s+INTO\s+schema_migrations/gi)).toHaveLength(1);
      // and every statement in them is still the additive, idempotent kind. Comments are
      // stripped BEFORE the split: 0032's own comment contains a semicolon.
      const stmts = m!.body
        .replace(/--[^\n]*/g, "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      const ddl = stmts.filter((s) => /^ALTER\s+TABLE/i.test(s));
      expect(ddl.length, `${m!.file} has no ALTER TABLE left`).toBeGreaterThan(0);
      for (const s of ddl) expect(s).toMatch(/ADD COLUMN IF NOT EXISTS/i);
      // nothing but the ALTERs and the one recording line
      expect(stmts).toHaveLength(ddl.length + 1);
      total += ddl.length;
    }
    // the seven ADD COLUMN IF NOT EXISTS statements the repair was scoped to, and no more
    expect(total).toBe(7);
  });
});
