/** JEV-COVERAGE JB-3: coverageOrNull, and the coverage field on the rooms-live now route and the admin fleet route. Synthetic counts only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const M = vi.hoisted(() => ({ cov: vi.fn(), snap: vi.fn(), cookie: vi.fn(), verify: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));
vi.mock("@/lib/jev/worker/coverage-view", async (orig) => ({ ...(await orig<Record<string, unknown>>()), coverageOrNull: M.cov }));
vi.mock("@/lib/rooms-live/snapshot", () => ({ getSnapshot: M.snap }));
vi.mock("@/lib/rooms-live/guard", () => ({ roomsLiveGuard: async () => ({ ok: true }) }));
vi.mock("@/lib/rooms-live/claims", () => ({ realClaimsPort: () => ({}) }));
vi.mock("@/lib/rooms-live/roster", () => ({ loadRoster: async () => [{ room_id: "room_a", label: "Room A" }] }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: M.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: M.verify }));
vi.mock("@/lib/fleet/read", () => ({ fleetDevices: async () => [], fleetCommands: async () => [], fleetAudit: async () => [] }));

import type { Coverage } from "@/lib/jev/worker/coverage";

const COV: Coverage = { ist_date: "2026-10-15", cut: 12, transcribed: 9, jev_done: { "pitch-detect": 7, "chair-affect": 6 }, no_state: { "pitch-detect": 1, "chair-affect": 0 }, clef_done: 5 };
const snapshot = (degraded: string[] = []) => ({ generated_at: "2026-10-15T10:00:00.000Z", rooms: [{ room_id: "room_a" }], degraded, steward_status: { state: "unavailable" }, changes_today: [] });

describe("coverageOrNull", () => {
  let actual: typeof import("@/lib/jev/worker/coverage-view");
  beforeEach(async () => {
    actual = await vi.importActual("@/lib/jev/worker/coverage-view");
    actual.__resetCoverageMemoForTests(); // JB3-1: the 10 s memo would otherwise carry one test's result into the next
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns the read's value", async () => {
    expect(await actual.coverageOrNull({ read: async () => COV })).toEqual(COV);
  });
  it("returns null on a throw, logging only the closed class", async () => {
    const r = await actual.coverageOrNull({ read: async () => { throw new Error("boom postgres://u:p@h/db"); } });
    expect(r).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.error).mock.calls[0]).toEqual(["[jev-coverage] read failed error"]);
  });
  it("returns null on a synchronous throw", async () => {
    expect(await actual.coverageOrNull({ read: (() => { throw new Error("sync"); }) as never })).toBeNull();
  });
  it("returns null on a timeout", async () => {
    const r = await actual.coverageOrNull({ timeoutMs: 20, read: () => new Promise<Coverage>(() => {}) });
    expect(r).toBeNull();
    expect(vi.mocked(console.error).mock.calls[0]).toEqual(["[jev-coverage] read failed timeout"]);
  });
});

describe("GET /api/rooms-live/now", () => {
  beforeEach(() => { M.cov.mockReset(); M.snap.mockReset(); vi.spyOn(console, "error").mockImplementation(() => {}); });
  afterEach(() => vi.restoreAllMocks());

  it("carries coverage and does not name it degraded", async () => {
    M.cov.mockResolvedValue(COV); M.snap.mockResolvedValue(snapshot());
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const res = await GET(new Request("http://x/api/rooms-live/now"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.coverage).toEqual(COV);
    expect(body.degraded).not.toContain("coverage");
    expect(body.rooms).toHaveLength(1);
    expect(JSON.stringify(body.coverage)).not.toMatch(/\b(u|cx)_[A-Za-z0-9]+/);
  });
  it("null coverage stays out of degraded and still answers 200 with rooms", async () => {
    M.cov.mockResolvedValue(null); M.snap.mockResolvedValue(snapshot(["steward"]));
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const res = await GET(new Request("http://x/api/rooms-live/now"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.coverage).toBeNull();
    expect(body.degraded).toEqual(["steward"]);
    expect(body.rooms).toHaveLength(1);
  });
  it("asks for coverage with a 2000 ms bound", async () => {
    M.cov.mockResolvedValue(COV); M.snap.mockResolvedValue(snapshot());
    const { GET } = await import("@/app/api/rooms-live/now/route");
    await GET(new Request("http://x/"));
    expect(M.cov).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });
  it("a throwing snapshot still answers 200 with coverage null", async () => {
    M.cov.mockResolvedValue(null); M.snap.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const res = await GET(new Request("http://x/"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.coverage).toBeNull();
    expect(body.degraded).toEqual(["snapshot"]);
    expect(body.rooms).toHaveLength(1);
  });
  it("a throwing snapshot keeps the coverage that did read", async () => {
    M.cov.mockResolvedValue(COV); M.snap.mockRejectedValue(new Error("boom"));
    const { GET } = await import("@/app/api/rooms-live/now/route");
    expect((await (await GET(new Request("http://x/"))).json()).coverage).toEqual(COV);
  });
});

describe("GET /api/admin/fleet", () => {
  beforeEach(() => { M.cov.mockReset(); M.cookie.mockResolvedValue("tok"); M.verify.mockResolvedValue({}); });
  const call = async () => (await import("@/app/api/admin/fleet/route")).GET(new (await import("next/server")).NextRequest("http://x/api/admin/fleet"));

  it("carries coverage in the 200 body, counts only", async () => {
    M.cov.mockResolvedValue(COV);
    const res = await call();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.coverage).toEqual(COV);
    expect(JSON.stringify(body.coverage)).not.toMatch(/\b(u|cx)_[A-Za-z0-9]+/);
  });
  it("null coverage is still a 200", async () => {
    M.cov.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).coverage).toBeNull();
  });
  it("no admin cookie is still 401 (coverage does not open the door)", async () => {
    M.cookie.mockResolvedValue(null); M.cov.mockResolvedValue(COV);
    expect((await call()).status).toBe(401);
  });
});
