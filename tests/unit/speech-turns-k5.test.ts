/**
 * Speech turns, slice A — kickoff K5, silence can record itself.
 *
 * THE DEFECT. The tool promised that "a window that survives nothing comes back as ONE
 * stt_silence", and could not do it for actual silence. lib/whisper.ts returns
 * `{ ok: false, error: 'empty_transcript' }` whenever the transcript is empty, and the tool
 * treated every ok:false as a failure — so it aborted before ever reaching the segment filter
 * that emits the silence. The one case stt_silence exists for was the one case it could not
 * handle, and the 07:45–07:51Z window on OPD 7 wrote nothing at all: not the turns, not the
 * marker, no record that anybody had asked.
 *
 * THE SIGNAL IS UNAMBIGUOUS. A non-200 leaves the client earlier as `http_<status>`.
 * `empty_transcript` is reached ONLY on a 200 whose text and segment text are both empty — a
 * successful transcription of a quiet room, mislabelled.
 *
 * THE RULE: empty_transcript is silence; every other error is a failed ask.
 *
 * lib/whisper.ts is deliberately NOT changed. The same signal means the opposite thing on the
 * encounter pipeline, where no note can be made from silence. Only the caller knows what it
 * asked for, so the caller decides.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  },
}));
vi.mock("@/lib/r2", () => ({
  signGetUrl: async (o: { key: string }) => `https://r2.example/${o.key}`,
  getObjectBytes: async () => new Uint8Array([1, 2, 3]),
}));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));

let brainResponder: (text: string, values: unknown[]) => Row[] = () => [];
vi.mock("@/lib/brain/db", () => ({
  TOKEN_ENV: "BRAIN_SERVICE_TOKEN",
  getPool: () => ({}),
  query: async (t: string, v?: unknown[]) => {
    const rows = brainResponder(t, v ?? []);
    return { rows, rowCount: rows.length };
  },
}));

/** What the Mini returns. Overwritten per test. */
let whisperOut: Row = { ok: false, error: "empty_transcript", latency_ms: 1914 };
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => whisperOut }));

import { BENCH_TOOLS, EMPTY_TRANSCRIPT } from "@/lib/mcp/tools/bench";

const tool = (name: string) => BENCH_TOOLS.find((x) => x.name === name)!;
const ctx = { origin: "https://preview.example" };

const ROOM = { id: "room_t", slug: "opd-test-a7q9", name: "OPD Test", disabled_at: null };
const SCRATCH_ROOM = { id: "room_scratch_t", slug: "scratch-opd-test-a7q9", name: "SCRATCH · OPD Test", disabled_at: null };
const SCRATCH_DAY = { id: "rd_scratch_t_20260819", room_id: "room_scratch_t", ist_date: "2026-08-19", scratch: true };
const SESSION = {
  id: "bs_a", room_id: "room_t", label: null, mic_label: null,
  started_at: "2026-08-19T05:00:00Z", ended_at: null, status: "ended", notes: null,
  room_slug: ROOM.slug, room_name: ROOM.name,
};
const chunk = (idx: number, startIso: string, endIso: string) => ({
  id: `bc_${idx}`, idx, source: "primary", r2_key: `bench/x/${idx}.webm`, content_type: "audio/webm",
  started_at: startIso, ended_at: endIso, upload_state: "verified", duration_ms: 300_000,
  size_bytes: 1, gap_before_ms: 0, created_at: endIso,
});
const CHUNKS = [chunk(0, "2026-08-19T05:00:00Z", "2026-08-19T05:05:00Z"), chunk(1, "2026-08-19T05:05:00Z", "2026-08-19T05:10:00Z")];

const WIN_FROM = Date.parse("2026-08-19T05:06:00Z");
const WIN_TO = Date.parse("2026-08-19T05:08:00Z");
const WINDOW = { session_id: "bs_a", start: "10:36", end: "10:38" }; // 05:06–05:08 UTC

let fetchCalls: Array<{ body: Row }> = [];
function mockFetch(json: Row = { ok: true, batch: true, deleted: 0, written: 2, already_existed: 0, dropped: 0, attempted: 2, state: {} }) {
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    fetchCalls.push({ body: JSON.parse(String(init.body)) as Row });
    return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  }));
}

beforeEach(() => {
  calls.length = 0;
  responder = (text) =>
    /FROM room WHERE id = \?/.test(text) && /room_scratch/.test(String(calls[calls.length - 1]?.values?.[0] ?? "")) ? [SCRATCH_ROOM]
    : /FROM room/.test(text) ? [ROOM]
    : /FROM bench_session s/.test(text) && /JOIN room r/.test(text) && !/COUNT/.test(text) ? [SESSION]
    : /FROM bench_chunk/.test(text) ? CHUNKS
    : [];
  brainResponder = (text) => (/FROM room_day WHERE room_id/.test(text) ? [SCRATCH_DAY] : []);
  process.env.BRAIN_SERVICE_TOKEN = "tok";
  delete process.env.BRAIN_BASE_URL;
  whisperOut = { ok: false, error: "empty_transcript", latency_ms: 1914 };
  mockFetch();
});

const run = (args: Row = {}) => tool("scribe_transcribe_range").handler({ ...WINDOW, ...args }, ctx) as Promise<Row>;
const cuesSent = () => (fetchCalls[0]?.body.cues as Row[]) ?? [];

// ===========================================================================

describe("empty_transcript is SILENCE, not a failure", () => {
  it("THE HEADLINE: one stt_silence, one complete marker, zero turns", async () => {
    const out = await run({ dry_run: false });

    // it is not an error any more — the room was quiet and we know that
    expect(out.ok).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.silent_window).toBe(true);
    expect(out.text).toBe("");

    expect(fetchCalls).toHaveLength(1);
    const cues = cuesSent();
    expect(cues.map((c) => c.type)).toEqual(["stt_silence", "stt_window"]);

    // the silence covers exactly what was asked for, keyed the settled way
    const silence = cues[0]!;
    expect(silence.at).toBe(new Date(WIN_FROM).toISOString());
    expect(silence.source_ref).toBe(`bs_a|${WIN_FROM}|${WIN_TO}|-`);
    expect(silence.payload).toMatchObject({ window: { start_ms: WIN_FROM, end_ms: WIN_TO }, engine: "whisper", source_used: "primary" });

    // THE ASK FINISHED. complete:true, and zero segments is the truth rather than a default.
    const marker = cues[1]!;
    expect(marker.source_ref).toBe(`bs_a|${WIN_FROM}|${WIN_TO}|window`);
    expect(marker.payload).toMatchObject({ complete: true, segment_count: 0, end: new Date(WIN_TO).toISOString() });
    expect((marker.payload as Row).stopped_early).toBeUndefined();

    // no turn, and nothing invented
    expect(cues.some((c) => c.type === "stt_turn")).toBe(false);
    expect((out.turn_counts as Row).turns).toBe(0);
    expect((out.turn_counts as Row).silences).toBe(1);
  });

  it("is NEVER counted as failed — nothing failed", async () => {
    const out = await run({ dry_run: false });
    expect(out.failed).toBe(0);
    expect(out.failed_reason).toBeUndefined();
    expect(out.dropped).toBe(0);
    expect(out.complete).toBe(true);
    expect(out.window_recorded).toBe(true);
  });

  it("goes through the SAME window machinery: the delete, the scratch day, the replace", async () => {
    await run({ dry_run: false });
    const body = fetchCalls[0]!.body;
    // a silent window replaces whatever the same (session_id, window) held before
    expect(body.replace_window).toEqual({ session_id: "bs_a", start_ms: WIN_FROM, end_ms: WIN_TO });
    expect(body.room_day_id).toBe("rd_scratch_t_20260819");
    expect(body.source).toBe("replay");
    expect(body.session_id).toBe("bs_a");
  });

  it("re-running a silent window REPLACES rather than accumulates", async () => {
    mockFetch({ ok: true, batch: true, deleted: 2, written: 2, already_existed: 0, dropped: 0, attempted: 2, state: {} });
    const out = await run({ dry_run: false });
    // the previous silence and its marker came out; the new pair went in. Still one of each.
    expect(out).toMatchObject({ deleted: 2, written: 2, dropped: 0, failed: 0 });
    expect(cuesSent()).toHaveLength(2);
  });

  it("a DRY run returns the silence and writes nothing", async () => {
    const out = await run();
    expect(out.ok).toBe(true);
    expect(out.silent_window).toBe(true);
    expect(out.dry_run).toBe(true);
    expect(fetchCalls).toHaveLength(0);
    expect(out.written).toBe(0);
    const turns = out.turns as Row[];
    expect(turns).toHaveLength(1);
    expect(turns[0]!.type).toBe("stt_silence");
    // and it shows the marker it WOULD write
    expect((out.window_cue as Row).type).toBe("stt_window");
  });

  it("the exported constant is the string the client actually sends", () => {
    expect(EMPTY_TRANSCRIPT).toBe("empty_transcript");
  });
});

describe("every OTHER Whisper error is a failed ask", () => {
  beforeEach(() => {
    whisperOut = { ok: false, error: "http_500: upstream exploded", latency_ms: 42 };
  });

  it("writes NO silence and NO turns — what the window held is unknown", async () => {
    const out = await run({ dry_run: false });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("whisper_failed");
    expect(out.detail).toBe("http_500: upstream exploded");
    const cues = cuesSent();
    expect(cues.map((c) => c.type)).toEqual(["stt_window"]);
    expect(cues.some((c) => c.type === "stt_silence")).toBe(false);
    expect(cues.some((c) => c.type === "stt_turn")).toBe(false);
  });

  it("records ONE marker with complete:false naming the cause", async () => {
    const out = await run({ dry_run: false });
    const marker = cuesSent()[0]!;
    expect(marker.payload).toMatchObject({ complete: false, stopped_early: "http_500: upstream exploded", segment_count: 0 });
    expect(out.window_recorded).toBe(true);
    expect(out.complete).toBe(false);
  });

  it("sends NO replace_window — a failed ask has nothing to replace the window WITH", async () => {
    await run({ dry_run: false });
    expect(fetchCalls[0]!.body.replace_window).toBeUndefined();
    // and so it issues no DELETE, which is the K4 property this inherits
    expect(fetchCalls).toHaveLength(1);
  });

  it("when the marker cannot be written either, it says the day holds NO record", async () => {
    fetchCalls = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      fetchCalls.push({ body: JSON.parse(String(init.body)) as Row });
      return new Response(JSON.stringify({ ok: false, error: "brain_permission_denied" }), { status: 503, headers: { "content-type": "application/json" } });
    }));
    const out = await run({ dry_run: false });
    expect(out.window_recorded).toBe(false);
    expect(out.window_record).toBe("none");
    expect(String(out.note_window_record)).toMatch(/only record/);
    expect(out.turn_write_error).toBe("brain_permission_denied");
  });

  it("a DRY run on a failed ask writes nothing and shows the marker it would write", async () => {
    const out = await run();
    expect(fetchCalls).toHaveLength(0);
    expect(out.window_recorded).toBe(false);
    expect((out.window_cue as Row).type).toBe("stt_window");
    expect(((out.window_cue as Row).payload as Row | undefined)).toBeUndefined(); // shownTurns omits payload
  });

  it("a timeout is a failed ask too, not silence", async () => {
    whisperOut = { ok: false, error: "timeout_90000ms", latency_ms: 90_000 };
    const out = await run({ dry_run: false });
    expect(out.ok).toBe(false);
    expect(out.silent_window).toBeUndefined();
    expect(cuesSent().map((c) => c.type)).toEqual(["stt_window"]);
    expect((cuesSent()[0]!.payload as Row).stopped_early).toBe("timeout_90000ms");
  });
});

describe("the guarantee the note describes is the guarantee the code has", () => {
  it("no note claims stt_window is deleted — K4 removed it from the delete", async () => {
    const dry = await run();
    const written = await run({ dry_run: false });
    for (const out of [dry, written]) {
      const note = String(out.note_turns ?? "");
      if (!note) continue;
      expect(note).not.toMatch(/stt_turn, stt_silence and stt_window[^.]*deleted/i);
    }
  });

  it("the tool description says empty_transcript is silence, so no reader infers a failure", () => {
    const d = tool("scribe_transcribe_range").description;
    expect(d).toMatch(/empty transcript/i);
    expect(d).toMatch(/never counted as `failed`/);
  });
});
