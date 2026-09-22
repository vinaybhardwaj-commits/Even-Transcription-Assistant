/**
 * E-2 — the speech gate (lib/encounter-clock/gate.ts).
 *
 * The rule these tests exist to protect: MISSING EVIDENCE IS UNJUDGED, NEVER SILENCE. No level
 * samples is not a quiet room; no transcript is not an empty one. Only evidence says non_speech, and
 * only both halves together say speech. The boundaries of every provisional threshold are pinned so
 * a `>=` quietly becoming `>` fails here.
 */
import { describe, it, expect } from "vitest";
import {
  gateProbe, energyHalf, transcriptHalf, uniqueCharsPerSecond, normaliseLine, covers, splitWindowText,
  UNIQUE_CHARS_PER_SECOND_MIN, ENERGY_ACTIVE_MIN, DEAD_MIC_ZERO_RATIO, DEAD_MIC_DBFS, GATE_VERSION,
  type EnergyEvidence, type TranscriptEvidence,
} from "@/lib/encounter-clock/gate";
import { DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";
import type { BenchLevelSample } from "@/lib/bench-levels";

const T0 = 1_790_000_000_000, T1 = T0 + 180_000;
const lvl = (avg: number | null, zero: number | null = 0): BenchLevelSample =>
  ({ t_ms: T0, peak: 0.5, avg, zero_ratio: zero, session_open: true, tape_advancing: true, samples: 1 });
const frames = (vals: number[]): EnergyEvidence => ({ kind: "frames", frame_rms: vals });
const ACTIVE: EnergyEvidence = frames(Array(100).fill(0.05));
const QUIET: EnergyEvidence = frames(Array(100).fill(0.001));
const DEAD: EnergyEvidence = frames(Array(100).fill(0.00001));                      // -100 dBFS
const covered = (spans: TranscriptEvidence["spans"]): TranscriptEvidence => ({ coverage: [{ start_ms: T0 - 60_000, end_ms: T1 + 60_000 }], spans });
// 180 s probe x 0.15 = 27 unique chars is the pass line
const TEXT = covered([{ start_ms: T0, end_ms: T1, text: "the patient reports chest pain since monday" }]);   // 43 chars
const NO_TEXT = covered([]);

describe("E-2 gateProbe — the truth table", () => {
  const g = (energy: EnergyEvidence | null, transcript: TranscriptEvidence | null) => gateProbe({ start_ms: T0, end_ms: T1, energy, transcript });
  it("dead mic -> unjudged: the mic heard nothing, so it says nothing about the room", () => {
    expect(g(DEAD, TEXT)).toMatchObject({ verdict: "unjudged", reason: "dead_mic" });
    expect(g(DEAD, NO_TEXT)).toMatchObject({ verdict: "unjudged", reason: "dead_mic" });
  });
  it("no energy evidence -> unjudged, whatever the transcript says", () => {
    expect(g(null, TEXT)).toMatchObject({ verdict: "unjudged", reason: "no_energy_evidence" });
    expect(g(null, NO_TEXT)).toMatchObject({ verdict: "unjudged", reason: "no_energy_evidence" });
  });
  it("quiet room -> non_speech; text on quiet audio is the hallucination signature, still non_speech", () => {
    expect(g(QUIET, NO_TEXT)).toMatchObject({ verdict: "non_speech", reason: "quiet_room" });
    expect(g(QUIET, null)).toMatchObject({ verdict: "non_speech", reason: "quiet_room" });
    expect(g(QUIET, TEXT)).toMatchObject({ verdict: "non_speech", reason: "text_on_quiet_audio" });
  });
  it("active room with no transcript -> unjudged: energy alone is not speech", () => {
    expect(g(ACTIVE, null)).toMatchObject({ verdict: "unjudged", reason: "no_transcript_evidence" });
  });
  it("active room + text -> speech; active room + no text -> non_speech", () => {
    expect(g(ACTIVE, TEXT)).toMatchObject({ verdict: "speech", reason: "speech", version: GATE_VERSION });
    expect(g(ACTIVE, NO_TEXT)).toMatchObject({ verdict: "non_speech", reason: "no_text" });
  });
});

describe("E-2 — missing evidence is unjudged, never silence", () => {
  it("empty level and frame evidence is missing, not quiet", () => {
    expect(energyHalf(null).state).toBe("missing");
    expect(energyHalf({ kind: "frames", frame_rms: [] }).state).toBe("missing");
    expect(energyHalf({ kind: "levels", samples: [] }).state).toBe("missing");
    expect(energyHalf({ kind: "levels", samples: [lvl(null, null), lvl(null, null)] }).state).toBe("missing");
  });
  it("a transcript that does not cover the whole probe is missing, not empty", () => {
    const partial: TranscriptEvidence = { coverage: [{ start_ms: T0, end_ms: T0 + 90_000 }], spans: [] };
    expect(transcriptHalf(partial, T0, T1).state).toBe("missing");
    expect(transcriptHalf(null, T0, T1).state).toBe("missing");
    expect(gateProbe({ start_ms: T0, end_ms: T1, energy: ACTIVE, transcript: partial }).verdict).toBe("unjudged");
  });
  it("covers merges adjacent ranges and refuses a gap", () => {
    expect(covers([{ start_ms: T0, end_ms: T0 + 90_000 }, { start_ms: T0 + 90_000, end_ms: T1 }], T0, T1)).toBe(true);
    expect(covers([{ start_ms: T0, end_ms: T0 + 89_000 }, { start_ms: T0 + 90_000, end_ms: T1 }], T0, T1)).toBe(false);
  });
});

describe("E-2 energy half — dead mic and the active boundary", () => {
  it(`dead mic at zero_ratio >= ${DEAD_MIC_ZERO_RATIO}, and not below it`, () => {
    expect(energyHalf({ kind: "levels", samples: [lvl(0.05, 0.98), lvl(0.05, 0.98)] }).state).toBe("dead_mic");
    expect(energyHalf({ kind: "levels", samples: [lvl(0.05, 0.97), lvl(0.05, 0.97)] }).state).toBe("active");
  });
  it(`dead mic at a median level <= ${DEAD_MIC_DBFS} dBFS, and not above it`, () => {
    const at = 10 ** (DEAD_MIC_DBFS / 20);
    expect(energyHalf(frames([at, at, at])).state).toBe("dead_mic");
    expect(energyHalf(frames([at * 1.2, at * 1.2, at * 1.2])).state).toBe("quiet");
  });
  it(`active at exactly ${ENERGY_ACTIVE_MIN} of frames at or above the floor; quiet just below`, () => {
    const n = 100, k = Math.round(ENERGY_ACTIVE_MIN * n);
    const mk = (hot: number) => frames([...Array(hot).fill(DEFAULT_ROOM_ENERGY_FLOOR), ...Array(n - hot).fill(0.0005)]);
    expect(energyHalf(mk(k)).state).toBe("active");
    expect(energyHalf(mk(k - 1)).state).toBe("quiet");
  });
  it("uses the production floor by default and a room's own floor when given", () => {
    const e = frames(Array(100).fill(0.005));
    expect(energyHalf(e).state).toBe("active");                   // 0.005 >= 0.00398
    expect(energyHalf(e, 0.01).state).toBe("quiet");              // a louder room's floor
  });
  it("a level sample with no avg is absent, not zero", () => {
    const r = energyHalf({ kind: "levels", samples: [lvl(null), lvl(0.02), lvl(0.02)] });
    expect(r.n).toBe(2);
    expect(r.state).toBe("active");
  });
});

describe("E-2 transcript half — unique chars/s", () => {
  it("a line repeated by the recogniser counts once", () => {
    const loop = Array(50).fill("thank you for watching").join("\n");
    const u = uniqueCharsPerSecond([{ start_ms: T0, end_ms: T1, text: loop }], T0, T1);
    expect(u).toBeCloseTo("thank you for watching".length / 180, 9);
  });
  it("case, punctuation and spacing do not make a line new", () => {
    expect(normaliseLine("  Thank you,  FOR watching!! ")).toBe("thank you for watching");
    const u = uniqueCharsPerSecond([{ start_ms: T0, end_ms: T1, text: "Thank you!\nthank  you\nTHANK YOU." }], T0, T1);
    expect(u).toBeCloseTo("thank you".length / 180, 9);
  });
  it("a span half inside the probe contributes half its characters", () => {
    const u = uniqueCharsPerSecond([{ start_ms: T1 - 10_000, end_ms: T1 + 10_000, text: "abcdefghij" }], T0, T1);
    expect(u).toBeCloseTo(5 / 180, 9);
  });
  it(`passes at exactly ${UNIQUE_CHARS_PER_SECOND_MIN} unique chars/s and fails just below`, () => {
    const exact = "x".repeat(Math.round(UNIQUE_CHARS_PER_SECOND_MIN * 180));        // 27 chars over 180 s
    expect(transcriptHalf(covered([{ start_ms: T0, end_ms: T1, text: exact }]), T0, T1).state).toBe("text");
    expect(transcriptHalf(covered([{ start_ms: T0, end_ms: T1, text: exact.slice(1) }]), T0, T1).state).toBe("no_text");
  });
  it("the threshold is exported, provisional, and 0.15", () => {
    expect(UNIQUE_CHARS_PER_SECOND_MIN).toBe(0.15);
  });
});

describe("E-2 splitWindowText — placing a window's text back on the clock", () => {
  const spans = [{ start_s: 0, end_s: 10, chars: 5 }, { start_s: 20, end_s: 30, chars: 3 }];
  it("slices the router's newline-joined text by each span's chars", () => {
    expect(splitWindowText("hello\nabc", spans, T0)).toEqual([
      { start_ms: T0, end_ms: T0 + 10_000, text: "hello" },
      { start_ms: T0 + 20_000, end_ms: T0 + 30_000, text: "abc" },
    ]);
  });
  it("tolerates a few characters of drift and refuses more — unplaceable text is missing, not guessed", () => {
    expect(splitWindowText("hello\nabc  ", spans, T0)).not.toBeNull();
    expect(splitWindowText("hello\nabc and a great deal more", spans, T0)).toBeNull();
  });
  it("text with no spans to place it on is unplaceable; no text and no spans is simply empty", () => {
    expect(splitWindowText("something", [], T0)).toBeNull();
    expect(splitWindowText("", [], T0)).toEqual([]);
  });
});
