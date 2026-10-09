/**
 * S6B — voice search v1, sql mocked: every statement's text and bound values are inspected. Transient: SELECT only, nothing stored, no vector in any answer.
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
const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const V = await import("@/lib/voice-search");
const S = await import("@/lib/mcp/surface");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;

/** a 192-float vector as base64 whose cosine with unit-x is exactly c */
const vec = (c: number, dim = 192): string => {
  const f = new Float32Array(dim);
  f[0] = c; f[1] = Math.sqrt(Math.max(0, 1 - c * c));
  return Buffer.from(f.buffer).toString("base64");
};
const PLACE_BLIND: [RegExp, Row[]] = [/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "q", room_id: BR, ist_date: BD, room_id2: null, ist_date2: null }]];
const PLACE_OK: [RegExp, Row[]] = [/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "q", room_id: "r1", ist_date: "2026-10-05", room_id2: null, ist_date2: null }]];
const PLACE_NONE: [RegExp, Row[]] = [/FROM bench_window w\s+LEFT JOIN room_day rd/, [{ id: "q", room_id: null, ist_date: null, room_id2: null, ist_date2: null }]];
const QVEC: [RegExp, Row[]] = [/jsonb_array_elements[\s\S]*LIMIT 1/, [{ b64: vec(1) }]];
const COUNTS = (n: number, blind = 0, unplaced = 0): Array<[RegExp, Row[]]> => [[/count\(\*\) FILTER \(WHERE NOT blind\)/, [{ n_candidates: n, n_blind: blind }]], [/rd\.id IS NULL AND s\.room_id/, [{ n: unplaced }]]];
const CANDS = (rows: Row[]): [RegExp, Row[]] => [/ORDER BY d\.window_id, sp->>'idx'/, rows];
const SCOPE = { rooms: ["r1"], from: "2026-10-01", to: "2026-10-07" };
const Q_WIN = { window_id: "q", speaker_idx: 0, ...SCOPE };
const vectorReads = () => statements.filter((s) => /ORDER BY d\.window_id, sp->>'idx'/.test(s.text));

beforeEach(() => { statements.length = 0; answers = []; });

describe("the query window passes the blind / unplaced rule first", () => {
  it("a held-out query window is blind_room_day, an unplaced or unknown one window_unplaced, and NO other read happens", async () => {
    answers = [PLACE_BLIND, QVEC, ...COUNTS(3), CANDS([])];
    expect(await V.voiceSearch(Q_WIN)).toEqual({ ok: false, error: "blind_room_day" });
    expect(statements).toHaveLength(1); // the placement read, nothing else
    statements.length = 0; answers = [PLACE_NONE, QVEC, ...COUNTS(3), CANDS([])];
    expect(await V.voiceSearch(Q_WIN)).toEqual({ ok: false, error: "window_unplaced" });
    expect(statements).toHaveLength(1);
    statements.length = 0; answers = [QVEC];
    expect(await V.voiceSearch(Q_WIN)).toEqual({ ok: false, error: "window_unplaced" });
    expect(statements).toHaveLength(1);
  });
});

describe("candidates and scope", () => {
  it("held-out pairs are excluded IN SQL and counted, unplaced windows counted, the vector query carries the exclusion and the scope", async () => {
    answers = [PLACE_OK, QVEC, ...COUNTS(2, 4, 3), CANDS([{ window_id: "wa", room_id: "r1", ist_date: "2026-10-02", idx: "0", b64: vec(0.9) }])];
    const r = await V.voiceSearch(Q_WIN) as Row;
    expect(r).toMatchObject({ ok: true, n_blind_excluded: 4, n_unplaced_excluded: 3, n_windows_in_scope: 2, label: "voice similarity, not identity" });
    const v = vectorReads()[0]!;
    expect(v.text).toMatch(/NOT \(EXISTS \(SELECT 1 FROM room_day r1, unnest\(\?::date\[\], \?::text\[\]\) AS b\(d, r\) WHERE r1\.id IN \(d\.room_day_id, w\.room_day_id\) AND b\.d = r1\.ist_date AND b\.r = r1\.room_id\) OR EXISTS \(SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2\.id = t\.room_day_id/); // Y1 + B2: bench, diarize AND the window's turn rows' own room-days // Y1: either placement
    expect(v.values).toContainEqual(BLIND_ROOM_DAYS.map(([d]) => d));
    expect(v.values).toContainEqual(BLIND_ROOM_DAYS.map(([, x]) => x));
    expect(v.values).toContainEqual(["r1"]);
    expect(v.values).toContain("2026-10-01");
    expect(v.values).toContain("2026-10-07");
  });
  it("more than 5000 candidate windows = search_too_wide with ZERO vector reads", async () => {
    answers = [PLACE_OK, QVEC, ...COUNTS(5001, 0, 0), CANDS([{ window_id: "wa", room_id: "r1", ist_date: "2026-10-02", idx: "0", b64: vec(0.9) }])];
    expect(await V.voiceSearch(Q_WIN)).toMatchObject({ ok: false, error: "search_too_wide", max_windows: 5000 });
    expect(vectorReads()).toEqual([]);
    statements.length = 0; answers = [PLACE_OK, QVEC, ...COUNTS(5000), CANDS([])];
    expect(await V.voiceSearch(Q_WIN)).toMatchObject({ ok: true });
  });
  it("scope validation: rooms 1-10 ids, real dates, from <= to, at most 14 days; refused before any read", async () => {
    for (const bad of [{ rooms: [] }, { rooms: Array.from({ length: 11 }, (_, i) => `r${i}`) }, { rooms: ["bad id!"] }, { rooms: "r1" }, { from: "2026-13-01" }, { from: "2026-10-08", to: "2026-10-07" }, { to: undefined }]) {
      const r = await V.voiceSearch({ ...Q_WIN, ...bad }) as Row;
      expect(r.ok).toBe(false);
      expect(["bad_rooms", "bad_dates"]).toContain(r.error);
    }
    expect(await V.voiceSearch({ ...Q_WIN, from: "2026-10-01", to: "2026-10-15" })).toMatchObject({ error: "scope_too_wide" }); // 15 days
    expect(await V.voiceSearch({ ...Q_WIN, from: "2026-10-01", to: "2026-10-14" })).not.toMatchObject({ error: "scope_too_wide" }); // 14 days
    expect(statements.filter((s) => /room_diarize_window/.test(s.text) && /ORDER BY d\.window_id/.test(s.text))).toEqual([]);
  });
  it("exactly one query: window + speaker together, or a clinician", async () => {
    expect(await V.voiceSearch({ ...SCOPE })).toMatchObject({ error: "one_query_required" });
    expect(await V.voiceSearch({ ...SCOPE, window_id: "q" })).toMatchObject({ error: "window_id_and_speaker_idx_required" });
    expect(await V.voiceSearch({ ...SCOPE, window_id: "q", speaker_idx: 0, clinician_id: "docA" })).toMatchObject({ error: "one_query_required" });
    expect(statements).toEqual([]);
  });
});

describe("ranking, floor, caps, dimensions", () => {
  const cands = (list: Array<[string, string, number | string]>): Row[] => list.map(([w, i, c]) => ({ window_id: w, room_id: "r1", ist_date: "2026-10-02", idx: i, b64: typeof c === "number" ? vec(c) : c }));
  it("sorted by cosine desc, 3 dp, the query's own speaker excluded, bad dims skipped and counted, the matched clinician attached", async () => {
    answers = [PLACE_OK, QVEC, ...COUNTS(3), CANDS(cands([["q", "0", 1], ["q", "1", 0.7], ["wa", "0", 0.91234], ["wb", "2", 0.8], ["wc", "0", vec(0.9, 100)], ["wd", "0", 0.55]])),
      [/JOIN room_diarize_window d ON d\.window_id = rts\.window_id AND d\.last_run_id/, [{ window_id: "wa", speaker_idx: 0, clinician_id: "docA" }]]];
    const r = await V.voiceSearch(Q_WIN) as { hits: Row[]; n_speakers_compared: number; n_bad_dim: number; n_windows_scanned: number; query: Row };
    expect(r.hits.map((h) => [h.window_id, h.speaker_idx, h.cosine, h.clinician_id])).toEqual([["wa", 0, 0.912, "docA"], ["wb", 2, 0.8, null], ["q", 1, 0.7, null]]);
    expect(r.hits[0]).toEqual({ window_id: "wa", room_id: "r1", ist_date: "2026-10-02", speaker_idx: 0, cosine: 0.912, clinician_id: "docA", clinician_ambiguous: false });
    expect(r).toMatchObject({ n_speakers_compared: 4, n_bad_dim: 1, n_windows_scanned: 5, query: { kind: "window_speaker" } });
  });
  it("S1: two different clinicians for one speaker = clinician_id null + clinician_ambiguous; the attribution SQL is tied to the window's current run", async () => {
    answers = [PLACE_OK, QVEC, ...COUNTS(2), CANDS(cands([["wa", "0", 0.9], ["wb", "0", 0.8]])),
      [/JOIN room_diarize_window d ON d\.window_id = rts\.window_id AND d\.last_run_id/, [{ window_id: "wa", speaker_idx: 0, clinician_id: "docB" }, { window_id: "wa", speaker_idx: 0, clinician_id: "docC" }, { window_id: "wb", speaker_idx: 0, clinician_id: "docA" }]]];
    const r = await V.voiceSearch(Q_WIN) as { hits: Row[] };
    expect(r.hits.map((h) => [h.window_id, h.clinician_id, h.clinician_ambiguous])).toEqual([["wa", null, true], ["wb", "docA", false]]);
    const m = statements.find((x) => /JOIN room_diarize_window d ON d\.window_id = rts\.window_id AND d\.last_run_id/.test(x.text))!;
    expect(m.text).toMatch(/JOIN room_diarize_window d ON d\.window_id = rts\.window_id AND d\.last_run_id = rts\.run_id/);
  });
  it("S2: a speakers_json entry whose idx is not a non-negative integer is skipped and counted in n_bad_dim, never returned as a hit", async () => {
    answers = [PLACE_OK, QVEC, ...COUNTS(1), CANDS(cands([["wa", "http://evil.example", 0.95], ["wa", "-1", 0.95], ["wa", "1.5", 0.95], ["wa", "NaN", 0.95], ["wa", "007", 0.95], ["wa", "2", 0.9]]))];
    const r = await V.voiceSearch(Q_WIN) as { hits: Row[]; n_bad_dim: number; n_speakers_compared: number };
    expect(r.hits.map((h) => h.speaker_idx)).toEqual([2]);
    expect(r).toMatchObject({ n_bad_dim: 5, n_speakers_compared: 1 });
  });
  it("min_cosine can be raised but never lowered below 0.50; top_k never above 50; defaults 0.65 and 20", async () => {
    expect(V.clampMinCosine(0.1)).toBe(0.5);
    expect(V.clampMinCosine(undefined)).toBe(0.65);
    expect(V.clampMinCosine(0.8)).toBe(0.8);
    expect(V.clampMinCosine(5)).toBe(1);
    expect(V.clampTopK(1000)).toBe(50);
    expect(V.clampTopK(undefined)).toBe(20);
    expect(V.clampTopK(0)).toBe(1);
    answers = [PLACE_OK, QVEC, ...COUNTS(1), CANDS(cands([["wa", "0", 0.55], ["wb", "0", 0.7]]))];
    const r = await V.voiceSearch({ ...Q_WIN, min_cosine: 0.01, top_k: 9999 }) as { hits: Row[]; min_cosine: number; top_k: number };
    expect(r.min_cosine).toBe(0.5);
    expect(r.top_k).toBe(50);
    expect(r.hits.map((h) => h.window_id)).toEqual(["wb", "wa"]); // 0.55 is above the 0.50 floor; the order is by cosine
    statements.length = 0; answers = [PLACE_OK, QVEC, ...COUNTS(1), CANDS(cands(Array.from({ length: 60 }, (_, i) => [`w${String(i).padStart(2, "0")}`, "0", 0.9] as [string, string, number])))];
    expect(((await V.voiceSearch(Q_WIN)) as { hits: Row[] }).hits).toHaveLength(20);
  });
  it("a clinician query uses the active centroid, no window guard; no voiceprint = no_voiceprint", async () => {
    answers = [[/FROM voice_print vp JOIN clinician c/, [{ b64: vec(1) }]], ...COUNTS(1), CANDS(cands([["wa", "0", 0.9]]))];
    const r = await V.voiceSearch({ ...SCOPE, clinician_id: "docA" }) as Row;
    expect(r).toMatchObject({ ok: true, query: { kind: "clinician" } });
    expect(statements.some((s) => /FROM bench_window w\s+LEFT JOIN room_day rd/.test(s.text))).toBe(false);
    statements.length = 0; answers = [];
    expect(await V.voiceSearch({ ...SCOPE, clinician_id: "docZ" })).toEqual({ ok: false, error: "no_voiceprint" });
  });
});

describe("transient and vector-free", () => {
  it("nothing is written (every statement is a SELECT) and no vector, base64, URL, audio key or text leaves in the answer", async () => {
    answers = [PLACE_OK, QVEC, ...COUNTS(1), CANDS([{ window_id: "wa", room_id: "r1", ist_date: "2026-10-02", idx: "0", b64: vec(0.95) }]), [/JOIN room_diarize_window d ON d\.window_id = rts\.window_id AND d\.last_run_id/, [{ window_id: "wa", speaker_idx: 0, clinician_id: "docA" }]]];
    const r = await V.voiceSearch(Q_WIN);
    for (const s of statements) { expect(s.text.trimStart()).toMatch(/^SELECT/); expect(s.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/); }
    const flat = (v: unknown, out: unknown[] = []): unknown[] => { out.push(v); if (Array.isArray(v)) v.forEach((x) => flat(x, out)); else if (v && typeof v === "object") Object.values(v as object).forEach((x) => flat(x, out)); return out; };
    for (const x of flat(r)) {
      if (Array.isArray(x) && x.length > 32 && x.every((n) => typeof n === "number")) throw new Error("a long numeric array left the server");
      if (typeof x === "string") { expect(x).not.toMatch(/^[A-Za-z0-9+/=]{100,}$/); expect(x).not.toMatch(/^https?:\/\//); }
    }
    expect(Object.keys(r).sort()).not.toContain("transcript");
    expect(JSON.stringify(r)).not.toMatch(/embedding|centroid|r2_key|audio/);
  });
  it("the tool: scribe_voice_console search is READ scope and passes its arguments through", async () => {
    const t = S.CALLABLE_TOOLS.get("scribe_voice_console")!;
    expect(t.scope).toBe("read");
    answers = [PLACE_BLIND];
    expect(await t.handler({ action: "search", ...Q_WIN }, { origin: "x", actor: "a", scopes: new Set(["read"]) } as never)).toEqual({ ok: false, error: "blind_room_day" });
  });
});
