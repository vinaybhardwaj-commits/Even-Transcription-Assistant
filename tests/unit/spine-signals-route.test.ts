/** Spine S1 routes: POST /api/spine/signals (503, 401, 422 at depth 3, duplicate, off) and GET /api/cron/spine. The store is mocked; the SQL is proven in spine-ingest-pg.test.ts. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ mode: vi.fn(), store: vi.fn(), ingest: vi.fn() }));
vi.mock("@/lib/spine/ingest-store", () => ({ readIngestMode: M.mode, storeSignals: M.store, ingestSpineSignals: M.ingest }));

import { POST } from "@/app/api/spine/signals/route";
import { GET } from "@/app/api/cron/spine/route";
import { NextRequest } from "next/server";

const SAVED = { t: process.env.SPINE_INGEST_TOKEN, c: process.env.CRON_SECRET };
const sig = (over: Record<string, unknown> = {}) => ({ proxy: "pqm", source_key: "pqm_test_01", source_rev: 1, t_open: "2026-10-18T04:00:00Z", observed_at: "2026-10-18T04:20:00Z", attrs: { ids: { consult_uid: "pqm_test_01" } }, ...over });
const post = (body: unknown, auth: string | null = "Bearer tok_test") =>
  new NextRequest("https://x.test/api/spine/signals", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: auth ? { authorization: auth } : {} });

beforeEach(() => { M.mode.mockReset().mockResolvedValue("shadow"); M.store.mockReset().mockResolvedValue({ inserted: 1, duplicate: 0 }); M.ingest.mockReset(); process.env.SPINE_INGEST_TOKEN = "tok_test"; process.env.CRON_SECRET = "cron_test"; });
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
  it("200 inserts a good batch", async () => {
    const res = await POST(post([sig()]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: 1, duplicate: 0 });
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
    M.store.mockResolvedValue({ inserted: 0, duplicate: 1 });
    const res = await POST(post([sig()]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, inserted: 0, duplicate: 1 });
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
  it("returns the counts, and 500 with a generic code on failure", async () => {
    M.ingest.mockResolvedValue({ skipped: "off" });
    expect(await (await GET(get("Bearer cron_test"))).json()).toEqual({ ok: true, ingest: { skipped: "off" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    M.ingest.mockRejectedValue(new Error("boom"));
    const res = await GET(get("Bearer cron_test"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });
});
