/** Cheap acoustic features beside the word-free timeline. No names, pitch stays null, no evidence is not zero. */
import { describe, expect, it } from "vitest";
import { DEAD_MIC_DBFS } from "@/lib/encounter-clock/gate";
import { buildRowFeatures, featuresAreWordFree, type FeatureRow } from "@/lib/encounter-clock/timeline-features";

const row = { t: "t+00:00", start_ms: 0, end_ms: 30_000, who: ["DOC", "B"], overlap_s: 2 };

describe("buildRowFeatures", () => {
  it("keeps timeline letters, drops anything else, and never invents a pitch", () => {
    const [f] = buildRowFeatures({
      rows: [{ ...row, who: ["DOC", "not-a-letter", "patient", "?", "C"] }],
      turns: [{ start_ms: 0, end_ms: 10_000 }],
      levels: [{ t_ms: 1_000, avg: 0.1, peak: 0.2, zero_ratio: 0 }, { t_ms: 2_000, avg: 0.1, peak: 0.2, zero_ratio: 0 }],
      covered: () => true,
    });
    expect(f!.who).toEqual(["DOC", "?", "C"]);
    expect(f!.pitch).toBeNull();
    expect(f!.overlap_s).toBe(2);
    expect(f!.silence_s).toBe(20);
    expect(f!.mean_turn_s).toBe(10);
    expect(featuresAreWordFree([f!])).toBe(true);
  });

  it("an uncovered row is null speech, not zero", () => {
    const [f] = buildRowFeatures({
      rows: [row],
      turns: [{ start_ms: 0, end_ms: 10_000 }],
      levels: [],
      covered: () => false,
    });
    expect(f).toMatchObject({ silence_s: null, mean_turn_s: null, overlap_s: null, loud_db: null, level_events: null, pitch: null });
  });

  it("no level samples leaves loudness null; a zero amplitude is the dead-mic floor", () => {
    const [none] = buildRowFeatures({ rows: [row], turns: [], levels: [], covered: () => true });
    expect(none!.loud_db).toBeNull();
    const [dead] = buildRowFeatures({
      rows: [row], turns: [], levels: [{ t_ms: 1_000, avg: 0, peak: 0, zero_ratio: 1 }], covered: () => true,
    });
    expect(dead!.loud_db).toBe(DEAD_MIC_DBFS);
  });

  it("counts level-log state changes and needs two samples to do it", () => {
    const levels = [
      { t_ms: 1_000, avg: 0, peak: 0, zero_ratio: 1 },
      { t_ms: 2_000, avg: 0.2, peak: 0.3, zero_ratio: 0 },
      { t_ms: 3_000, avg: 0.0001, peak: 0.0001, zero_ratio: 0 },
    ];
    const [f] = buildRowFeatures({ rows: [row], turns: [], levels, covered: () => true });
    expect(f!.level_events).toBe(2);
    const [one] = buildRowFeatures({ rows: [row], turns: [], levels: levels.slice(0, 1), covered: () => true });
    expect(one!.level_events).toBeNull();
  });

  it("refuses a feature row that carries a name", () => {
    const bad = { t: "t+00:00", who: ["DOC"], loud_db: null, silence_s: null, mean_turn_s: null, overlap_s: null, level_events: null, pitch: null } as FeatureRow;
    expect(featuresAreWordFree([{ ...bad, who: ["room five"] }])).toBe(false);
    expect(featuresAreWordFree([bad])).toBe(true);
  });
});
