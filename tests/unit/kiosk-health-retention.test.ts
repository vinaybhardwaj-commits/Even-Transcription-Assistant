/** GET /api/cron/kiosk-health-retention — auth, batch loop, budget. sql is mocked as a tagged template. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: M.sql }));

import { GET } from "@/app/api/cron/kiosk-health-retention/route";

const SAVED = process.env.CRON_SECRET;
const req = (auth?: string) => new Request("https://x.test/api/cron/kiosk-health-retention", { headers: auth ? { authorization: auth } : {} });
const ids = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

beforeEach(() => {
  process.env.CRON_SECRET = "s3cret";
  M.sql.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = SAVED;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("GET /api/cron/kiosk-health-retention", () => {
  it("503 when CRON_SECRET is unset, 401 on a missing or wrong bearer; nothing is deleted", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer x"))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret";
    expect((await GET(req())).status).toBe(401);
    expect((await GET(req("Bearer nope"))).status).toBe(401);
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("loops two full batches then a zero batch and reports the totals", async () => {
    M.sql.mockResolvedValueOnce(ids(5000)).mockResolvedValueOnce(ids(1200)).mockResolvedValueOnce([]);
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 6200, batches: 2, budget_hit: false });
    expect(M.sql).toHaveBeenCalledTimes(3);
  });

  it("uses a 30-day cutoff bound as a parameter and the id-subselect batch form", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T00:00:00.000Z"), toFake: ["Date"] });
    M.sql.mockResolvedValueOnce([]);
    await GET(req("Bearer s3cret"));
    const [strings, ...values] = M.sql.mock.calls[0] as [string[], ...unknown[]];
    const text = strings.join("?");
    expect(text).toContain("DELETE FROM kiosk_health_events");
    expect(text).toContain("WHERE id IN (SELECT id FROM kiosk_health_events WHERE received_at <");
    expect(text).toContain("ORDER BY id LIMIT 5000");
    expect(values).toEqual(["2026-09-06T00:00:00.000Z"]);
  });

  it("stops at the 20 s budget and says so", async () => {
    let now = Date.parse("2026-10-06T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    M.sql.mockImplementation(async () => {
      now += 12_000; // each batch takes 12 s
      return ids(5000);
    });
    const body = (await (await GET(req("Bearer s3cret"))).json()) as { deleted: number; batches: number; budget_hit: boolean };
    expect(body).toEqual({ deleted: 10_000, batches: 2, budget_hit: true });
  });

  it("503 with the partial count on a database fault", async () => {
    M.sql.mockResolvedValueOnce(ids(5000)).mockRejectedValueOnce(new Error("down"));
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ deleted: 5000, batches: 1 });
  });
});
