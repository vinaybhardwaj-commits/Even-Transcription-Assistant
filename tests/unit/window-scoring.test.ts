/**
 * Build 2 §C — the refusal-emitting scorer.
 *
 * PRD §4: "no code path renders WER without its refusal rate." Every pair reaches SCORED or
 * REFUSED and never a third outcome; these tests are one fixture per reason code, plus the two
 * rules that are easy to get subtly wrong — that family contamination SURVIVES graduation, and
 * that a missing silence typing withholds only the insertion metric and never the WER.
 */
import { describe, it, expect } from "vitest";
import {
  decideScore,
  clipHypothesisToCovered,
  coverageRatio,
  parseSilenceSpans,
  insertionsPerSilentSecond,
  COVERAGE_FLOOR,
  type GoldRow,
  type RunRow,
} from "@/lib/stt/window-scoring";

const SPINE_APPLIED = new Date("2026-08-29T12:00:00.000Z");

const gold = (over: Partial<GoldRow> = {}): GoldRow => ({
  window_id: "bw_test",
  reference_text: "the patient reports chest pain radiating to the left arm",
  status: "graduated",
  seed_engine_family: null,
  covered_ms: 900000,
  window_ms: 900000,
  silence_spans_json: null,
  ...over,
});

const run = (over: Partial<RunRow> = {}): RunRow => ({
  id: "tr_test",
  engine: "whisper",
  transcript_original: "the patient reports chest pain radiating to the left arm",
  receipt_complete: true,
  created_at: "2026-08-30T09:00:00.000Z",
  ...over,
});

const decide = (g: GoldRow | null, r: RunRow, family: string | null = "whisper") =>
  decideScore({ gold: g, run: r, engineFamily: family, spineAppliedAt: SPINE_APPLIED });

describe("each refusal code on its own fixture", () => {
  it("NO_GOLD — no reference row at all", () => {
    expect(decide(null, run())).toEqual({ kind: "refused", reason: "NO_GOLD" });
  });

  it("GOLD_NOT_GRADUATED — the five Cardiology seeds, exactly as they ship", () => {
    const seed = gold({ status: "seed", seed_engine_family: "sarvam" });
    expect(decide(seed, run())).toEqual({ kind: "refused", reason: "GOLD_NOT_GRADUATED" });
  });

  it("every non-graduated status refuses, not merely 'seed'", () => {
    for (const status of ["seed", "in_review", "rejected"]) {
      expect(decide(gold({ status }), run())).toEqual({ kind: "refused", reason: "GOLD_NOT_GRADUATED" });
    }
  });

  it("FAMILY_CONTAMINATION — the engine's family seeded the reference", () => {
    const g = gold({ seed_engine_family: "sarvam" });
    expect(decide(g, run({ engine: "sarvam" }), "sarvam")).toEqual({ kind: "refused", reason: "FAMILY_CONTAMINATION" });
  });

  it("COVERAGE_BELOW_FLOOR — the reference covers too little of the window", () => {
    const g = gold({ covered_ms: 500000, window_ms: 900000 }); // 0.555…
    expect(decide(g, run())).toEqual({ kind: "refused", reason: "COVERAGE_BELOW_FLOOR" });
  });

  it("NO_RECEIPT — the run is younger than the spine and still unreceipted", () => {
    const r = run({ receipt_complete: false, created_at: "2026-08-30T09:00:00.000Z" });
    expect(decide(gold(), r)).toEqual({ kind: "refused", reason: "NO_RECEIPT" });
  });

  it("LEGACY_UNRECEIPTED — the run predates the spine and had no columns to fill", () => {
    const r = run({ receipt_complete: false, created_at: "2026-08-24T09:00:00.000Z" });
    expect(decide(gold(), r)).toEqual({ kind: "refused", reason: "LEGACY_UNRECEIPTED" });
  });
});

describe("the LEGACY / NO_RECEIPT cutoff", () => {
  it("one millisecond before the migration is LEGACY", () => {
    const r = run({ receipt_complete: false, created_at: new Date(SPINE_APPLIED.getTime() - 1).toISOString() });
    expect(decide(gold(), r)).toEqual({ kind: "refused", reason: "LEGACY_UNRECEIPTED" });
  });

  it("the migration instant itself is NOT legacy — the columns existed", () => {
    const r = run({ receipt_complete: false, created_at: new Date(SPINE_APPLIED.getTime()).toISOString() });
    expect(decide(gold(), r)).toEqual({ kind: "refused", reason: "NO_RECEIPT" });
  });

  it("an unknown migration time reports the STRICTER code, never excusing a run it cannot date", () => {
    const d = decideScore({
      gold: gold(),
      run: run({ receipt_complete: false, created_at: "2026-01-01T00:00:00.000Z" }),
      engineFamily: "whisper",
      spineAppliedAt: null,
    });
    expect(d).toEqual({ kind: "refused", reason: "NO_RECEIPT" });
  });
});

describe("family contamination goes through the registry, and survives graduation", () => {
  it("A GRADUATED seed STILL refuses its own family — the load-bearing rule of §4", () => {
    const g = gold({ status: "graduated", seed_engine_family: "sarvam" });
    expect(decide(g, run({ engine: "sarvam" }), "sarvam")).toEqual({ kind: "refused", reason: "FAMILY_CONTAMINATION" });
  });

  it("a DIFFERENT family scores against the same graduated seed", () => {
    const g = gold({ status: "graduated", seed_engine_family: "sarvam" });
    const d = decide(g, run({ engine: "whisper" }), "whisper");
    expect(d.kind).toBe("scored");
  });

  it("the composite is caught BY FAMILY, which a string compare on the key would miss", () => {
    // elevenlabs_scribe is ElevenLabs ASR wearing Even's note LLM: a different KEY, same family.
    const g = gold({ seed_engine_family: "elevenlabs" });
    expect(decide(g, run({ engine: "elevenlabs_scribe" }), "elevenlabs"))
      .toEqual({ kind: "refused", reason: "FAMILY_CONTAMINATION" });
    // The key differs from the family, so a naive `engine === seed_engine_family` would score it.
    expect("elevenlabs_scribe").not.toBe("elevenlabs");
  });

  it("an UNREGISTERED engine fails CLOSED rather than scoring unprovable", () => {
    const g = gold({ seed_engine_family: "sarvam" });
    expect(decide(g, run({ engine: "mystery" }), null)).toEqual({ kind: "refused", reason: "FAMILY_CONTAMINATION" });
  });

  it("a gold with no seed family cannot contaminate anything", () => {
    const g = gold({ seed_engine_family: null });
    expect(decide(g, run(), null).kind).toBe("scored");
  });
});

describe("the coverage floor boundary", () => {
  it("exactly at the floor is scoreable; a hair below is not", () => {
    expect(decide(gold({ covered_ms: 540000, window_ms: 900000 }), run()).kind).toBe("scored"); // 0.60
    expect(decide(gold({ covered_ms: 539999, window_ms: 900000 }), run()))
      .toEqual({ kind: "refused", reason: "COVERAGE_BELOW_FLOOR" });
  });

  it("the floor is 60%, as PRD §4 states", () => {
    expect(COVERAGE_FLOOR).toBe(0.6);
  });

  it("an unstated coverage is treated as below the floor, never waved through", () => {
    expect(decide(gold({ covered_ms: null }), run())).toEqual({ kind: "refused", reason: "COVERAGE_BELOW_FLOOR" });
    expect(coverageRatio(null, 900000)).toBeNull();
    expect(coverageRatio(900000, 0)).toBeNull();
  });
});

describe("the hypothesis is clipped to covered_ms BEFORE the WER", () => {
  it("full coverage clips nothing", () => {
    expect(clipHypothesisToCovered("a b c d", 900000, 900000)).toBe("a b c d");
  });

  it("half coverage keeps the leading half of the words", () => {
    expect(clipHypothesisToCovered("a b c d e f", 450000, 900000)).toBe("a b c");
  });

  it("clipping happens before scoring, so a partial reference is not punished for the rest", () => {
    // Reference covers 60% of the window; the run transcribed the whole thing. Without the clip
    // the trailing 40% would all count as insertions and the engine would look far worse.
    const g = gold({ reference_text: "alpha bravo charlie", covered_ms: 540000, window_ms: 900000 });
    const r = run({ transcript_original: "alpha bravo charlie delta echo" });
    const d = decide(g, r);
    expect(d.kind).toBe("scored");
    if (d.kind === "scored") expect(d.wer).toBe(0);
  });

  it("an empty hypothesis clips to empty rather than throwing", () => {
    expect(clipHypothesisToCovered("", 450000, 900000)).toBe("");
  });
});

describe("the insertion metric refuses ALONE — WER always stands", () => {
  it("null spans withhold only insertions_per_silent_second", () => {
    const d = decide(gold({ silence_spans_json: null }), run());
    expect(d.kind).toBe("scored");
    if (d.kind === "scored") {
      expect(d.wer).not.toBeNull();
      expect(d.insertions_per_silent_second).toBeNull();
      expect(d.insertion_refusal).toBe("SILENCE_UNTYPED");
    }
  });

  it("an UNTYPED span refuses exactly as a missing one does", () => {
    const d = decide(gold({ silence_spans_json: [{ start_ms: 0, end_ms: 1000 }] }), run());
    expect(d.kind).toBe("scored");
    if (d.kind === "scored") expect(d.insertion_refusal).toBe("SILENCE_UNTYPED");
  });

  it("an unrecognised type is not a type", () => {
    expect(parseSilenceSpans([{ start_ms: 0, end_ms: 1000, type: "banana" }])).toBeNull();
  });

  it("typed spans compute the metric and refuse nothing", () => {
    const d = decideScore({
      gold: gold({ silence_spans_json: [{ start_ms: 0, end_ms: 10000, type: "ambient" }] }),
      run: run(),
      engineFamily: "whisper",
      spineAppliedAt: SPINE_APPLIED,
      textSpans: [{ start_ms: 1000, end_ms: 2000, text: "thank you" }],
    });
    expect(d.kind).toBe("scored");
    if (d.kind === "scored") {
      expect(d.insertion_refusal).toBeNull();
      expect(d.insertions_per_silent_second).toBe(0.2); // 2 words over 10 s
    }
  });

  it("the three typed values are the closed set", () => {
    for (const type of ["equipment", "corridor", "ambient"]) {
      expect(parseSilenceSpans([{ start_ms: 0, end_ms: 1000, type }])).toHaveLength(1);
    }
  });

  it("a word overlapping silence counts; one wholly outside does not", () => {
    const spans = [{ start_ms: 5000, end_ms: 10000, type: "ambient" as const }];
    expect(insertionsPerSilentSecond([{ start_ms: 4000, end_ms: 6000, text: "two words" }], spans)).toBe(0.4);
    expect(insertionsPerSilentSecond([{ start_ms: 0, end_ms: 1000, text: "two words" }], spans)).toBe(0);
    expect(insertionsPerSilentSecond([{ start_ms: 6000, end_ms: 7000, text: "   " }], spans)).toBe(0);
  });
});

describe("precedence — one reason per pair, in a stated order", () => {
  it("NO_GOLD outranks everything: without a reference nothing else can be judged", () => {
    expect(decide(null, run({ receipt_complete: false }), null)).toEqual({ kind: "refused", reason: "NO_GOLD" });
  });

  it("GOLD_NOT_GRADUATED outranks contamination, coverage and receipt", () => {
    const g = gold({ status: "seed", seed_engine_family: "sarvam", covered_ms: 1 });
    expect(decide(g, run({ engine: "sarvam", receipt_complete: false }), "sarvam"))
      .toEqual({ kind: "refused", reason: "GOLD_NOT_GRADUATED" });
  });

  it("FAMILY_CONTAMINATION outranks coverage and receipt", () => {
    const g = gold({ seed_engine_family: "sarvam", covered_ms: 1 });
    expect(decide(g, run({ engine: "sarvam", receipt_complete: false }), "sarvam"))
      .toEqual({ kind: "refused", reason: "FAMILY_CONTAMINATION" });
  });

  it("COVERAGE_BELOW_FLOOR outranks receipt", () => {
    const g = gold({ covered_ms: 1 });
    expect(decide(g, run({ receipt_complete: false }))).toEqual({ kind: "refused", reason: "COVERAGE_BELOW_FLOOR" });
  });
});

describe("today's data: every pair refuses, and that is correct", () => {
  it("a Cardiology seed against Sarvam refuses on graduation, not on a bug", () => {
    const seed = gold({ status: "seed", source: "contaminated_seed", seed_engine_family: "sarvam" } as Partial<GoldRow>);
    const sarvamRun = run({ engine: "sarvam", receipt_complete: false });
    const d = decide(seed, sarvamRun, "sarvam");
    expect(d).toEqual({ kind: "refused", reason: "GOLD_NOT_GRADUATED" });
  });

  it("even a perfectly receipted run refuses while the seed is ungraduated", () => {
    const seed = gold({ status: "seed", seed_engine_family: "sarvam" });
    expect(decide(seed, run({ receipt_complete: true }), "whisper").kind).toBe("refused");
  });
});
