/** GET /api/cron/encounter-windows/warehouse — auth, params, batching and the counts-only response. attributeFromWarehouse is mocked. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ attribute: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: Object.assign(() => [], { transaction: async () => [] }) }));
vi.mock("@/lib/encounter-windows/warehouse-attribution", () => ({ attributeFromWarehouse: M.attribute }));

import { GET } from "@/app/api/cron/encounter-windows/warehouse/route";
import fs from "node:fs";

const SAVED = process.env.CRON_SECRET;
const sum = (o: Record<string, number> = {}) => ({ candidates: 0, checked: 0, resolved: 0, unresolved: 0, mismatches: 0, raced: 0, deferred: 0, ...o });
const req = (auth?: string, qs = "") =>
  new Request(`https://x.test/api/cron/encounter-windows/warehouse${qs}`, { headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  M.attribute.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = SAVED;
  vi.restoreAllMocks();
});

describe("GET /api/cron/encounter-windows/warehouse", () => {
  it("503 when CRON_SECRET is unset, 401 on a missing or wrong bearer; nothing runs", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer x"))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret";
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(M.attribute).not.toHaveBeenCalled();
  });

  it("400 on a bad hours, running nothing", async () => {
    process.env.CRON_SECRET = "s3cret";
    for (const qs of ["?hours=abc", "?hours=0", "?hours=-5"]) expect((await GET(req("Bearer s3cret", qs))).status, qs).toBe(400);
    expect(M.attribute).not.toHaveBeenCalled();
  });

  it("default: 36 h, one batch of 500, counts only", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.attribute.mockResolvedValue(sum({ candidates: 12, checked: 12, resolved: 9, unresolved: 3, mismatches: 4 }));
    const r = await GET(req("Bearer s3cret"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, hours: 36, batches: 1, complete: true, ...sum({ candidates: 12, checked: 12, resolved: 9, unresolved: 3, mismatches: 4 }) });
    expect(M.attribute).toHaveBeenCalledTimes(1);
    const [, opts] = M.attribute.mock.calls[0]!;
    expect(opts).toMatchObject({ hours: 36, limit: 500 });
    expect(opts.deadlineMs).toBeGreaterThan(Date.now());
    expect(opts.deadlineMs).toBeLessThanOrEqual(Date.now() + 50_000);
  });

  it("?hours= is clamped to 720; a full batch is followed by another until the queue is short", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.attribute
      .mockResolvedValueOnce(sum({ candidates: 500, checked: 500, resolved: 480, unresolved: 20, mismatches: 200 }))
      .mockResolvedValueOnce(sum({ candidates: 130, checked: 130, resolved: 100, unresolved: 30, mismatches: 40 }));
    const body = await (await GET(req("Bearer s3cret", "?hours=100000"))).json();
    expect(M.attribute).toHaveBeenCalledTimes(2);
    expect(M.attribute.mock.calls[0]![1].hours).toBe(720);
    expect(body).toMatchObject({ hours: 720, batches: 2, complete: true, candidates: 630, checked: 630, resolved: 580, unresolved: 50, mismatches: 240 });
  });

  it("stops without looping when a full batch wrote nothing, or the batch deferred work; reports complete=false", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.attribute.mockResolvedValue(sum({ candidates: 500, checked: 0, raced: 500 }));
    expect(await (await GET(req("Bearer s3cret", "?hours=48"))).json()).toMatchObject({ batches: 1, complete: false });
    expect(M.attribute).toHaveBeenCalledTimes(1);
    M.attribute.mockReset();
    M.attribute.mockResolvedValue(sum({ candidates: 500, checked: 200, deferred: 300 }));
    expect(await (await GET(req("Bearer s3cret", "?hours=48"))).json()).toMatchObject({ batches: 1, complete: false, deferred: 300 });
    expect(M.attribute).toHaveBeenCalledTimes(1);
  });

  it("a failure is a generic 500; the reason (here a connection string) never reaches the response", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.attribute.mockRejectedValue(new Error("Metabase HTTP 500: postgres://secret@host"));
    const r = await GET(req("Bearer s3cret"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secret");
  });
});

describe("vercel.json", () => {
  it("schedules the warehouse door every 2 minutes, next to the existing encounter-windows crons", () => {
    const crons = (JSON.parse(fs.readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> }).crons;
    expect(crons).toContainEqual({ path: "/api/cron/encounter-windows/warehouse", schedule: "*/2 * * * *" });
    expect(crons).toContainEqual({ path: "/api/cron/encounter-windows", schedule: "*/5 * * * *" });
    expect(crons).toContainEqual({ path: "/api/cron/encounter-windows/sweep", schedule: "7 * * * *" });
  });
});
