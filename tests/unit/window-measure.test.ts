/**
 * Build 1 §B — the free-signal stack.
 *
 * The rule these tests exist to protect above all others: `peak_level IS NULL` is UNKNOWN, never
 * silence (migration 0066). Everything downstream — the quarantine decision, the coverage
 * report, and the entire natural-silence experiment that spends a paid batch on known-zero
 * references — is built on that distinction holding.
 */
import { describe, it, expect } from "vitest";
import {
  measureWindow,
  partitionWindow,
  partitionSumsToWindow,
  quarantineFor,
  confusabilityOf,
  normalizeOpinion,
  scoreWindow,
  levelSpans,
  mergeSpans,
  overlapMs,
  roomEnergyFloor,
  DEFAULT_ROOM_ENERGY_FLOOR,
  MEASURABILITY_FLOOR,
  PROXY_VERSION,
  type MeasureChunk,
} from "@/lib/stt/window-measure";

const T0 = Date.parse("2026-08-24T06:30:00.000Z"); // window start
const FIFTEEN = 15 * 60_000;
const T1 = T0 + FIFTEEN;

/** A chunk covering [T0 + fromMs, T0 + toMs) of the window. */
const chunk = (fromMs: number, toMs: number, peak: number | null, state = "verified", gap = 0): MeasureChunk => ({
  started_at: new Date(T0 + fromMs).toISOString(),
  ended_at: new Date(T0 + toMs).toISOString(),
  upload_state: state,
  peak_level: peak,
  gap_before_ms: gap,
});

const LOUD = 0.5;
const QUIET = 0.0001;

describe("the 0066 rule — NULL is unknown, never silence", () => {
  it("a window of NULL levels reports unknown_ms, and zero silence", () => {
    const m = measureWindow([chunk(0, FIFTEEN, null)], T0, T1);
    expect(m.unknown_ms).toBe(FIFTEEN);
    expect(m.silent_ms).toBe(0);
    expect(m.energy_ms).toBe(0);
  });

  it("unknown time NEVER reaches m — an unmeasured window is not a measurable one", () => {
    const m = measureWindow([chunk(0, FIFTEEN, null)], T0, T1);
    expect(m.m).toBe(0);
    expect(m.quarantine_reason).toBe("NO_LEVELS");
  });

  it("below-floor IS silence, and it is evidence — it counts toward m", () => {
    const m = measureWindow([chunk(0, FIFTEEN, QUIET)], T0, T1);
    expect(m.silent_ms).toBe(FIFTEEN);
    expect(m.unknown_ms).toBe(0);
    expect(m.m).toBe(1);
    expect(m.quarantine_reason).toBeNull();
  });

  it("a NaN or undefined level is unknown, not a comparison that quietly reads false", () => {
    const nan = measureWindow([chunk(0, FIFTEEN, Number.NaN)], T0, T1);
    expect(nan.unknown_ms).toBe(FIFTEEN);
    expect(nan.silent_ms).toBe(0);
    const undef = measureWindow(
      [{ started_at: new Date(T0).toISOString(), ended_at: new Date(T1).toISOString(), upload_state: "verified", peak_level: undefined as unknown as null }],
      T0, T1,
    );
    expect(undef.unknown_ms).toBe(FIFTEEN);
    expect(undef.silent_ms).toBe(0);
  });

  it("half unknown and half silent never merge into one bucket", () => {
    const m = measureWindow([chunk(0, FIFTEEN / 2, null), chunk(FIFTEEN / 2, FIFTEEN, QUIET)], T0, T1);
    expect(m.unknown_ms).toBe(FIFTEEN / 2);
    expect(m.silent_ms).toBe(FIFTEEN / 2);
    expect(m.m).toBe(0.5);
  });
});

describe("the partition is exhaustive", () => {
  it("energy + silent + unknown + unverified + gap + uncovered === window_ms", () => {
    const p = partitionWindow(
      [
        chunk(0, 200_000, LOUD),
        chunk(200_000, 400_000, QUIET),
        chunk(400_000, 600_000, null),
        chunk(600_000, 700_000, LOUD, "pending"),
      ],
      T0, T1, DEFAULT_ROOM_ENERGY_FLOOR,
    );
    expect(partitionSumsToWindow(p, FIFTEEN)).toBe(true);
  });

  it("an empty window is entirely uncovered, and still sums", () => {
    const p = partitionWindow([], T0, T1, DEFAULT_ROOM_ENERGY_FLOOR);
    expect(p.uncovered_ms).toBe(FIFTEEN);
    expect(partitionSumsToWindow(p, FIFTEEN)).toBe(true);
  });

  it("a chunk straddling the boundary contributes only the part inside the window", () => {
    const p = partitionWindow([chunk(-60_000, 60_000, LOUD)], T0, T1, DEFAULT_ROOM_ENERGY_FLOOR);
    expect(p.energy_ms).toBe(60_000);
    expect(partitionSumsToWindow(p, FIFTEEN)).toBe(true);
  });

  it("overlapping chunks are clipped, never double-counted — m can never exceed 1", () => {
    const p = partitionWindow([chunk(0, FIFTEEN, LOUD), chunk(0, FIFTEEN, LOUD)], T0, T1, DEFAULT_ROOM_ENERGY_FLOOR);
    expect(p.energy_ms).toBe(FIFTEEN);
    expect(partitionSumsToWindow(p, FIFTEEN)).toBe(true);
    expect(measureWindow([chunk(0, FIFTEEN, LOUD), chunk(0, FIFTEEN, LOUD)], T0, T1).m).toBe(1);
  });

  it("gap_before_ms lands in its own bucket and is discounted from m by never entering it", () => {
    // 5 min of gap, then 10 min of loud audio.
    const p = partitionWindow([chunk(300_000, FIFTEEN, LOUD, "verified", 300_000)], T0, T1, DEFAULT_ROOM_ENERGY_FLOOR);
    expect(p.gap_ms).toBe(300_000);
    expect(p.energy_ms).toBe(600_000);
    expect(partitionSumsToWindow(p, FIFTEEN)).toBe(true);
    const m = measureWindow([chunk(300_000, FIFTEEN, LOUD, "verified", 300_000)], T0, T1);
    expect(m.m).toBeCloseTo(600_000 / FIFTEEN, 6);
  });

  it("an unverified chunk's level is not evidence about the room", () => {
    const p = partitionWindow([chunk(0, FIFTEEN, LOUD, "pending")], T0, T1, DEFAULT_ROOM_ENERGY_FLOOR);
    expect(p.unverified_ms).toBe(FIFTEEN);
    expect(p.energy_ms).toBe(0);
    expect(p.silent_ms).toBe(0);
  });
});

describe("quarantine — one reason per branch, from a closed set", () => {
  it("NO_AUDIO — nothing covers the window at all", () => {
    expect(measureWindow([], T0, T1).quarantine_reason).toBe("NO_AUDIO");
  });

  it("NO_LEVELS — tape exists and not one covering chunk carries a level", () => {
    expect(measureWindow([chunk(0, FIFTEEN, null)], T0, T1).quarantine_reason).toBe("NO_LEVELS");
  });

  it("UNVERIFIED_CHUNKS — the unmeasured time is mostly uploads that never verified", () => {
    const m = measureWindow([chunk(0, 800_000, LOUD, "pending"), chunk(800_000, FIFTEEN, LOUD)], T0, T1);
    expect(m.m).toBeLessThan(MEASURABILITY_FLOOR);
    expect(m.quarantine_reason).toBe("UNVERIFIED_CHUNKS");
  });

  it("LOW_COVERAGE — everything else below the floor", () => {
    // A quarter of the window measured, the rest simply not covered.
    const m = measureWindow([chunk(0, 200_000, LOUD)], T0, T1);
    expect(m.m).toBeLessThan(MEASURABILITY_FLOOR);
    expect(m.quarantine_reason).toBe("LOW_COVERAGE");
  });

  it("NO_AUDIO outranks NO_LEVELS — an absent recording is not the meter's fault", () => {
    expect(quarantineFor(
      { energy_ms: 0, silent_ms: 0, unknown_ms: 0, unverified_ms: 0, gap_ms: 0, uncovered_ms: FIFTEEN },
      FIFTEEN,
    )).toBe("NO_AUDIO");
  });

  it("a measurable window is never quarantined", () => {
    const m = measureWindow([chunk(0, FIFTEEN, LOUD)], T0, T1);
    expect(m.m).toBe(1);
    expect(m.quarantine_reason).toBeNull();
  });

  it("the floor is exclusive — exactly at 0.5 is measurable, just below is not", () => {
    const at = measureWindow([chunk(0, FIFTEEN / 2, LOUD)], T0, T1);
    expect(at.m).toBe(0.5);
    expect(at.quarantine_reason).toBeNull();
    const below = measureWindow([chunk(0, FIFTEEN / 2 - 1000, LOUD)], T0, T1);
    expect(below.quarantine_reason).not.toBeNull();
  });

  it("the reason vocabulary is CLOSED — no branch invents a fifth", () => {
    const reasons = new Set([
      measureWindow([], T0, T1).quarantine_reason,
      measureWindow([chunk(0, FIFTEEN, null)], T0, T1).quarantine_reason,
      measureWindow([chunk(0, 800_000, LOUD, "pending"), chunk(800_000, FIFTEEN, LOUD)], T0, T1).quarantine_reason,
      measureWindow([chunk(0, 200_000, LOUD)], T0, T1).quarantine_reason,
    ]);
    for (const r of reasons) {
      expect(["NO_LEVELS", "LOW_COVERAGE", "UNVERIFIED_CHUNKS", "NO_AUDIO"]).toContain(r);
    }
    expect(reasons.size).toBe(4);
  });
});

describe("the energy floor", () => {
  it("defaults to the device's own -48 dBFS VAD floor in amplitude", () => {
    expect(roomEnergyFloor("room_x", {})).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
    // The constant IS the conversion, to three significant figures — not a tidier 0.004.
    expect(DEFAULT_ROOM_ENERGY_FLOOR).toBeCloseTo(10 ** (-48 / 20), 4);
    expect(DEFAULT_ROOM_ENERGY_FLOOR).toBeLessThan(10 ** (-48 / 20));
  });

  it("honours a valid override", () => {
    expect(roomEnergyFloor("room_x", { ROOM_ENERGY_FLOOR: "0.02" })).toBe(0.02);
  });

  it("IGNORES a nonsense override rather than reporting a whole day as silent", () => {
    for (const bad of ["", "abc", "-1", "2", "NaN"]) {
      expect(roomEnergyFloor("room_x", { ROOM_ENERGY_FLOOR: bad })).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
    }
  });
});

describe("confusability — all four values, and the partial cases", () => {
  it("0 — every opinion is the same code, across names and locales", () => {
    const r = confusabilityOf({ probe_language: "english", full_window_language: "english", sarvam_language: "en-IN" });
    expect(r).toEqual({ confusability: 0, opinions_present: 3 });
  });

  it("1 — codes differ inside one bucket", () => {
    const r = confusabilityOf({ probe_language: "hindi", full_window_language: "hindi", sarvam_language: "kn-IN" });
    expect(r).toEqual({ confusability: 1, opinions_present: 3 });
  });

  it("2 — the buckets split 2-1", () => {
    const r = confusabilityOf({ probe_language: "english", full_window_language: "english", sarvam_language: "hi-IN" });
    expect(r).toEqual({ confusability: 2, opinions_present: 3 });
  });

  it("3 — all three codes differ, and it OUTRANKS the bucket split it also is", () => {
    const r = confusabilityOf({ probe_language: "english", full_window_language: "hindi", sarvam_language: "ta-IN" });
    expect(r).toEqual({ confusability: 3, opinions_present: 3 });
  });

  it("a null opinion is missing evidence, never agreement — opinions_present says so", () => {
    const r = confusabilityOf({ probe_language: "english", full_window_language: null, sarvam_language: "en-IN" });
    expect(r).toEqual({ confusability: 0, opinions_present: 2 });
  });

  it("two opinions can reach 2, but never 3 — three distinct codes need three opinions", () => {
    expect(confusabilityOf({ probe_language: "english", sarvam_language: "hi-IN" }))
      .toEqual({ confusability: 2, opinions_present: 2 });
    expect(confusabilityOf({ probe_language: "hindi", sarvam_language: "kn-IN" }))
      .toEqual({ confusability: 1, opinions_present: 2 });
  });

  it("one opinion agrees with nothing and disagrees with nothing", () => {
    expect(confusabilityOf({ probe_language: "hindi" })).toEqual({ confusability: 0, opinions_present: 1 });
  });

  it("no opinion at all is NULL, not 0 — nothing agreed because nothing spoke", () => {
    expect(confusabilityOf({})).toEqual({ confusability: null, opinions_present: 0 });
    expect(confusabilityOf({ probe_language: "auto", full_window_language: "und", sarvam_language: "unknown" }))
      .toEqual({ confusability: null, opinions_present: 0 });
  });

  it("normalizeOpinion folds names and locales onto one comparable code", () => {
    expect(normalizeOpinion("english")).toBe("en");
    expect(normalizeOpinion("en-IN")).toBe("en");
    expect(normalizeOpinion("hindi")).toBe("hi");
    expect(normalizeOpinion("hi-IN")).toBe("hi");
    expect(normalizeOpinion("  AUTO ")).toBeNull();
    expect(normalizeOpinion(null)).toBeNull();
  });
});

describe("scores — text on silence, and energy with no text", () => {
  const chunks = [chunk(0, 300_000, QUIET), chunk(300_000, 600_000, LOUD), chunk(600_000, 900_000, null)];

  it("transcript inside metered quiet is counted — every character there is a hallucination", () => {
    const s = scoreWindow(chunks, [{ start_ms: T0 + 10_000, end_ms: T0 + 20_000, text: "the patient says" }], T0, T1);
    expect(s.text_on_silence_ms).toBe(10_000);
  });

  it("metered sound with no words at all is the whole energy span", () => {
    const s = scoreWindow(chunks, [], T0, T1);
    expect(s.energy_no_text_ms).toBe(300_000);
  });

  it("text over UNKNOWN time counts as neither — it was never measured", () => {
    const s = scoreWindow(chunks, [{ start_ms: T0 + 700_000, end_ms: T0 + 800_000, text: "hello" }], T0, T1);
    expect(s.text_on_silence_ms).toBe(0);
    expect(s.energy_no_text_ms).toBe(300_000);
  });

  it("blank text is not transcript — it cannot hallucinate onto silence", () => {
    const s = scoreWindow(chunks, [{ start_ms: T0 + 10_000, end_ms: T0 + 20_000, text: "   " }], T0, T1);
    expect(s.text_on_silence_ms).toBe(0);
  });

  it("overlapping segments are merged, never summed past the window", () => {
    const s = scoreWindow(
      chunks,
      [
        { start_ms: T0, end_ms: T0 + 200_000, text: "a" },
        { start_ms: T0 + 100_000, end_ms: T0 + 300_000, text: "b" },
      ],
      T0, T1,
    );
    expect(s.text_on_silence_ms).toBe(300_000);
  });

  it("levelSpans admits only verified chunks that carry a level", () => {
    const { quiet, energy } = levelSpans(
      [chunk(0, 100_000, QUIET), chunk(100_000, 200_000, LOUD), chunk(200_000, 300_000, null), chunk(300_000, 400_000, QUIET, "pending")],
      T0, T1, DEFAULT_ROOM_ENERGY_FLOOR,
    );
    expect(quiet).toEqual([{ start_ms: T0, end_ms: T0 + 100_000 }]);
    expect(energy).toEqual([{ start_ms: T0 + 100_000, end_ms: T0 + 200_000 }]);
  });

  it("mergeSpans and overlapMs are the arithmetic the scores rest on", () => {
    expect(mergeSpans([{ start_ms: 0, end_ms: 10 }, { start_ms: 5, end_ms: 20 }])).toEqual([{ start_ms: 0, end_ms: 20 }]);
    expect(mergeSpans([{ start_ms: 0, end_ms: 10 }, { start_ms: 20, end_ms: 30 }])).toHaveLength(2);
    expect(overlapMs([{ start_ms: 0, end_ms: 100 }], [{ start_ms: 50, end_ms: 200 }])).toBe(50);
    expect(overlapMs([{ start_ms: 0, end_ms: 100 }], [{ start_ms: 200, end_ms: 300 }])).toBe(0);
  });
});

describe("the instrument names itself", () => {
  it("every measurement carries the proxy version that produced it", () => {
    expect(measureWindow([chunk(0, FIFTEEN, LOUD)], T0, T1).proxy_version).toBe(PROXY_VERSION);
    expect(scoreWindow([], [], T0, T1).proxy_version).toBe(PROXY_VERSION);
  });
});

describe("rerun is idempotent — the same input is the same row", () => {
  it("measuring twice produces byte-identical output", () => {
    const cs = [chunk(0, 300_000, QUIET), chunk(300_000, 600_000, LOUD), chunk(600_000, 900_000, null)];
    expect(JSON.stringify(measureWindow(cs, T0, T1))).toBe(JSON.stringify(measureWindow(cs, T0, T1)));
  });

  it("chunk ORDER does not change the answer", () => {
    const a = [chunk(0, 300_000, QUIET), chunk(300_000, 600_000, LOUD)];
    const b = [chunk(300_000, 600_000, LOUD), chunk(0, 300_000, QUIET)];
    expect(measureWindow(a, T0, T1)).toEqual(measureWindow(b, T0, T1));
  });
});
