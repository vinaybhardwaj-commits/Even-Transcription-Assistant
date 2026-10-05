/** Auth and shape of the two encounter-windows routes. The DB and the resolver are mocked: these tests pin the doors. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({
  refresh: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ sql: Object.assign(() => [], { transaction: async () => [] }) }));
vi.mock("@/lib/encounter-windows", () => ({ refreshWindowsByDay: M.refresh, queryWindows: M.query }));

import { GET as cronGET } from "@/app/api/cron/encounter-windows/route";
import { GET as sweepGET } from "@/app/api/cron/encounter-windows/sweep/route";
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

const RESULT = {
  range: { from: "a", to: "b" }, chunks: 1, complete: true, next_from: null, events: 10, deleted: 2, inserted: 3,
  summary: { consults: 3, unpaired_refs: 4, by_quality: { clean: 3 }, by_attribution: { rows: 3 }, by_close_reason: { endConsult: 3 } },
};

const cronReq = (auth?: string, qs = "", path = "") =>
  new Request(`https://x.test/api/cron/encounter-windows${path}${qs}`, { headers: auth ? { authorization: auth } : {} });
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
    M.refresh.mockResolvedValue(RESULT);
    const before = Date.now();
    const r = await cronGET(cronReq("Bearer s3cret"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ ok: true, mode: "recent", hours: 3, consults: 3, unpaired_refs: 4, inserted: 3, complete: true, by_quality: { clean: 3 } });
    const [, range, opts] = M.refresh.mock.calls[0]!;
    expect(range.to - range.from).toBe(3 * 3_600_000 + 5 * 60_000); // the last 3 h by default
    expect(range.from).toBeGreaterThanOrEqual(before - 3 * 3_600_000);
    expect(opts.deadlineMs).toBeGreaterThan(before);
  });

  it("?mode=recent is the 3 h refresh and ?mode=sweep the 48 h sweep", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.refresh.mockResolvedValue(RESULT);
    await cronGET(cronReq("Bearer s3cret", "?mode=recent"));
    await cronGET(cronReq("Bearer s3cret", "?mode=sweep"));
    const spans = M.refresh.mock.calls.map(([, r]) => (r.to - r.from - 5 * 60_000) / 3_600_000);
    expect(spans).toEqual([3, 48]);
  });

  it("400 on an unknown mode or bad backfill params, running nothing", async () => {
    process.env.CRON_SECRET = "s3cret";
    for (const qs of ["?mode=bogus", "?hours=abc", "?hours=0", "?hours=24&from=not-a-date"]) {
      expect((await cronGET(cronReq("Bearer s3cret", qs))).status, qs).toBe(400);
    }
    expect(M.refresh).not.toHaveBeenCalled();
  });

  it("backfill: ?hours=N (clamped to 720) and ?from= resume a stopped run; reports complete=false and next_from", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.refresh.mockResolvedValue({ ...RESULT, complete: false, next_from: "2026-10-03T18:30:00.000Z" });
    const r = await cronGET(cronReq("Bearer s3cret", "?hours=72&from=2026-10-01T00:00:00Z"));
    const body = await r.json();
    expect(body).toMatchObject({ mode: "backfill", hours: 72, complete: false, next_from: "2026-10-03T18:30:00.000Z" });
    expect(M.refresh.mock.calls[0]![1].from).toBe(Date.parse("2026-10-01T00:00:00Z"));
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

describe("GET /api/cron/encounter-windows/sweep", () => {
  it("is the hourly 48 h sweep with no query string, behind the same bearer", async () => {
    delete process.env.CRON_SECRET;
    expect((await sweepGET(cronReq("Bearer x", "", "/sweep"))).status).toBe(503);
    process.env.CRON_SECRET = "s3cret";
    expect((await sweepGET(cronReq(undefined, "", "/sweep"))).status).toBe(401);
    expect(M.refresh).not.toHaveBeenCalled();
    M.refresh.mockResolvedValue(RESULT);
    const r = await sweepGET(cronReq("Bearer s3cret", "", "/sweep"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, mode: "sweep", hours: 48 });
    const [, range] = M.refresh.mock.calls[0]!;
    expect((range.to - range.from - 5 * 60_000) / 3_600_000).toBe(48);
  });

  it("ignores ?mode= (the door decides), while ?hours= is still a backfill", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.refresh.mockResolvedValue(RESULT);
    expect(await (await sweepGET(cronReq("Bearer s3cret", "?mode=recent", "/sweep"))).json()).toMatchObject({ mode: "sweep", hours: 48 });
    expect(await (await sweepGET(cronReq("Bearer s3cret", "?hours=10", "/sweep"))).json()).toMatchObject({ mode: "backfill", hours: 10 });
  });

  it("the base door still defaults to recent with no query string, and ?mode=sweep still works on it", async () => {
    process.env.CRON_SECRET = "s3cret";
    M.refresh.mockResolvedValue(RESULT);
    expect(await (await cronGET(cronReq("Bearer s3cret"))).json()).toMatchObject({ mode: "recent", hours: 3 });
    expect(await (await cronGET(cronReq("Bearer s3cret", "?mode=sweep"))).json()).toMatchObject({ mode: "sweep", hours: 48 });
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
    M.query.mockResolvedValue([{ consult_key: "E1@m" }]);
    const r = await readGET(readReq("?room_id=room_x&doctor_uid=UA&from=2026-10-03T00:00:00Z&to=2026-10-04T00:00:00Z&quality=clean&limit=50"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, count: 1, windows: [{ consult_key: "E1@m" }] });
    expect(M.query.mock.calls[0]![1]).toEqual({
      room_id: "room_x", doctor_uid: "UA", from: "2026-10-03T00:00:00.000Z", to: "2026-10-04T00:00:00.000Z", quality: "clean", mismatch: null, limit: 50,
    });
  });

  it("?mismatch=true reaches the query as true, ?mismatch=false as false, absent as null; anything else is a 400", async () => {
    process.env.ADMIN_TOKEN = "tok";
    M.query.mockResolvedValue([]);
    await readGET(readReq("?mismatch=true"));
    await readGET(readReq("?mismatch=false"));
    await readGET(readReq(""));
    expect(M.query.mock.calls.map(([, f]) => f.mismatch)).toEqual([true, false, null]);
    M.query.mockClear();
    expect((await readGET(readReq("?mismatch=yes"))).status).toBe(400);
    expect(M.query).not.toHaveBeenCalled();
  });
});
