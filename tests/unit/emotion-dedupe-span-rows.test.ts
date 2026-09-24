/**
 * prepare's span rows must reach the single INSERT ... ON CONFLICT DO UPDATE with one row per conflict key,
 * or Postgres refuses the whole batch ("cannot affect row a second time") and every retry fails the same way
 * (30 windows at the attempt bound, 20 of them on this error). Pure: no database.
 */
import { describe, it, expect } from "vitest";
import { dedupeSpanRows, skippedRow, unscorableRow, type SegmentWrite } from "@/lib/emotion/store";
import type { MeasuredSegment, SkippedSpan } from "@/lib/emotion/segments";

const W: SegmentWrite = {
  windowId: "bw_x", roomDayId: "rd_x", diarizeRunId: "run1", clipR2Key: "k", windowStartMs: 1_000, cap_s: 30,
  model: { model: null, model_key: null, subfolder: null, device: null },
};
const skipped = (speaker_idx: number, start_ms: number, end_ms: number, ref: string): SkippedSpan =>
  ({ speaker_idx, start_ms, end_ms, source_refs: [ref], reason: "straddle" });
const unscorable = (speaker_idx: number, start_ms: number, end_ms: number, refs: string[]): MeasuredSegment => ({
  speaker_idx, source_refs: refs, run_start_ms: start_ms, run_end_ms: end_ms, chunk_idx: 0, chunk_count: 1,
  start_ms, end_ms, clip_start_s: (start_ms - 1_000) / 1000, clip_end_s: (end_ms - 1_000) / 1000, speech_ms: 400,
});

describe("dedupeSpanRows", () => {
  it("leaves rows with distinct keys alone, in order", () => {
    const rows = [skippedRow(W, skipped(0, 2_000, 3_000, "a"), 0), skippedRow(W, skipped(1, 2_000, 3_000, "b"), 0), skippedRow(W, skipped(0, 4_000, 5_000, "c"), 0)];
    const out = dedupeSpanRows(rows);
    expect(out.collapsed).toBe(0);
    expect(out.rows.map((r) => r.source_refs[0])).toEqual(["a", "b", "c"]);
  });

  it("folds two straddle turns of one speaker starting on the same millisecond into one row, keeping both refs and the later end", () => {
    const out = dedupeSpanRows([skippedRow(W, skipped(0, 2_000, 3_000, "a"), 0), skippedRow(W, skipped(0, 2_000, 3_500, "b"), 0)]);
    expect(out.collapsed).toBe(1);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.state).toBe("skipped");
    expect(out.rows[0]!.source_refs).toEqual(["a", "b"]);
    expect(out.rows[0]!.run_end_ms).toBe(3_500);
    expect(out.rows[0]!.segment_end_ms).toBe(3_500);
    expect(out.rows[0]!.clip_end_s).toBeCloseTo(2.5);
  });

  it("an unscorable chunk beats a skipped row on the same key, in either order, and keeps every ref", () => {
    const s = skippedRow(W, skipped(0, 2_000, 2_800, "s"), 0);
    const u = unscorableRow(W, unscorable(0, 2_000, 3_200, ["u1", "u2"]));
    for (const rows of [[s, u], [u, s]]) {
      const out = dedupeSpanRows(rows);
      expect(out.collapsed).toBe(1);
      expect(out.rows).toHaveLength(1);
      expect(out.rows[0]!.state).toBe("unscorable");
      expect(new Set(out.rows[0]!.source_refs)).toEqual(new Set(["s", "u1", "u2"]));
      expect(out.rows[0]!.run_end_ms).toBe(3_200);
    }
  });

  it("the same start on a different speaker or chunk is a different key", () => {
    const a = skippedRow(W, skipped(0, 2_000, 3_000, "a"), 0);
    const b = skippedRow(W, skipped(1, 2_000, 3_000, "b"), 0);
    const c = { ...unscorableRow(W, unscorable(0, 2_000, 60_000, ["c"])), chunk_idx: 1 };
    expect(dedupeSpanRows([a, b, c]).collapsed).toBe(0);
  });

  it("no input, no output", () => {
    expect(dedupeSpanRows([])).toEqual({ rows: [], collapsed: 0 });
  });
});
