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
  M.sql.mockResolvedValue([]); // steward_nonces / steward_decisions deletes (0128) find nothing unless a test queues rows
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
    expect(await res.json()).toEqual({ deleted: 6200, batches: 2, budget_hit: false, steward_nonces_deleted: 0, steward_decisions_deleted: 0, steward_tickets_deleted: 0, steward_tickets_expired: 0 });
    expect(M.sql).toHaveBeenCalledTimes(7); // 3 kiosk statements, then one empty statement each for nonces, decisions, ticket expiry, ticket delete
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
    expect(body).toMatchObject({ deleted: 10_000, batches: 2, budget_hit: true, steward_nonces_deleted: 0, steward_decisions_deleted: 0, steward_tickets_deleted: 0, steward_tickets_expired: 0 });
    expect(M.sql).toHaveBeenCalledTimes(2); // budget spent: the steward deletes never run
  });

  it("deletes steward_nonces > 7 d, steward_decisions > 30 d and finished steward_tickets > 30 d, in batches, with bound cutoffs", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-06T00:00:00.000Z"), toFake: ["Date"] });
    M.sql
      .mockResolvedValueOnce([]) // kiosk
      .mockResolvedValueOnce([{ nonce: "a" }, { nonce: "b" }]) // nonces batch 1
      .mockResolvedValueOnce([]) // nonces done
      .mockResolvedValueOnce([{ id: 1 }]) // decisions batch 1
      .mockResolvedValueOnce([]) // decisions done
      .mockResolvedValueOnce([{ ticket_id: "x" }, { ticket_id: "y" }]) // stale outstanding tickets flipped to expired
      .mockResolvedValueOnce([]) // flips done
      .mockResolvedValueOnce([{ ticket_id: "a" }, { ticket_id: "b" }, { ticket_id: "c" }]) // tickets batch 1
      .mockResolvedValueOnce([]); // tickets done
    const body = await (await GET(req("Bearer s3cret"))).json();
    expect(body).toEqual({ deleted: 0, batches: 0, budget_hit: false, steward_nonces_deleted: 2, steward_decisions_deleted: 1, steward_tickets_deleted: 3, steward_tickets_expired: 2 });
    const call = (i: number) => {
      const [strings, ...values] = M.sql.mock.calls[i] as [string[], ...unknown[]];
      return { text: strings.join("?"), values };
    };
    expect(call(1).text).toContain("DELETE FROM steward_nonces");
    expect(call(1).text).toContain("seen_at <");
    expect(call(1).text).toContain("LIMIT 5000");
    expect(call(1).values).toEqual(["2026-09-29T00:00:00.000Z"]);
    expect(call(3).text).toContain("DELETE FROM steward_decisions");
    expect(call(3).text).toContain("ts <");
    expect(call(3).values).toEqual(["2026-09-06T00:00:00.000Z"]);
    expect(call(5).text).toContain("UPDATE steward_tickets SET status = 'expired'");
    expect(call(5).text).toContain("status IN ('issued', 'fetched') AND expires_at < now()");
    expect(call(5).text).toContain("LIMIT 5000");
    expect(call(5).values).toEqual([]);
    expect(call(7).text).toContain("DELETE FROM steward_tickets"); // after the flip, so a never-polled machine's rows are deleted too
    expect(call(7).text).toContain("status IN ('done', 'failed', 'expired')");
    expect(call(7).text).toContain("COALESCE(completed_at, expires_at) <");
    expect(call(7).text).toContain("LIMIT 5000");
    expect(call(7).values).toEqual(["2026-09-06T00:00:00.000Z"]);
  });

  it("503 with the partial count on a database fault", async () => {
    M.sql.mockResolvedValueOnce(ids(5000)).mockRejectedValueOnce(new Error("down"));
    const res = await GET(req("Bearer s3cret"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ deleted: 5000, batches: 1 });
  });
});
