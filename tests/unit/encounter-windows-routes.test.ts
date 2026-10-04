/** Auth and shape of the two encounter-windows routes. The DB and the resolver are mocked: these tests pin the doors. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({
  refresh: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ sql: Object.assign(() => [], { transaction: async () => [] }) }));
vi.mock("@/lib/encounter-windows", () => ({ refreshWindows: M.refresh, queryWindows: M.query }));

import { GET as cronGET } from "@/app/api/cron/encounter-windows/route";
import { GET as readGET } from "@/app/api/encounter-windows/route";
import { NextRequest } from "next/server";

const SAVED = { CRON_SECRET: process.env.CRON_SECRET, ADMIN_TOKEN: process.env.ADMIN_TOKEN };
beforeEach(() => {
  M.refresh.mockReset();
  M.query.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const cronReq = (auth?: string, qs = "") =>
  new Request(`https://x.test/api/cron/encounter-windows${qs}`, { headers: auth ? { authorization: auth } : {} });
const readReq = (qs = "", auth = "Bearer tok") =>
  new NextRequest(`https://x.test/api/encounter-windows${qs}`, { headers: auth ? { authorization: auth } : {} });

describe("GET /api/cron/encounter-windows", () => {
  it("503 and runs nothing when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const r = await cronGET(cronReq("Bearer anything"));
    expect(r.status).toBe(503);
    expect(M.refresh).not.toHaveBeenCalled();
  });

  it("401 on a missing or wrong bearer", async () => {
    process.env.CRON_SECRET = "s3cret";
    expect((await cronGET(cronReq())).status).toBe(401);
    expect((await cronGET(cronReq("Bearer nope"))).status).toBe(401);
    expect(M.refresh).not.toHaveBeenCalled();
  });

  it("refreshes the last 48 h and returns counts only", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.refresh.mockResolvedValue({
      range: { from: "a", to: "b" }, events: 10, deleted: 2, inserted: 3,
      summary: { consults: 3, unpaired_refs: 4, by_quality: { clean: 3 }, by_attribution: { rows: 3 }, by_close_reason: { endConsult: 3 } },
    });
    const before = Date.now();
    const r = await cronGET(cronReq("Bearer s3cret"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, hours: 48, consults: 3, unpaired_refs: 4, inserted: 3, by_quality: { clean: 3 } });
    const [, range] = M.refresh.mock.calls[0]!;
    expect(range.to - range.from).toBe(48 * 3_600_000 + 5 * 60_000);
    expect(range.from).toBeGreaterThanOrEqual(before - 48 * 3_600_000);
  });

  it("widens with ?hours= (clamped) and reports a failed refresh as 500 without leaking the reason", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.refresh.mockRejectedValue(new Error("connection string postgres://secret"));
    const r = await cronGET(cronReq("Bearer s3cret", "?hours=100000"));
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("postgres");
    const [, range] = M.refresh.mock.calls[0]!;
    expect(range.to - range.from).toBe(720 * 3_600_000 + 5 * 60_000);
  });
});

describe("GET /api/encounter-windows", () => {
  it("401 without the admin token, and when ADMIN_TOKEN is unset", async () => {
    process.env.ADMIN_TOKEN = "tok";
    expect((await readGET(readReq("", ""))).status).toBe(401);
    expect((await readGET(readReq("", "Bearer wrong"))).status).toBe(401);
    delete process.env.ADMIN_TOKEN;
    expect((await readGET(readReq())).status).toBe(401);
    expect(M.query).not.toHaveBeenCalled();
  });

  it("400 on bad params", async () => {
    process.env.ADMIN_TOKEN = "tok";
    expect((await readGET(readReq("?quality=bogus"))).status).toBe(400);
    expect((await readGET(readReq("?from=not-a-date"))).status).toBe(400);
    expect((await readGET(readReq("?limit=0"))).status).toBe(400);
    expect(M.query).not.toHaveBeenCalled();
  });

  it("passes the filters through and returns the rows", async () => {
    process.env.ADMIN_TOKEN = "tok";
    M.query.mockResolvedValue([{ consult_key: "E1" }]);
    const r = await readGET(readReq("?room_id=room_x&doctor_uid=UA&from=2026-10-03T00:00:00Z&to=2026-10-04T00:00:00Z&quality=clean&limit=50"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, count: 1, windows: [{ consult_key: "E1" }] });
    expect(M.query.mock.calls[0]![1]).toEqual({
      room_id: "room_x", doctor_uid: "UA", from: "2026-10-03T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z", quality: "clean", limit: 50,
    });
  });
});
