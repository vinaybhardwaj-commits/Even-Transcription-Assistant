/**
 * lib/bench-levels.ts — the low_signal confabulation marker (STT-HALLUCINATION-PACK item 2).
 *
 * `percentile` and `levelForSpan` are PURE (no I/O, fixture-driven, like buildTurns in
 * lib/mcp/tools/bench.ts). `readLevelSamplesInRange` and `deriveQuietFloor` are the two I/O
 * functions, tested here with a MOCKED `sql` — no live database anywhere.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql };
});

import {
  deriveQuietFloor,
  levelForSpan,
  percentile,
  QUIET_FLOOR_RMS,
  readLevelSamplesInRange,
  type LevelSample,
} from "@/lib/bench-levels";

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("percentile — pure", () => {
  it("empty input is null, never 0 (0 would read as a real, very quiet measurement)", () => {
    expect(percentile([], 20)).toBeNull();
  });

  it("nearest-rank on a known set", () => {
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 100)).toBe(5);
  });

  it("unsorted input is sorted first", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  });

  it("a single value is that value at any percentile", () => {
    expect(percentile([0.02], 20)).toBe(0.02);
    expect(percentile([0.02], 90)).toBe(0.02);
  });
});

describe("levelForSpan — pure", () => {
  const floor = 0.016;

  it("no samples over the span: null peak/avg, low_signal null (not false — unmeasured, not checked-and-fine)", () => {
    const r = levelForSpan([], 1_000, 2_000, floor);
    expect(r).toEqual({ peak: null, avg: null, samples: 0, low_signal: null });
  });

  it("samples all below the floor: low_signal true, peak is the MAX in span", () => {
    const samples: LevelSample[] = [
      { sampledAtMs: 1_100, peak: 0.004, avg: 0.002 },
      { sampledAtMs: 1_400, peak: 0.009, avg: 0.005 },
    ];
    const r = levelForSpan(samples, 1_000, 2_000, floor);
    expect(r.peak).toBeCloseTo(0.009);
    expect(r.avg).toBeCloseTo((0.002 + 0.005) / 2);
    expect(r.samples).toBe(2);
    expect(r.low_signal).toBe(true);
  });

  it("one loud sample in an otherwise quiet span is NOT low_signal — peak decides, not the average", () => {
    const samples: LevelSample[] = [
      { sampledAtMs: 1_100, peak: 0.004, avg: 0.003 },
      { sampledAtMs: 1_300, peak: 0.2, avg: 0.15 }, // someone spoke up
      { sampledAtMs: 1_600, peak: 0.005, avg: 0.004 },
    ];
    const r = levelForSpan(samples, 1_000, 2_000, floor);
    expect(r.peak).toBeCloseTo(0.2);
    expect(r.low_signal).toBe(false);
  });

  it("samples outside the span are excluded, at both ends", () => {
    const samples: LevelSample[] = [
      { sampledAtMs: 500, peak: 0.9, avg: 0.9 }, // before the span — excluded
      { sampledAtMs: 1_500, peak: 0.005, avg: 0.004 }, // inside
      { sampledAtMs: 2_500, peak: 0.9, avg: 0.9 }, // after the span — excluded
    ];
    const r = levelForSpan(samples, 1_000, 2_000, floor);
    expect(r.samples).toBe(1);
    expect(r.peak).toBeCloseTo(0.005);
    expect(r.low_signal).toBe(true);
  });

  it("the span's own boundary timestamps are INCLUDED (inclusive on both ends)", () => {
    const samples: LevelSample[] = [
      { sampledAtMs: 1_000, peak: 0.5, avg: 0.5 },
      { sampledAtMs: 2_000, peak: 0.5, avg: 0.5 },
    ];
    expect(levelForSpan(samples, 1_000, 2_000, floor).samples).toBe(2);
  });

  it("a peak exactly AT the floor is NOT low_signal — 'below' is strict", () => {
    const samples: LevelSample[] = [{ sampledAtMs: 1_100, peak: floor, avg: floor }];
    expect(levelForSpan(samples, 1_000, 2_000, floor).low_signal).toBe(false);
  });

  it("avg ignores null readings rather than treating them as zero", () => {
    const samples: LevelSample[] = [
      { sampledAtMs: 1_100, peak: 0.02, avg: null },
      { sampledAtMs: 1_200, peak: 0.03, avg: 0.02 },
    ];
    const r = levelForSpan(samples, 1_000, 2_000, floor);
    expect(r.avg).toBeCloseTo(0.02);
  });

  it("a span whose only readings all have null avg reports avg:null, not 0", () => {
    const samples: LevelSample[] = [{ sampledAtMs: 1_100, peak: 0.02, avg: null }];
    expect(levelForSpan(samples, 1_000, 2_000, floor).avg).toBeNull();
  });

  it("is pure — two calls over the same input are byte-identical", () => {
    const samples: LevelSample[] = [{ sampledAtMs: 1_100, peak: 0.02, avg: 0.01 }];
    expect(JSON.stringify(levelForSpan(samples, 1_000, 2_000, floor))).toBe(
      JSON.stringify(levelForSpan(samples, 1_000, 2_000, floor)),
    );
  });
});

describe("readLevelSamplesInRange — the SQL shape and row mapping", () => {
  it("queries bench_level_sample by room_id and the timestamp bounds, ordered ascending", async () => {
    responder = () => [];
    await readLevelSamplesInRange("room_t", 1_000, 2_000);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.text).toContain("FROM bench_level_sample");
    expect(c.text).toContain("room_id = ?");
    expect(c.text).toContain("ORDER BY sampled_at ASC");
    expect(c.values[0]).toBe("room_t");
  });

  it("maps sampled_at to epoch ms and coerces peak/avg to numbers, preserving avg:null", async () => {
    responder = () => [
      { sampled_at: "2026-09-23T00:00:01.000Z", peak: "0.02", avg: "0.01" },
      { sampled_at: "2026-09-23T00:00:02.000Z", peak: 0.03, avg: null },
    ];
    const rows = await readLevelSamplesInRange("room_t", 0, 999_999_999_999);
    expect(rows).toEqual([
      { sampledAtMs: Date.parse("2026-09-23T00:00:01.000Z"), peak: 0.02, avg: 0.01 },
      { sampledAtMs: Date.parse("2026-09-23T00:00:02.000Z"), peak: 0.03, avg: null },
    ]);
  });
});

describe("deriveQuietFloor — the real derivation this ruling asked for, not called anywhere in this build", () => {
  it("computes the requested percentile over tape_advancing peak samples", async () => {
    responder = () => [{ peak: "0.01" }, { peak: "0.02" }, { peak: "0.03" }, { peak: "0.04" }, { peak: "0.05" }];
    const r = await deriveQuietFloor(20, 14);
    expect(r.sampleCount).toBe(5);
    expect(r.floor).toBeCloseTo(0.02); // p20 nearest-rank of [0.01..0.05]
    const c = calls[0]!;
    expect(c.text).toContain("tape_advancing = true");
  });

  it("no samples: floor null, sampleCount 0 — never a fabricated number", async () => {
    responder = () => [];
    const r = await deriveQuietFloor();
    expect(r).toEqual({ floor: null, sampleCount: 0 });
  });

  it("fails safe: a query error returns floor:null rather than throwing", async () => {
    responder = () => {
      throw new Error("db_unreachable");
    };
    await expect(deriveQuietFloor()).resolves.toEqual({ floor: null, sampleCount: 0 });
  });
});

describe("QUIET_FLOOR_RMS — the provisional constant itself", () => {
  it("sits strictly between digital-zero territory and the constant it was derived from", () => {
    // SILENCE_RMS in lib/bench-dual.ts, duplicated here as a literal rather than imported so
    // this assertion does not silently track a future change to that file's own constant.
    const SILENCE_RMS = 0.0015;
    expect(QUIET_FLOOR_RMS).toBeGreaterThan(SILENCE_RMS);
    expect(QUIET_FLOOR_RMS).toBeLessThan(0.5371); // the loudest reading ETA-E13 measured
  });
});
