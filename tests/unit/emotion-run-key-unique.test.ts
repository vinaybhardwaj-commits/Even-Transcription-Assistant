/**
 * buildRuns must never return two runs with one (speaker_idx, start_ms): that is the row key's run part, and
 * two rows with one key either fail the whole batch ("cannot affect row a second time") or overwrite each other.
 * The two geometries are eta-refuter's, from the review of emotion-dedupe 87a7215. Pure: no database.
 */
import { describe, it, expect } from "vitest";
import { buildRuns, planSegments, type AttributedTurn } from "@/lib/emotion/segments";

const T = (source_ref: string, speaker_idx: number, start_ms: number, end_ms: number, no_role_reason: string | null = null): AttributedTurn =>
  ({ source_ref, speaker_idx, start_ms, end_ms, no_role_reason });
const keys = (turns: AttributedTurn[]) => {
  const { runs } = buildRuns(turns);
  return planSegments(runs, 0, 30).map((p) => `${p.speaker_idx}|${p.run_start_ms}|${p.chunk_idx}`);
};

describe("buildRuns: one run per (speaker, start)", () => {
  it("interleaved speakers with a shared start: the two spk0 runs fold into one", () => {
    const turns = [T("a", 0, 1000, 1200), T("b", 1, 1000, 1500), T("c", 0, 1000, 9000)];
    const { runs } = buildRuns(turns);
    expect(runs.filter((r) => r.speaker_idx === 0)).toEqual([{ speaker_idx: 0, start_ms: 1000, end_ms: 9000, source_refs: ["a", "c"] }]);
    expect(runs).toHaveLength(2);
    const k = keys(turns);
    expect(new Set(k).size).toBe(k.length);
  });

  it("a straddle between two same-start turns of one speaker: still one run, and the straddle stays skipped", () => {
    const turns = [T("a", 0, 1000, 1200), T("s", 0, 1000, 1300, "straddle"), T("c", 0, 1000, 9000)];
    const { runs, skipped } = buildRuns(turns);
    expect(runs).toEqual([{ speaker_idx: 0, start_ms: 1000, end_ms: 9000, source_refs: ["a", "c"] }]);
    expect(skipped.map((s) => s.source_refs[0])).toEqual(["s"]);
    const k = keys(turns);
    expect(new Set(k).size).toBe(k.length);
  });

  it("ordinary runs are untouched: gap merge, a new run past the gap, another speaker", () => {
    const turns = [T("a", 0, 0, 1000), T("b", 0, 1500, 2500), T("c", 1, 2600, 3000), T("d", 0, 9000, 9500)];
    expect(buildRuns(turns).runs).toEqual([
      { speaker_idx: 0, start_ms: 0, end_ms: 2500, source_refs: ["a", "b"] },
      { speaker_idx: 1, start_ms: 2600, end_ms: 3000, source_refs: ["c"] },
      { speaker_idx: 0, start_ms: 9000, end_ms: 9500, source_refs: ["d"] },
    ]);
  });

  it("surviving runs keep the order they were first opened, the folded one at its first position", () => {
    const turns = [T("a", 0, 1000, 1200), T("b", 1, 1000, 1500), T("c", 0, 1000, 9000), T("d", 1, 20000, 21000)];
    expect(buildRuns(turns).runs.map((r) => `${r.speaker_idx}|${r.start_ms}`)).toEqual(["0|1000", "1|1000", "1|20000"]);
  });

  it("random turn soups never yield a duplicate planned key", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    for (let n = 0; n < 300; n += 1) {
      const turns: AttributedTurn[] = [];
      for (let i = 0; i < 12; i += 1) {
        const s = Math.floor(rnd() * 4) * 500;
        turns.push(T(`t${i}`, Math.floor(rnd() * 3), s, s + 100 + Math.floor(rnd() * 3000), rnd() < 0.15 ? "straddle" : null));
      }
      const k = keys(turns);
      expect(new Set(k).size).toBe(k.length);
    }
  });
});
