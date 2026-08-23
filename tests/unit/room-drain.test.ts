/**
 * K4b Part C — the pure half of the room STT drain: the report-only vocabulary (C8), the
 * language-probe slice (C3) and the Sarvam locale map.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The source with every comment removed.
 *
 * These assertions are about what the drain DOES, and a prose promise that it does not diarize
 * is not the same evidence as the absence of a diarization call. Reading the raw file makes the
 * header's own "No diarization (K5 owns it)" fail the test that checks for diarization, which is
 * the opposite of useful.
 */
const codeOf = (f: string): string =>
  readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
import {
  describeWindowActivity,
  probeSlice,
  sarvamLanguageCode,
  bucketFor,
  PROBE_SECONDS,
  DRAIN_MAX_ATTEMPTS,
} from "@/lib/stt/room-drain";

const FIFTEEN = 15 * 60_000;
const piece = (idx: number, duration_s: number) => ({
  chunk: { idx, source: "primary" as const, r2_key: `k${idx}`, content_type: "audio/webm", started_at: "2026-08-22T16:00:00Z", ended_at: "2026-08-22T16:05:00Z", upload_state: "verified" },
  offset_in_chunk_s: 0,
  duration_s,
  chunk_bounds: { started_at: "2026-08-22T16:00:00Z", ended_at: "2026-08-22T16:05:00Z" },
});

describe("C8 — silence is REPORTED, never inferred", () => {
  it("zero segments is silence", () => {
    expect(describeWindowActivity(0, FIFTEEN, [])).toBe("silent");
  });

  it("1..3 segments on a window of ten minutes or more is thin", () => {
    expect(describeWindowActivity(1, FIFTEEN, ["a"])).toBe("thin");
    expect(describeWindowActivity(3, 10 * 60_000, ["a", "b", "c"])).toBe("thin");
  });

  it("the same 1..3 segments on a SHORT window is not thin — the rule names ten minutes", () => {
    expect(describeWindowActivity(2, 5 * 60_000, ["a", "b"])).toBe("speech");
  });

  it("four segments is not thin", () => {
    expect(describeWindowActivity(4, FIFTEEN, ["a", "b", "c", "d"])).toBe("speech");
  });

  it("repeated identical text is a loop, whatever the count", () => {
    expect(describeWindowActivity(6, FIFTEEN, Array(6).fill("thank you."))).toBe("loop");
    expect(describeWindowActivity(6, FIFTEEN, Array(6).fill("  thank you.  "))).toBe("loop");
  });

  it("a loop beats thin, because a repeated phrase is the more specific fault", () => {
    expect(describeWindowActivity(2, FIFTEEN, ["hmm", "hmm"])).toBe("loop");
  });

  it("one segment is not a loop — a single phrase repeats nothing", () => {
    expect(describeWindowActivity(1, FIFTEEN, ["hello"])).toBe("thin");
  });

  it("the vocabulary is CLOSED — no branch invents a fifth verdict", () => {
    const verdicts = new Set([
      describeWindowActivity(0, FIFTEEN, []),
      describeWindowActivity(1, FIFTEEN, ["a"]),
      describeWindowActivity(9, FIFTEEN, Array(9).fill("x")),
      describeWindowActivity(9, FIFTEEN, ["a", "b", "c", "d", "e", "f", "g", "h", "i"]),
    ]);
    expect([...verdicts].sort()).toEqual(["loop", "silent", "speech", "thin"]);
  });

  it("no VAD, no threshold, no second stack — the CODE names none of them", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    expect(src).not.toMatch(/\bvad\b/i);
    expect(src).not.toMatch(/no_speech_prob\s*[<>]/);
    expect(src).not.toMatch(/silence_threshold|min_confidence/i);
  });
});

describe("C3 — the probe slice", () => {
  it("takes the first 30 seconds from a single long piece", () => {
    const s = probeSlice([piece(0, 300)], PROBE_SECONDS);
    expect(s.pieces).toHaveLength(1);
    expect(s.seconds).toBe(30);
    expect(s.pieces[0]!.duration_s).toBe(30);
  });

  it("spans pieces when the first is shorter than the probe", () => {
    const s = probeSlice([piece(0, 12), piece(1, 300)], PROBE_SECONDS);
    expect(s.pieces).toHaveLength(2);
    expect(s.seconds).toBe(30);
    expect(s.pieces[1]!.duration_s).toBe(18);
  });

  it("a window shorter than the probe yields what exists and SAYS so", () => {
    const s = probeSlice([piece(0, 7)], PROBE_SECONDS);
    expect(s.seconds).toBe(7);
    expect(s.pieces).toHaveLength(1);
  });

  it("never reaches for a piece it does not need", () => {
    const s = probeSlice([piece(0, 300), piece(1, 300), piece(2, 300)], PROBE_SECONDS);
    expect(s.pieces).toHaveLength(1);
  });

  it("no covering pieces is not a crash", () => {
    expect(probeSlice([], PROBE_SECONDS)).toEqual({ pieces: [], seconds: 0 });
  });
});

describe("C3 — Whisper's language becomes Sarvam's", () => {
  it("maps the codes Whisper actually returns", () => {
    expect(sarvamLanguageCode("en")).toBe("en-IN");
    expect(sarvamLanguageCode("hi")).toBe("hi-IN");
    expect(sarvamLanguageCode("kn")).toBe("kn-IN");
    expect(sarvamLanguageCode("ta")).toBe("ta-IN");
  });

  it("an English variant is still English", () => {
    expect(sarvamLanguageCode("en-US")).toBe("en-IN");
    expect(sarvamLanguageCode("eng")).toBe("en-IN");
  });

  it("UNKNOWN means do not force — never a plausible guess", () => {
    for (const v of [null, undefined, "", "auto", "und", "unknown", "zz", "xhosa"]) {
      expect(sarvamLanguageCode(v)).toBeNull();
    }
  });

  it("the bucket follows the same English rule the rest of the app uses", () => {
    expect(bucketFor("en")).toBe("english");
    expect(bucketFor("en-IN")).toBe("english");
    expect(bucketFor("hi")).toBe("indic");
    expect(bucketFor(null)).toBe("indic");
  });
});

describe("C7 — three attempts, then park", () => {
  it("the ceiling is three", () => {
    expect(DRAIN_MAX_ATTEMPTS).toBe(3);
  });

  it("the failure path parks the window and stops re-queueing", () => {
    const src = codeOf("lib/stt/room-drain.ts");
    expect(src).toContain("attempts + 1 >= ${DRAIN_MAX_ATTEMPTS} THEN 'failed'");
    expect(src).toContain("state = 'failed'");
    // and the queue runner refuses to pick up an exhausted job at all
    expect(src).toContain("j.attempts < ${DRAIN_MAX_ATTEMPTS}");
  });
});

describe("the DO NOTs, held by the source itself", () => {
  const src = codeOf("lib/stt/room-drain.ts");

  it("does not diarize — K5 owns that", () => {
    expect(src).not.toMatch(/with_diarization|withDiarization|num_speakers|numSpeakers|diariz/i);
  });

  it("generates no note", () => {
    expect(src).not.toContain("generateNote");
  });

  it("calls ONE routed engine, never a fan-out", () => {
    expect(src).not.toContain("runFanoutForEncounter");
    expect(src).not.toContain("enqueueFanout");
    expect(src.match(/adapter\.transcribe\(/g) ?? []).toHaveLength(1);
  });

  it("never types an engine name into a payload or a run", () => {
    expect(src).not.toMatch(/engine:\s*"/);
    expect(src).toContain("adapter.key");
  });

  it("resolves the ROOM stage, never 'live'", () => {
    expect(src).toContain('DRAIN_STAGE = "room"');
    expect(src).not.toMatch(/resolveRouting\(\s*"live"/);
  });

  it("bounds the session from chunks — session.ended_at is never read", () => {
    expect(src).not.toContain("ended_at FROM bench_session");
    expect(src).not.toMatch(/session\.ended_at/);
  });
});
