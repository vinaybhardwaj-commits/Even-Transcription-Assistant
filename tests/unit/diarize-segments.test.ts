/**
 * diarize-segments.test.ts — the doctor-ID feed: speaker timings for an encounter, a room window or a
 * bench session, and NEVER text.
 *
 * The rows below are poisoned on purpose: every text-bearing or identity-bearing field the two stores
 * can hold (a segment `text`, a speaker `label`/`type`/`name`, the service guess, an embedding) carries
 * a marker string, and the payload must contain none of them — by key or by value. All values are
 * synthetic.
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db: { calls: Array<{ q: string; vals: unknown[] }>; rows: unknown[]; fail: boolean } = { calls: [], rows: [], fail: false };
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => {
    db.calls.push({ q: strings.join("?"), vals });
    return db.fail ? Promise.reject(new Error("db down")) : Promise.resolve(db.rows);
  },
}));

import {
  DIARIZE_SOURCE_DEFAULT,
  encounterPayload,
  lookupSegments,
  pickQuery,
  shapeSegments,
  shapeSpeakers,
  sourceOf,
  windowPayload,
  type EncounterRow,
  type WindowRow,
} from "@/lib/diarize-segments";
import { GET } from "@/app/api/diarize-segments/route";

const MARK = "POISON_TEXT_MARKER";
const EMB = "RU1CRURESU5HX01BUktFUg==";

const poisonedSpeakers = [
  { idx: 1, label: `Dr ${MARK}`, type: "clinician", name: MARK, total_speech_sec: 12.5, clinician_id: "doc_fake0001", confidence: 0.81, embedding_base64: EMB, source: "voiceprint" },
  { idx: 0, label: `Patient ${MARK}`, type: "patient", total_speech_sec: 3.25, embedding_base64: EMB, unverified_service_guess: { label: MARK, type: "patient" } },
  { idx: 0, label: "duplicate idx is dropped" },
  { label: "no idx is dropped" },
  "not an object",
];
const poisonedSegments = [
  { start_ms: 4000, end_ms: 6500, speaker_idx: 1, overlap: false, text: MARK, transcript: MARK, words: [{ w: MARK }] },
  { start_ms: 0, end_ms: 3900, speaker_idx: 0, overlap: true, text: MARK, speaker_name: MARK },
  { start_ms: 7000, end_ms: 7000, speaker_idx: 0 },   // zero length
  { start_ms: 8000, end_ms: 9000, speaker_idx: -1 },  // bad idx
  { start_ms: "x", end_ms: 9000, speaker_idx: 0 },    // unreadable
  null,
];

const encRow = (over: Partial<EncounterRow> = {}): EncounterRow => ({
  id: "enc_test1",
  doctor_id: "doc_fake0001",
  recorded_at: "2026-06-01T11:36:37.948Z",
  duration_seconds: 171,
  diarize_status: "complete",
  diarize_completed_at: new Date("2026-08-23T04:50:56.652Z"),
  speakers: poisonedSpeakers,
  transcript_segments: poisonedSegments,
  diarize_timing: { wall_ms: 2600, note: MARK },
  ...over,
});

const winRow = (over: Partial<WindowRow> = {}): WindowRow => ({
  window_id: "bw_test_1789999200000",
  session_id: "bs_test",
  room_day_id: "rd_test",
  source_mic: "primary",
  state: "ok",
  diarized_at: "2026-09-21T14:00:00Z",
  start_ms: "1789999200000",
  end_ms: "1790000100000",
  segments_run_id: "run_2",
  last_run_id: "run_2",
  speakers_json: poisonedSpeakers,
  segments_json: poisonedSegments,
  timing_json: { provider: "eta-diarize" },
  ...over,
});

/** Every key anywhere in a JSON value. */
function allKeys(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

const FORBIDDEN_KEYS = [
  "text", "transcript", "words", "label", "type", "name", "speaker_name", "embedding_base64",
  "unverified_service_guess", "note", "tagged_transcript", "transcript_segments", "speakers_json", "segments_json",
];

function assertNoText(payload: unknown) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain(MARK);
  expect(json).not.toContain(EMB);
  const keys = allKeys(payload);
  for (const k of FORBIDDEN_KEYS) expect(keys.has(k), `payload carries a "${k}" field`).toBe(false);
}

beforeEach(() => {
  db.calls.length = 0;
  db.rows = [];
  db.fail = false;
});

describe("no text, ever", () => {
  it("an encounter payload carries no text, label, name or embedding", () => {
    assertNoText(encounterPayload(encRow()));
  });

  it("a window payload carries no text, label, name or embedding", () => {
    assertNoText(windowPayload(winRow()));
  });

  it("the route's JSON carries none of them either", async () => {
    process.env.SCRIBE_MCP_TOKEN = "tok-read";
    db.rows = [encRow()];
    const res = await GET(req("encounter_id=enc_test1", "tok-read"));
    expect(res.status).toBe(200);
    assertNoText(await res.json());
  });

  it("no SELECT names a transcript or note column", async () => {
    db.rows = [encRow()];
    await lookupSegments({ encounter_id: "enc_test1" });
    db.rows = [winRow()];
    await lookupSegments({ window_id: "bw_x" });
    await lookupSegments({ session_id: "bs_x" });
    for (const c of db.calls) {
      expect(c.q).toMatch(/^\s*SELECT/);
      expect(c.q).not.toMatch(/transcript_(raw|clean|original|english)|tagged_transcript|note_json|cdmss|native_analysis/);
    }
  });
});

describe("shaping", () => {
  it("speakers: neutral labels, sorted, deduplicated; match id + confidence only where matched", () => {
    expect(shapeSpeakers(poisonedSpeakers)).toEqual([
      { speaker_idx: 0, speaker_label: "S0", total_speech_ms: 3250 },
      { speaker_idx: 1, speaker_label: "S1", matched_clinician_id: "doc_fake0001", confidence: 0.81, total_speech_ms: 12500 },
    ]);
  });

  it("segments: valid spans only, sorted by start, overlap kept, confidence from a matched speaker", () => {
    const sp = shapeSpeakers(poisonedSpeakers);
    expect(shapeSegments(poisonedSegments, sp, "eta-diarize")).toEqual([
      { start_ms: 0, end_ms: 3900, speaker_idx: 0, speaker_label: "S0", source: "eta-diarize", overlap: true },
      { start_ms: 4000, end_ms: 6500, speaker_idx: 1, speaker_label: "S1", source: "eta-diarize", overlap: false, confidence: 0.81 },
    ]);
  });

  it("non-arrays shape to empty", () => {
    expect(shapeSpeakers(null)).toEqual([]);
    expect(shapeSegments({ a: 1 }, [], "x")).toEqual([]);
  });

  it("source: a stored provider string wins, otherwise the Mini service", () => {
    expect(sourceOf({ provider: "pyannote-ai" })).toBe("pyannote-ai");
    expect(sourceOf({ provider: "<script>" })).toBe(DIARIZE_SOURCE_DEFAULT);
    expect(sourceOf(null)).toBe(DIARIZE_SOURCE_DEFAULT);
  });

  it("an encounter is recording-relative and keeps its ids", () => {
    const p = encounterPayload(encRow());
    expect(p).toMatchObject({
      kind: "encounter", encounter_id: "enc_test1", doctor_id: "doc_fake0001", clock: "recording_relative",
      duration_seconds: 171, diarized_at: "2026-08-23T04:50:56.652Z", source: DIARIZE_SOURCE_DEFAULT,
    });
    expect(p.segments).toHaveLength(2);
  });

  it("a window is clip-relative with the wall-clock origin from bench_window.start_ms", () => {
    const p = windowPayload(winRow());
    expect(p).toMatchObject({ kind: "window", clock: "clip_relative", origin_ms: 1789999200000, segments_stale: false, source: "eta-diarize" });
  });

  it("a window whose segments came from an older run, or from no recorded run, is stale", () => {
    expect(windowPayload(winRow({ segments_run_id: "run_1", last_run_id: "run_2" })).segments_stale).toBe(true);
    expect(windowPayload(winRow({ segments_run_id: null })).segments_stale).toBe(true);
  });
});

describe("the query", () => {
  it("needs exactly one id", () => {
    expect(pickQuery({})).toMatchObject({ ok: false, error: "one_id_required" });
    expect(pickQuery({ encounter_id: "enc_1", window_id: "bw_1" })).toMatchObject({ ok: false, error: "one_id_required" });
    expect(pickQuery({ encounter_id: "  " })).toMatchObject({ ok: false, error: "one_id_required" });
  });

  it("refuses an id that is not an id", () => {
    expect(pickQuery({ window_id: "bw_1'; DROP TABLE x" })).toMatchObject({ ok: false, error: "bad_id" });
  });

  it("clamps the session limit", () => {
    expect(pickQuery({ session_id: "bs_1", limit: 9999 })).toMatchObject({ ok: true, limit: 500 });
    expect(pickQuery({ session_id: "bs_1", limit: 0 })).toMatchObject({ ok: true, limit: 1 });
    expect(pickQuery({ session_id: "bs_1" })).toMatchObject({ ok: true, limit: 100 });
  });

  it("a session reads one extra row to report truncation honestly", async () => {
    db.rows = [winRow({ window_id: "bw_a" }), winRow({ window_id: "bw_b" }), winRow({ window_id: "bw_c" })];
    const r = await lookupSegments({ session_id: "bs_test", limit: 2 });
    expect(db.calls[0]!.vals).toContain(3);
    expect(r).toMatchObject({ ok: true, payload: { kind: "session", truncated: true } });
    if (r.ok && r.payload.kind === "session") expect(r.payload.windows.map((w) => w.window_id)).toEqual(["bw_a", "bw_b"]);
  });

  it("nothing found is a 404, not an empty success", async () => {
    expect(await lookupSegments({ encounter_id: "enc_none" })).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(await lookupSegments({ session_id: "bs_none" })).toEqual({ ok: false, status: 404, error: "not_found" });
  });
});

function req(qs: string, token?: string): NextRequest {
  return new NextRequest(`https://evenscribe.test/api/diarize-segments?${qs}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("the route: MCP bearer, read scope", () => {
  const saved = { one: process.env.SCRIBE_MCP_TOKEN, map: process.env.SCRIBE_MCP_TOKENS };
  afterEach(() => {
    process.env.SCRIBE_MCP_TOKEN = saved.one;
    process.env.SCRIBE_MCP_TOKENS = saved.map;
    if (saved.one === undefined) delete process.env.SCRIBE_MCP_TOKEN;
    if (saved.map === undefined) delete process.env.SCRIBE_MCP_TOKENS;
  });

  it("no token configured → 503, and nothing is read", async () => {
    delete process.env.SCRIBE_MCP_TOKEN;
    delete process.env.SCRIBE_MCP_TOKENS;
    expect((await GET(req("encounter_id=enc_1", "x"))).status).toBe(503);
    expect(db.calls).toHaveLength(0);
  });

  it("missing or wrong token → 401, and nothing is read", async () => {
    process.env.SCRIBE_MCP_TOKEN = "tok-read";
    expect((await GET(req("encounter_id=enc_1"))).status).toBe(401);
    expect((await GET(req("encounter_id=enc_1", "wrong"))).status).toBe(401);
    expect(db.calls).toHaveLength(0);
  });

  it("a token without read → 403, and nothing is read", async () => {
    const hash = createHash("sha256").update("tok-invoke").digest("hex");
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [hash]: { actor: "invoker", scopes: ["invoke"] } });
    const res = await GET(req("encounter_id=enc_1", "tok-invoke"));
    expect(res.status).toBe(403);
    expect(db.calls).toHaveLength(0);
  });

  it("two ids → 400; unknown → 404; a DB failure → 500 without detail", async () => {
    process.env.SCRIBE_MCP_TOKEN = "tok-read";
    expect((await GET(req("encounter_id=enc_1&window_id=bw_1", "tok-read"))).status).toBe(400);
    expect((await GET(req("window_id=bw_none", "tok-read"))).status).toBe(404);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.fail = true;
    const res = await GET(req("session_id=bs_1", "tok-read"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "read_failed" });
    spy.mockRestore();
  });

  it("responses are never cached", async () => {
    process.env.SCRIBE_MCP_TOKEN = "tok-read";
    db.rows = [winRow()];
    const res = await GET(req("window_id=bw_test_1789999200000", "tok-read"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
