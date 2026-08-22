/**
 * Speech turns, slice A — the tape becomes evidence.
 *
 * Four things are proved here, and they are the four the slice is:
 *
 *   1. THE LIVE-WRITE HAZARD IS CLOSED. scribe_post_cue refuses the seven machine cue types by
 *      name. They key on source_ref and live in the scratch graph; that tool can only reach a
 *      LIVE day, and a hand-stamped one would carry no key and duplicate on every re-run.
 *   2. WHISPER KEEPS ITS SEGMENTS. The client asks for verbose_json and the segments survive
 *      the parse — a transcript with no timings cannot become a turn.
 *   3. THE TIME MAPPING. Segment seconds are offset onto the clip's TRUE start with Math.floor,
 *      filtered to the window asked for, blank text dropped, and a window that survives nothing
 *      writes one stt_silence rather than nothing at all.
 *   4. THE KEY. source_ref is exactly "{session_id}|{start_ms}|{end_ms}|{speaker}", four fields,
 *      pipe separated, integer epoch ms, and `-` in the speaker slot for every slice A turn and
 *      every silence.
 *
 * Mocked `sql`, `fetch`, R2 and Whisper. No live database and no brain.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] | Promise<Row[]> = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql };
});
vi.mock("@/lib/r2", () => ({
  signGetUrl: async (o: { key: string }) => `https://r2.example/${o.key}?sig=1`,
  getObjectBytes: async () => new Uint8Array([1, 2, 3]),
}));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));

const brainCalls: Call[] = [];
let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/brain/db", () => ({
  TOKEN_ENV: "BRAIN_SERVICE_TOKEN",
  getPool: () => ({}),
  query: async (t: string, v?: unknown[]) => {
    brainCalls.push({ text: t, values: v ?? [] });
    const rows = brainResponder(t, v ?? []);
    return { rows, rowCount: rows.length };
  },
}));

/** What the Mini returns. Overwritten per test. */
let whisperOut: Row = { ok: true, transcript: "", segments: [], language: "en", duration_seconds: 300, latency_ms: 10 };
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => whisperOut }));

import { BRAIN_TOOLS, POST_CUE_BLOCKED_TYPES } from "@/lib/mcp/tools/brain";
import { BENCH_TOOLS, buildTurns, turnSourceRef, TURN_SPEAKER_UNKNOWN } from "@/lib/mcp/tools/bench";

const tool = (name: string) => {
  const t = [...BRAIN_TOOLS, ...BENCH_TOOLS].find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
const ctx = { origin: "https://preview.example" };
const ROOM = { id: "room_t", slug: "opd-test-a7q9", name: "OPD Test", disabled_at: null };

let fetchCalls: Array<{ url: string; body: Row; auth: string | null }> = [];
function mockFetch(json: Row = { ok: true, cue_id: "cue_1", cue_at: "2026-08-19T10:00:00.000Z", state: {} }) {
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>)?.Authorization ?? null });
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

beforeEach(() => {
  calls.length = 0;
  brainCalls.length = 0;
  responder = (text) => (/FROM room/.test(text) ? [ROOM] : []);
  brainResponder = () => [];
  process.env.BRAIN_SERVICE_TOKEN = "tok";
  delete process.env.BRAIN_BASE_URL;
  mockFetch();
});

// ---------------------------------------------------------------------------
// 1. the blocklist — the live-write hazard
// ---------------------------------------------------------------------------

describe("scribe_post_cue — the machine cue types are refused by name", () => {
  it("names exactly the seven, in the settled order", () => {
    expect(POST_CUE_BLOCKED_TYPES).toEqual([
      "stt_turn", "stt_silence", "speaker_match", "pqm_called", "pstart", "dx_event", "pulse_note",
    ]);
  });

  it.each(POST_CUE_BLOCKED_TYPES.map((t) => [t] as const))("refuses %s and posts nothing", async (type) => {
    const out = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "type_not_allowed", type });
    expect(out.blocked).toEqual(POST_CUE_BLOCKED_TYPES);
    expect(fetchCalls).toHaveLength(0);
  });

  it("the type set is still OPEN — anything not on the list still posts", async () => {
    const out = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "consult_mark" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    const second = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "some_new_idea" }, ctx)) as Row;
    expect(second.ok).toBe(true);
    expect(fetchCalls).toHaveLength(2);
  });

  it("the refusal happens before the cue door is reached, not after it answers", async () => {
    // A brain that would have said yes is never asked.
    mockFetch({ ok: true, cue_id: "cue_should_not_exist", cue_at: "2026-08-19T10:00:00.000Z", state: {} });
    const out = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "stt_turn", payload: { text: "hello" } }, ctx)) as Row;
    expect(out.ok).toBe(false);
    expect(out.cue_id).toBeUndefined();
    expect(fetchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. the time mapping — pure, and the part that is silently wrong or silently right
// ---------------------------------------------------------------------------

const SESSION_ID = "bs_xvntaugh";

describe("turnSourceRef — the key, exactly", () => {
  it("the slice A speaker is the literal `-`", () => {
    expect(TURN_SPEAKER_UNKNOWN).toBe("-");
  });
  it("is four fields, pipe separated, no spaces, with the kickoff's own example", () => {
    expect(turnSourceRef("bs_xvntaugh", 1755576000000, 1755576004320)).toBe("bs_xvntaugh|1755576000000|1755576004320|-");
    expect(turnSourceRef("bs_xvntaugh", 1755576000000, 1755576004320).split("|")).toHaveLength(4);
  });
  it("FLOORS, never rounds — the same turn re-transcribed is the same key", () => {
    expect(turnSourceRef("bs_a", 1000.9, 2000.999)).toBe("bs_a|1000|2000|-");
    expect(turnSourceRef("bs_a", 1000.1, 2000.4)).toBe("bs_a|1000|2000|-");
  });
  it("slice B's integer goes in the speaker slot, and the format gains no fifth field", () => {
    const ref = turnSourceRef("bs_a", 1, 2, "3");
    expect(ref).toBe("bs_a|1|2|3");
    expect(ref.split("|")).toHaveLength(4);
    // an anonymous turn and a diarised one over the same instants are DIFFERENT rows
    expect(ref).not.toBe(turnSourceRef("bs_a", 1, 2));
  });
});

describe("buildTurns — offset, filter, drop, and say so when nothing is left", () => {
  const CLIP = Date.parse("2026-08-19T05:05:00Z"); // the chunk's own start
  const WIN_FROM = Date.parse("2026-08-19T05:06:00Z");
  const WIN_TO = Date.parse("2026-08-19T05:08:00Z");
  const seg = (start_s: number, end_s: number, text: string) => ({ start_s, end_s, text });

  it("offsets segment seconds onto the CLIP's true start with Math.floor on both ends", () => {
    const b = buildTurns({
      sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO,
      segments: [seg(60, 64.3209, "hello there")], language: "en",
    });
    expect(b.silence).toBe(false);
    const t = b.turns[0]!;
    // 05:05:00Z + 60s = 05:06:00Z, and 64.3209s floors to 64320 ms — never 64321
    expect(t.start_ms).toBe(Date.parse("2026-08-19T05:06:00Z"));
    expect(t.end_ms).toBe(Date.parse("2026-08-19T05:06:04.320Z"));
    expect(t.at).toBe("2026-08-19T05:06:00.000Z");
    expect(t.type).toBe("stt_turn");
    expect(t.speaker).toBe("-");
    expect(t.source_ref).toBe(`${SESSION_ID}|${t.start_ms}|${t.end_ms}|-`);
    expect(t.payload).toMatchObject({ text: "hello there", start_ms: t.start_ms, end_ms: t.end_ms, speaker: "-", engine: "whisper", language: "en", session_id: SESSION_ID });
  });

  it("the clip start is what moves the day: the same segments on a joined clip land elsewhere", () => {
    const onChunk = buildTurns({ sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO, segments: [seg(60, 90, "x")] });
    const onClip = buildTurns({ sessionId: SESSION_ID, clipStartMs: WIN_FROM, windowStartMs: WIN_FROM, windowEndMs: WIN_TO, segments: [seg(0, 30, "x")] });
    expect(onChunk.turns[0]!.start_ms).toBe(onClip.turns[0]!.start_ms);
    expect(onChunk.turns[0]!.source_ref).toBe(onClip.turns[0]!.source_ref);
  });

  it("filters to the window asked for — the whole chunk is transcribed, the window is what is kept", () => {
    const b = buildTurns({
      sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO,
      segments: [
        seg(0, 30, "before the window"),
        seg(55, 65, "straddles the start — kept whole"),
        seg(70, 80, "inside"),
        seg(175, 185, "straddles the end — kept whole"),
        seg(200, 210, "after the window"),
      ],
    });
    expect(b.turns.map((t) => t.text)).toEqual(["straddles the start — kept whole", "inside", "straddles the end — kept whole"]);
    expect(b.dropped_outside_window).toBe(2);
    // a straddling turn keeps its TRUE bounds — clamping would invent a turn nobody said
    expect(b.turns[0]!.start_ms).toBe(CLIP + 55_000);
    expect(b.turns[0]!.start_ms).toBeLessThan(WIN_FROM);
  });

  it("drops blank text — a cue with no words is evidence of nothing", () => {
    const b = buildTurns({
      sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO,
      segments: [seg(60, 61, "   "), seg(62, 63, ""), seg(64, 65, "real")],
    });
    expect(b.turns).toHaveLength(1);
    expect(b.turns[0]!.text).toBe("real");
    expect(b.dropped_blank).toBe(2);
  });

  it("a window that survived NOTHING is one stt_silence over the whole window", () => {
    const b = buildTurns({
      sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO,
      segments: [seg(0, 10, "before"), seg(61, 62, "  ")],
    });
    expect(b.silence).toBe(true);
    expect(b.turns).toHaveLength(1);
    const s = b.turns[0]!;
    expect(s.type).toBe("stt_silence");
    expect(s.start_ms).toBe(WIN_FROM);
    expect(s.end_ms).toBe(WIN_TO);
    expect(s.speaker).toBe("-");
    expect(s.text).toBe("");
    expect(s.source_ref).toBe(`${SESSION_ID}|${WIN_FROM}|${WIN_TO}|-`);
    expect(s.payload).toMatchObject({ segments_considered: 2, dropped_outside_window: 1, dropped_blank: 1 });
  });

  it("no segments at all is a silence, not a crash — and neither is a transcriber that sent none", () => {
    expect(buildTurns({ sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO, segments: [] }).silence).toBe(true);
    // an older engine, a stub, a future adapter: undefined where an array was expected
    const b = buildTurns({ sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO, segments: undefined as unknown as [] });
    expect(b.silence).toBe(true);
    expect(b.turns).toHaveLength(1);
  });

  it("is pure — two runs over the same segments are byte-identical", () => {
    const args = { sessionId: SESSION_ID, clipStartMs: CLIP, windowStartMs: WIN_FROM, windowEndMs: WIN_TO, segments: [seg(60, 65, "a"), seg(70, 75, "b")] };
    expect(JSON.stringify(buildTurns(args))).toBe(JSON.stringify(buildTurns(args)));
  });
});

// ---------------------------------------------------------------------------
// 3. the tool — dry by default, and what a write actually posts
// ---------------------------------------------------------------------------

const SESSION = { id: "bs_a", room_id: "room_t", label: null, mic_label: null, started_at: "2026-08-19T05:00:00Z", ended_at: null, status: "ended", notes: null, room_slug: "opd-test-a7q9", room_name: "OPD Test" };
const chunk = (idx: number, startIso: string, endIso: string) => ({
  id: `bc_${idx}`, idx, source: "primary", r2_key: `bench/x/2026-08-19/bs_a/chunk_${String(idx).padStart(5, "0")}.webm`,
  content_type: "audio/webm", started_at: startIso, ended_at: endIso, upload_state: "verified",
  duration_ms: 300_000, size_bytes: 1, gap_before_ms: 0, created_at: endIso,
});
const CHUNKS = [
  chunk(0, "2026-08-19T05:00:00Z", "2026-08-19T05:05:00Z"),
  chunk(1, "2026-08-19T05:05:00Z", "2026-08-19T05:10:00Z"),
];
const SCRATCH_ROOM = { id: "room_scratch_t", slug: "scratch-opd-test-a7q9", name: "SCRATCH · OPD Test", disabled_at: null };
const SCRATCH_DAY = { id: "rd_scratch_t_20260819", room_id: "room_scratch_t", ist_date: "2026-08-19", scratch: true };

/** The world: a real room, one session, two chunks, and a scratch graph that already exists. */
function seedWorld(day: Row = SCRATCH_DAY) {
  responder = (text) =>
    /FROM room WHERE id = \?/.test(text) && /room_scratch/.test(String(calls[calls.length - 1]?.values?.[0] ?? "")) ? [SCRATCH_ROOM]
    : /FROM room/.test(text) ? [ROOM]
    : /FROM bench_session s/.test(text) && /JOIN room r/.test(text) && !/COUNT/.test(text) ? [SESSION]
    : /FROM bench_chunk/.test(text) ? CHUNKS
    : [];
  brainResponder = (text) => (/FROM room_day WHERE room_id/.test(text) ? [day] : []);
  whisperOut = {
    ok: true,
    transcript: "hello there and later",
    language: "en",
    duration_seconds: 300,
    latency_ms: 10,
    // chunk 1 starts 05:05:00Z; the window below is 05:06–05:08
    segments: [
      { start_s: 10, end_s: 20, text: "before the window" },
      { start_s: 60, end_s: 64.32, text: "hello there" },
      { start_s: 120, end_s: 130, text: "and later" },
    ],
  };
}

const WINDOW = { session_id: "bs_a", start: "10:36", end: "10:38" }; // 05:06–05:08 UTC

describe("scribe_transcribe_range — turns, and writing them", () => {
  beforeEach(() => seedWorld());

  it("dry by default: the turns come back, and NOTHING is posted", async () => {
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(fetchCalls).toHaveLength(0);
    expect(out.written).toBe(0);
    const turns = out.turns as Row[];
    expect(turns.map((t) => t.text)).toEqual(["hello there", "and later"]); // the third is outside the window
    expect(turns[0]!.source_ref).toBe(`bs_a|${Date.parse("2026-08-19T05:06:00Z")}|${Date.parse("2026-08-19T05:06:04.320Z")}|-`);
    expect(out.clip_start_ms).toBe(Date.parse("2026-08-19T05:05:00Z")); // the WHOLE chunk was sent
    expect(out.text).toBe("hello there and later"); // the text answer is unchanged
  });

  it("dry_run:false posts one cue per turn — scratch day, source replay, source_ref, and NO session_id", async () => {
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: false }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.dry_run).toBe(false);
    expect(out.room_day_id).toBe("rd_scratch_t_20260819");
    expect(fetchCalls).toHaveLength(2);
    for (const c of fetchCalls) {
      expect(c.url).toBe("https://preview.example/api/brain/cues");
      expect(c.auth).toBe("Bearer tok");
      expect(c.body.room_id).toBe("room_scratch_t");
      expect(c.body.room_day_id).toBe("rd_scratch_t_20260819");
      expect(c.body.source).toBe("replay");
      expect(c.body.type).toBe("stt_turn");
      expect(String(c.body.source_ref).split("|")).toHaveLength(4);
      // 0046's index is (session_id, type, at); a turn must be in 0050's key ONLY
      expect(c.body.session_id).toBeUndefined();
    }
    expect(out).toMatchObject({ written: 2, already_existed: 0, dropped: 0, attempted: 2 });
    expect(out.natural_key).toEqual(["source_ref", "type"]);
  });

  it("a re-run writes nothing twice: no row and no error is already_existed, never a failure", async () => {
    mockFetch({ ok: true, cue_id: null, cue_at: "2026-08-19T05:06:00.000Z", already_existed: true, state: {} });
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: false }, ctx)) as Row;
    expect(out).toMatchObject({ written: 0, already_existed: 2, dropped: 0 });
  });

  it("a window with nothing in it writes ONE stt_silence", async () => {
    whisperOut = { ok: true, transcript: "only outside", language: "en", latency_ms: 1, segments: [{ start_s: 10, end_s: 20, text: "before the window" }] };
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: false }, ctx)) as Row;
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.body.type).toBe("stt_silence");
    expect(fetchCalls[0]!.body.source_ref).toBe(`bs_a|${Date.parse("2026-08-19T05:06:00Z")}|${Date.parse("2026-08-19T05:08:00Z")}|-`);
    expect((out.turn_counts as Row).silences).toBe(1);
    expect(out.written).toBe(1);
  });

  it("BRAIN_BASE_URL refuses the write by name — and the text still comes back", async () => {
    process.env.BRAIN_BASE_URL = "https://brain.example/";
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: false }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.text).toBe("hello there and later");
    expect(out.turn_write_error).toBe("brain_base_url_set");
    expect(fetchCalls).toHaveLength(0);
    expect(out.written).toBe(0);
  });

  it("a day whose scratch flag is not true is refused, and nothing is posted", async () => {
    seedWorld({ ...SCRATCH_DAY, scratch: false });
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: false }, ctx)) as Row;
    expect(out.turn_write_error).toBe("not_a_scratch_day");
    expect(fetchCalls).toHaveLength(0);
    expect(out.text).toBe("hello there and later");
  });

  it("a brain that refuses every write stops early and names the drops — a drop is a bug, not a mode", async () => {
    fetchCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)), auth: null });
      return new Response(JSON.stringify({ ok: false, error: "boom" }), { status: 503, headers: { "content-type": "application/json" } });
    }));
    whisperOut = {
      ok: true, transcript: "a b c d", language: "en", latency_ms: 1,
      segments: [60, 70, 80, 90, 100].map((t) => ({ start_s: t, end_s: t + 1, text: `turn at ${t}` })),
    };
    const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: false }, ctx)) as Row;
    expect(out.dropped).toBe(3);
    expect(out.stopped_early).toBe("consecutive_failures");
    expect(fetchCalls).toHaveLength(3); // stopped, not all five
    expect((out.failures as Row[])[0]).toMatchObject({ type: "stt_turn" });
  });

  it("FAILS DRY: only an explicit false writes — a typo, a string or a null stays dry", async () => {
    for (const v of ["yes-please", "no", null, 1, {}, "FALSE"]) {
      fetchCalls = [];
      const out = (await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: v }, ctx)) as Row;
      expect(out.dry_run, `dry_run:${JSON.stringify(v)} must stay dry`).toBe(true);
      expect(fetchCalls).toHaveLength(0);
    }
    // and the two spellings that DO write
    for (const v of [false, "false"]) {
      fetchCalls = [];
      await tool("scribe_transcribe_range").handler({ ...WINDOW, dry_run: v }, ctx);
      expect(fetchCalls.length, `dry_run:${JSON.stringify(v)} must write`).toBeGreaterThan(0);
    }
  });
});
