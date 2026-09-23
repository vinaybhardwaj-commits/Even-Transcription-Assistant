/**
 * VAD dead-air trimming: the region map and the time remap.
 *
 * Every expected position below is worked out BY HAND from the region layout, never by calling the
 * function under test. A remap test whose expectation is itself a remap cannot fail.
 */
import { describe, it, expect } from "vitest";
import { buildRegionMap, remapSegments, vadTrimParams, vadTrimEnabled, VAD_TRIM_DEFAULTS, observedQuietSpans } from "@/lib/diarize-vad-trim";
import { DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";

// 16 kHz. Two regions kept from a 60 s clip:
//   region A: original 10.0-14.0 s  (samples 160000-224000) -> trimmed 0.0-4.0 s
//   region B: original 30.0-33.0 s  (samples 480000-528000) -> trimmed 4.0-7.0 s
// The 16 s between them (14-30 s) was dead air and is not in the file.
const SR = 16000;
const TOTAL = 60 * SR;
const TWO = [
  { start_sample: 160000, end_sample: 224000, trim_start_sample: 0 },
  { start_sample: 480000, end_sample: 528000, trim_start_sample: 64000 },
];

describe("buildRegionMap — a map that does not add up is rejected, not repaired", () => {
  it("builds the map in ms, with speech and original seconds", () => {
    const m = buildRegionMap(TWO, SR, TOTAL)!;
    expect(m.regions).toEqual([
      { origStartMs: 10000, origEndMs: 14000, trimStartMs: 0, trimEndMs: 4000 },
      { origStartMs: 30000, origEndMs: 33000, trimStartMs: 4000, trimEndMs: 7000 },
    ]);
    expect(m.speechSeconds).toBe(7);          // 4 s + 3 s: what pyannote.ai bills
    expect(m.originalSeconds).toBe(60);
  });

  it("a trimmed offset that is not the sum of the lengths before it is REJECTED", () => {
    // B claims to start at 4.5 s in the file, but A is 4.0 s long: a 0.5 s gap that the remap would
    // not know about, shifting every one of B's speakers by half a second.
    const gap = [TWO[0]!, { ...TWO[1]!, trim_start_sample: 72000 }];
    expect(buildRegionMap(gap, SR, TOTAL)).toBeNull();
    const overlap = [TWO[0]!, { ...TWO[1]!, trim_start_sample: 56000 }];
    expect(buildRegionMap(overlap, SR, TOTAL)).toBeNull();
  });

  it("unsorted, overlapping, empty, out-of-clip and non-integer regions are rejected", () => {
    expect(buildRegionMap([TWO[1]!, { ...TWO[0]!, trim_start_sample: 48000 }], SR, TOTAL)).toBeNull();    // unsorted
    expect(buildRegionMap([TWO[0]!, { start_sample: 200000, end_sample: 250000, trim_start_sample: 64000 }], SR, TOTAL)).toBeNull(); // overlaps A
    expect(buildRegionMap([{ start_sample: 5, end_sample: 5, trim_start_sample: 0 }], SR, TOTAL)).toBeNull();   // empty
    expect(buildRegionMap([{ start_sample: 0, end_sample: TOTAL + 1, trim_start_sample: 0 }], SR, TOTAL)).toBeNull(); // past the end
    expect(buildRegionMap([{ start_sample: 0.5, end_sample: 100, trim_start_sample: 0 }], SR, TOTAL)).toBeNull();  // non-integer
    expect(buildRegionMap([{ start_sample: -1, end_sample: 100, trim_start_sample: 0 }], SR, TOTAL)).toBeNull();   // negative
    expect(buildRegionMap(["x"], SR, TOTAL)).toBeNull();
  });

  it("a bad sample rate or clip length is rejected", () => {
    expect(buildRegionMap(TWO, 0, TOTAL)).toBeNull();
    expect(buildRegionMap(TWO, 16000.5, TOTAL)).toBeNull();
    expect(buildRegionMap(TWO, SR, 0)).toBeNull();
    expect(buildRegionMap(TWO, "16000x", TOTAL)).toBeNull();
  });
});

describe("remapSegments — trimmed time back onto the original clock", () => {
  const map = buildRegionMap(TWO, SR, TOTAL)!;

  it("a segment inside one region moves by that region's offset", () => {
    // trimmed 1.0-2.5 s is inside A, which starts at original 10.0 s -> 11.0-12.5 s
    expect(remapSegments([{ start_ms: 1000, end_ms: 2500, speaker_idx: 0 }], map))
      .toEqual([{ start_ms: 11000, end_ms: 12500, speaker_idx: 0 }]);
    // trimmed 5.0-6.0 s is inside B (trim 4.0 -> orig 30.0), so 1.0 s in -> 31.0-32.0 s
    expect(remapSegments([{ start_ms: 5000, end_ms: 6000, speaker_idx: 1 }], map))
      .toEqual([{ start_ms: 31000, end_ms: 32000, speaker_idx: 1 }]);
  });

  it("A SEGMENT ACROSS THE JOIN IS SPLIT — never stretched over the dead air that was removed", () => {
    // trimmed 3.0-5.0 s: the last 1 s of A and the first 1 s of B.
    //   A part: trimmed 3.0-4.0 -> original 13.0-14.0
    //   B part: trimmed 4.0-5.0 -> original 30.0-31.0
    // Stretched, it would be 13.0-31.0: a speaker over sixteen seconds pyannote.ai never heard.
    const out = remapSegments([{ start_ms: 3000, end_ms: 5000, speaker_idx: 2 }], map);
    expect(out).toEqual([
      { start_ms: 13000, end_ms: 14000, speaker_idx: 2 },
      { start_ms: 30000, end_ms: 31000, speaker_idx: 2 },
    ]);
    // And nothing covers the removed span.
    for (const s of out) expect(s.start_ms >= 14000 && s.end_ms <= 30000).toBe(false);
  });

  it("the speaker index survives the split on every piece", () => {
    const out = remapSegments([{ start_ms: 3500, end_ms: 4500, speaker_idx: 7 }], map);
    expect(out.map((s) => s.speaker_idx)).toEqual([7, 7]);
  });

  it("a segment past the end of the file is cut there, never extended", () => {
    // trimmed 6.0-9.0 s: B ends at trimmed 7.0 s, so only 6.0-7.0 exists -> original 32.0-33.0
    expect(remapSegments([{ start_ms: 6000, end_ms: 9000, speaker_idx: 0 }], map))
      .toEqual([{ start_ms: 32000, end_ms: 33000, speaker_idx: 0 }]);
    expect(remapSegments([{ start_ms: 8000, end_ms: 9000, speaker_idx: 0 }], map)).toEqual([]);
  });

  it("output is sorted by start, whatever order pyannote.ai answered in", () => {
    const out = remapSegments([
      { start_ms: 5000, end_ms: 6000, speaker_idx: 1 },
      { start_ms: 1000, end_ms: 2000, speaker_idx: 0 },
    ], map);
    expect(out.map((s) => s.start_ms)).toEqual([11000, 31000]);
  });

  it("uses the Mini's own cut points, so there is no drift across many regions", () => {
    // 100 regions of 0.1234 s each (1974.4 samples is not whole, so use 1975) with 1 s gaps.
    // The last region's original start is known exactly; a per-region rounding in the map would
    // accumulate error by the hundredth region.
    const len = 1975, gap = SR;
    const many = Array.from({ length: 100 }, (_, i) => ({
      start_sample: i * (len + gap), end_sample: i * (len + gap) + len, trim_start_sample: i * len,
    }));
    const m = buildRegionMap(many, SR, 100 * (len + gap))!;
    const last = 99;
    // A 1-sample-long probe at the start of the last region, in trimmed time.
    const trimMs = (last * len * 1000) / SR;
    const out = remapSegments([{ start_ms: trimMs, end_ms: trimMs + 50, speaker_idx: 0 }], m);
    const expectedOrigMs = Math.round((last * (len + gap) * 1000) / SR);
    expect(out[0]!.start_ms).toBe(expectedOrigMs);
  });
});

describe("observedQuietSpans — where the level log CONFIRMED quiet (ruling b)", () => {
  // Level buckets are 15 s slots aligned to the epoch; t_ms is the bucket's last sample.
  const b = (slotStartMs: number, peak: number, samples = 3) => ({
    t_ms: slotStartMs + 7_000, peak, avg: null, zero_ratio: null, session_open: true, tape_advancing: true, samples,
  });
  // A window from 100 000 ms to 160 000 ms, i.e. 60 s, starting mid-slot (slots at 90 000, 105 000 …).
  const W = { start_ms: 100_000, end_ms: 160_000 };

  it("a quiet bucket becomes a span, clamped to the window and clip-relative, in 16 kHz samples", () => {
    // Slot 90 000-105 000 overlaps the window as 100 000-105 000 -> clip 0-5 000 ms -> 0-80 000 samples.
    expect(observedQuietSpans([b(90_000, 0)], W)).toEqual([[0, 80000]]);
    // Slot 120 000-135 000 -> clip 20 000-35 000 ms -> 320 000-560 000 samples.
    expect(observedQuietSpans([b(120_000, 0)], W)).toEqual([[320000, 560000]]);
  });

  it("an ACTIVE bucket is never cuttable", () => {
    expect(observedQuietSpans([b(120_000, DEFAULT_ROOM_ENERGY_FLOOR)], W)).toEqual([]);   // at the floor = active
    expect(observedQuietSpans([b(120_000, 0.5)], W)).toEqual([]);
  });

  it("A BUCKET WITH NO READING IS NOT QUIET — absence of evidence is not silence", () => {
    // No bucket at 135 000: that stretch must not appear, even between two quiet ones.
    const spans = observedQuietSpans([b(120_000, 0), b(150_000, 0)], W);
    expect(spans).toEqual([[320000, 560000], [800000, 960000]]);
    // …and a bucket that claims zero samples was not observed at all.
    expect(observedQuietSpans([b(120_000, 0, 0)], W)).toEqual([]);
    expect(observedQuietSpans([], W)).toEqual([]);
  });

  it("adjacent quiet buckets join into one span", () => {
    expect(observedQuietSpans([b(120_000, 0), b(135_000, 0)], W)).toEqual([[320000, 800000]]);
  });

  it("buckets outside the window contribute nothing", () => {
    expect(observedQuietSpans([b(0, 0), b(300_000, 0)], W)).toEqual([]);
  });

  it("the floor is the shared room floor, compared strictly: just under it is quiet", () => {
    expect(observedQuietSpans([b(120_000, DEFAULT_ROOM_ENERGY_FLOOR - 1e-9)], W)).toEqual([[320000, 560000]]);
  });
});

describe("the flag and the parameters", () => {
  it("DIARIZE_VAD_TRIM is off by default and strict", async () => {
    const { FlagValueError } = await import("@/lib/flags");
    expect(vadTrimEnabled({})).toBe(false);
    expect(vadTrimEnabled({ DIARIZE_VAD_TRIM: "1" })).toBe(true);
    expect(() => vadTrimEnabled({ DIARIZE_VAD_TRIM: "maybe" })).toThrow(FlagValueError);
  });

  it("defaults are lab-mover's MEASURED Silero params, with post-processing a no-op", () => {
    // threshold 0.15 / min_silence 1200 / speech_pad 500 / min_speech 250 -> 2.36% cut on the 16
    // normal bake windows. Silero's own default threshold (0.5) would cut far more.
    expect(VAD_TRIM_DEFAULTS).toEqual({
      pad_s: 0, merge_gap_s: 0, min_region_s: 0,
      threshold: 0.15, min_silence_ms: 1200, speech_pad_ms: 500, min_speech_ms: 250,
    });
    expect(vadTrimParams({})).toEqual(VAD_TRIM_DEFAULTS);
  });

  it("env overrides are honoured; blank, nonsense and out-of-range are not", () => {
    const p = vadTrimParams({ DIARIZE_VAD_PAD_S: "0.4", DIARIZE_VAD_THRESHOLD: "0.3", DIARIZE_VAD_MIN_SILENCE_MS: "800" });
    expect(p.pad_s).toBe(0.4);
    expect(p.threshold).toBe(0.3);
    expect(p.min_silence_ms).toBe(800);
    for (const bad of ["", "  ", "abc", "-1", "99999"]) {
      expect(vadTrimParams({ DIARIZE_VAD_MIN_SILENCE_MS: bad }).min_silence_ms, `value ${JSON.stringify(bad)}`).toBe(1200);
    }
  });

  it("the threshold is a probability: 0, 1 and beyond are refused", () => {
    for (const bad of ["0", "1", "1.5", "-0.1", ""]) {
      expect(vadTrimParams({ DIARIZE_VAD_THRESHOLD: bad }).threshold, `value ${JSON.stringify(bad)}`).toBe(0.15);
    }
    expect(vadTrimParams({ DIARIZE_VAD_THRESHOLD: "0.5" }).threshold).toBe(0.5);
  });
});
