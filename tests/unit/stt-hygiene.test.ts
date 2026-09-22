/**
 * STT hygiene (Week A: A-ETA-1 and A-ETA-3).
 *
 *   · every POST to whisper.cpp says max_context=0 — no previous-text conditioning, so one
 *     invented phrase cannot become the prompt for the next;
 *   · the speech gate's Whisper rule drops a segment only when BOTH no_speech_prob >= 0.6 AND
 *     avg_logprob < -1.0, and a segment missing either number is kept;
 *   · a silent clip comes back EMPTY, never as the words Whisper likes to invent on silence;
 *   · a sticky loop is marked by the phrase-loop guard (47a648e) and the distinct lines are not.
 *
 * Fixture text is synthetic — never patient content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { transcribeWithWhisper, EMPTY_TRANSCRIPT } from "@/lib/whisper";
import { runWhisperProbe } from "@/lib/health/whisper-probe";
import {
  dropWhisperNonSpeech,
  whisperSegmentVerdict,
  WHISPER_AVG_LOGPROB_MAX,
  WHISPER_NO_SPEECH_MIN,
  whisperNoSpeechDropEnabled,
} from "@/lib/stt/speech-gate";
import { detectRepeatRuns } from "@/lib/transcript/repeat-runs";

type Row = Record<string, unknown>;

let posted: FormData[] = [];
function mockWhisper(json: Row) {
  posted = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    posted.push(init.body as FormData);
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

beforeEach(() => {
  process.env.WHISPER_BASE_URL = "https://whisper.example";
});
afterEach(() => {
  delete process.env.ETA_WHISPER_NOSPEECH_DROP;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const speech = (start: number, text: string) => ({ start, end: start + 2, text, no_speech_prob: 0.05, avg_logprob: -0.3 });
const invented = (start: number, text: string) => ({ start, end: start + 2, text, no_speech_prob: 0.9, avg_logprob: -1.4 });

describe("A-ETA-1 — max_context=0 on every whisper.cpp POST", () => {
  it("transcribeWithWhisper sends it, beside the pinned decoder", async () => {
    mockWhisper({ text: "hello", segments: [speech(0, "hello")] });
    await transcribeWithWhisper(new Uint8Array([1, 2, 3]));
    expect(posted).toHaveLength(1);
    expect(posted[0]!.get("max_context")).toBe("0");
    expect(posted[0]!.get("temperature")).toBe("0.0");
  });

  it("the health probe sends the same form", async () => {
    mockWhisper({ text: "" });
    await runWhisperProbe({ readFixture: async () => new Uint8Array([1, 2, 3]), fetchImpl: (u, i) => fetch(u, i) });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.get("max_context")).toBe("0");
  });
});

describe("A-ETA-3 — the speech gate's Whisper rule", () => {
  it("uses Whisper's own defaults", () => {
    expect(WHISPER_NO_SPEECH_MIN).toBe(0.6);
    expect(WHISPER_AVG_LOGPROB_MAX).toBe(-1.0);
  });

  it("non_speech only when BOTH numbers say so, at the boundaries", () => {
    expect(whisperSegmentVerdict({ no_speech_prob: 0.6, avg_logprob: -1.01 })).toBe("non_speech");
    expect(whisperSegmentVerdict({ no_speech_prob: 0.59, avg_logprob: -3 })).toBe("speech");   // unsure decoder, real speech
    expect(whisperSegmentVerdict({ no_speech_prob: 0.99, avg_logprob: -1.0 })).toBe("speech"); // quiet but confident
    expect(whisperSegmentVerdict({ no_speech_prob: 0.9 })).toBe("unjudged");
    expect(whisperSegmentVerdict({ avg_logprob: -2 })).toBe("unjudged");
    expect(whisperSegmentVerdict({})).toBe("unjudged");
  });

  it("drops only the invented segment; order kept; missing evidence kept", () => {
    const segs = [
      { no_speech_prob: 0.1, avg_logprob: -0.2, id: "a" },
      { no_speech_prob: 0.8, avg_logprob: -1.5, id: "b" },
      { id: "c" },
    ];
    const { kept, dropped } = dropWhisperNonSpeech(segs);
    expect(dropped).toBe(1);
    expect(kept.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("the client drops it, rebuilds the transcript without it, and counts it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockWhisper({
      // The server's own text still carries the invented line; it must not survive.
      text: "Take one tablet at night. Thank you for watching. Come back in two weeks.",
      segments: [speech(0, "Take one tablet at night."), invented(2, "Thank you for watching."), speech(4, "Come back in two weeks.")],
    });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript).toBe("Take one tablet at night. Come back in two weeks.");
    expect(r.segments.map((s) => s.text)).toEqual(["Take one tablet at night.", "Come back in two weeks."]);
    expect(r.no_speech_dropped).toBe(1);
    expect(r.segments[0]!.avg_logprob).toBe(-0.3);
    expect(log.mock.calls.some((c) => String(c[0]).includes("dropped 1 of 3"))).toBe(true);
    // The log line carries counts and thresholds, never the text it dropped.
    expect(log.mock.calls.some((c) => String(c[0]).includes("Thank you"))).toBe(false);
  });

  it("nothing dropped: the server's own text is used exactly as before", async () => {
    mockWhisper({ text: "Server text, verbatim.", segments: [speech(0, "Server"), speech(2, "text")] });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r.ok && r.transcript).toBe("Server text, verbatim.");
    expect(r.ok && r.no_speech_dropped).toBe(0);
  });
});

describe("ETA_WHISPER_NOSPEECH_DROP — the kill switch (default ON)", () => {
  const mixed = {
    text: "Take one tablet at night. Thank you for watching. Come back in two weeks.",
    segments: [speech(0, "Take one tablet at night."), invented(2, "Thank you for watching."), speech(4, "Come back in two weeks.")],
  };

  it("parses: unset, blank and truthy are ON; falsy words are OFF; an unknown value stays ON and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(whisperNoSpeechDropEnabled({})).toBe(true);
    expect(whisperNoSpeechDropEnabled({ ETA_WHISPER_NOSPEECH_DROP: "  " })).toBe(true);
    for (const on of ["1", "true", "ON", " yes "]) expect(whisperNoSpeechDropEnabled({ ETA_WHISPER_NOSPEECH_DROP: on })).toBe(true);
    for (const off of ["off", "OFF", "0", "false", "no"]) expect(whisperNoSpeechDropEnabled({ ETA_WHISPER_NOSPEECH_DROP: off })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(whisperNoSpeechDropEnabled({ ETA_WHISPER_NOSPEECH_DROP: "ofF-typo" })).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).not.toContain("ofF-typo"); // the value itself is never echoed
  });

  it("ON (unset): the invented segment is dropped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockWhisper(mixed);
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r.ok && r.transcript).toBe("Take one tablet at night. Come back in two weeks.");
    expect(r.ok && r.no_speech_dropped).toBe(1);
  });

  it("off: the behaviour before the gate — every segment, the server's own text, nothing logged", async () => {
    process.env.ETA_WHISPER_NOSPEECH_DROP = "off";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mockWhisper(mixed);
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.transcript).toBe(mixed.text);
    expect(r.segments).toHaveLength(3);
    expect(r.no_speech_dropped).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  it("off: a silent clip's invented words come back as they did before", async () => {
    process.env.ETA_WHISPER_NOSPEECH_DROP = "off";
    mockWhisper({ text: "Thank you.", segments: [invented(0, "Thank you.")] });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r.ok && r.transcript).toBe("Thank you.");
  });
});

describe("a silent clip returns empty", () => {
  it("every segment invented → EMPTY_TRANSCRIPT, not the invented words", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockWhisper({ text: "Thank you. Thank you.", segments: [invented(0, "Thank you."), invented(2, "Thank you.")] });
    const r = await transcribeWithWhisper(new Uint8Array([1]));
    expect(r).toMatchObject({ ok: false, error: EMPTY_TRANSCRIPT });
    expect(posted).toHaveLength(1); // empty is an answer, not a retryable failure
  });

  it("server returns no text and no segments → EMPTY_TRANSCRIPT", async () => {
    mockWhisper({ text: "", segments: [] });
    expect(await transcribeWithWhisper(new Uint8Array([1]))).toMatchObject({ ok: false, error: EMPTY_TRANSCRIPT });
  });
});

describe("a sticky loop is marked by the phrase-loop guard (47a648e); distinct lines are not", () => {
  const turns = [
    "Any pain in the chest?",
    "Only when I climb stairs.",
    "Thank you.", "Thank you.", "Thank you.", "Thank you.", "Thank you.", "Thank you.",
    "Take the tablet after food.",
    "Thank you.",
    "Yes, yes, yes.", "Yes, yes, yes.", "Yes, yes, yes.",
  ].map((text, i) => ({ source_ref: `t${i}`, text }));

  it("flags the loop and nothing else", () => {
    const res = detectRepeatRuns(turns);
    const flagged = res.filter((r) => r.in_run).map((r) => r.source_ref);
    expect(flagged).toEqual(["t2", "t3", "t4", "t5", "t6", "t7"]);
    expect(res[2]!.run_length).toBe(6);
  });

  it("cleaning by the guard's marks (keep rank 1 of a run) keeps every distinct line", () => {
    const res = detectRepeatRuns(turns);
    const cleaned = turns.filter((_, i) => !res[i]!.in_run || res[i]!.run_rank === 1).map((t) => t.text);
    expect(cleaned).toEqual([
      "Any pain in the chest?",
      "Only when I climb stairs.",
      "Thank you.",
      "Take the tablet after food.",
      "Thank you.",                                    // a later, separate "Thank you." is a distinct line
      "Yes, yes, yes.", "Yes, yes, yes.", "Yes, yes, yes.", // a 3x repeat is ordinary speech: untouched
    ]);
  });
});
