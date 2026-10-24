/** Spine S1 routes: POST /api/spine/signals (503, 401, 422 at depth 3, duplicate, off) and GET /api/cron/spine. The store is mocked; the SQL is proven in spine-ingest-pg.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:crypto", async (orig) => { const c = await orig<typeof import("node:crypto")>(); return { ...c, timingSafeEqual: vi.fn(c.timingSafeEqual) }; });
const M = vi.hoisted(() => ({ mode: vi.fn(), store: vi.fn(), ingest: vi.fn(), merge: vi.fn(), enqueue: vi.fn(), tf: vi.fn() }));
vi.mock("@/lib/spine/ingest-store", () => ({ readIngestMode: M.mode, storeSignals: M.store, ingestSpineSignals: M.ingest }));
vi.mock("@/lib/spine/merge-store", () => ({ runSpineMerge: M.merge }));
vi.mock("@/lib/spine/enqueue-store", () => ({ runSpineEnqueue: M.enqueue }));
vi.mock("@/lib/spine/transcript-final-store", () => ({ runTranscriptFinal: M.tf }));   // S7a: the 4th step; its own proof is spine-s7a-pg.test.ts

import { POST } from "@/app/api/spine/signals/route";
import { GET } from "@/app/api/cron/spine/route";
import { NextRequest } from "next/server";
import { timingSafeEqual } from "node:crypto";

const SAVED = { t: process.env.SPINE_INGEST_TOKEN, c: process.env.CRON_SECRET };
const sig = (over: Record<string, unknown> = {}) => ({ proxy: "pqm", source_key: "pqm_a1b2c3d4e5f6a7b8c9d0e1", source_rev: 1, t_open: "2026-10-18T04:00:00Z", observed_at: "2026-10-18T04:20:00Z", attrs: { ids: { consult_uid: "pqm_a1b2c3d4e5f6a7b8c9d0e1" } }, ...over });
const post = (body: unknown, auth: string | null = "Bearer tok_test") =>
  new NextRequest("https://x.test/api/spine/signals", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: auth ? { authorization: auth } : {} });

beforeEach(() => { M.mode.mockReset().mockResolvedValue("shadow"); M.store.mockReset().mockResolvedValue({ inserted: 1, duplicate: 0, conflict: 0 }); M.ingest.mockReset(); M.merge.mockReset().mockResolvedValue({ skipped: "off" }); M.enqueue.mockReset().mockResolvedValue({ skipped: "off" }); M.tf.mockReset().mockResolvedValue({ skipped: "off" }); process.env.SPINE_INGEST_TOKEN = "tok_test"; process.env.CRON_SECRET = "cron_test"; });
afterEach(() => { for (const [k, v] of [["SPINE_INGEST_TOKEN", SAVED.t], ["CRON_SECRET", SAVED.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

describe("POST /api/spine/signals", () => {
  it("503 when the token is unset (even with a bearer), 401 on a missing or wrong one; nothing is stored", async () => {
    delete process.env.SPINE_INGEST_TOKEN;
    expect((await POST(post([sig()]))).status).toBe(503);
    process.env.SPINE_INGEST_TOKEN = "tok_test";
    expect((await POST(post([sig()], null))).status).toBe(401);
    expect((await POST(post([sig()], "Bearer wrong"))).status).toBe(401);
    expect((await POST(post([sig()], "Basic tok_test"))).status).toBe(401);
    expect(M.store).not.toHaveBeenCalled();
  });
  it("only the exact scheme \"Bearer \" passes (any case); a 7-character other scheme does not", async () => {
    for (const h of ["Basic tok_test", "Token tok_test", "Xearer tok_test", "Bearer", "Bearertok_test", "tok_test"]) expect((await POST(post([sig()], h))).status, h).toBe(401);
    for (const h of ["bearer tok_test", "BEARER tok_test", "Bearer tok_test"]) expect((await POST(post([sig()], h))).status, h).toBe(200);
  });
  it("uses the timing-safe compare", async () => {
    vi.mocked(timingSafeEqual).mockClear();
    await POST(post([sig()]));
    expect(timingSafeEqual).toHaveBeenCalled();
  });
  it("422 for a value outside the closed rules, storing nothing", async () => {
    for (const bad of [sig({ attrs: { close_reason: "has space" } }), sig({ attrs: { close_reason: "Ravi_Kumar_98765" } }), sig({ attrs: { ids: { consult_uid: "Patient said chest pain" } } }), sig({ source_key: "Ravi Kumar" })])
      expect((await POST(post([bad]))).status, JSON.stringify(bad)).toBe(422);
    expect(M.store).not.toHaveBeenCalled();
  });
  it("200 inserts a good batch", async () => {
    const res = await POST(post([sig()]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: 1, duplicate: 0, conflict: 0 });
    expect(M.store).toHaveBeenCalledTimes(1);
  });
  it("422 for a text-like key at depth 0, 1 and 3, storing nothing", async () => {
    for (const bad of [[sig({ patient: "x" })], [sig({ attrs: { name: "x" } })], [sig({ attrs: { ids: { a: { b: { phone: "x" } } } } })]]) {
      const res = await POST(post(bad));
      expect(res.status, JSON.stringify(bad)).toBe(422);
      expect(JSON.stringify(await res.json())).not.toContain("phone");
    }
    expect(M.store).not.toHaveBeenCalled();
  });
  it("400 for a disallowed attrs key, bad JSON and a non-array; 413 over the size cap", async () => {
    expect((await POST(post([sig({ attrs: { extra: 1 } })]))).status).toBe(400);
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post({ a: 1 }))).status).toBe(400);
    expect((await POST(post("x".repeat(1_000_001)))).status).toBe(413);
  });
  it("a re-post of the same key is a 200 with duplicate counted", async () => {
    M.store.mockResolvedValue({ inserted: 0, duplicate: 1, conflict: 0 });
    const res = await POST(post([sig()]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: 0, duplicate: 1, conflict: 0 });
  });
  it("off (or a failed config read) is a 200 skipped and stores nothing", async () => {
    M.mode.mockResolvedValue("off");
    expect(await (await POST(post([sig()]))).json()).toEqual({ ok: true, skipped: "off" });
    expect(M.store).not.toHaveBeenCalled();
  });
  it("a store failure is a 503 with a sqlstate code and no detail", async () => {
    M.store.mockRejectedValue(Object.assign(new Error("secret detail"), { code: "23505" }));
    const res = await POST(post([sig()]));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toBe('{"ok":false,"error":"db:23505"}');
  });
});

describe("GET /api/cron/spine", () => {
  const get = (auth?: string) => new Request("https://x.test/api/cron/spine", { headers: auth ? { authorization: auth } : {} });
  it("503 without CRON_SECRET, 401 on a wrong bearer; nothing runs", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(get("Bearer x"))).status).toBe(503);
    process.env.CRON_SECRET = "cron_test";
    expect((await GET(get())).status).toBe(401);
    expect((await GET(get("Bearer nope"))).status).toBe(401);
    expect(M.ingest).not.toHaveBeenCalled();
  });
  it("only the exact scheme \"Bearer \" passes, and the compare is timing-safe", async () => {
    M.ingest.mockResolvedValue({ skipped: "off" });
    for (const h of ["Basic cron_test", "Xearer cron_test", "cron_test"]) expect((await GET(get(h))).status, h).toBe(401);
    vi.mocked(timingSafeEqual).mockClear();
    expect((await GET(get("bearer cron_test"))).status).toBe(200);
    expect(timingSafeEqual).toHaveBeenCalled();
  });
  it("returns the counts, and 500 with a generic code on failure", async () => {
    M.ingest.mockResolvedValue({ skipped: "off" });
    expect(await (await GET(get("Bearer cron_test"))).json()).toEqual({ ok: true, ingest: { skipped: "off" }, merge: { skipped: "off" }, enqueue: { skipped: "off" }, transcript_final: { skipped: "off" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    M.ingest.mockRejectedValue(new Error("boom"));
    const res = await GET(get("Bearer cron_test"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });
  it("P2 chain: ingest, then merge, then enqueue, each result in the response; a step that is off reports skipped and the others still run", async () => {
    M.ingest.mockResolvedValue({ skipped: "off" });
    M.merge.mockResolvedValue({ mode: "shadow", days: 1 });
    M.enqueue.mockResolvedValue({ skipped: "off" });
    expect(await (await GET(get("Bearer cron_test"))).json()).toEqual({ ok: true, ingest: { skipped: "off" }, merge: { mode: "shadow", days: 1 }, enqueue: { skipped: "off" }, transcript_final: { skipped: "off" } });
    const order: string[] = [];
    M.ingest.mockImplementation(async () => { order.push("ingest"); return {}; });
    M.merge.mockImplementation(async () => { order.push("merge"); return {}; });
    M.enqueue.mockImplementation(async () => { order.push("enqueue"); return {}; });
    M.tf.mockImplementation(async () => { order.push("transcript_final"); return {}; });
    await GET(get("Bearer cron_test"));
    expect(order).toEqual(["ingest", "merge", "enqueue", "transcript_final"]);
  });
  it("P2 chain: an ingest failure still merges and enqueues; a merge failure skips enqueue (fail closed); both answer 500 with a generic code and the counts that ran", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    M.ingest.mockRejectedValue(new Error("boom_ingest"));
    M.merge.mockResolvedValue({ mode: "shadow" });
    const r1 = await GET(get("Bearer cron_test"));
    const b1 = await r1.json();
    expect(r1.status).toBe(500);
    expect(b1).toMatchObject({ ok: false, error: { code: "SPINE_INGEST_FAILED" }, failed: ["ingest"], merge: { mode: "shadow" } });
    expect(M.enqueue).toHaveBeenCalledTimes(1);
    expect(M.tf).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(b1)).not.toContain("boom");
    M.enqueue.mockClear();
    M.ingest.mockResolvedValue({ skipped: "off" });
    M.merge.mockRejectedValue(new Error("boom_merge"));
    const r2 = await GET(get("Bearer cron_test"));
    expect(r2.status).toBe(500);
    expect(await r2.json()).toMatchObject({ error: { code: "SPINE_MERGE_FAILED" }, failed: ["merge"] });
    expect(M.enqueue).not.toHaveBeenCalled();
    expect(M.tf).toHaveBeenCalledTimes(1);   // only the ingest-failure pass above ran it: a merge failure skips transcript_final too
    // an enqueue failure also skips transcript_final (fail closed), with its own generic code
    M.tf.mockClear(); M.merge.mockResolvedValue({ mode: "shadow" }); M.enqueue.mockRejectedValue(new Error("boom_enq"));
    const r3 = await GET(get("Bearer cron_test"));
    expect(r3.status).toBe(500);
    expect(await r3.json()).toMatchObject({ error: { code: "SPINE_ENQUEUE_FAILED" }, failed: ["enqueue"] });
    expect(M.tf).not.toHaveBeenCalled();
    // a transcript_final failure answers 500 with its own generic code and no error text
    M.enqueue.mockResolvedValue({ skipped: "off" }); M.tf.mockRejectedValue(new Error("boom_tf"));
    const r4 = await GET(get("Bearer cron_test"));
    expect(r4.status).toBe(500);
    const b4 = await r4.json();
    expect(b4).toMatchObject({ error: { code: "SPINE_TRANSCRIPT_FINAL_FAILED" }, failed: ["transcript_final"] });
    expect(JSON.stringify(b4)).not.toContain("boom");
  });
});
