/** /api/reb/index doors and shapes with the database mocked: auth 401/503, validation 400 with the row index, inserted/existing/409, GET params. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const M = vi.hoisted(() => ({ calls: [] as Array<{ q: string; v: unknown[] }>, inserted: [] as unknown[], stored: [] as unknown[], page: [] as unknown[], fail: false }));
vi.mock("@/lib/db", () => ({
  sql: async (s: TemplateStringsArray, ...v: unknown[]) => {
    const q = s.join("?");
    M.calls.push({ q, v });
    if (M.fail) throw new Error("boom");
    if (/^\s*INSERT/.test(q)) return M.inserted;
    if (/JOIN \(SELECT DISTINCT/.test(q)) return M.stored;
    return M.page;
  },
}));

import { GET, POST } from "@/app/api/reb/index/route";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const row = (o: Record<string, unknown> = {}) => ({
  window_id: "w1", ist_date: "2026-10-06", room_id: "room_a", layer: "stt", engine: "whisper-auto", version: "v1", config_hash: "c0ffee00",
  status: "ok", r2_key: "reb/k.json", sha256: SHA_A, ...o,
});
const keyRow = (o: Record<string, unknown> = {}, sha = SHA_A) => ({ window_id: "w1", layer: "stt", engine: "whisper-auto", version: "v1", config_hash: "c0ffee00", shadow: false, sha256: sha, ...o });
const post = (body: unknown, token: string | null = "wtok", raw = false) =>
  POST(new NextRequest("http://x/api/reb/index", { method: "POST", headers: token === null ? {} : { authorization: `Bearer ${token}` }, body: raw ? (body as string) : JSON.stringify(body) }));
const get = (qs: string, token: string | null = "rtok") =>
  GET(new NextRequest(`http://x/api/reb/index?${qs}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } }));

const SAVED = { w: process.env.REB_INDEX_TOKEN, r: process.env.REB_INDEX_READ_TOKEN };
beforeEach(() => {
  process.env.REB_INDEX_TOKEN = "wtok";
  process.env.REB_INDEX_READ_TOKEN = "rtok";
  M.calls = []; M.inserted = []; M.stored = []; M.page = []; M.fail = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED.w === undefined) delete process.env.REB_INDEX_TOKEN; else process.env.REB_INDEX_TOKEN = SAVED.w;
  if (SAVED.r === undefined) delete process.env.REB_INDEX_READ_TOKEN; else process.env.REB_INDEX_READ_TOKEN = SAVED.r;
  vi.restoreAllMocks();
});

describe("POST auth", () => {
  it("401 for a missing, wrong, or read-only token; the database is never touched", async () => {
    for (const t of [null, "nope", "rtok", ""]) expect((await post(row(), t)).status).toBe(401);
    expect(M.calls).toHaveLength(0);
  });
  it("503 when REB_INDEX_TOKEN is unset or blank (even with a header)", async () => {
    delete process.env.REB_INDEX_TOKEN;
    expect((await post(row())).status).toBe(503);
    process.env.REB_INDEX_TOKEN = "   ";
    expect((await post(row(), "")).status).toBe(503);
    expect(M.calls).toHaveLength(0);
  });
});

describe("POST validation", () => {
  it("400 names the row index; nothing is written", async () => {
    const r = await post([row(), row({ status: "weird" })]);
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(/^row 1: status must be one of/);
    expect(M.calls).toHaveLength(0);
  });
  it.each([
    [{ window_id: "" }, /window_id/], [{ room_id: undefined }, /room_id/], [{ ist_date: "2026-02-30" }, /ist_date/], [{ ist_date: "2026-13-01" }, /ist_date/], [{ ist_date: "06-10-2026" }, /ist_date/],
    [{ sha256: "abc" }, /sha256/], [{ shadow: "yes" }, /shadow/], [{ t0_ms: 1.5 }, /t0_ms/], [{ bytes: -1 }, /bytes/], [{ started_at: "not a time" }, /started_at/], [{ started_at: "1" }, /started_at/], [{ finished_at: "2026-10-06" }, /finished_at/], [{ started_at: "2026-10-06T04:00:00" }, /started_at/],
    [{ model: 5 }, /model/], [{ r2_key: undefined }, /r2_key/],
  ])("rejects %j", async (o, re) => {
    const r = await post(row(o as Record<string, unknown>));
    expect(r.status).toBe(400);
    expect((await r.json()).error.message).toMatch(re);
  });
  it("accepts ISO 8601 timestamps with a zone", async () => {
    M.stored = [keyRow()];
    for (const t of ["2026-10-06T04:00:00Z", "2026-10-06T09:30:00.123+05:30", "2026-10-06 04:00:00+00"]) expect((await post(row({ started_at: t, finished_at: t }))).status).toBe(200);
  });
  it("400 for non-JSON, an empty array, a non-object row and 501 rows; 500 rows pass validation", async () => {
    expect((await post("{nope", "wtok", true)).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post([7])).status).toBe(400);
    const over = await post(Array.from({ length: 501 }, (_, i) => row({ window_id: `w${i}` })));
    expect(over.status).toBe(400);
    expect((await over.json()).error.message).toMatch(/at most 500/);
    expect(M.calls).toHaveLength(0);
    const ok = await post(Array.from({ length: 500 }, (_, i) => row({ window_id: `w${i}` })));
    expect(ok.status).not.toBe(400);
  });
});

describe("POST result", () => {
  it("inserted", async () => {
    M.inserted = [keyRow()]; M.stored = [keyRow()];
    const r = await post(row());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, inserted: 1, existing: 0, conflicts: [] });
  });
  it("existing: same sha already stored", async () => {
    M.stored = [keyRow()];
    expect(await (await post(row())).json()).toEqual({ ok: true, inserted: 0, existing: 1, conflicts: [] });
  });
  it("409: a different sha under the same key; other rows still count as inserted", async () => {
    M.inserted = [keyRow({ window_id: "w2" })];
    M.stored = [keyRow(), keyRow({ window_id: "w2" })];
    const r = await post([row({ sha256: SHA_B }), row({ window_id: "w2" })]);
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({
      ok: false, inserted: 1, existing: 0,
      conflicts: [{ key: "w1/stt.whisper-auto__v1__c0ffee00", stored_sha: SHA_A, sent_sha: SHA_B }],
    });
  });
  it("shadow is part of the key and defaults to false", async () => {
    M.inserted = [keyRow({ shadow: true })]; M.stored = [keyRow({ shadow: true }), keyRow()];
    const r = await post([row({ shadow: true }), row()]);
    expect(await r.json()).toMatchObject({ inserted: 1, existing: 1, conflicts: [] });
    const sent = JSON.parse(M.calls[0]!.v[0] as string) as Array<{ shadow: boolean }>;
    expect(sent.map((x) => x.shadow)).toEqual([true, false]);
  });
  it("500 with no detail when the database throws", async () => {
    M.fail = true;
    const r = await post(row());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toMatch(/boom/);
  });
  it("only bound parameters: no row value appears in the statement text", async () => {
    M.stored = [keyRow()];
    await post(row({ window_id: "w'; DROP TABLE x;--" }));
    for (const c of M.calls) expect(c.q).not.toMatch(/DROP TABLE|w1|c0ffee00/);
  });
});

describe("GET", () => {
  it("accepts the read token and the write token; 401 otherwise; 503 only when neither is set", async () => {
    expect((await get("window_id=w1", "rtok")).status).toBe(200);
    expect((await get("window_id=w1", "wtok")).status).toBe(200);
    expect((await get("window_id=w1", "nope")).status).toBe(401);
    expect((await get("window_id=w1", null)).status).toBe(401);
    delete process.env.REB_INDEX_READ_TOKEN;
    expect((await get("window_id=w1", "wtok")).status).toBe(200);
    expect((await get("window_id=w1", "rtok")).status).toBe(401);
    delete process.env.REB_INDEX_TOKEN;
    expect((await get("window_id=w1")).status).toBe(503);
  });
  it("needs window_id or ist_date; validates ist_date, limit, cursor", async () => {
    for (const qs of ["", "layer=stt", "ist_date=2026-13-01", "window_id=w&limit=0", "window_id=w&limit=x", "window_id=w&cursor=-1", "window_id=w&cursor=abc"])
      expect((await get(qs)).status, qs).toBe(400);
  });
  it("binds filters, excludes shadow by default, clamps limit to 5000 and asks for one extra row", async () => {
    await get("window_id=w1&layer=stt&engine=e&room_id=r");
    const a = M.calls[0]!;
    expect(a.v).toEqual([0, "w1", "w1", null, null, "stt", "stt", "e", "e", "r", "r", false, expect.any(Array), expect.any(Array), 1001]);
    await get("ist_date=2026-10-06&shadow=1&limit=99999&cursor=7");
    expect(M.calls[1]!.v).toEqual([7, null, null, "2026-10-06", "2026-10-06", null, null, null, null, null, null, true, expect.any(Array), expect.any(Array), 5001]);
  });
  it("paginates: next_cursor is the last id of a full page, null at the end; ids and bigints come back as numbers, timestamps as strings", async () => {
    const mk = (id: number) => ({ id: String(id), window_id: "w", ist_date: "2026-10-06", t0_ms: "5", t1_ms: null, bytes: "9", started_at: new Date("2026-10-06T04:00:00Z"), finished_at: null, indexed_at: "2026-10-06 10:00:00+00", shadow: false });
    M.page = [mk(1), mk(2), mk(3)];
    const full = await (await get("window_id=w&limit=2")).json();
    expect(full).toMatchObject({ ok: true, count: 2, next_cursor: 2 });
    expect(full.rows[0]).toMatchObject({ id: 1, t0_ms: 5, t1_ms: null, bytes: 9, started_at: "2026-10-06T04:00:00.000Z", indexed_at: "2026-10-06 10:00:00+00" });
    M.page = [mk(3)];
    expect(await (await get("window_id=w&limit=2&cursor=2")).json()).toMatchObject({ count: 1, next_cursor: null });
  });
});
