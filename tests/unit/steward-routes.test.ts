/**
 * GET /api/cron/steward (bearer, budget, summary) and GET /api/admin/steward/decisions (admin guard, filters, limit clamp), and the vercel.json cron entry.
 * sql, the loop and the guard are mocked; the real rows come back through real SQL in steward-pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

const M = vi.hoisted(() => ({ sql: vi.fn(), run: vi.fn(), guard: vi.fn() }));
vi.mock("@/lib/db", () => ({ sql: M.sql }));
vi.mock("@/lib/steward/loop", () => ({ runSteward: M.run }));
vi.mock("@/lib/bench", () => ({ benchAdminGuard: M.guard }));

import { GET as cron } from "@/app/api/cron/steward/route";
import { GET as decisions } from "@/app/api/admin/steward/decisions/route";

const SAVED = process.env.CRON_SECRET;
beforeEach(() => {
  M.sql.mockReset();
  M.run.mockReset();
  M.guard.mockReset();
  process.env.CRON_SECRET = "cron-s";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = SAVED;
  vi.restoreAllMocks();
});

const get = (auth: string | null) => new Request("https://x.test/api/cron/steward", { headers: auth ? { authorization: auth } : {} });
const SUMMARY = { rooms: 9, decisions_written: 2, skipped_lock: false, elapsed_ms: 1234, degraded: [], kill_switch: true, budget_hit: false, fleet_incidents: 0 };

describe("GET /api/cron/steward", () => {
  it("503 when CRON_SECRET is unset and nothing runs; 401 without or with a wrong bearer and nothing runs", async () => {
    delete process.env.CRON_SECRET;
    expect((await cron(get("Bearer cron-s"))).status).toBe(503);
    process.env.CRON_SECRET = "cron-s";
    expect((await cron(get(null))).status).toBe(401);
    expect((await cron(get("Bearer nope"))).status).toBe(401);
    expect((await cron(get("cron-s"))).status).toBe(401);
    expect(M.run).not.toHaveBeenCalled();
  });

  it("200 with the loop's summary, no-store, and the 20 s budget", async () => {
    M.run.mockResolvedValue(SUMMARY);
    const res = await cron(get("Bearer cron-s"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(SUMMARY);
    expect(M.run).toHaveBeenCalledTimes(1);
    const [, opts] = M.run.mock.calls[0]!;
    expect(opts.budgetMs).toBe(20_000);
    expect(Math.abs(opts.asOf - Date.now())).toBeLessThan(5000);
  });

  it("a held lock is still a 200 (skipped_lock true)", async () => {
    M.run.mockResolvedValue({ ...SUMMARY, skipped_lock: true, rooms: 0 });
    const res = await cron(get("Bearer cron-s"));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped_lock).toBe(true);
  });

  it("500 with a generic body when the loop itself crashes (no message leaked)", async () => {
    M.run.mockRejectedValue(new Error("secret detail"));
    const res = await cron(get("Bearer cron-s"));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
  });
});

describe("GET /api/admin/steward/decisions", () => {
  const req = (qs = "") => new Request(`https://x.test/api/admin/steward/decisions${qs ? `?${qs}` : ""}`);
  const okGuard = () => M.guard.mockResolvedValue({ ok: true, claims: {} });
  const row = (id: number, ts: string) => ({ id: String(id), ts, room_id: "room_a", machine: "H", window_kind: "clinic", rule: "ok", action: "none", params: {}, mode: "shadow", result: null, actor: "steward", why: "w", why_not: null, inputs_hash: "abc", inputs: {} });

  it("401 without an admin session; the database is never touched", async () => {
    M.guard.mockResolvedValue({ ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" });
    const res = await decisions(req());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("AUTH_REQUIRED");
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("returns rows newest first with ISO timestamps and numeric ids; every filter is a bound parameter; default limit 100", async () => {
    okGuard();
    M.sql.mockResolvedValue([row(3, "2026-10-06T10:02:00.000Z"), row(2, "2026-10-06 10:01:00+00")]);
    const res = await decisions(req("room=room_a&since=2026-10-06T00:00:00Z"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.limit).toBe(100);
    expect(body.decisions.map((d: { id: number }) => d.id)).toEqual([3, 2]);
    expect(body.decisions[1].ts).toBe("2026-10-06T10:01:00.000Z");
    const [strings, ...values] = M.sql.mock.calls[0]!;
    const text = (strings as string[]).join("?");
    expect(text).toContain("ORDER BY ts DESC, id DESC");
    expect(values).toEqual(["room_a", "room_a", "2026-10-06T00:00:00.000Z", "2026-10-06T00:00:00.000Z", null, null, null, null, 100]);
  });

  it("no filters -> nulls bound; limit is clamped to 500", async () => {
    okGuard();
    M.sql.mockResolvedValue([]);
    const res = await decisions(req("limit=9999"));
    expect((await res.json()).limit).toBe(500);
    const [, ...values] = M.sql.mock.calls[0]!;
    expect(values).toEqual([null, null, null, null, null, null, null, null, 500]);
  });

  it("rule and action filters are bound parameters (FLEET polls live attempts with action=scribe_start&rule=not_recording)", async () => {
    okGuard();
    M.sql.mockResolvedValue([]);
    await decisions(req("room=room_a&rule=not_recording&action=scribe_start"));
    const [strings, ...values] = M.sql.mock.calls[0]!;
    const text = (strings as string[]).join("?");
    expect(text).toContain("rule = ");
    expect(text).toContain("action = ");
    expect(values).toEqual(["room_a", "room_a", null, null, "not_recording", "not_recording", "scribe_start", "scribe_start", 100]);
    expect(JSON.stringify(values)).not.toContain("DROP");
  });

  it("400 on a bad since, a bad limit or an over-long room", async () => {
    okGuard();
    for (const qs of ["since=yesterday", "limit=0", "limit=abc", "limit=1.5", `room=${"x".repeat(65)}`, "room=", `rule=${"x".repeat(65)}`, "rule=", `action=${"x".repeat(65)}`, "action="]) {
      expect((await decisions(req(qs))).status).toBe(400);
    }
    expect(M.sql).not.toHaveBeenCalled();
  });

  it("500 with a generic body when the read fails", async () => {
    okGuard();
    M.sql.mockRejectedValue(new Error("relation steward_decisions does not exist"));
    const res = await decisions(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});

describe("vercel.json", () => {
  it("runs /api/cron/steward every minute, once", () => {
    const j = JSON.parse(readFileSync("vercel.json", "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(j.crons.filter((c) => c.path === "/api/cron/steward")).toEqual([{ path: "/api/cron/steward", schedule: "* * * * *" }]);
  });
});
