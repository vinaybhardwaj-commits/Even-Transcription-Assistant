/**
 * tests/unit/speech-gate.test.ts — the diarization speech gate.
 *
 * The gate exists because pyannote stores room noise as speaker-labelled segments. It must reduce
 * that WITHOUT reproducing the router's expensive lesson: on far-field room audio Silero's "no
 * speech" is a VAD failure far more often than a quiet room (50.4% recall, 5 of 30 windows zero
 * spans on 179-671 s of real speech). So an empty answer must convict nothing.
 *
 * Counts and milliseconds only.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_MIN_SPEECH_MS, SPEECH_GATE_FLAG, SPEECH_GATE_BASIS,
  gateSegments, overlapMs, speechMsIn, speechGateEnabled,
  type SpeechSpan,
} from "@/lib/stt/speech-gate";
import { roomEnergyFloor, globalEnergyFloor, DEFAULT_ROOM_ENERGY_FLOOR } from "@/lib/stt/window-measure";

const seg = (start_ms: number, end_ms: number, speaker_idx = 0) => ({ start_ms, end_ms, speaker_idx });
const spans = (...p: Array<[number, number]>): SpeechSpan[] => p.map(([a, b]) => ({ start_ms: a, end_ms: b }));

describe("overlap arithmetic", () => {
  it("counts only the shared milliseconds, never negative", () => {
    expect(overlapMs(seg(0, 1000), { start_ms: 500, end_ms: 1500 })).toBe(500);
    expect(overlapMs(seg(0, 1000), { start_ms: 2000, end_ms: 3000 })).toBe(0);
    expect(overlapMs(seg(0, 1000), { start_ms: 0, end_ms: 1000 })).toBe(1000);
  });

  it("sums several spans but can never exceed the segment's own duration", () => {
    expect(speechMsIn(seg(0, 5000), spans([0, 1000], [2000, 3000]))).toBe(2000);
    // a pathological span set cannot inflate a segment beyond its length
    expect(speechMsIn(seg(0, 1000), spans([0, 9000], [0, 9000]))).toBe(1000);
  });

  it("handles unsorted spans", () => {
    expect(speechMsIn(seg(0, 5000), spans([4000, 4500], [0, 500]))).toBe(1000);
  });
});

describe("the flag decides, and it is OFF by default", () => {
  it("is off when unset", () => {
    expect(speechGateEnabled({})).toBe(false);
  });
  it("is on only for the agreed truthy values", () => {
    for (const v of ["1", "true", "yes", "on", "ON", " true "]) {
      expect(speechGateEnabled({ [SPEECH_GATE_FLAG]: v })).toBe(true);
    }
  });
  it("throws on a value it does not recognise rather than reading it as off", () => {
    expect(() => speechGateEnabled({ [SPEECH_GATE_FLAG]: "maybe" })).toThrow();
  });
});

describe("IT FLAGS — it never drops", () => {
  it("returns every segment it was given, in order, whatever the verdicts", () => {
    const input = [seg(0, 2000), seg(2000, 4000), seg(4000, 6000)];
    const out = gateSegments(input, { ok: true, spans: spans([0, 1500]) });
    expect(out.segments.length).toBe(3);
    expect(out.segments.map((s) => s.start_ms)).toEqual([0, 2000, 4000]);
    expect(out.summary.total).toBe(3);
  });

  it("keeps a rejected segment's own fields untouched beside the verdict", () => {
    const out = gateSegments([seg(0, 2000, 7)], { ok: true, spans: spans([0, 10]) });
    const s = out.segments[0];
    expect(s.verdict).toBe("non_speech");
    expect({ start_ms: s.start_ms, end_ms: s.end_ms, speaker_idx: s.speaker_idx })
      .toEqual({ start_ms: 0, end_ms: 2000, speaker_idx: 7 });
  });

  it("records how it judged, so a stored row is re-readable later", () => {
    const out = gateSegments([seg(0, 2000)], { ok: true, spans: spans([0, 1500]) });
    expect(out.segments[0].speech_ms).toBe(1500);
    expect(out.segments[0].speech_ratio).toBe(0.75);
    expect(out.segments[0].speech_basis).toBe(SPEECH_GATE_BASIS);
    expect(out.summary.min_speech_ms).toBe(DEFAULT_MIN_SPEECH_MS);
  });
});

describe("the threshold", () => {
  it("keeps a segment at or above the floor and rejects one below it", () => {
    const at = gateSegments([seg(0, 5000)], { ok: true, spans: spans([0, DEFAULT_MIN_SPEECH_MS]) });
    expect(at.segments[0].verdict).toBe("speech");
    const below = gateSegments([seg(0, 5000)], { ok: true, spans: spans([0, DEFAULT_MIN_SPEECH_MS - 1]) });
    expect(below.segments[0].verdict).toBe("non_speech");
  });

  it("is 1000 ms by default — the knee measured against V's ear (83% kept / 70% removed)", () => {
    expect(DEFAULT_MIN_SPEECH_MS).toBe(1000);
  });

  it("can be retuned per call without touching the default", () => {
    const out = gateSegments([seg(0, 5000)], { ok: true, spans: spans([0, 400]) }, { minSpeechMs: 300 });
    expect(out.segments[0].verdict).toBe("speech");
    expect(out.summary.min_speech_ms).toBe(300);
  });

  it("counts a mixed window correctly", () => {
    const out = gateSegments(
      [seg(0, 3000), seg(3000, 6000), seg(6000, 9000)],
      { ok: true, spans: spans([0, 2000], [6000, 6200]) },
    );
    expect(out.summary).toMatchObject({ total: 3, speech: 1, non_speech: 2, unjudged: 0 });
  });
});

describe("AN EMPTY VAD ANSWER CONVICTS NOTHING — the router's lesson, not repeated here", () => {
  it("leaves every segment UNJUDGED when the VAD returned no spans", () => {
    const out = gateSegments([seg(0, 5000), seg(5000, 9000)], { ok: false, reason: "vad_empty_window" });
    expect(out.segments.every((s) => s.verdict === "unjudged")).toBe(true);
    expect(out.segments.every((s) => s.unjudged_reason === "vad_empty_window")).toBe(true);
    expect(out.summary).toMatchObject({ non_speech: 0, unjudged: 2 });
  });

  it("leaves every segment unjudged when the VAD could not be reached", () => {
    const out = gateSegments([seg(0, 5000)], { ok: false, reason: "vad_unavailable" });
    expect(out.segments[0].verdict).toBe("unjudged");
    expect(out.summary.non_speech).toBe(0);
  });

  it("never marks a segment non_speech without positive evidence of silence", () => {
    for (const reason of ["vad_empty_window", "vad_unavailable"] as const) {
      const out = gateSegments([seg(0, 60_000)], { ok: false, reason });
      expect(out.segments[0].speech_ms).toBeNull();
      expect(out.segments[0].verdict).not.toBe("non_speech");
    }
  });
});

// The "OFF means unjudged" block lived here and is GONE with `ungatedSegments`. OFF no longer
// stamps anything — it stores the raw segments, byte for byte — and that is asserted where it can
// actually be observed, on the real call site, in speech-gate-wiring.test.ts.

describe("roomEnergyFloor now uses its room", () => {
  it("falls back to the global floor when no per-room value exists", () => {
    expect(roomEnergyFloor("room_x", {})).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
    expect(roomEnergyFloor("room_x", { ROOM_ENERGY_FLOOR: "0.02" })).toBe(0.02);
  });

  it("USES the per-room value when one exists", () => {
    const env = { ROOM_ENERGY_FLOOR: "0.02", ROOM_ENERGY_FLOORS: '{"room_a":0.05,"room_b":0.001}' };
    expect(roomEnergyFloor("room_a", env)).toBe(0.05);
    expect(roomEnergyFloor("room_b", env)).toBe(0.001);
    // a room with no entry still gets the global one
    expect(roomEnergyFloor("room_c", env)).toBe(0.02);
  });

  it("ignores an unparseable map rather than silencing a room", () => {
    const env = { ROOM_ENERGY_FLOOR: "0.02", ROOM_ENERGY_FLOORS: "{not json" };
    expect(roomEnergyFloor("room_a", env)).toBe(0.02);
  });

  it("ignores an out-of-range or non-numeric per-room entry", () => {
    for (const bad of ["-1", "2", "NaN", '"loud"', "null"]) {
      const env = { ROOM_ENERGY_FLOORS: `{"room_a":${bad}}` };
      expect(roomEnergyFloor("room_a", env)).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
    }
  });

  it("ignores a JSON array or scalar, which is not a map", () => {
    expect(roomEnergyFloor("room_a", { ROOM_ENERGY_FLOORS: "[1,2]" })).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
    expect(roomEnergyFloor("room_a", { ROOM_ENERGY_FLOORS: "4" })).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
  });

  it("returns the global floor when asked about no room at all", () => {
    expect(roomEnergyFloor(null, { ROOM_ENERGY_FLOORS: '{"room_a":0.05}' })).toBe(DEFAULT_ROOM_ENERGY_FLOOR);
    expect(globalEnergyFloor({ ROOM_ENERGY_FLOOR: "0.03" })).toBe(0.03);
  });
});

describe("the VAD client — every failure is fail-safe", () => {
  const audio = new Uint8Array([1, 2, 3]);
  const withFetch = async (impl: typeof fetch, env: Record<string, string | undefined>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const { fetchWindowSpeech } = await import("@/lib/stt/speech-gate");
      return await fetchWindowSpeech(audio, "audio/wav", { env });
    } finally {
      globalThis.fetch = orig;
    }
  };
  const ok = (body: unknown) =>
    (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;

  it("refuses without an endpoint, and never reaches the network", async () => {
    // The refusal must come from the GUARD, not from a thrown URL being swallowed by the catch:
    // those are indistinguishable by return value, so the proof is that fetch was never called.
    let called = 0;
    const counting = (async () => { called += 1; return { ok: true, json: async () => ({ spans: [] }) }; }) as unknown as typeof fetch;
    const r = await withFetch(counting, {});
    expect(r).toEqual({ ok: false, reason: "vad_unavailable" });
    expect(called).toBe(0);
  });

  it("reads spans when the router answers", async () => {
    const r = await withFetch(ok({ spans: [{ start_ms: 0, end_ms: 1500 }] }), { ETA_VAD_URL: "http://x" });
    expect(r).toEqual({ ok: true, spans: [{ start_ms: 0, end_ms: 1500 }] });
  });

  it("treats NO SPANS as vad_empty_window, never as silence", async () => {
    const r = await withFetch(ok({ spans: [] }), { ETA_VAD_URL: "http://x" });
    expect(r).toEqual({ ok: false, reason: "vad_empty_window" });
  });

  it("drops malformed spans rather than trusting them", async () => {
    const r = await withFetch(
      ok({ spans: [{ start_ms: 0, end_ms: 0 }, { start_ms: "a", end_ms: 5 }, { start_ms: 10, end_ms: 20 }] }),
      { ETA_VAD_URL: "http://x" },
    );
    expect(r).toEqual({ ok: true, spans: [{ start_ms: 10, end_ms: 20 }] });
  });

  it("a non-200 or a thrown fetch judges nothing", async () => {
    expect(await withFetch((async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
      { ETA_VAD_URL: "http://x" })).toEqual({ ok: false, reason: "vad_unavailable" });
    expect(await withFetch((async () => { throw new Error("down"); }) as unknown as typeof fetch,
      { ETA_VAD_URL: "http://x" })).toEqual({ ok: false, reason: "vad_unavailable" });
  });
});
