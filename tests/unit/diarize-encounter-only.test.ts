/**
 * This build touches the ENCOUNTER path and nothing else.
 *
 * The brief was explicit about what it must not do: no diarizing a room window, a bench_window,
 * or anything on the tape (that slice is gated on a schema decision nobody has made); no writes
 * to speaker_cluster; no touching ROOM_STT_DRAIN_ENABLED, FUSE_LIVE_ENABLED, arm A, the fuse or
 * the drain. Those are easy promises to make in a report and easy to break by accident later,
 * so they are assertions instead.
 *
 * Read off the source, not off a mock: what matters is what the shipped files can reach.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const diarize = readFileSync("lib/diarize.ts", "utf8");
const gate = readFileSync("lib/diarize-gate.ts", "utf8");
const migration = readFileSync("db/migrations/0063_diarize_slot.sql", "utf8");
const resume = readFileSync("app/api/admin/resume-processing/route.ts", "utf8");
const build = [diarize, gate, migration, resume].join("\n");

/** Comments discuss the room path (they must, to explain why it is out of scope). Code may not. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

describe("the diarize dispatch build stays on the encounter path", () => {
  it.each([
    ["bench_window", /bench_window/],
    ["speaker_cluster", /speaker_cluster/],
    ["room_day", /room_day/],
    ["stt_window", /stt_window/],
    ["the drain flag", /ROOM_STT_DRAIN_ENABLED/],
    ["the fuse flag", /FUSE_LIVE_ENABLED/],
  ])("never names %s in code", (_label, re) => {
    expect(codeOnly(build)).not.toMatch(re);
  });

  it("the migration adds a slot table and one encounter column, and alters nothing else", () => {
    // Strip line comments FIRST: the header prose contains a semicolon (the probe's linear fit),
    // and splitting before stripping would cut a statement in half.
    const stmts = migration
      .replace(/--[^\n]*/g, "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    const ddl = stmts.filter((s) => /^(CREATE|ALTER|DROP|TRUNCATE|UPDATE|DELETE)\b/i.test(s));
    expect(ddl).toHaveLength(2);
    expect(ddl[0]).toMatch(/^CREATE TABLE IF NOT EXISTS diarize_slot\b/i);
    expect(ddl[1]).toMatch(/^ALTER TABLE encounter ADD COLUMN IF NOT EXISTS diarize_timing JSONB$/i);
    expect(migration).not.toMatch(/\bDROP\b/i);
  });

  it("re-running diarization cannot regenerate a note (the rediarize door is narrow)", () => {
    // The whole reason ?rediarize=1 exists is that the only pre-existing door, ?reset=1, clears
    // note_json and cdmss_json. Its own UPDATE must touch diarization fields and the step-lock
    // bookkeeping, and nothing clinical.
    const branch = /if \(rediarize\) \{[\s\S]*?\n    \}/.exec(resume)?.[0] ?? "";
    expect(branch).toBeTruthy();
    // The SQL itself, without the comments that (correctly) name what it leaves alone.
    const stmt = /UPDATE encounter SET[\s\S]*?WHERE id = \$\{manualId\}/.exec(branch)?.[0] ?? "";
    expect(stmt).toBeTruthy();
    expect(stmt).toMatch(/diarize_status = NULL/);
    expect(stmt).not.toMatch(/note_json|cdmss_json|transcript|translated|(?<![_a-z])status\s*=/);
    // and it drives the step machine narrowed to diarization
    expect(branch).toMatch(/resumeOne\([^)]*"diarize"\)/);
  });
});
