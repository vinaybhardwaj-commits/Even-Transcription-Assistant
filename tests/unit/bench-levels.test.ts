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

  it("unsorted input is sorted first (X6, ETA-Refuter 23 Sep: the prior fixture [5,1,3,2,4] happened to put the sorted median AND the unsorted index-2 value at the same 3, so it passed even with the sort removed — this one does not)", () => {
    // sorted [1,2,3,4,50] -> p50 index 2 -> 3. The unsorted array's own index 2 is 2 — a
    // dropped sort would return 2, not 3, so this fixture actually distinguishes the two.
    expect(percentile([50, 1, 2, 3, 4], 50)).toBe(3);
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

  it("X4 (ETA-Refuter, 23 Sep): low_signal is decided by PEAK, not (avg ?? peak) — a loud spike with a low overall avg is NOT low_signal", () => {
    // peak 0.5 is well above QUIET_FLOOR_RMS; the only avg reading, 0.002, is well below it.
    // (avg ?? peak) < floor would flip this to low_signal:true — that mutation left the suite
    // green until now because avg was 0% populated when this file was first written; it is
    // populated on most rows today (ETA-LOW-SIGNAL-MARKER-REFUTER-VERDICT-23-SEP-2026.md), so
    // the deliberate peak-basis choice is now load-bearing and needed its own assertion.
    const samples: LevelSample[] = [{ sampledAtMs: 1_100, peak: 0.5, avg: 0.002 }];
    const r = levelForSpan(samples, 1_000, 2_000, QUIET_FLOOR_RMS);
    expect(r.peak).toBeCloseTo(0.5);
    expect(r.avg).toBeCloseTo(0.002);
    expect(r.low_signal).toBe(false);
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

  it("X6 (ETA-Refuter, 23 Sep): the percentile it derives is correct even when the DB returns rows out of order — proves percentile's own sort runs, not just that its unit test claims so", async () => {
    // sorted peaks [0.01,0.02,0.03,0.04,0.05] -> p50 index 2 -> 0.03. Deliberately NOT the
    // sorted order below, and NOT an order whose own index 2 happens to also be 0.03 (the same
    // trap the old percentile unit test fell into) — index 2 of THIS order is 0.02.
    responder = () => [{ peak: "0.05" }, { peak: "0.01" }, { peak: "0.02" }, { peak: "0.03" }, { peak: "0.04" }];
    const r = await deriveQuietFloor(50, 14);
    expect(r.sampleCount).toBe(5);
    expect(r.floor).toBeCloseTo(0.03);
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

describe("QUIET_FLOOR_RMS — the measured constant itself (ETA-LOW-SIGNAL-MARKER-REFUTER-VERDICT-23-SEP-2026.md)", () => {
  it("is exactly the measured p05 of peak over tape_advancing spans (n=51,074)", () => {
    expect(QUIET_FLOOR_RMS).toBe(0.008);
  });

  it("sits strictly between digital-zero territory and the loudest reading on record", () => {
    // SILENCE_RMS in lib/bench-dual.ts, duplicated here as a literal rather than imported so
    // this assertion does not silently track a future change to that file's own constant.
    const SILENCE_RMS = 0.0015;
    expect(QUIET_FLOOR_RMS).toBeGreaterThan(SILENCE_RMS);
    expect(QUIET_FLOOR_RMS).toBeLessThan(0.5371); // the loudest reading ETA-E13 measured
  });

  it("sits AT OR BELOW the real median (0.0107) — a floor above the median is not a marker, it is a constant (the failure mode the first shipped value had)", () => {
    expect(QUIET_FLOOR_RMS).toBeLessThanOrEqual(0.0107);
  });
});
