/**
 * nemotron-segments.test.ts — the PURE mapping from a Nemotron answer to the shape the room tables store
 * (lib/diarize-nemotron/segments.ts). The expected values are worked out by hand.
 */
import { describe, expect, it } from "vitest";
import { nemotronToSegments } from "@/lib/diarize-nemotron/segments";

describe("nemotronToSegments", () => {
  it("indices follow the label NUMBER, with no gap: spk0, spk2 → idx 0, 1; the answer's order does not matter", () => {
    const r = nemotronToSegments([[0, 1000, "spk2"], [2000, 3000, "spk0"], [4000, 5000, "spk2"]]);
    expect(r.labels).toEqual(["spk0", "spk2"]);
    expect(r.segments.map((s) => [s.start_ms, s.end_ms, s.speaker_idx])).toEqual([[0, 1000, 1], [2000, 3000, 0], [4000, 5000, 1]]);
  });

  it("overlap is set from interval intersection with ANOTHER speaker; touching edges and the same speaker are not overlap", () => {
    const r = nemotronToSegments([[0, 4000, "spk0"], [3500, 8000, "spk1"], [8000, 9000, "spk0"], [9000, 12000, "spk0"], [9500, 10000, "spk0"]]);
    expect(r.segments.map((s) => s.overlap)).toEqual([true, true, false, false, false]);
  });

  it("a zero-length turn is dropped, so end_ms > start_ms always holds; an empty answer is empty", () => {
    expect(nemotronToSegments([[1000, 1000, "spk0"]]).segments).toEqual([]);
    expect(nemotronToSegments([])).toEqual({ labels: [], segments: [] });
  });

  it("the stored shape has exactly the four keys the readers know", () => {
    const [s] = nemotronToSegments([[0, 1, "spk0"]]).segments;
    expect(Object.keys(s!).sort()).toEqual(["end_ms", "overlap", "speaker_idx", "start_ms"]);
  });
});
