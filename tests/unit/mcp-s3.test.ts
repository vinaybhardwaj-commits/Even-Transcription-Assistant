/**
 * Operator MCP S3 — writes + audio by clock time. Mocked `sql` and `fetch`; no live DB/brain.
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
vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => ({ ok: true, transcript: "hello from the chunk", language: "en", duration_seconds: 300, latency_ms: 10 }),
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

import { parseOperatorTime, resolveRange, fmtIstClock } from "@/lib/bench-range";
import { BRAIN_TOOLS } from "@/lib/mcp/tools/brain";
import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";

const tool = (name: string) => {
  const t = [...BRAIN_TOOLS, ...BENCH_TOOLS].find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t;
};
const ctx = { origin: "https://preview.example" };
const ROOM = { id: "room_t", slug: "opd-test-a7q9", name: "OPD Test", disabled_at: null };

let fetchCalls: Array<{ url: string; body: Row; auth: string | null }> = [];
function mockFetch(status = 200, json: Row = { ok: true, cue_id: "cue_1", cue_at: "2026-08-19T10:00:00.000Z", state: { visits: [] } }) {
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>)?.Authorization ?? null });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }));
}

beforeEach(() => {
  calls.length = 0;
  responder = (text) => (/FROM room/.test(text) ? [ROOM] : []);
  process.env.BRAIN_SERVICE_TOKEN = "tok";
  mockFetch();
});

// ---------------------------------------------------------------------------

describe("bench-range — IST clock ↔ UTC", () => {
  it("HH:MM on the session's IST date maps to UTC (−05:30)", () => {
    const p = parseOperatorTime("11:02", "2026-08-19")!;
    expect(new Date(p.ms).toISOString()).toBe("2026-08-19T05:32:00.000Z");
    expect(p.kind).toBe("clock");
    expect(parseOperatorTime("11:02:30", "2026-08-19")!.ms - p.ms).toBe(30_000);
    expect(fmtIstClock(p.ms)).toBe("11:02:00");
  });
  it("midnight edge: a session started after 18:30 UTC is the NEXT IST date; clocks anchor on the IST date, not the UTC folder date", () => {
    // 19:00 UTC on Aug 19 = 00:30 IST Aug 20 → IST day is 2026-08-20 though the R2 folder says 2026-08-19
    const p = parseOperatorTime("00:45", "2026-08-20")!;
    expect(new Date(p.ms).toISOString()).toBe("2026-08-19T19:15:00.000Z");
    // before 18:30 UTC the dates agree
    const q = parseOperatorTime("23:59", "2026-08-19")!;
    expect(new Date(q.ms).toISOString()).toBe("2026-08-19T18:29:00.000Z");
  });
  it("ISO / epoch pass through; garbage is null", () => {
    expect(parseOperatorTime("2026-08-19T05:32:00Z", "2026-08-19")!.kind).toBe("iso");
    expect(parseOperatorTime(1_700_000_000_000, "2026-08-19")!.ms).toBe(1_700_000_000_000);
    expect(parseOperatorTime("25:00", "2026-08-19")).toBeNull();
    expect(parseOperatorTime("nope", "2026-08-19")).toBeNull();
  });
});

const chunk = (idx: number, startIso: string, endIso: string, source: "primary" | "backup" = "primary") => ({
  id: `bc_${source}_${idx}`, idx, source, r2_key: `bench/x/2026-08-19/bs_a/${source === "backup" ? "backup_chunk" : "chunk"}_${String(idx).padStart(5, "0")}.webm`,
  content_type: "audio/webm", started_at: startIso, ended_at: endIso, upload_state: "verified", duration_ms: 300_000, size_bytes: 1, gap_before_ms: 0, created_at: endIso,
});
const CHUNKS = [
  chunk(0, "2026-08-19T05:00:00Z", "2026-08-19T05:05:00Z"),
  chunk(1, "2026-08-19T05:05:00Z", "2026-08-19T05:10:00Z"),
  chunk(2, "2026-08-19T05:10:00Z", "2026-08-19T05:15:00Z"),
  chunk(0, "2026-08-19T05:00:10Z", "2026-08-19T05:05:10Z", "backup"),
];

describe("bench-range — single vs multi chunk resolution", () => {
  const ms = (s: string) => Date.parse(s);
  it("a window inside one chunk → single with offset + duration", () => {
    const r = resolveRange(CHUNKS, ms("2026-08-19T05:06:00Z"), ms("2026-08-19T05:08:00Z"));
    expect(r.kind).toBe("single");
    if (r.kind !== "single") return;
    expect(r.covering.chunk.idx).toBe(1);
    expect(r.covering.offset_in_chunk_s).toBe(60);
    expect(r.covering.duration_s).toBe(120);
  });
  it("a window spanning chunks → multi listing each covering chunk in order", () => {
    const r = resolveRange(CHUNKS, ms("2026-08-19T05:04:00Z"), ms("2026-08-19T05:11:00Z"));
    expect(r.kind).toBe("multi");
    if (r.kind !== "multi") return;
    expect(r.covering.map((c) => c.chunk.idx)).toEqual([0, 1, 2]);
    expect(r.covering[0]!.offset_in_chunk_s).toBe(240);
    expect(r.covering[0]!.duration_s).toBe(60);
    expect(r.covering[2]!.duration_s).toBe(60);
  });
  it("no overlap → none; boundaries are half-open; source selects the stream", () => {
    expect(resolveRange(CHUNKS, ms("2026-08-19T06:00:00Z"), ms("2026-08-19T06:01:00Z")).kind).toBe("none");
    expect(resolveRange(CHUNKS, ms("2026-08-19T05:05:00Z"), ms("2026-08-19T05:06:00Z")).kind).toBe("single"); // starts exactly at chunk 1 start
    const b = resolveRange(CHUNKS, ms("2026-08-19T05:01:00Z"), ms("2026-08-19T05:02:00Z"), "backup");
    expect(b.kind).toBe("single");
    if (b.kind === "single") expect(b.covering.chunk.source).toBe("backup");
    expect(resolveRange(CHUNKS, ms("2026-08-19T05:02:00Z"), ms("2026-08-19T05:01:00Z")).kind).toBe("none"); // end before start
  });
});

// ---------------------------------------------------------------------------

describe("scribe_post_cue — client of the brain door, source forced", () => {
  it("POSTs same-origin /api/brain/cues with the server bearer and forces source into the payload", async () => {
    const out = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "test", payload: { x: 1, source: "kiosk" } }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.cue_id).toBe("cue_1");
    expect(String(out.state_summary).length).toBeLessThanOrEqual(80);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://preview.example/api/brain/cues");
    expect(fetchCalls[0]!.auth).toBe("Bearer tok");
    expect(fetchCalls[0]!.body).toMatchObject({ room_id: "room_t", type: "test", payload: { x: 1, source: "mcp" } }); // caller's "kiosk" overwritten
  });
  // The standalone Cloud Run brain is retired: there is no base-URL override env any more, so
  // every cue this tool posts goes at THIS app's origin. That is now an invariant, not a default.
  it("always posts same-origin; rejects a disallowed source; no cue SQL is ever issued", async () => {
    await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "t", source: "replay" }, ctx);
    expect(fetchCalls[0]!.url).toBe("https://preview.example/api/brain/cues");
    expect(fetchCalls[0]!.body.payload).toEqual({ source: "replay" });
    const bad = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "t", source: "kiosk" }, ctx)) as Row;
    expect(bad.error).toBe("source_not_allowed");
    expect(calls.some((c) => /INSERT INTO cue/i.test(c.text))).toBe(false);
  });

  // Fuse slice 3: `warehouse` used to be one of the three sources this tool would stamp. It is
  // gone, and this is the caller that changed with it. A warehouse cue needs a source_ref to
  // carry 0047's natural key, and this tool writes to the room's LIVE day — the two things a
  // warehouse cue must never be.
  it("no longer accepts source 'warehouse' — it is refused by name, and nothing is posted", async () => {
    const out = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "t", source: "warehouse" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "source_not_allowed" });
    expect(out.allowed).toEqual(["mcp", "replay"]);
    expect(fetchCalls).toHaveLength(0);
  });
  it("missing token → service_token_not_configured (no throw)", async () => {
    delete process.env.BRAIN_SERVICE_TOKEN;
    const out = (await tool("scribe_post_cue").handler({ room: "opd-test-a7q9", type: "t" }, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "service_token_not_configured" });
  });
});

describe("scribe_pin_visit — operator_pin cue, visit table untouched", () => {
  it("emits operator_pin with phase/visit_id/source and never issues visit SQL", async () => {
    const out = (await tool("scribe_pin_visit").handler({ room: "opd-test-a7q9", phase: "in_chair", visit_id: "vis_1" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.visit_table_touched).toBe(false);
    expect(fetchCalls[0]!.body).toMatchObject({ type: "operator_pin", payload: { phase: "in_chair", visit_id: "vis_1", source: "mcp" } });
    expect(calls.some((c) => /\bvisit\b/i.test(c.text) && /UPDATE|INSERT/i.test(c.text))).toBe(false);
  });
  it("rejects an unknown phase without calling the brain", async () => {
    const out = (await tool("scribe_pin_visit").handler({ room: "opd-test-a7q9", phase: "sleeping" }, ctx)) as Row;
    expect(out.error).toBe("invalid_phase");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("scribe_mark_consult — durable-first with / without an active session", () => {
  it("with an active session: INSERT bench_event 'failed' → cue → UPDATE 'sent'", async () => {
    responder = (text) => (/FROM room/.test(text) ? [ROOM] : /FROM bench_session/.test(text) ? [{ id: "bs_live", status: "recording", started_at: "2026-08-19T04:00:00Z" }] : []);
    const out = (await tool("scribe_mark_consult").handler({ room: "opd-test-a7q9", note: "second patient" }, ctx)) as Row;
    expect(out.event_row).toBe("inserted");
    expect(out.session_id).toBe("bs_live");
    const ins = calls.find((c) => /INSERT INTO bench_event/.test(c.text))!;
    expect(ins.text).toContain("'consult_mark'");
    expect(ins.text).toContain("'failed'");
    expect(JSON.parse(String(ins.values[3]))).toEqual({ source: "mcp", note: "second patient" });
    expect(calls.some((c) => /UPDATE bench_event SET brain_status = 'sent'/.test(c.text))).toBe(true);
    expect(fetchCalls[0]!.body).toMatchObject({ type: "consult_mark", payload: { source: "mcp", note: "second patient" } });
    expect((out.cue as Row).ok).toBe(true);
  });
  it("without an active session: the cue still lands, event_row = no_active_session, no bench_event row", async () => {
    const out = (await tool("scribe_mark_consult").handler({ room: "opd-test-a7q9" }, ctx)) as Row;
    expect(out.event_row).toBe("no_active_session");
    expect(out.event_id).toBeNull();
    expect((out.cue as Row).ok).toBe(true);
    expect(calls.some((c) => /INSERT INTO bench_event/.test(c.text))).toBe(false);
    expect(fetchCalls).toHaveLength(1);
  });
  it("brain down: row stays 'failed', ok still true because the durable row exists", async () => {
    responder = (text) => (/FROM room/.test(text) ? [ROOM] : /FROM bench_session/.test(text) ? [{ id: "bs_live", status: "recording", started_at: "2026-08-19T04:00:00Z" }] : []);
    mockFetch(503, { ok: false, error: "brain_unavailable" });
    const out = (await tool("scribe_mark_consult").handler({ room: "opd-test-a7q9" }, ctx)) as Row;
    expect(out.event_row).toBe("inserted");
    expect((out.cue as Row).ok).toBe(false);
    expect(out.ok).toBe(true);
    expect(calls.some((c) => /SET brain_status = 'sent'/.test(c.text))).toBe(false);
  });
});

// ---------------------------------------------------------------------------

const SESSION = { id: "bs_a", room_id: "room_t", label: null, mic_label: null, started_at: "2026-08-19T05:00:00Z", ended_at: null, status: "recording", notes: null, room_slug: "opd-test-a7q9", room_name: "OPD Test" };

describe("scribe_extract_audio / scribe_transcribe_range", () => {
  beforeEach(() => {
    responder = (text) => (/FROM room/.test(text) ? [ROOM] : /FROM bench_session s/.test(text) && /JOIN room r/.test(text) && !/COUNT/.test(text) ? [SESSION] : /FROM bench_chunk/.test(text) ? CHUNKS : []);
  });
  it("single covering chunk → one short presign + offsets (IST clock input)", async () => {
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:36", end: "10:38" }, ctx)) as Row; // 05:06–05:08Z
    expect(out.ok).toBe(true);
    expect(out.chunk_idx).toBe(1);
    expect(out.offset_in_chunk_s).toBe(60);
    expect(out.duration_s).toBe(120);
    expect(String(out.presigned_get)).toContain("chunk_00001.webm");
    expect(out.expires_in_seconds).toBe(900);
    expect((out.requested_range as Row).start_ist).toBe("10:36:00");
  });
  it("spanning window → multi_chunk_not_supported_v1 with every covering chunk presigned", async () => {
    const out = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:34", end: "10:41" }, ctx)) as Row;
    expect(out.ok).toBe(false);
    expect(out.error).toBe("multi_chunk_not_supported_v1");
    const cov = out.covering_chunks as Row[];
    expect(cov.map((c) => c.chunk_idx)).toEqual([0, 1, 2]);
    expect(cov.every((c) => String(c.presigned_get).startsWith("https://r2.example/"))).toBe(true);
  });
  it("source:'backup' selects the backup stream; out-of-range → no_audio_in_range", async () => {
    const b = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "10:31", end: "10:32", source: "backup" }, ctx)) as Row;
    expect(b.ok).toBe(true);
    expect(String(b.presigned_get)).toContain("backup_chunk_00000.webm");
    const none = (await tool("scribe_extract_audio").handler({ session_id: "bs_a", start: "12:00", end: "12:01" }, ctx)) as Row;
    expect(none.error).toBe("no_audio_in_range");
  });
  it("transcribe: whisper only; returns whole-chunk text + the honest note", async () => {
    const bad = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:36", end: "10:38", engine: "deepgram" }, ctx)) as Row;
    expect(bad.error).toBe("engine_not_supported_v1");
    const out = (await tool("scribe_transcribe_range").handler({ session_id: "bs_a", start: "10:36", end: "10:38" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.text).toBe("hello from the chunk");
    expect(out.chunk_idx).toBe(1);
    expect(String(out.note)).toMatch(/WHOLE chunk 1/);
  });
});

describe("scribe_list_commands — bus queue shape", () => {
  it("no args → newest-first rows with the documented fields", async () => {
    responder = (text) => (/FROM bench_command c/.test(text) ? [{ id: "cmd_1", room_id: "room_t", kind: "start_day", args: null, status: "acked", source: "mcp", result: { ok: true }, error: null, created_at: "2026-08-19T12:00:00Z", acked_at: "2026-08-19T12:00:02Z", room_slug: "opd-test-a7q9", room_name: "OPD Test" }] : []);
    const out = (await tool("scribe_list_commands").handler({}, ctx)) as Row;
    const rows = out.commands as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "cmd_1", room_slug: "opd-test-a7q9", kind: "start_day", status: "acked", source: "mcp", error: null, acked_at: "2026-08-19T12:00:02.000Z" });
    const q = calls.find((c) => /FROM bench_command c/.test(c.text))!;
    expect(q.text).toContain("ORDER BY c.created_at DESC");
    expect(q.values).toEqual([null, null, null, null, 50]);
  });
  it("bus not migrated → bus_not_migrated, never a throw", async () => {
    responder = (text) => {
      if (/FROM bench_command c/.test(text)) throw Object.assign(new Error('relation "bench_command" does not exist'), { code: "42P01" });
      return [];
    };
    const out = (await tool("scribe_list_commands").handler({}, ctx)) as Row;
    expect(out).toMatchObject({ ok: false, error: "bus_not_migrated", commands: [] });
  });
});
