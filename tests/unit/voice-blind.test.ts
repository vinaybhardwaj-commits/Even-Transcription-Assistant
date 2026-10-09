/**
 * S6-BLIND — the held-out room-day rule on the voice / diarize READ tools. sql, the brain state and R2 are FAKES: every query's text is spied, so each guard is proved by what was NOT read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answers: Array<[RegExp, Row[]]> = [];
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    for (const [re, rows] of answers) if (re.test(text)) return rows;
    return [];
  },
}));
const brain = { roomExists: vi.fn(async () => true), findRoomDay: vi.fn(async () => ({ id: "rd_x" })), readClustersForDay: vi.fn(() => ({ clustering: { running: false }, clusters: [] })) };
vi.mock("@/lib/brain/state", async (orig) => ({ ...((await orig()) as object), roomExists: brain.roomExists, findRoomDay: brain.findRoomDay, readClustersForDay: brain.readClustersForDay }));
vi.mock("@/lib/mcp/tools/brain", async (orig) => ({ ...((await orig()) as object), resolveRoom: async (a: Row) => ({ id: String(a.room_id ?? "r1"), slug: "r1", name: "r1", disabled_at: null }) }));
const signed: string[] = [];
vi.mock("@/lib/r2", async (orig) => ({ ...((await orig()) as object), signGetUrl: async (a: { key: string }) => { signed.push(a.key); return `https://signed.example.test/${a.key}`; } }));
vi.mock("@/lib/voice-samples", async (orig) => ({ ...((await orig()) as object), listSamples: async () => samples }));
let samples: Row[] = [];

const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const S = await import("@/lib/mcp/surface");
const D = await import("@/lib/diarize-segments");
const V = await import("@/lib/voice-blind");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;
const call = async (name: string, args: Row) => (await S.CALLABLE_TOOLS.get(name)!.handler(args, { origin: "https://x", actor: "mcp:t", scopes: new Set(["read"]) } as never)) as Row;
const reads = (re: RegExp) => statements.filter((s) => re.test(s.text));
/** the placement answer for a window / room-day */
const PLACE_BLIND = [/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "w1", room_id: BR, ist_date: BD, room_id2: null, ist_date2: null }]] as [RegExp, Row[]];
const PLACE_OK = [/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "w1", room_id: "r1", ist_date: "2026-10-05", room_id2: null, ist_date2: null }]] as [RegExp, Row[]];
const PLACE_NONE = [/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "w1", room_id: null, ist_date: null, room_id2: null, ist_date2: null }]] as [RegExp, Row[]];

beforeEach(() => { statements.length = 0; answers = []; signed.length = 0; samples = []; brain.findRoomDay.mockClear(); brain.roomExists.mockClear(); });

describe("scribe_window_speakers", () => {
  it("a window on a held-out room-day is refused blind_room_day with ZERO room_turn_speaker reads; an unplaced and an unknown window are window_unplaced; an ordinary window is read", async () => {
    answers = [PLACE_BLIND];
    expect(await call("scribe_window_speakers", { window_id: "w1" })).toMatchObject({ error: "blind_room_day", spans: [] });
    expect(reads(/FROM room_turn_speaker/)).toEqual([]);
    statements.length = 0; answers = [PLACE_NONE];
    expect(await call("scribe_window_speakers", { window_id: "w1" })).toMatchObject({ error: "window_unplaced" });
    expect(reads(/FROM room_turn_speaker/)).toEqual([]);
    statements.length = 0; answers = []; // unknown window: no bench_window row
    expect(await call("scribe_window_speakers", { window_id: "w_nope" })).toMatchObject({ error: "window_unplaced" });
    expect(reads(/FROM room_turn_speaker/)).toEqual([]);
    statements.length = 0; answers = [PLACE_OK, [/FROM room_turn_speaker/, [{ window_id: "w1", source_ref: "t1", speaker_idx: 0, role: "clinician", clinician_id: "docA" }]]];
    expect(await call("scribe_window_speakers", { window_id: "w1" })).toMatchObject({ summary: { turns: 1 } });
    expect(reads(/FROM room_turn_speaker/)).toHaveLength(1);
  });
  it("room_day_id: held out = blind_room_day, no room-day = window_unplaced, both with zero turn reads; with both ids either one can refuse", async () => {
    answers = [[/FROM room_day WHERE id/, [{ room_id: BR, ist_date: BD }]]];
    expect(await call("scribe_window_speakers", { room_day_id: "rd_b" })).toMatchObject({ error: "blind_room_day" });
    statements.length = 0; answers = [];
    expect(await call("scribe_window_speakers", { room_day_id: "rd_none" })).toMatchObject({ error: "window_unplaced" });
    expect(reads(/FROM room_turn_speaker/)).toEqual([]);
    statements.length = 0; answers = [PLACE_OK, [/FROM room_day WHERE id/, [{ room_id: BR, ist_date: BD }]]];
    expect(await call("scribe_window_speakers", { window_id: "w1", room_day_id: "rd_b" })).toMatchObject({ error: "blind_room_day" });
    expect(reads(/FROM room_turn_speaker/)).toEqual([]);
  });
  it("a window whose bench_window and diarize-window room-days differ is refused if EITHER is held out", async () => {
    answers = [[/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "w1", room_id: "r1", ist_date: "2026-10-05", room_id2: BR, ist_date2: BD }]]];
    expect(await call("scribe_window_speakers", { window_id: "w1" })).toMatchObject({ error: "blind_room_day" });
  });
});

describe("scribe_diarize_segments (the MCP read; the HTTP route is unchanged)", () => {
  it("window: held out = 403 blind_room_day, unplaced = window_unplaced, zero segment reads; unknown stays not_found; the unguarded call (the route) never asks for a placement", async () => {
    answers = [PLACE_BLIND];
    expect(await D.lookupSegments({ window_id: "w1" }, { blindGuard: true })).toEqual({ ok: false, status: 403, error: "blind_room_day" });
    expect(reads(/FROM room_diarize_window d/)).toEqual([]);
    statements.length = 0; answers = [PLACE_NONE];
    expect(await D.lookupSegments({ window_id: "w1" }, { blindGuard: true })).toEqual({ ok: false, status: 403, error: "window_unplaced" });
    expect(reads(/FROM room_diarize_window d/)).toEqual([]);
    statements.length = 0; answers = [];
    expect(await D.lookupSegments({ window_id: "w_nope" }, { blindGuard: true })).toMatchObject({ ok: false, status: 404, error: "not_found" });
    statements.length = 0; answers = [PLACE_BLIND];
    await D.lookupSegments({ window_id: "w1" }); // no guard: the route's behaviour
    expect(reads(/LEFT JOIN room_day rd/)).toEqual([]);
    expect(reads(/FROM room_diarize_window d/)).toHaveLength(1);
    // through the tool
    statements.length = 0; answers = [PLACE_BLIND];
    expect(await call("scribe_diarize_segments", { window_id: "w1" })).toEqual({ segments: null, error: "blind_room_day" });
    expect(reads(/FROM room_diarize_window d/)).toEqual([]);
  });
  it("session: held-out and unplaced windows are left out IN SQL before the LIMIT, counted apart; an all-excluded session answers with counts, not 404", async () => {
    answers = [[/NOT EXISTS/, [{ window_id: "wa", session_id: "s1", room_day_id: "rd_ok", source_mic: "primary", state: "ok", diarized_at: "2026-10-05T00:00:00Z", start_ms: 0, end_ms: 1000, speakers_json: [], segments_json: [], timing_json: {} }]], [/count\(\*\) FILTER/, [{ unplaced: 2, blind: 3 }]]];
    const r = await D.lookupSegments({ session_id: "s1" }, { blindGuard: true });
    expect(r).toMatchObject({ ok: true, payload: { kind: "session", n_blind_excluded: 3, n_unplaced_excluded: 2 } });
    const q = statements.find((s) => /NOT EXISTS/.test(s.text))!;
    expect(q.text.indexOf("NOT EXISTS")).toBeLessThan(q.text.indexOf("LIMIT"));
    expect(q.text).toMatch(/JOIN room_day rd ON rd\.id = COALESCE\(d\.room_day_id, w\.room_day_id\)/);
    expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([d]) => d));
    expect(q.values).toContainEqual(BLIND_ROOM_DAYS.map(([, x]) => x));
    statements.length = 0; answers = [[/count\(\*\) FILTER/, [{ unplaced: 0, blind: 4 }]]];
    expect(await D.lookupSegments({ session_id: "s1" }, { blindGuard: true })).toMatchObject({ ok: true, payload: { windows: [], n_blind_excluded: 4 } });
    statements.length = 0; answers = [];
    expect(await D.lookupSegments({ session_id: "s_nope" }, { blindGuard: true })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("scribe_get_clusters", () => {
  it("a held-out room + date is refused blind_room_day BEFORE any room-day lookup; another day is not", async () => {
    expect(await call("scribe_get_clusters", { room_id: BR, ist_date: BD })).toMatchObject({ error: "blind_room_day", clusters: [] });
    expect(brain.roomExists).not.toHaveBeenCalled();
    expect(brain.findRoomDay).not.toHaveBeenCalled();
    expect(await call("scribe_get_clusters", { room_id: "r1", ist_date: "2026-10-05" })).toMatchObject({ clusters: [] });
    expect(brain.findRoomDay).toHaveBeenCalled();
  });
});

describe("scribe_list_voice_samples include_urls", () => {
  const S1 = (id: string, src: string | null, key: string | null): Row => ({ id, created_at: "2026-10-01T00:00:00Z", source: "passive", duration_ms: 1000, content_type: "audio/webm", included: true, has_audio: !!key, source_encounter_id: src, session_id: null, sample_index: 0, match_confidence: 0.8, audio_r2_key: key });
  it("no presigned URL (and no R2 sign call) for a sample whose source is a held-out or unplaced WINDOW or whose key is room audio; encounter-keyed samples are left as is", async () => {
    samples = [S1("s_blind", "w_blind", "voice-samples/a.webm"), S1("s_none", "w_none", "voice-samples/b.webm"), S1("s_ok", "w_ok", "voice-samples/c.webm"), S1("s_enc", "enc_1", "voice-samples/d.webm"), S1("s_room", null, "bench/r1/2026-10-05/s/chunk_00001.webm")];
    answers = [[/FROM bench_window w\s+LEFT JOIN room_day rd[\s\S]*ANY/, [
      { id: "w_blind", room_id: BR, ist_date: BD, room_id2: null, ist_date2: null },
      { id: "w_none", room_id: null, ist_date: null, room_id2: null, ist_date2: null },
      { id: "w_ok", room_id: "r1", ist_date: "2026-10-05", room_id2: null, ist_date2: null }]]];
    const out = await call("scribe_list_voice_samples", { clinician_id: "docA", include_urls: true }) as { samples: Row[] };
    const by = Object.fromEntries(out.samples.map((x) => [String(x.id), x]));
    expect(by.s_blind).toMatchObject({ url_withheld: "blind_room_day" });
    expect(by.s_blind!.presigned_get).toBeUndefined();
    expect(by.s_none).toMatchObject({ url_withheld: "blind_room_day" });
    expect(by.s_room).toMatchObject({ url_withheld: "blind_room_day" });
    expect(by.s_ok).toMatchObject({ presigned_get: expect.stringContaining("voice-samples/c.webm") });
    expect(by.s_enc).toMatchObject({ presigned_get: expect.stringContaining("voice-samples/d.webm") });
    expect(signed.sort()).toEqual(["voice-samples/c.webm", "voice-samples/d.webm"]);
  });
  it("without include_urls nothing is looked up or signed", async () => {
    samples = [S1("s1", "w_blind", "voice-samples/a.webm")];
    await call("scribe_list_voice_samples", { clinician_id: "docA" });
    expect(statements).toEqual([]);
    expect(signed).toEqual([]);
  });
});

describe("the pure rule", () => {
  it("refusalForPairs: none resolved = window_unplaced, any held out = blind_room_day, otherwise null; the blind answer never names a pair", () => {
    expect(V.refusalForPairs([])).toBe("window_unplaced");
    expect(V.refusalForPairs([null, null])).toBe("window_unplaced");
    expect(V.refusalForPairs([{ room_id: "r1", ist_date: "2026-10-05" }, null])).toBeNull();
    expect(V.refusalForPairs([{ room_id: "r1", ist_date: "2026-10-05" }, { room_id: BR, ist_date: BD }])).toBe("blind_room_day");
    expect(JSON.stringify(V.refusalForPairs([{ room_id: BR, ist_date: BD }]))).not.toContain(BR);
  });
});
