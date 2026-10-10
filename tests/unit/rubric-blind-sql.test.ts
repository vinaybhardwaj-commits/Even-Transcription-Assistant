/**
 * S8A6 (GATING G62, G64, G65, G66) — the held-out set (LIFTED by V 10 Oct 2026, now EMPTY: formerly blind pairs are served and written like any day; the NULL-pair rule stays) at the reads and writes of the rubric store, with sql and the lab store MOCKED (no docker, so these run under ETA_ALLOW_SKIP_E2E=1 too).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    return Promise.resolve(answer(text, values));
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
const gets: string[] = [], puts: string[] = [];
const mem = new Map<string, string>();

const L = await import("@/lib/sarvam-lab");
const S = await import("@/lib/mcp/surface");
const Store = await import("@/lib/rubrics/store");
const { BLIND_ROOM_DAYS, BlindRoomDayError } = await import("@/lib/rubrics/blind-room-days");
const { listConsultKeys } = await import("@/lib/rubrics/readers/consult-span");
const { listAudioHours, AUDIO_ROWS_MAX } = await import("@/lib/rubrics/readers/audio-state");

const { FORMER_BLIND_PAIRS } = await import("../support/former-blind-pairs");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const run = async (args: Row) => (await S.CALLABLE_TOOLS.get("scribe_rubric")!.handler(args, { origin: "https://x", actor: "mcp:t", scopes: new Set(["read"]) } as never)) as Row;

beforeEach(() => {
  statements.length = 0; gets.length = 0; puts.length = 0; mem.clear(); answer = () => [];
  L.setLabStoreForTests({ get: async (k) => { gets.push(k); return mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null; }, put: async (k, b) => { puts.push(k); mem.set(k, b); return "ok"; }, list: async () => [] });
});

describe("G62 — the results read serves the formerly held-out pairs (set lifted)", () => {
  it("a (room, date) filter that names a formerly blind pair is served (queried), like a neighbour day", async () => {
    expect(BLIND_ROOM_DAYS).toHaveLength(0);
    expect(await run({ action: "results", rooms: [BR], from: BD, to: BD })).toMatchObject({ ok: true });
    expect(await run({ action: "results", rooms: [BR], from: BD })).toMatchObject({ ok: true });
    expect(await run({ action: "results", rooms: [BR], to: BD })).toMatchObject({ ok: true });
    expect(statements.some((s) => /FROM rubric_result/.test(s.text))).toBe(true);
    expect(await run({ action: "results", rooms: [BR], from: "2026-10-01", to: "2026-10-01" })).toMatchObject({ ok: true, count: 0 });
    expect(await run({ action: "results", rooms: ["r1"], from: BD, to: BD })).toMatchObject({ ok: true }); // another room on that date
  });
  it("listResults keeps its NOT EXISTS exclusion in the query but passes EMPTY pair arrays, so the former 14 pairs are not excluded", async () => {
    await Store.listResults({ limit: 10 });
    const q = statements.find((s) => /FROM rubric_result/.test(s.text))!;
    expect(q.text).toMatch(/NOT EXISTS[\s\S]*unnest[\s\S]*b\.d = rubric_result\.ist_date AND b\.r = rubric_result\.room_id[\s\S]*unit_kind = 'room_hour'[\s\S]*split_part[\s\S]*ORDER BY[\s\S]*LIMIT/);
    expect(q.values).toContainEqual([]);
    for (const [d, r] of FORMER_BLIND_PAIRS) expect(q.values.some((v) => Array.isArray(v) && ((v as unknown[]).includes(d) || (v as unknown[]).includes(r)))).toBe(false);
  });
  it("readEvidence fetches a formerly blind pair and a formerly blind room-hour key like any other key", async () => {
    mem.set("rubric/talk_time/0.1.0/w1.json", "{\"ok\":1}");
    mem.set(`rubric/room_mic_quality/0.1.0/${BR}:${BD}:10.json`, "{\"secret\":1}");
    expect(await Store.readEvidence("rubric/talk_time/0.1.0/w1.json", { room_id: BR, ist_date: BD })).toEqual({ ok: 1 });
    expect(await Store.readEvidence(`rubric/room_mic_quality/0.1.0/${BR}:${BD}:10.json`)).toEqual({ secret: 1 });
    expect(gets).toHaveLength(2);
    gets.length = 0;
    expect(await Store.readEvidence("rubric/talk_time/0.1.0/w1.json", { room_id: "r1", ist_date: "2026-10-01" })).toEqual({ ok: 1 });
    expect(gets).toEqual(["rubric/talk_time/0.1.0/w1.json"]);
  });
  it("our G65 — rows whose room or date is NULL are excluded in SQL and never fetched: the listing says IS NOT NULL, and readEvidence with an incomplete pair throws before the store", async () => {
    await Store.listResults({ limit: 10 });
    const q = statements.find((s) => /FROM rubric_result/.test(s.text))!;
    expect(q.text).toMatch(/room_id IS NOT NULL AND ist_date IS NOT NULL/);
    mem.set("rubric/talk_time/0.1.0/wn.json", "{\"secret\":1}");
    for (const pair of [{ room_id: null, ist_date: "2026-10-01" }, { room_id: BR, ist_date: null }, { room_id: null, ist_date: null }, { room_id: "", ist_date: "2026-10-01" }]) {
      await expect(Store.readEvidence("rubric/talk_time/0.1.0/wn.json", pair)).rejects.toBeInstanceOf(BlindRoomDayError);
    }
    expect(gets).toEqual([]);
    // through the tool: a planted NULL row (the fake answers as if the SQL filter were absent) gets evidence:null and no fetch
    answer = (t) => (/FROM rubric_result/.test(t) ? [{ rubric_id: "talk_time", unit_key: "wn", room_id: null, ist_date: null, status: "ok", score: { evidence_key: "rubric/talk_time/0.1.0/wn.json" }, findings: [] }] : []);
    const r = await run({ action: "results", include_text: true });
    expect((r.results as Row[])[0]).toMatchObject({ evidence: null });
    expect(gets).toEqual([]);
  });
  it("include_text on a formerly blind row serves its evidence like any other row (the store is fetched)", async () => {
    mem.set("rubric/talk_time/0.1.0/wb.json", "{\"secret\":1}");
    answer = (t) => (/FROM rubric_result/.test(t) ? [{ rubric_id: "talk_time", unit_key: "wb", room_id: BR, ist_date: BD, status: "ok", score: { evidence_key: "rubric/talk_time/0.1.0/wb.json" }, findings: [] }] : []);
    const r = await run({ action: "results", include_text: true });
    expect((r.results as Row[])[0]).toMatchObject({ evidence: { secret: 1 } });
    expect(gets).toEqual(["rubric/talk_time/0.1.0/wb.json"]);
  });
});

describe("G66 — the writers accept the formerly held-out pairs, proven without docker", () => {
  const base = { rubric_id: "talk_time", version: "0.1.0", unit_kind: "window", unit_key: "w1", run_id: "rub_1", status: "ok" as const, score: { a: 1 }, findings: [], lab: true };
  it("upsertResult writes a formerly blind pair, by columns and by a room-hour key", async () => {
    for (const [d, r] of FORMER_BLIND_PAIRS) {
      statements.length = 0;
      await Store.upsertResult({ ...base, room_id: r, ist_date: d });
      expect(statements.some((s) => /INSERT INTO rubric_result/.test(s.text)), `${d}|${r}`).toBe(true);
      statements.length = 0;
      await Store.upsertResult({ ...base, unit_kind: "room_hour", unit_key: `${r}:${d}:09`, room_id: null, ist_date: null });
      expect(statements.some((s) => /INSERT INTO rubric_result/.test(s.text)), `${d}|${r} room_hour`).toBe(true);
    }
  });
  it("writeEvidence puts for a formerly blind pair and room-hour name, like an ordinary write", async () => {
    expect(await Store.writeEvidence("talk_time", "0.1.0", "w1", { x: 1 }, { room_id: BR, ist_date: BD })).toBe("rubric/talk_time/0.1.0/w1.json");
    expect(await Store.writeEvidence("room_mic_quality", "0.1.0", `${BR}:${BD}:03`, { x: 1 })).toBe(`rubric/room_mic_quality/0.1.0/${BR}:${BD}:03.json`);
    expect(puts).toHaveLength(2);
    expect(await Store.writeEvidence("talk_time", "0.1.0", "w1", { x: 1 }, { room_id: "r1", ist_date: "2026-10-01" })).toBe("rubric/talk_time/0.1.0/w1.json");
    expect(puts).toHaveLength(3);
  });
});

describe("G64 / G65 — consult listing filters in SQL before the LIMIT; the audio-hours listing says when its row cap is hit", () => {
  it("listConsultKeys: the blind filter is in the WHERE (before ORDER BY / LIMIT), the limit counts real consults, blind ones are counted apart", async () => {
    answer = (t) => (/count\(\*\)/.test(t) ? [{ n: 3 }] : [{ consult_key: "a" }, { consult_key: "b" }, { consult_key: "c" }]);
    const r = await listConsultKeys({ from: "2026-09-01", to: "2026-09-30", limit: 2 });
    expect(r).toEqual({ keys: ["a", "b"], truncated: true, blind_excluded: 3 });
    const q = statements.find((s) => /SELECT consult_key/.test(s.text))!;
    expect(q.text.indexOf("NOT EXISTS")).toBeGreaterThan(0);
    expect(q.text.indexOf("NOT EXISTS")).toBeLessThan(q.text.indexOf("LIMIT"));
    expect(q.values).toContain(3); // limit + 1
    expect(q.values).toContainEqual([]); // empty held-out arrays
  });
  it("listAudioHours: truncated is true when the row cap is hit, false at exactly the cap", async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ room_id: "r1", ts_start: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 1000), ts_end: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 1000 + 500) }));
    answer = () => mk(AUDIO_ROWS_MAX + 1);
    expect((await listAudioHours({ from: "2026-10-01", to: "2026-10-05", limit: 100 })).truncated).toBe(true);
    answer = () => mk(AUDIO_ROWS_MAX);
    expect((await listAudioHours({ from: "2026-10-01", to: "2026-10-05", limit: 100 })).truncated).toBe(false);
    const q = statements.find((s) => /FROM room_audio_state/.test(s.text))!;
    expect(q.values).toContain(AUDIO_ROWS_MAX + 1);
  });
});
