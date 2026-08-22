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
import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";

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
