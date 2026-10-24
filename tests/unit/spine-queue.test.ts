/** spine-queue.test.ts — S5 pure parts and the routes (jobs layer mocked). Synthetic ids only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { backoffMs, breakerOpen, nextIstDayStart, resolveOutcome, BACKOFF_CAP_MS } from "@/lib/spine/retry";
import { modesFrom, parseMode } from "@/lib/spine/config";
import { checkSpineBearer } from "@/lib/spine/auth";

describe("backoff", () => {
  it("attempts 1-6: base 2 min × 3^(n-1), ±20%, never above 6 h", () => {
    const base = [2, 6, 18, 54, 162, 486].map((m) => m * 60_000);
    base.forEach((b, i) => {
      const lo = backoffMs(i + 1, 0), hi = backoffMs(i + 1, 0.999999);
      expect(lo).toBe(Math.min(BACKOFF_CAP_MS, Math.round(b * 0.8)));
      expect(hi).toBeLessThanOrEqual(BACKOFF_CAP_MS);
      expect(hi).toBeGreaterThanOrEqual(Math.min(BACKOFF_CAP_MS, Math.round(b * 1.19999)));
    });
    expect(backoffMs(6, 0.999999)).toBe(BACKOFF_CAP_MS);
    expect(backoffMs(40, 0.999999)).toBe(BACKOFF_CAP_MS);
  });
  it("is deterministic in its inputs", () => expect(backoffMs(3, 0.5)).toBe(backoffMs(3, 0.5)));
});

describe("resolveOutcome", () => {
  const now = new Date("2026-10-19T06:00:00Z");
  it("permanent is final on attempt 1; budget and shadow give the attempt back; transient dies at the cap", () => {
    expect(resolveOutcome("permanent", 1, now, 0.5)).toMatchObject({ status: "failed", nextAttemptAt: null });
    expect(resolveOutcome("budget", 3, now, 0.5)).toMatchObject({ status: "queued", attemptsDelta: -1 });
    expect(resolveOutcome("shadow", 1, now, 0.5)).toMatchObject({ status: "shadow", attemptsDelta: -1 });
    expect(resolveOutcome("transient", 5, now, 0.5).status).toBe("queued");
    expect(resolveOutcome("transient", 6, now, 0.5).status).toBe("dead");
  });
  it("IST day start", () => {
    expect(nextIstDayStart(new Date("2026-10-19T18:29:59Z")).toISOString()).toBe("2026-10-19T18:30:00.000Z");
    expect(nextIstDayStart(new Date("2026-10-19T18:30:00Z")).toISOString()).toBe("2026-10-20T18:30:00.000Z");
  });
});

describe("resolveOutcome blocked (F3)", () => {
  it("holds the row, gives the attempt back, records no failure", () => {
    expect(resolveOutcome("blocked", 1, new Date("2026-10-19T06:00:00Z"), 0.5)).toEqual({ status: "queued", nextAttemptAt: null, attemptsDelta: -1, errorClass: null, doneAt: null, hold: true });
  });
});

describe("breakerOpen", () => {
  const now = new Date("2026-10-19T06:00:00Z");
  const rows = (fails: number, total: number, ageMin: number) => Array.from({ length: total }, (_, i) => ({ status: i < fails ? "failed" : "done", done_at: new Date(now.getTime() - (ageMin + i) * 60_000).toISOString() }));
  it("30% of the last 20 opens it for 30 min", () => {
    expect(breakerOpen(rows(6, 20, 1), now)).toBe(true);
    expect(breakerOpen(rows(5, 20, 1), now)).toBe(false);
    expect(breakerOpen(rows(6, 20, 31), now)).toBe(false);
    expect(breakerOpen(rows(3, 4, 1), now)).toBe(true);    // no minimum sample size (plan §4)
    expect(breakerOpen(rows(1, 1, 1), now)).toBe(true);
    expect(breakerOpen(rows(0, 20, 1), now)).toBe(false);
    expect(breakerOpen([], now)).toBe(false);
    // only the LAST 20 count: 12 old failures behind 20 recent successes stay outside the window
    const old = Array.from({ length: 12 }, (_, i) => ({ status: "failed", done_at: new Date(now.getTime() - (21 + i) * 60_000).toISOString() }));
    expect(breakerOpen([...rows(0, 20, 1), ...old], now)).toBe(false);
    expect(breakerOpen([...rows(6, 20, 1), ...old], now)).toBe(true);
  });
});

describe("config: missing or malformed means off", () => {
  it("parseMode", () => {
    expect([parseMode(undefined), parseMode("LIVE"), parseMode(5), parseMode({ mode: "shadow" }), parseMode("live"), parseMode([])]).toEqual(["off", "off", "off", "shadow", "live", "off"]);
  });
  it("jobs off, kill switch, paid stages and unknown stages are off", () => {
    const rows = [{ key: "jobs", value: "shadow" }, { key: "mode.recut", value: "live" }, { key: "mode.sarvam", value: "live" }, { key: "mode.bogus", value: "live" }];
    expect(modesFrom(rows, ["recut", "sarvam", "bogus", "acoustics"])).toEqual({ jobs: "shadow", stages: { recut: "live", sarvam: "off", bogus: "off", acoustics: "off" }, scopes: { recut: null, sarvam: null, bogus: null, acoustics: null } });
    expect(modesFrom(rows.slice(1), ["recut"]).stages.recut).toBe("off");
    expect(modesFrom([...rows, { key: "kill_switch", value: true }], ["recut"])).toEqual({ jobs: "off", stages: { recut: "off" }, scopes: { recut: null } });
  });
  it("F4: a kill_switch that is not exactly false / {on:false} is KILLED", () => {
    const base = [{ key: "jobs", value: "live" }, { key: "mode.recut", value: "live" }];
    const st = (v: unknown) => modesFrom([...base, { key: "kill_switch", value: v }], ["recut"]).stages.recut;
    for (const v of ["yes", "ON", "1", { on: "yes" }, "false", 0, null, [], {}, { on: "false" }, true, { on: true }]) expect(st(v)).toBe("off");
    for (const v of [false, { on: false }]) expect(st(v)).toBe("live");
    expect(modesFrom(base, ["recut"]).stages.recut).toBe("live");   // no kill_switch row: not a kill
  });
});

describe("bearer", () => {
  const h = (a?: string) => new Headers(a ? { authorization: a } : {});
  it("503 when unset, 401 wrong or missing, null when right", () => {
    expect(checkSpineBearer(h("Bearer x"), {})).toEqual({ status: 503, error: "spine_token_unset" });
    expect(checkSpineBearer(h(), { SPINE_BEARER_TOKEN: "tok" })?.status).toBe(401);
    expect(checkSpineBearer(h("Bearer tok2"), { SPINE_BEARER_TOKEN: "tok" })?.status).toBe(401);
    expect(checkSpineBearer(h("Bearer tok"), { SPINE_BEARER_TOKEN: "tok" })).toBeNull();
  });
});

const M = vi.hoisted(() => ({
  modes: { jobs: "shadow", stages: { recut: "shadow", acoustics: "live" } } as { jobs: string; stages: Record<string, string> },
  claim: vi.fn(async (..._a: unknown[]) => [] as unknown[]), report: vi.fn(async () => ({ ok: true, status: "shadow" }) as unknown),
}));
vi.mock("@/lib/spine/config", async (orig) => ({ ...(await orig<typeof import("@/lib/spine/config")>()), readModes: async () => ({ scopes: {}, ...M.modes }), readMode: async () => "off" }));
vi.mock("@/lib/spine/jobs", () => ({ claimJobs: M.claim, reportJob: M.report, openBreakers: async () => ["recut"], reapExhausted: async () => 0, opsAlertNotifier: {}, stubNotifier: {} }));
import { NextRequest } from "next/server";
import { POST as claimPOST } from "@/app/api/spine/claim/route";
import { POST as reportPOST } from "@/app/api/spine/report/route";

const req = (url: string, body: unknown, auth = "Bearer tok") => new NextRequest(`http://x${url}`, { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("routes", () => {
  beforeEach(() => { process.env.SPINE_BEARER_TOKEN = "tok"; M.claim.mockClear(); M.report.mockClear(); M.modes = { jobs: "shadow", stages: { recut: "shadow", acoustics: "live" } }; });
  it("auth: 401 wrong, 503 unset", async () => {
    expect((await claimPOST(req("/api/spine/claim", { owner: "r" }, "Bearer no"))).status).toBe(401);
    delete process.env.SPINE_BEARER_TOKEN;
    expect((await reportPOST(req("/api/spine/report", {}))).status).toBe(503);
  });
  it("S6: a live claim takes nothing when jobs=shadow, whatever mode.<stage> says", async () => {
    M.modes = { jobs: "shadow", stages: { recut: "live", acoustics: "live" } };
    expect(await (await claimPOST(req("/api/spine/claim", { owner: "r", live: true }))).json()).toEqual({ ok: true, jobs: [] });
    expect(M.claim).not.toHaveBeenCalled();
  });
  it("claim returns nothing and never touches the queue when jobs=off", async () => {
    M.modes = { jobs: "off", stages: {} };
    const r = await claimPOST(req("/api/spine/claim", { owner: "r" }));
    expect(await r.json()).toEqual({ ok: true, jobs: [] });
    expect(M.claim).not.toHaveBeenCalled();
  });
  // The claim route skips K lanes (acoustics, nemotron) from :20 to :45 IST; pin the clock so these tests do not depend on when CI runs.
  const atIstMinute = (min: number) => { const IST = 5.5 * 3600e3, t = Date.now(); return new Date(t - (((t + IST) % 3600e3) + 3600e3) % 3600e3 + 3600e3 + min * 60e3); };
  afterEach(() => { vi.useRealTimers(); });
  it("claim passes only stages that are not off and whose breaker is closed; live=true narrows to live", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(atIstMinute(10));   // outside the K-lane window
    await claimPOST(req("/api/spine/claim", { owner: "r" }));
    expect(M.claim.mock.calls[0]![1]).toEqual([]);                 // F1: non-live takes shadow stages only (recut shadow but breaker open; acoustics is live)
    M.modes.stages.recut = "live";
    M.modes.jobs = "live";   // S6: a live claim needs jobs=live
    await claimPOST(req("/api/spine/claim", { owner: "r", live: true }));
    expect(M.claim.mock.calls[1]![1]).toEqual(["acoustics"]);
    M.modes.stages.acoustics = "shadow";
    await claimPOST(req("/api/spine/claim", { owner: "r", live: true }));
    expect(M.claim.mock.calls[2]![1]).toEqual([]);
    await claimPOST(req("/api/spine/claim", { owner: "r" }));
    expect(M.claim.mock.calls[3]![1]).toEqual(["acoustics"]);      // shadow, breaker closed
  });
  it("inside the :20-:45 IST window a live claim withholds K lanes (acoustics) but still hands out other live stages", async () => {
    M.modes.jobs = "live";   // S6: a live claim needs jobs=live
    M.modes.stages.recut = "live";
    M.modes.stages.nemotron = "live";
    for (const min of [20, 30, 44]) {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(atIstMinute(min));
      M.claim.mockClear();
      await claimPOST(req("/api/spine/claim", { owner: "r", live: true }));
      expect(M.claim.mock.calls[0]![1]).toEqual([]);   // recut's breaker is open in this mock; acoustics and nemotron are K lanes
    }
    M.modes.stages.parts = "live";
    vi.setSystemTime(atIstMinute(30));
    M.claim.mockClear();
    await claimPOST(req("/api/spine/claim", { owner: "r", live: true }));
    expect(M.claim.mock.calls[0]![1]).toEqual(["parts"]);
    vi.setSystemTime(atIstMinute(10));
    M.claim.mockClear();
    await claimPOST(req("/api/spine/claim", { owner: "r", live: true }));
    expect(M.claim.mock.calls[0]![1]).toEqual(expect.arrayContaining(["acoustics", "nemotron", "parts"]));
  });
  it("claim and report validate input", async () => {
    expect((await claimPOST(req("/api/spine/claim", { owner: "bad owner!" }))).status).toBe(400);
    expect((await reportPOST(req("/api/spine/report", { job_id: 1, owner: "r", outcome: "weird" }))).status).toBe(400);
    expect((await reportPOST(req("/api/spine/report", { job_id: "1", owner: "r", outcome: "done" }))).status).toBe(400);
    expect((await reportPOST(req("/api/spine/report", { job_id: 1, owner: "r", outcome: "shadow" }))).status).toBe(200);
    M.report.mockResolvedValueOnce({ ok: false, error: "lease_lost" });
    expect((await reportPOST(req("/api/spine/report", { job_id: 1, owner: "r", outcome: "done" }))).status).toBe(409);
  });
});
