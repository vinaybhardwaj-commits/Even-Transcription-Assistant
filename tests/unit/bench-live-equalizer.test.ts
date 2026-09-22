import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDigitalSilence } from "@/lib/bench-meter";
import { isIsoDate } from "@/lib/bench-levels";

describe("Bench Live Equalizer", () => {
  it("uses the reported zero ratio for digital silence", () => {
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1, zero_ratio: 0.99 })).toBe(true);
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1, zero_ratio: 0.2 })).toBe(false);
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1 }, true)).toBe(true);
    expect(isDigitalSilence(null)).toBe(false);
  });

  it("validates timeline day parameters", () => {
    expect(isIsoDate("2026-09-22")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("22-09-2026")).toBe(false);
  });

  it("uses production migration 0112 and schema version 112", () => {
    const migration = readFileSync("db/migrations/0112_bench_level_samples.sql", "utf8");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS bench_level_sample");
    expect(migration).toMatch(/VALUES\s*\(112,\s*'0112_bench_level_samples'\)/);
    expect(migration).not.toContain("VALUES (69,");
  });
});
