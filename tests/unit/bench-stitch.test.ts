/**
 * ETA-MCP-UPGRADE U2 — hear a consultation, not a piece.
 *
 * Mocked `sql`, `r2`, `whisper` and `fetch`; no live DB, no live R2, no joining service. What is
 * proved here is the door's half of the contract: which windows reach the joining service, which
 * are refused by name, what the request on the wire looks like, and what comes back when the
 * joining service is not there.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] = () => [];

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
vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => ({ ok: true, transcript: "the joined window, start to finish", language: "en", duration_seconds: 180, latency_ms: 12 }),
}));
vi.mock("@/lib/bench-timeline", () => ({ renderBenchTimeline: async () => ({ markdown: "" }) }));
vi.mock("@/lib/brain/db", () => ({ TOKEN_ENV: "BRAIN_SERVICE_TOKEN", getPool: () => ({}), query: async () => ({ rows: [] }) }));
vi.mock("@/lib/brain/state", () => ({
  CUES_DEFAULT_LIMIT: 50, CUES_MAX_LIMIT: 200, findRoomDay: async () => null, isIstDateString: (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s),
  istDate: () => "2026-08-19", listCuesForDay: async () => ({ cues: [] }), readGraph: async () => ({}), roomExists: async () => true,
  // K3: the turn writer's completeness cue type. A constant, not a function — the mock has to
  // carry it or buildWindowCue reads undefined off the mocked module.
  WINDOW_CUE_TYPE: "stt_window",
}));

import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";
import { buildJoinRequest, clipKey, clipMeta, CLIPS_PREFIX, JOIN_MAX_MINUTES, pickRecordingRooms, refuseIfTooLong } from "@/lib/bench-join";

const tool = (name: string) => {
  const t = BENCH_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
const ctx = { origin: "https://preview.example" };

const ROOM = { id: "room_t", slug: "opd-test-a7q9", name: "OPD Test", disabled_at: null };
const SESSION = { id: "bs_a", room_id: "room_t", label: null, mic_label: null, started_at: "2026-08-19T05:00:00Z", ended_at: null, status: "ended", notes: null, room_slug: "opd-test-a7q9", room_name: "OPD Test" };

const chunk = (idx: number, startIso: string, endIso: string, source: "primary" | "backup" = "primary") => ({
  id: `bc_${source}_${idx}`, idx, source, r2_key: `bench/opd-test-a7q9/2026-08-19/bs_a/${source === "backup" ? "backup_chunk" : "chunk"}_${String(idx).padStart(5, "0")}.webm`,
  content_type: "audio/webm", started_at: startIso, ended_at: endIso, upload_state: "verified", duration_ms: 300_000, size_bytes: 1_100_000, gap_before_ms: 0, created_at: endIso,
});
// 05:00–05:15Z = 10:30–10:45 IST, three five-minute pieces.
const CHUNKS = [
  chunk(0, "2026-08-19T05:00:00Z", "2026-08-19T05:05:00Z"),
  chunk(1, "2026-08-19T05:05:00Z", "2026-08-19T05:10:00Z"),
  chunk(2, "2026-08-19T05:10:00Z", "2026-08-19T05:15:00Z"),
];

/** Rows `listBenchSessions({status:'recording'})` returns — the recording guard's only input. */
let recordingRows: Row[] = [];
/** Rows `getListener(room)` returns. */
let listenerRows: Row[] = [];

/** Calls that reached the joining service. */
let joinCalls: Array<{ url: string; body: Row; auth: string | null }> = [];
let joinReply: () => Response | Promise<Response> = () => new Response("{}", { status: 200 });

beforeEach(() => {
  calls.length = 0;
  recordingRows = [];
  listenerRows = [];
  joinCalls = [];
  responder = (text) => {
    if (/FROM room/.test(text)) return [ROOM];
    if (/FROM bench_listener/.test(text)) return listenerRows;
    if (/FROM bench_session s/.test(text) && /COUNT/.test(text)) return recordingRows;
    if (/FROM bench_session s/.test(text) && /JOIN room r/.test(text)) return [SESSION];
    if (/FROM bench_chunk/.test(text)) return CHUNKS;
    return [];
  };
  process.env.AUDIO_JOIN_URL = "https://join.example";
  process.env.AUDIO_JOIN_TOKEN = "join-tok";
  joinReply = () =>
    new Response(JSON.stringify({ ok: true, key: joinCalls.at(-1)!.body.out_key, bytes: 1_437_012, duration_ms: 180_000 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    joinCalls.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      auth: (init.headers as Record<string, string>)?.Authorization ?? null,
    });
    return joinReply();
  }));
});

afterEach(() => {
  delete process.env.AUDIO_JOIN_URL;
  delete process.env.AUDIO_JOIN_TOKEN;
  vi.unstubAllGlobals();
});

/** A room recording right now: a 'recording' session whose last piece landed a minute ago. */
const recordingNow = (nowMs = Date.now()) => ({
  id: "bs_live", room_id: "room_live", room_slug: "cardiology-x1", status: "recording",
  started_at: new Date(nowMs - 3_600_000).toISOString(), last_any_chunk_at: new Date(nowMs - 60_000).toISOString(),
  ended_at: null, chunk_count: 12, backup_chunk_count: 0,
});

// ---------------------------------------------------------------------------
// 1. A window inside one piece takes the existing path, unchanged.
// ---------------------------------------------------------------------------

describe("a window inside one piece", () => {
  it("answers exactly as before — one 15-minute presign on that chunk, no join, no joining service call", async () => {
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:36", end: "10:38" }, ctx)) as Row; // 05:06–05:08Z
    expect(out.ok).toBe(true);
    expect(out.joined).toBeUndefined();
    expect(out.chunk_idx).toBe(1);
    expect(out.offset_in_chunk_s).toBe(60);
    expect(out.duration_s).toBe(120);
    expect(String(out.presigned_get)).toContain("chunk_00001.webm");
    expect(out.expires_in_seconds).toBe(900);
    expect(joinCalls).toHaveLength(0);
  });

  it("transcribe on a single piece still returns the whole-chunk text and the honest note", async () => {
    const out = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:36", end: "10:38" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.joined).toBeUndefined();
    expect(out.chunk_idx).toBe(1);
    expect(String(out.note)).toMatch(/WHOLE chunk 1/);
    expect(joinCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. A window crossing two pieces resolves to both, in order.
// ---------------------------------------------------------------------------

describe("a window crossing two pieces", () => {
  it("sends both pieces to the joining service in order, with the trim measured against the joined stream", async () => {
    // 10:34–10:37 IST = 05:04–05:07Z: the last minute of piece 0 and the first two of piece 1.
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:37" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.joined).toBe(true);
    expect(joinCalls).toHaveLength(1);
    expect(joinCalls[0]!.url).toBe("https://join.example/join");
    expect(joinCalls[0]!.auth).toBe("Bearer join-tok");

    const pieces = joinCalls[0]!.body.pieces as Row[];
    expect(pieces.map((p) => p.idx)).toEqual([0, 1]);
    expect(pieces.map((p) => p.key)).toEqual([
      "bench/opd-test-a7q9/2026-08-19/bs_a/chunk_00000.webm",
      "bench/opd-test-a7q9/2026-08-19/bs_a/chunk_00001.webm",
    ]);
    // 4 min into piece 0, and 1 min of piece 0 + 2 min of piece 1 = 3 min of window.
    expect(joinCalls[0]!.body.trim).toEqual({ start_ms: 240_000, end_ms: 420_000 });

    // One clip, one link, and no multi_chunk_not_supported_v1 anywhere in the answer.
    const clip = out.clip as Row;
    expect(String(clip.r2_key)).toBe("clips/bs_a/20260819T050400Z-20260819T050700Z-primary.webm");
    expect(String(clip.presigned_get)).toContain("clips/bs_a/");
    expect(clip.expires_in_seconds).toBe(3600);
    expect(out.error).toBeUndefined();
    expect((out.pieces as Row[]).map((p) => p.chunk_idx)).toEqual([0, 1]);
  });

  it("three pieces stay in tape order, and the window is echoed back", async () => {
    // 10:32–10:44 IST = 05:02–05:14Z — the PRD's 12-minute acceptance window.
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:32", end: "10:44" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect((joinCalls[0]!.body.pieces as Row[]).map((p) => p.idx)).toEqual([0, 1, 2]);
    expect(joinCalls[0]!.body.trim).toEqual({ start_ms: 120_000, end_ms: 840_000 }); // 12 min
    expect((out.requested_range as Row).start_ist).toBe("10:32:00");
    expect((out.requested_range as Row).end_ist).toBe("10:44:00");
  });

  it("transcribe on a crossing window runs on the joined clip and says the text covers the window", async () => {
    const out = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:34", end: "10:37" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.joined).toBe(true);
    expect(out.text).toBe("the joined window, start to finish");
    expect(String(out.note)).toMatch(/covers the requested window 10:34:00–10:37:00 IST/);
    expect(String(out.note)).not.toMatch(/WHOLE chunk/);
    expect((out.clip as Row).r2_key).toBe("clips/bs_a/20260819T050400Z-20260819T050700Z-primary.webm");
  });

  it("buildJoinRequest is pure and never reorders what it is handed", () => {
    const covering = [
      { chunk: { idx: 7, r2_key: "bench/x/chunk_00007.webm" }, offset_in_chunk_s: 30, duration_s: 270 },
      { chunk: { idx: 8, r2_key: "bench/x/chunk_00008.webm" }, offset_in_chunk_s: 0, duration_s: 300 },
      { chunk: { idx: 9, r2_key: "bench/x/chunk_00009.webm" }, offset_in_chunk_s: 0, duration_s: 90 },
    ];
    const req = buildJoinRequest("bs_x", covering, Date.parse("2026-08-19T06:00:00Z"), Date.parse("2026-08-19T06:11:00Z"), "primary");
    expect(req.pieces.map((p) => p.idx)).toEqual([7, 8, 9]);
    expect(req.trim).toEqual({ start_ms: 30_000, end_ms: 690_000 }); // 30 s in, 11 min of tape
  });
});

// ---------------------------------------------------------------------------
// 3. Over 30 minutes is refused, naming the limit.
// ---------------------------------------------------------------------------

describe("over thirty minutes", () => {
  it("a 45-minute window is refused by name, states the limit, and never reaches the joining service", async () => {
    // 10:30–11:15 IST = 05:00–05:45Z.
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:30", end: "11:15" }, ctx)) as Row;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("window_too_long");
    expect(out.requested_minutes).toBe(45);
    expect(out.limit_minutes).toBe(30);
    expect(joinCalls).toHaveLength(0);
    // Still not a dead end: the covering pieces come back with their own links.
    expect((out.covering_chunks as Row[]).map((c) => c.chunk_idx)).toEqual([0, 1, 2]);
  });

  it("transcribe refuses the same window the same way", async () => {
    const out = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:30", end: "11:15" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "window_too_long", limit_minutes: 30 });
    expect(joinCalls).toHaveLength(0);
  });

  it("the limit is exactly 30 minutes — 30 passes, 30 minutes and one second does not", () => {
    const t0 = Date.parse("2026-08-19T05:00:00Z");
    expect(refuseIfTooLong(t0, t0 + 30 * 60_000)).toBeNull();
    expect(refuseIfTooLong(t0, t0 + 30 * 60_000 + 1_000)).toMatchObject({ error: "window_too_long", limit_minutes: JOIN_MAX_MINUTES });
  });
});

// ---------------------------------------------------------------------------
// 4. Refused while a room is recording; allowed when none is.
// ---------------------------------------------------------------------------

describe("the recording guard (D15)", () => {
  it("refuses while any room is recording, names the room, and never reaches the joining service", async () => {
    recordingRows = [recordingNow()];
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:37" }, ctx)) as Row;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("room_recording");
    const rooms = out.recording_rooms as Row[];
    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({ room_slug: "cardiology-x1", session_id: "bs_live" });
    expect(String(out.hint)).toMatch(/try again/i);
    expect(joinCalls).toHaveLength(0);
    // The pieces are still offered.
    expect((out.covering_chunks as Row[]).map((c) => c.chunk_idx)).toEqual([0, 1]);
  });

  it("allows the join when nothing is recording", async () => {
    recordingRows = [];
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:37" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.joined).toBe(true);
    expect(joinCalls).toHaveLength(1);
  });

  it("transcribe is guarded by the same rule", async () => {
    recordingRows = [recordingNow()];
    const out = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:34", end: "10:37" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "room_recording" });
    expect(joinCalls).toHaveLength(0);
  });

  it("a session left 'recording' by a crashed tab with no live kiosk is not recording — the reaper's own stall rule decides", async () => {
    const now = Date.now();
    // Last piece 3 hours ago, no listener row at all: the browser died, the row lied.
    recordingRows = [{ ...recordingNow(now), last_any_chunk_at: new Date(now - 3 * 3_600_000).toISOString() }];
    listenerRows = [];
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:37" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(joinCalls).toHaveLength(1);
  });

  it("but a stalled session whose kiosk is still polling IS recording — between chunk rotations, not dead", () => {
    const now = new Date();
    const rows = [{ ...recordingNow(now.getTime()), last_any_chunk_at: new Date(now.getTime() - 3 * 3_600_000).toISOString() }];
    const listeners = new Map([["room_live", { room_id: "room_live", tab_id: "t1", last_poll_at: new Date(now.getTime() - 2_000).toISOString(), recording_session_id: "bs_live", paused: false }]]);
    expect(pickRecordingRooms(rows, listeners, now)).toHaveLength(1);
    expect(pickRecordingRooms(rows, new Map(), now)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. With the joining service unreachable, the answer is the multi-piece response.
// ---------------------------------------------------------------------------

describe("joining unavailable (D10)", () => {
  it("a dead service degrades to today's multi-piece answer — every covering piece with its own link, no error page", async () => {
    joinReply = () => { throw new Error("connect ECONNREFUSED"); };
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:41" }, ctx)) as Row;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("multi_chunk_not_supported_v1"); // byte-for-byte the pre-U2 reason
    expect(out.join_error).toBe("join_unreachable");
    const cov = out.covering_chunks as Row[];
    expect(cov.map((c) => c.chunk_idx)).toEqual([0, 1, 2]);
    expect(cov.every((c) => String(c.presigned_get).startsWith("https://r2.example/"))).toBe(true);
    expect(out.clip).toBeUndefined();
  });

  it("a service that refuses degrades the same way, carrying its named reason", async () => {
    joinReply = () => new Response(JSON.stringify({ ok: false, error: "join_already_running" }), { status: 200, headers: { "content-type": "application/json" } });
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:41" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "multi_chunk_not_supported_v1", join_error: "join_already_running" });
    expect((out.covering_chunks as Row[])).toHaveLength(3);
  });

  it("no joining service configured at all → the same multi-piece answer, named", async () => {
    delete process.env.AUDIO_JOIN_URL;
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:41" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "multi_chunk_not_supported_v1", join_error: "join_service_not_configured" });
    expect((out.covering_chunks as Row[])).toHaveLength(3);
  });

  it("transcribe degrades to the multi-piece answer too, never a 500", async () => {
    joinReply = () => { throw new Error("boom"); };
    const out = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:34", end: "10:41" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "multi_chunk_not_supported_v1", join_error: "join_unreachable" });
    expect(out.text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. The stored clip's key and recorded origin carry session, window, microphone and time.
// ---------------------------------------------------------------------------

describe("the kept clip (D3, D4)", () => {
  it("the key sits under the clips prefix and names session, window and microphone", () => {
    const start = Date.parse("2026-08-19T05:02:00Z");
    const end = Date.parse("2026-08-19T05:14:00Z");
    expect(clipKey("bs_xvntaugh", start, end, "primary")).toBe("clips/bs_xvntaugh/20260819T050200Z-20260819T051400Z-primary.webm");
    expect(clipKey("bs_xvntaugh", start, end, "backup")).toBe("clips/bs_xvntaugh/20260819T050200Z-20260819T051400Z-backup.webm");
    expect(clipKey("bs_a", start, end, "primary").startsWith(CLIPS_PREFIX)).toBe(true);
    // Deterministic: the same window twice is one object, not two.
    expect(clipKey("bs_a", start, end, "primary")).toBe(clipKey("bs_a", start, end, "primary"));
  });

  it("the recorded origin carries session, requested window, microphone and creation time", () => {
    const made = new Date("2026-08-20T09:15:00Z");
    const meta = clipMeta("bs_xvntaugh", Date.parse("2026-08-19T05:02:00Z"), Date.parse("2026-08-19T05:14:00Z"), "primary", made);
    expect(meta).toEqual({
      session_id: "bs_xvntaugh",
      requested_start: "2026-08-19T05:02:00.000Z",
      requested_end: "2026-08-19T05:14:00.000Z",
      source: "primary",
      created_at: "2026-08-20T09:15:00.000Z",
    });
  });

  it("the request actually sent carries the key and the origin, and the backup mic is named in both", async () => {
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:32", end: "10:44" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    const body = joinCalls[0]!.body;
    expect(body.out_key).toBe("clips/bs_a/20260819T050200Z-20260819T051400Z-primary.webm");
    expect(body.meta).toMatchObject({
      session_id: "bs_a",
      requested_start: "2026-08-19T05:02:00.000Z",
      requested_end: "2026-08-19T05:14:00.000Z",
      source: "primary",
    });
    expect(typeof (body.meta as Row).created_at).toBe("string");
    expect((out.clip as Row).r2_key).toBe(body.out_key);
  });
});
