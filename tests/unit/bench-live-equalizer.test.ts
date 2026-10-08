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
  it("LEVELS_FROZEN_MS boundary: an identical run of exactly 6000 ms is not stale, 6001 ms is", () => {
    expect(LEVELS_FROZEN_MS).toBe(6_000);
    const run = (span: number) => [st(T), st(T + span)];
    expect(levelsStale(run(LEVELS_FROZEN_MS), T + LEVELS_FROZEN_MS)).toBe(false);
    expect(levelsStale(run(LEVELS_FROZEN_MS + 1), T + LEVELS_FROZEN_MS + 1)).toBe(true);
  });
  it("LEVELS_FRESH_MS is at least twice the hidden-tab poll interval (5 s)", () => {
    expect(LEVELS_FRESH_MS).toBe(12_000);
    expect(levelsStale([st(T, 0.3)], T + 5_000 + 1_000)).toBe(false);
    expect(levelsStale([st(T, 0.3)], T + LEVELS_FRESH_MS)).toBe(false);
    expect(levelsStale([st(T, 0.3)], T + LEVELS_FRESH_MS + 1)).toBe(true);
  });
  it("no zero_ratio on the newest sample: the repeat test cannot judge, so null, never stale (but an old sample is still stale)", () => {
    const rows = Array.from({ length: 8 }, (_, i) => st(T + i * 1500, 0.0125, 0.01, null));
    expect(levelsStale(rows, T + 7 * 1500)).toBeNull();
    expect(levelsStale(rows, T + 7 * 1500 + LEVELS_FRESH_MS + 1)).toBe(true);
  });
  it("no samples at all in the window is stale (true), not unknown", () => {
    expect(levelsStale([], T)).toBe(true);
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

describe("levels_stale while the kiosk keeps polling but samples stop (refuter C1)", () => {
  it("the route's reader: a room with NO samples in the window reads stale true; a read that fails leaves the room out (null on the card)", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    const NOW = 5_000_000;
    let rows: Array<Record<string, unknown>> = [];
    let fail = false;
    vi.doMock("@/lib/db", () => ({ sql: async () => { if (fail) throw new Error("db down"); return rows; } }));
    const { readLevelsStale } = await import("@/lib/bench-levels-stale");
    // r1 has a fresh moving sample; r2 stopped sending (no rows); r3's only sample is 20 s old (in the window, past the 12 s fresh line)
    rows = [
      { room_id: "r1", sampled_at: new Date(NOW - 1000), peak: 0.2, avg: 0.1, zero_ratio: 0.1 },
      { room_id: "r3", sampled_at: new Date(NOW - 20_000), peak: 0.2, avg: 0.1, zero_ratio: 0.1 },
    ];
    const m = await readLevelsStale(["r1", "r2", "r3"], NOW);
    expect(m.get("r1")).toBe(false);
    expect(m.get("r2")).toBe(true);
    expect(m.get("r3")).toBe(true);
    fail = true;
    const failed = await readLevelsStale(["r1"], NOW);
    expect(failed.get("r1") ?? null).toBeNull();
    vi.doUnmock("@/lib/db");
  });
  it("the route uses that reader and passes its answer to the card", () => {
    const r = readFileSync("app/api/admin/bench/listeners/route.ts", "utf8");
    expect(r).toContain('from "@/lib/bench-levels-stale"');
    expect(r).toContain("levels_stale: stale.get(l.room_id) ?? null");
  });
});
