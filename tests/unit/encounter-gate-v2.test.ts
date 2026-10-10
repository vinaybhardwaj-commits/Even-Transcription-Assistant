/** gate v2 (epic #23 d): every truth-table row, the v1 default untouched, and the flags. */
import { describe, it, expect } from "vitest";
import {
  gateProbeV2, diarizedSpeechMs, GATE_V2_VERSION, type DiarEvidence,
} from "@/lib/encounter-clock/gate-v2";
import { gateProbe, GATE_VERSION } from "@/lib/encounter-clock/gate";
import { encounterGateDiarEnabled, encounterTimelineShadowEnabled } from "@/lib/encounter-clock/flag";
import type { BenchLevelSample } from "@/lib/bench-levels";

const T0 = 1_790_000_000_000, T1 = T0 + 180_000;
const lv = (avg: number, zero = 0): BenchLevelSample[] =>
  Array.from({ length: 19 }, (_, i) => ({ t_ms: T0 + i * 10_000, avg, peak: avg, zero_ratio: zero }) as BenchLevelSample);
const active = { kind: "levels" as const, samples: lv(0.2) };
const quiet = { kind: "levels" as const, samples: lv(0.0001) };
const dead = { kind: "levels" as const, samples: lv(0, 1) };
const covered = (turns: Array<[number, number]>): DiarEvidence => ({
  coverage: [{ start_ms: T0 - 1000, end_ms: T1 + 1000 }],
  turns: turns.map(([a, b]) => ({ start_ms: T0 + a, end_ms: T0 + b })),
});
const text = { coverage: [{ start_ms: T0, end_ms: T1 }], spans: [{ start_ms: T0, end_ms: T1, text: "x".repeat(200), chars: 200 } as never] };
const g = (energy: never, diar: DiarEvidence | null, transcript: never = null as never) =>
  gateProbeV2({ start_ms: T0, end_ms: T1, energy, diar, transcript });

describe("gate v2 truth table", () => {
  it("dead mic → unjudged dead_mic", () => expect(g(dead as never, covered([[0, 60_000]]))).toMatchObject({ verdict: "unjudged", reason: "dead_mic" }));
  it("no energy and no coverage → unjudged no_energy_evidence", () =>
    expect(g(null as never, null)).toMatchObject({ verdict: "unjudged", reason: "no_energy_evidence", diar_coverage: false, diarized_speech_ms: null }));
  it("energy active + diarized speech at the minimum → speech", () =>
    expect(g(active as never, covered([[0, 8_000]]))).toMatchObject({ verdict: "speech", reason: "diarized_speech", diarized_speech_ms: 8_000 }));
  it("one ms under the minimum is not speech", () =>
    expect(g(active as never, covered([[0, 7_999]]))).toMatchObject({ verdict: "unjudged", reason: "diar_speech_short" }));
  it("energy active + covered + under 2 s → non_speech no_diarized_speech", () => {
    expect(g(active as never, covered([[0, 1_999]]))).toMatchObject({ verdict: "non_speech", reason: "no_diarized_speech" });
    expect(g(active as never, covered([]))).toMatchObject({ verdict: "non_speech", reason: "no_diarized_speech", diarized_speech_ms: 0 });
  });
  it("exactly 2 s is in the short band, not non_speech", () =>
    expect(g(active as never, covered([[0, 2_000]]))).toMatchObject({ verdict: "unjudged", reason: "diar_speech_short" }));
  it("energy quiet + diarized speech → unjudged halves_disagree", () =>
    expect(g(quiet as never, covered([[0, 30_000]]))).toMatchObject({ verdict: "unjudged", reason: "halves_disagree" }));
  it("energy quiet + none → non_speech quiet_room", () =>
    expect(g(quiet as never, covered([]))).toMatchObject({ verdict: "non_speech", reason: "quiet_room" }));
  it("text still promotes to speech when energy is active", () =>
    expect(g(active as never, covered([[0, 100]]), text as never)).toMatchObject({ verdict: "speech", reason: "speech" }));
  it("no diar coverage falls back to the v1 transcript rule", () => {
    expect(g(active as never, null)).toMatchObject({ verdict: "unjudged", reason: "no_transcript_evidence" });
    expect(g(active as never, null, text as never)).toMatchObject({ verdict: "speech" });
  });
  it("energy missing but covered: diarized speech decides, silence stays unjudged", () => {
    expect(g(null as never, covered([[0, 20_000]]))).toMatchObject({ verdict: "speech", reason: "diarized_speech" });
    expect(g(null as never, covered([]))).toMatchObject({ verdict: "unjudged", reason: "no_energy_evidence" });
  });
  it("a partly covered probe has no diar coverage", () => {
    const part: DiarEvidence = { coverage: [{ start_ms: T0, end_ms: T0 + 90_000 }], turns: [{ start_ms: T0, end_ms: T0 + 80_000 }] };
    expect(g(active as never, part)).toMatchObject({ diar_coverage: false, diarized_speech_ms: null });
  });
  it("stamps its own version and never claims v1's", () => {
    const r = g(active as never, covered([]));
    expect(r.version).toBe(GATE_V2_VERSION);
    expect(r.version).not.toBe(GATE_VERSION);
  });
  it("v1 is unchanged: active energy with no transcript is still unjudged", () =>
    expect(gateProbe({ start_ms: T0, end_ms: T1, energy: active as never, transcript: null })).toMatchObject({ verdict: "unjudged", reason: "no_transcript_evidence", version: GATE_VERSION }));
});

describe("diarizedSpeechMs", () => {
  it("counts overlapping speakers once and clips to the probe", () => {
    expect(diarizedSpeechMs([{ start_ms: 0, end_ms: 10 }, { start_ms: 5, end_ms: 20 }], 0, 100)).toBe(20);
    expect(diarizedSpeechMs([{ start_ms: -50, end_ms: 10 }, { start_ms: 90, end_ms: 500 }], 0, 100)).toBe(20);
    expect(diarizedSpeechMs([], 0, 100)).toBe(0);
  });
});

describe("flags", () => {
  it("default off; a typo throws instead of defaulting", () => {
    expect(encounterGateDiarEnabled({})).toBe(false);
    expect(encounterTimelineShadowEnabled({})).toBe(false);
    expect(encounterGateDiarEnabled({ ENCOUNTER_GATE_DIAR: "1" })).toBe(true);
    expect(encounterTimelineShadowEnabled({ ENCOUNTER_TIMELINE_SHADOW: "1" })).toBe(true);
    expect(() => encounterGateDiarEnabled({ ENCOUNTER_GATE_DIAR: "yes please" })).toThrow();
    expect(() => encounterTimelineShadowEnabled({ ENCOUNTER_TIMELINE_SHADOW: "tru" })).toThrow();
  });
});
