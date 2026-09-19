/**
 * S2b voiceprint re-enrolment tooling (scripts/s2b-reenrol/) and migration 0106.
 *
 * The Python lib is pure (no numpy, no network), so its unit tests run here, in the repo gate:
 * they pin the embedding wire format, the float32 centroid mean, the watchdog gate and the
 * insert-only SQL. The rest are static reads of the files. No database, no Mini.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, "scripts", "s2b-reenrol");
const read = (p: string) => fs.readFileSync(p, "utf8");

describe("s2b-reenrol python lib", () => {
  it("passes its own unit tests", () => {
    const r = spawnSync("python3", ["-m", "unittest", "test_s2b_lib"], { cwd: DIR, encoding: "utf8" });
    expect(r.stderr + r.stdout).toMatch(/OK/);
    expect(r.status).toBe(0);
  });

  it("lib imports nothing outside the standard library (so this runs anywhere python3 does)", () => {
    const imports = [...read(path.join(DIR, "s2b_lib.py")).matchAll(/^(?:from|import)\s+([\w.]+)/gm)].map((m) => m[1]);
    const stdlib = new Set(["__future__", "base64", "json", "math", "struct", "statistics"]);
    expect(imports.filter((i) => !stdlib.has(i))).toEqual([]);
  });
});

describe("mine.py — the watchdog gate is in the path of every heavy step", () => {
  const src = read(path.join(DIR, "mine.py"));
  const body = src.slice(src.indexOf("def main"));

  it("waits for GO immediately before each ffmpeg cut and each /enroll POST", () => {
    const lines = body.split("\n").map((l) => l.trim());
    for (const call of ["cut_clip(", "post_enroll("]) {
      const i = lines.findIndex((l) => l.includes(call));
      expect(i, `${call} is called in main`).toBeGreaterThan(0);
      expect(lines[i - 1], `gate precedes ${call}`).toBe("wait_for_go(log)");
    }
  });

  it("the wait has no iteration cap and calls the lib gate", () => {
    const wait = src.slice(src.indexOf("def wait_for_go"), src.indexOf("def cut_clip"));
    expect(wait).toContain("while True");
    expect(wait).toContain("gate(");
    expect(wait).not.toMatch(/range\(|max_|attempts|retries/);
  });

  it("posts to /enroll and stores the returned bytes untouched", () => {
    expect(src).toContain('/enroll"');
    expect(src).toContain('res["embedding_base64"]');
    expect(src).not.toMatch(/np\.|numpy|linalg|l2_?norm/i);
  });

  it("touches no database, no connection string, no git", () => {
    for (const f of ["mine.py", "emit_sql.py", "s2b_lib.py"]) {
      const s = read(path.join(DIR, f));
      expect(s, f).not.toMatch(/psycopg|neon|DATABASE_URL|postgres(ql)?:\/\/|subprocess\.[a-z]+\(\s*\[\s*["']git/i);
    }
  });
});

describe("migration 0106_voice_print_generation", () => {
  const sql = read(path.join(ROOT, "db", "migrations", "0106_voice_print_generation.sql"));
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("creates one new table, re-runnably", () => {
    expect(code).toMatch(/CREATE TABLE IF NOT EXISTS voice_print_generation/);
    expect(code).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(code.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it("never alters, updates or deletes anything that already exists", () => {
    // ON DELETE CASCADE on the new table's own FK is a constraint clause, not a delete statement.
    const stmts = code.replace(/ON DELETE CASCADE/g, "");
    expect(stmts).not.toMatch(/\bALTER\s+TABLE\b|\bUPDATE\b|\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
  });

  it("keeps the old print by copying it as generation 1, and cannot overwrite a generation", () => {
    expect(code).toMatch(/UNIQUE \(clinician_id, generation\)/);
    expect(code).toMatch(/FROM voice_print vp\s+ON CONFLICT DO NOTHING/);
    expect(code).toContain("'enrolment_clip'");
  });

  it("pins the embedding size and the origin vocabulary", () => {
    expect(code).toContain("octet_length(centroid) = 768");
    expect(code).toMatch(/origin IN \('enrolment_clip', 'room_audio'\)/);
  });

  it("records itself as version 106", () => {
    expect(code).toMatch(/VALUES \(106, '0106_voice_print_generation'\)/);
  });

  it("number 0106 is used once in db/migrations", () => {
    expect(fs.readdirSync(path.join(ROOT, "db", "migrations")).filter((f) => f.startsWith("0106_"))).toHaveLength(1);
  });
});
