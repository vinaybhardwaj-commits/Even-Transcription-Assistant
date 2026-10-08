import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isDigitalSilence, levelsStale, LEVELS_FRESH_MS, LEVELS_FROZEN_MS } from "@/lib/bench-meter";
import { SILENT_ZERO_RATIO } from "@/lib/bench-bus-constants";
import { isIsoDate, markFrozenBuckets, FROZEN_BUCKETS, type BenchLevelSample } from "@/lib/bench-levels";

describe("Bench Live Equalizer", () => {
  it("uses the reported zero ratio for digital silence", () => {
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1, zero_ratio: 0.99 })).toBe(true);
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1, zero_ratio: 0.2 })).toBe(false);
    expect(isDigitalSilence({ peak: 0.2, avg: 0.1 }, true)).toBe(true);
    expect(isDigitalSilence(null)).toBe(false);
    // The meter and the watchdog share one ratio. Moving either without the other fails here.
    expect(isDigitalSilence({ peak: 0, avg: 0, zero_ratio: SILENT_ZERO_RATIO })).toBe(true);
    expect(isDigitalSilence({ peak: 0, avg: 0, zero_ratio: SILENT_ZERO_RATIO - 0.0001 })).toBe(false);
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

describe("frozen / stale levels (Arch #19)", () => {
  const T = 1_000_000;
  const st = (t: number, peak = 0.0125, avg: number | null = 0.01, zero_ratio: number | null = 0.1) => ({ t_ms: t, peak, avg, zero_ratio });

  it("the same non-zero triple for longer than the frozen window is stale", () => {
    const rows = Array.from({ length: 8 }, (_, i) => st(T + i * 1500));
    expect(levelsStale(rows, T + 7 * 1500)).toBe(true);
  });
  it("a moving signal is not stale", () => {
    const rows = Array.from({ length: 8 }, (_, i) => st(T + i * 1500, 0.01 + i * 0.001));
    expect(levelsStale(rows, T + 7 * 1500)).toBe(false);
  });
  it("a short repeat inside the window is not stale", () => {
    expect(levelsStale([st(T), st(T + 1500), st(T + 3000)], T + 3000)).toBe(false);
    expect(LEVELS_FROZEN_MS).toBe(6_000);
  });
  it("no sample newer than the fresh window is stale even if the values moved", () => {
    expect(levelsStale([st(T, 0.3)], T + LEVELS_FRESH_MS + 1)).toBe(true);
  });
  it("digital silence repeating is not 'frozen' (it has its own name)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => st(T + i * 1500, 0, 0, 1));
    expect(levelsStale(rows, T + 7 * 1500)).toBe(false);
  });
  it("no samples is unknown, not stale", () => {
    expect(levelsStale([], T)).toBeNull();
  });

  const bucket = (peak: number, zr: number | null = 0.1): BenchLevelSample => ({ t_ms: 0, peak, avg: 0.01, zero_ratio: zr, session_open: true, tape_advancing: true, samples: 10 });
  it("day timeline buckets repeating the identical triple are MARKED stale, never dropped", () => {
    const out = markFrozenBuckets([bucket(0.2), bucket(0.0125), bucket(0.0125), bucket(0.0125), bucket(0.0125), bucket(0.3)]);
    expect(out).toHaveLength(6);
    expect(FROZEN_BUCKETS).toBe(3);
    expect(out.map((s) => s.stale === true)).toEqual([false, false, false, true, true, false]);
  });
  it("digital-silence buckets are not marked frozen", () => {
    expect(markFrozenBuckets([bucket(0, 1), bucket(0, 1), bucket(0, 1), bucket(0, 1)]).some((s) => s.stale)).toBe(false);
  });
  it("the card greys a stale level: the meter takes a stale prop and the card passes levels_stale", () => {
    expect(readFileSync("components/admin/BenchLevelMeter.tsx", "utf8")).toMatch(/stale\?: boolean/);
    expect(readFileSync("components/admin/BenchRoomsLive.tsx", "utf8")).toContain("stale={l?.levels_stale === true}");
  });
});
