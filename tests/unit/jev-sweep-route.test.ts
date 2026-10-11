/**
 * /api/cron/jev-sweep — auth, and DARK: with JEV_WORKER_ENABLED off it reads nothing (no DB statement, no Jev call).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const H = vi.hoisted(() => ({ sql: 0 }));
vi.mock("@/lib/db", () => ({ sql: Object.assign(() => { H.sql += 1; return Promise.resolve([]); }, { transaction: async () => { H.sql += 1; return []; } }) }));

const call = async (auth?: string) => {
  const { GET } = await import("@/app/api/cron/jev-sweep/route");
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest("http://localhost/api/cron/jev-sweep", auth ? { headers: { authorization: auth } } : {}));
};

beforeEach(() => { H.sql = 0; vi.stubEnv("CRON_SECRET", "cron-secret-for-test"); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("the sweeper route", () => {
  it("no or wrong bearer is 401; the bare x-vercel-cron header does not authorise", async () => {
    expect((await call()).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
    const { GET } = await import("@/app/api/cron/jev-sweep/route");
    const { NextRequest } = await import("next/server");
    expect((await GET(new NextRequest("http://localhost/x", { headers: { "x-vercel-cron": "1" } }))).status).toBe(401);
    expect(H.sql).toBe(0);
  });
  it("flag unset or off: skipped worker_disabled, ZERO sql", async () => {
    for (const v of [undefined, "0", "off", ""]) {
      if (v === undefined) vi.stubEnv("JEV_WORKER_ENABLED", ""); else vi.stubEnv("JEV_WORKER_ENABLED", v);
      const res = await call("Bearer cron-secret-for-test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ skipped: "worker_disabled" });
    }
    expect(H.sql).toBe(0);
  });
  it("a typo in the flag is a 500, never 'off'", async () => {
    vi.stubEnv("JEV_WORKER_ENABLED", "yess");
    expect((await call("Bearer cron-secret-for-test")).status).toBe(500);
    expect(H.sql).toBe(0);
  });
  it("C1: the route's own module graph sees ALL EIGHT P2 uses (the sweeper's registry is not empty there)", async () => {
    vi.resetModules();                                             // a fresh graph: only what the route itself pulls in
    const uses = await import("@/lib/jev/worker/uses");
    expect(uses.listUses().length, "nothing registered before the route is loaded").toBe(0);
    await import("@/app/api/cron/jev-sweep/route");
    expect(uses.listUses().map((u) => `${u.use}/${u.setId}`).sort()).toEqual([
      "consult_rubric/chair-affect", "consult_rubric/doubt", "consult_rubric/pitch-detect", "consult_rubric/pitch-uptake",
      "encounter_timeline/encounter-end", "encounter_timeline/u10-timeline", "stt_pick/stt-pick", "stt_quality/stt-quality",
    ]);
  });
  it("C1: a nudge (which does not go through the route) sees them too, via the sweeper", async () => {
    vi.resetModules();
    const uses = await import("@/lib/jev/worker/uses");
    await import("@/lib/jev/worker/nudge");
    expect(uses.listUses().length).toBe(8);
  });
  it("vercel.json schedules it every 5 minutes", async () => {
    const cfg = JSON.parse((await import("node:fs")).readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(cfg.crons.find((c) => c.path === "/api/cron/jev-sweep")).toEqual({ path: "/api/cron/jev-sweep", schedule: "*/5 * * * *" });
  });
});
