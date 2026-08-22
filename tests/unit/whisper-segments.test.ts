/**
 * The Whisper client keeps its segments (speech turns, slice A).
 *
 * The client used to ask for `json` and read only `text`. Timings the model had already
 * computed were dropped at the wire, and a transcript with no timings can never become a turn.
 * It now asks for `verbose_json`, and these are the two things that must hold:
 *
 *   · the REQUEST says verbose_json, and
 *   · the segments survive the parse — including from a server that spells its bounds
 *     differently, and including a server that sends none at all.
 *
 * Nothing here is converted to wall clock: segment seconds are relative to the clip, and only
 * the caller knows when the clip began.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseSegmentSeconds, parseWhisperSegments, transcribeWithWhisper } from "@/lib/whisper";

type Row = Record<string, unknown>;

let posted: Array<{ url: string; form: FormData }> = [];
function mockWhisper(json: Row, status = 200) {
  posted = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    posted.push({ url: String(url), form: init.body as FormData });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }));
}

beforeEach(() => {
  process.env.WHISPER_BASE_URL = "https://whisper.example";
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSegmentSeconds — tolerant on the wire", () => {
  it("reads numbers, numeric strings and HH:MM:SS[.,]mmm", () => {
    expect(parseSegmentSeconds(4.32)).toBe(4.32);
    expect(parseSegmentSeconds("4.32")).toBe(4.32);
    expect(parseSegmentSeconds("00:00:04.320")).toBeCloseTo(4.32, 6);
    expect(parseSegmentSeconds("00:00:04,320")).toBeCloseTo(4.32, 6);
    expect(parseSegmentSeconds("01:02:03")).toBe(3723);
    expect(parseSegmentSeconds(0)).toBe(0);
  });
  it("refuses what it cannot read rather than guessing", () => {
    expect(parseSegmentSeconds("nope")).toBeNull();
    expect(parseSegmentSeconds("")).toBeNull();
    expect(parseSegmentSeconds(null)).toBeNull();
    expect(parseSegmentSeconds(undefined)).toBeNull();
    expect(parseSegmentSeconds(Number.NaN)).toBeNull();
    expect(parseSegmentSeconds({})).toBeNull();
  });
});

describe("parseWhisperSegments — a bad segment is dropped alone", () => {
  it("keeps the readable ones, in order, with text trimmed", () => {
    const out = parseWhisperSegments([
      { start: 0, end: 1.5, text: "  hello  " },
      { start: "00:00:01,500", end: "00:00:04,320", text: "there", no_speech_prob: 0.02 },
      { start: 9, end: 4, text: "backwards — dropped" },
      { start: "x", end: 5, text: "unreadable — dropped" },
      "not an object",
      null,
    ]);
    expect(out).toEqual([
      { start_s: 0, end_s: 1.5, text: "hello" },
      { start_s: 1.5, end_s: 4.32, text: "there", no_speech_prob: 0.02 },
    ]);
  });
  it("a blank segment is KEPT here — 'is this blank' is the caller's window rule", () => {
    expect(parseWhisperSegments([{ start: 0, end: 1, text: "   " }])).toEqual([{ start_s: 0, end_s: 1, text: "" }]);
  });
  it("no segments field, or a non-array, is empty and not an error", () => {
    expect(parseWhisperSegments(undefined)).toEqual([]);
    expect(parseWhisperSegments({ nope: true })).toEqual([]);
    expect(parseWhisperSegments([])).toEqual([]);
  });
});

describe("transcribeWithWhisper — the request and what survives it", () => {
  it("asks for verbose_json and returns the segments alongside the text", async () => {
    mockWhisper({
      text: "hello there",
      language: "en",
      duration: 4.32,
      segments: [
        { id: 0, start: 0, end: 1.5, text: "hello" },
        { id: 1, start: 1.5, end: 4.32, text: " there" },
      ],
    });
    const out = await transcribeWithWhisper(new Uint8Array([1, 2, 3]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(posted[0]!.form.get("response_format")).toBe("verbose_json");
    expect(out.transcript).toBe("hello there");
    expect(out.segments).toEqual([
      { start_s: 0, end_s: 1.5, text: "hello" },
      { start_s: 1.5, end_s: 4.32, text: "there" },
    ]);
  });

  it("an older server that answers plain json still works — no segments, same transcript", async () => {
    mockWhisper({ text: "hello there", language: "en", duration: 4.32 });
    const out = await transcribeWithWhisper(new Uint8Array([1]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.transcript).toBe("hello there");
    expect(out.segments).toEqual([]);
  });

  it("segments but no top-level text → the transcript is rebuilt, never lost", async () => {
    mockWhisper({ language: "en", segments: [{ start: 0, end: 1, text: "hello" }, { start: 1, end: 2, text: "there" }] });
    const out = await transcribeWithWhisper(new Uint8Array([1]));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.transcript).toBe("hello there");
    expect(out.segments).toHaveLength(2);
  });

  it("nothing at all is still empty_transcript", async () => {
    mockWhisper({ text: "   ", segments: [] });
    const out = await transcribeWithWhisper(new Uint8Array([1]));
    expect(out).toMatchObject({ ok: false, error: "empty_transcript" });
  });
});
