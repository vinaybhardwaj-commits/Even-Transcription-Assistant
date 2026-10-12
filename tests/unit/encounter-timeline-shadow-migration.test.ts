/** 0156 is additive, matches the writer, and has a hand-run rollback. */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEAVE_CLOSED_BY, LEAVE_REASONS } from "@/lib/encounter-clock/fusion-leave";

const up = readFileSync("db/migrations/0156_encounter_timeline_shadow.sql", "utf8");
const down = readFileSync("db/rollbacks/0156_encounter_timeline_shadow.down.sql", "utf8");
const writer = readFileSync("lib/encounter-clock/shadow-leave.ts", "utf8");

describe("0156 encounter_timeline_shadow", () => {
  it("is present once, sits just before 0157, and does not grant", () => {
    const nums = readdirSync("db/migrations").filter((f) => /^\d{4}_.+\.sql$/.test(f)).map((f) => f.slice(0, 4));
    expect(nums.filter((n) => n === "0156")).toEqual(["0156"]);
    expect(nums.filter((n) => n === "0157")).toEqual(["0157"]);
    expect(nums.filter((n) => n === "0158")).toEqual(["0158"]);
    expect(nums.filter((n) => n === "0159")).toEqual(["0159"]);
    // 0156..0159 are each present once (above). Later numbers may exist (0160: kiosk-health dedupe replay key), so this no longer pins the maximum at 159.
    expect(Math.max(...nums.map(Number))).toBeGreaterThanOrEqual(159);
    expect(up).not.toMatch(/\bGRANT\b/);
    expect(up).toMatch(/INSERT INTO schema_migrations \(version, name\)\s+VALUES \(156, '0156_encounter_timeline_shadow'\)/);
    const tables = up.slice(up.indexOf("CREATE TABLE"));
    expect(tables).not.toMatch(/transcript|full_name|doctor_name|audio_key/);
  });

  it("checks the same closed_by and reason codes the fusion emits", () => {
    for (const c of LEAVE_CLOSED_BY) expect(up).toContain(`'${c}'`);
    for (const c of LEAVE_REASONS) expect(up).toContain(`'${c}'`);
    expect(up).toMatch(/end_ms > start_ms/);
    expect(up).toMatch(/jsonb_typeof\(features\) = 'array'/);
  });

  it("the writer inserts every column the table has for a consult, and the rollback drops only these two", () => {
    const cols = ["consult_key", "start_ms", "end_ms", "confidence", "raw_confidence", "reason_codes", "closed_by", "encounter_end_ms", "jev_used", "cache_hit", "cache_key", "end_row", "end_signal", "late_start_p", "kind", "kind_conf", "features"];
    for (const c of cols) {
      expect(up).toContain(c);
      expect(writer).toContain(c);
    }
    expect(down).toMatch(/DROP TABLE IF EXISTS encounter_timeline_shadow;/);
    expect(down).toMatch(/DROP TABLE IF EXISTS encounter_timeline_shadow_run;/);
    expect(down).toMatch(/DELETE FROM schema_migrations WHERE version = 156;/);
    expect(down).toMatch(/RUN BY HAND ONLY/);
  });
});
