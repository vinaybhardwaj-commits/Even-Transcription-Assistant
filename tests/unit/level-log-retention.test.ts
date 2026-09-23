/**
 * Level-log retention (plan §2): the cutoff, the batched purge, and the cron route's guards.
 *
 * lib/bench-levels.ts's retention helpers are exercised directly (levelRetentionCutoffIstDate is
 * pure; countOldLevelSamples/purgeOldLevelSamplesBatch go through a mocked `sql`, so the exact
 * SQL text is asserted rather than trusted). The route is exercised through its own GET/POST with
 * `sql` mocked at the same seam — never over HTTP.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const H = vi.hoisted(() => ({
  sql: vi.fn(async (_text: string, _values: unknown[]): Promise<unknown[]> => []),
  cookie: null as string | null,
  verify: vi.fn(async (_c: string): Promise<{ admin_id: string }> => ({ admin_id: "adm_test" })),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s.join("?"), v) }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => H.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: (c: string) => H.verify(c) }));

import {
  LEVEL_RETENTION_DAYS,
  LEVEL_RETENTION_BATCH_SIZE,
  levelRetentionCutoffIstDate,
  countOldLevelSamples,
  purgeOldLevelSamplesBatch,
  oldLevelSamplesByRoom,
} from "@/lib/bench-levels";
import { GET, POST } from "@/app/api/admin/bench/levels-retention/route";
import { GET as reportGET } from "@/app/api/admin/bench/levels-retention/report/route";
import fs from "node:fs";
import path from "node:path";

const ENV = "BENCH_LEVEL_RETENTION";
let savedEnv: string | undefined;
let savedMigration: string | undefined;
let savedCron: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV];
  savedMigration = process.env.MIGRATION_SECRET;
  savedCron = process.env.CRON_SECRET;
  H.cookie = null;
  H.sql.mockReset();
  H.sql.mockResolvedValue([]);
  H.verify.mockReset();
  H.verify.mockResolvedValue({ admin_id: "adm_test" });
});
afterEach(() => {
  for (const [k, v] of [[ENV, savedEnv], ["MIGRATION_SECRET", savedMigration], ["CRON_SECRET", savedCron]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new NextRequest("http://localhost/api/admin/bench/levels-retention", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
const get = (headers: Record<string, string> = {}) =>
  GET(new NextRequest("http://localhost/api/admin/bench/levels-retention", { headers }));

describe("levelRetentionCutoffIstDate — pure", () => {
  it("keeps LEVEL_RETENTION_DAYS (7) IST calendar days", () => {
    expect(LEVEL_RETENTION_DAYS).toBe(7);
    expect(levelRetentionCutoffIstDate(new Date("2026-09-22T12:00:00.000Z"))).toBe("2026-09-15");
  });

  it("is exact calendar-day arithmetic, not a 168 h subtraction: near-midnight IST does not shift the day", () => {
    // 2026-09-22T18:35Z = 2026-09-23T00:05 IST — already the 23rd in IST.
    expect(levelRetentionCutoffIstDate(new Date("2026-09-22T18:35:00.000Z"))).toBe("2026-09-16");
  });

  it("respects a custom day count", () => {
    expect(levelRetentionCutoffIstDate(new Date("2026-09-22T12:00:00.000Z"), 1)).toBe("2026-09-21");
    expect(levelRetentionCutoffIstDate(new Date("2026-09-22T12:00:00.000Z"), 0)).toBe("2026-09-22");
  });
});

describe("countOldLevelSamples / purgeOldLevelSamplesBatch — SQL shape", () => {
  it("count issues a read-only count, never a DELETE", async () => {
    H.sql.mockResolvedValueOnce([{ n: 42 }]);
    expect(await countOldLevelSamples("2026-09-15")).toBe(42);
    const text = String(H.sql.mock.calls[0]![0]);
    expect(text).toMatch(/SELECT\s+count\(\*\)/i);
    expect(text).not.toMatch(/DELETE/i);
    // Refuter finding 4 (ETA-LEVEL-LOG-OPS-REFUTER-22-SEP-2026.md, L7): a mock-`sql` test cannot
    // prove the comparison is right, but it CAN prove the string says `<` and not `<=` — a plain
    // `/</` match is satisfied by either, which is exactly why the mutant survived before.
    expect(text).toMatch(/ist_date\s*<(?!=)/i);
  });

  it("count with no matching rows is 0, not null or undefined", async () => {
    H.sql.mockResolvedValueOnce([]);
    expect(await countOldLevelSamples("2026-09-15")).toBe(0);
  });

  it("purge deletes only rows before the cutoff, via a bounded subquery, and returns the count removed", async () => {
    H.sql.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const n = await purgeOldLevelSamplesBatch("2026-09-15", 100);
    expect(n).toBe(3);
    const [text, values] = H.sql.mock.calls[0]!;
    expect(String(text)).toMatch(/DELETE FROM bench_level_sample/i);
    expect(String(text)).toMatch(/ist_date\s*<(?!=).*::date/i); // L8: `<`, never `<=`
    expect(String(text)).toMatch(/LIMIT/i);
    expect(values).toContain("2026-09-15");
    expect(values).toContain(100);
  });

  it("purge on an empty result is 0, and is idempotent: two calls with nothing left both return 0", async () => {
    H.sql.mockResolvedValue([]);
    expect(await purgeOldLevelSamplesBatch("2026-09-15")).toBe(0);
    expect(await purgeOldLevelSamplesBatch("2026-09-15")).toBe(0);
  });

  it("default batch size is LEVEL_RETENTION_BATCH_SIZE when none is passed", async () => {
    H.sql.mockResolvedValueOnce([]);
    await purgeOldLevelSamplesBatch("2026-09-15");
    expect(H.sql.mock.calls[0]![1]).toContain(LEVEL_RETENTION_BATCH_SIZE);
  });
});

describe("route: not enabled by default — every call is a dry run until BENCH_LEVEL_RETENTION=on", () => {
  it("POST with the flag unset: forced dry run, deletes nothing, even with dryRun:false", async () => {
    delete process.env[ENV];
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 9 }]); // count
    const res = await post({ dryRun: false }, { authorization: "Bearer sekret" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: false, forced_dry_run: true, dry_run: true, matched_before: 9, deleted: 0 });
    expect(H.sql).toHaveBeenCalledTimes(1); // the count only — no DELETE call at all
  });

  it("GET (cron) with the flag unset is also a forced dry run", async () => {
    delete process.env[ENV];
    H.sql.mockResolvedValueOnce([{ n: 3 }]);
    const res = await get({ "x-vercel-cron": "1" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ forced_dry_run: true, dry_run: true, deleted: 0 });
  });

  it("dryRun:true is always a dry run, flag on or off", async () => {
    process.env[ENV] = "on";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 5 }]);
    const res = await post({ dryRun: true }, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, forced_dry_run: false, dry_run: true, matched_before: 5, deleted: 0 });
    expect(H.sql).toHaveBeenCalledTimes(1);
  });
});

describe("ETA-LEVEL-RETENTION-ENABLE-REFUTER-VERDICT-23-SEP-2026.md R2 — the flag is lib/flags.ts's parseFlag, not a hand-rolled === \"on\"", () => {
  // R2: "replacing process.env[RETENTION_ENV] === 'on' with a truthiness check leaves the suite
  // green" — a later Boolean(env)-style tidy-up would flip every falsy-INTENT value, including
  // "false" and "off", into ENABLED. This test fails under that refactor and passes under
  // parseFlag, which is exactly the strictness the finding says nothing was pinning.
  it("BENCH_LEVEL_RETENTION=true enables it — the value that works everywhere else in this repo, previously silently ignored", async () => {
    process.env[ENV] = "true";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 5 }]).mockResolvedValueOnce([]);
    const res = await post({}, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, forced_dry_run: false, dry_run: false });
  });

  it("BENCH_LEVEL_RETENTION=1 also enables it", async () => {
    process.env[ENV] = "1";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const res = await post({}, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, dry_run: false });
  });

  it("BENCH_LEVEL_RETENTION=false stays DISABLED — a non-empty, JS-truthy string that a Boolean(env) refactor would wrongly enable", async () => {
    process.env[ENV] = "false";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 5 }]); // the count only — no DELETE call reaches sql
    const res = await post({}, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: false, forced_dry_run: true, dry_run: true, deleted: 0 });
    expect(H.sql).toHaveBeenCalledTimes(1);
  });

  it("BENCH_LEVEL_RETENTION=off also stays disabled, and is case-insensitive (ON/On/on all enable)", async () => {
    process.env[ENV] = "off";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 0 }]);
    const off = await post({}, { authorization: "Bearer sekret" });
    expect((await off.json() as Record<string, unknown>)).toMatchObject({ enabled: false });

    for (const v of ["ON", "On", "TRUE", "Yes"]) {
      process.env[ENV] = v;
      H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
      const res = await post({}, { authorization: "Bearer sekret" });
      expect((await res.json() as Record<string, unknown>), `BENCH_LEVEL_RETENTION=${v}`).toMatchObject({ enabled: true });
    }
  });

  it("a malformed value THROWS rather than reading as off — surfaced as a route failure, before any DB call", async () => {
    process.env[ENV] = "maybe";
    process.env.MIGRATION_SECRET = "sekret";
    const res = await post({}, { authorization: "Bearer sekret" });
    // PIPELINE_FAILED -> 500 (lib/respond.ts), not a 200 with enabled:false — a typo must be
    // visible, not silently treated as "the flag is off".
    expect(res.status).toBe(500);
    expect(H.sql).not.toHaveBeenCalled(); // parseFlag throws before countOldLevelSamples runs
  });

  it("the cron GET path is subject to the same strict parsing as POST", async () => {
    process.env[ENV] = "not-a-flag";
    const res = await get({ "x-vercel-cron": "1" });
    expect(res.status).toBe(500);
    expect(H.sql).not.toHaveBeenCalled();
  });
});

describe("route: enabled — it actually deletes, batched, idempotent, capped", () => {
  it("loops batches until one comes back short, and sums the deleted count", async () => {
    process.env[ENV] = "on";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql
      .mockResolvedValueOnce([{ n: 12_000 }]) // count
      .mockResolvedValueOnce(Array.from({ length: 5_000 }, (_, i) => ({ id: i }))) // batch 1: full
      .mockResolvedValueOnce(Array.from({ length: 5_000 }, (_, i) => ({ id: i + 5_000 }))) // batch 2: full
      .mockResolvedValueOnce(Array.from({ length: 2_000 }, (_, i) => ({ id: i + 10_000 }))); // batch 3: short -> stop
    const res = await post({}, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, dry_run: false, matched_before: 12_000, deleted: 12_000, batches_run: 3, capped: false });
  });

  it("a rerun with nothing left deletes 0 and stops after one batch (idempotent)", async () => {
    process.env[ENV] = "on";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const res = await post({}, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ deleted: 0, batches_run: 1, matched_before: 0 });
  });

  it("stops at LEVEL_RETENTION_MAX_BATCHES and reports capped:true", async () => {
    process.env[ENV] = "on";
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 1_000_000 }]);
    for (let i = 0; i < 60; i++) H.sql.mockResolvedValueOnce(Array.from({ length: LEVEL_RETENTION_BATCH_SIZE }, (_, j) => ({ id: j })));
    const res = await post({}, { authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ capped: true, batches_run: 50, deleted: 50 * LEVEL_RETENTION_BATCH_SIZE });
  });
});

describe("route auth: same shape as reap-stuck (admin cookie OR MIGRATION_SECRET; cron header OR CRON_SECRET)", () => {
  it("POST with no cookie and no secret is refused, and touches sql not at all", async () => {
    delete process.env.MIGRATION_SECRET;
    const res = await post({});
    expect(res.status).toBe(401);
    expect(H.sql).not.toHaveBeenCalled();
  });

  it("POST with an admin cookie passes without MIGRATION_SECRET", async () => {
    delete process.env.MIGRATION_SECRET;
    H.cookie = "jwt.fixture";
    H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    process.env[ENV] = "on";
    expect((await post({})).status).toBe(200);
    expect(H.verify).toHaveBeenCalledWith("jwt.fixture");
  });

  it("POST with the wrong bearer is refused", async () => {
    process.env.MIGRATION_SECRET = "sekret";
    const res = await post({}, { authorization: "Bearer nope" });
    expect(res.status).toBe(401);
  });

  it("GET with no cron header and no CRON_SECRET configured is refused", async () => {
    delete process.env.CRON_SECRET;
    expect((await get()).status).toBe(401);
    expect(H.sql).not.toHaveBeenCalled();
  });

  it("GET with CRON_SECRET configured but the wrong bearer is refused", async () => {
    process.env.CRON_SECRET = "cronsekret";
    expect((await get({ authorization: "Bearer nope" })).status).toBe(401);
  });

  it("GET passes with the x-vercel-cron header alone, no secret needed", async () => {
    process.env[ENV] = "on";
    H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    expect((await get({ "x-vercel-cron": "1" })).status).toBe(200);
  });

  it("GET passes with a configured CRON_SECRET bearer", async () => {
    process.env.CRON_SECRET = "cronsekret";
    process.env[ENV] = "on";
    H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    expect((await get({ authorization: "Bearer cronsekret" })).status).toBe(200);
  });
});

describe("Refuter finding 2 — a successful run is logged, not only a failed one", () => {
  it("POST logs the result at console.log, unmuted", async () => {
    process.env.MIGRATION_SECRET = "sekret";
    delete process.env[ENV];
    H.sql.mockResolvedValueOnce([{ n: 4 }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await post({}, { authorization: "Bearer sekret" });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("[bench-levels-retention]") && String(c[1]).includes("matched_before"))).toBe(true);
    spy.mockRestore();
  });

  it("GET (cron) logs the result too, including a forced dry run", async () => {
    delete process.env[ENV];
    H.sql.mockResolvedValueOnce([{ n: 0 }]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await get({ "x-vercel-cron": "1" });
    expect(spy.mock.calls.some((c) => String(c[0]).includes("[bench-levels-retention]"))).toBe(true);
    spy.mockRestore();
  });

  it("a refused call (bad auth) logs nothing — there is no result to log", async () => {
    delete process.env.MIGRATION_SECRET;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await post({});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("vercel.json — the cron entry is wired, hourly, offset from the top of the hour", () => {
  it("lists /api/admin/bench/levels-retention", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as {
      crons: Array<{ path: string; schedule: string }>;
    };
    const entry = cfg.crons.find((c) => c.path === "/api/admin/bench/levels-retention");
    expect(entry, "the retention route must be scheduled").toBeDefined();
    // Refuter finding 1: hourly, not daily — a daily cron falls behind past ~9-23 rooms.
    expect(entry!.schedule).toMatch(/^\S+\s+\*\s+\*\s+\*\s+\*$/);
    expect(entry!.schedule).not.toBe("0 * * * *"); // offset from reap-stuck, not required but tidy
  });

  it("the report route is NOT scheduled — it is for a human to call, not a cron", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as {
      crons: Array<{ path: string }>;
    };
    expect(cfg.crons.some((c) => c.path.includes("levels-retention/report"))).toBe(false);
  });
});

describe("oldLevelSamplesByRoom — SQL shape and mapping", () => {
  it("groups by room, orders largest first, and never deletes", async () => {
    H.sql.mockResolvedValueOnce([
      { room_id: "room_b", n: 500, oldest: "2026-09-01", newest: "2026-09-14" },
      { room_id: "room_a", n: 9000, oldest: "2026-08-20", newest: "2026-09-14" },
    ]);
    const rows = await oldLevelSamplesByRoom("2026-09-15");
    expect(rows).toEqual([
      { room_id: "room_b", count: 500, oldest_ist_date: "2026-09-01", newest_ist_date: "2026-09-14" },
      { room_id: "room_a", count: 9000, oldest_ist_date: "2026-08-20", newest_ist_date: "2026-09-14" },
    ]);
    const text = String(H.sql.mock.calls[0]![0]);
    expect(text).toMatch(/GROUP BY room_id/i);
    expect(text).toMatch(/ist_date\s*<(?!=).*::date/i);
    expect(text).not.toMatch(/DELETE|UPDATE|INSERT/i);
  });

  it("a Date object from the driver is normalised to YYYY-MM-DD, same as a string", async () => {
    H.sql.mockResolvedValueOnce([{ room_id: "room_x", n: 1, oldest: new Date("2026-09-01T00:00:00Z"), newest: new Date("2026-09-01T00:00:00Z") }]);
    const rows = await oldLevelSamplesByRoom("2026-09-15");
    expect(rows[0]).toMatchObject({ oldest_ist_date: "2026-09-01", newest_ist_date: "2026-09-01" });
  });

  it("no old rows in any room is an empty list, not an error", async () => {
    H.sql.mockResolvedValueOnce([]);
    expect(await oldLevelSamplesByRoom("2026-09-15")).toEqual([]);
  });
});

describe("GET /api/admin/bench/levels-retention/report — read-only, never deletes", () => {
  const reportGet = (headers: Record<string, string> = {}) =>
    reportGET(new NextRequest("http://localhost/api/admin/bench/levels-retention/report", { headers }));

  it("requires auth, same as the retention route", async () => {
    delete process.env.MIGRATION_SECRET;
    const res = await reportGet();
    expect(res.status).toBe(401);
    expect(H.sql).not.toHaveBeenCalled();
  });

  it("reports the total and the per-room breakdown, and issues no DELETE regardless of BENCH_LEVEL_RETENTION", async () => {
    process.env.MIGRATION_SECRET = "sekret";
    process.env[ENV] = "on"; // even enabled, this route must never delete
    H.sql
      .mockResolvedValueOnce([{ n: 12_000 }])
      .mockResolvedValueOnce([{ room_id: "room_a", n: 12_000, oldest: "2026-09-01", newest: "2026-09-14" }]);
    const res = await reportGet({ authorization: "Bearer sekret" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      would_delete_total: 12_000,
      rooms_affected: 1,
      would_delete_by_room: [{ room_id: "room_a", count: 12_000, oldest_ist_date: "2026-09-01", newest_ist_date: "2026-09-14" }],
    });
    for (const [text] of H.sql.mock.calls) expect(String(text)).not.toMatch(/DELETE|UPDATE|INSERT/i);
  });

  it("has no POST export — the file cannot be called to write", async () => {
    const mod = await import("@/app/api/admin/bench/levels-retention/report/route");
    expect((mod as Record<string, unknown>).POST).toBeUndefined();
  });

  it("an empty fleet reports zero, not an error", async () => {
    process.env.MIGRATION_SECRET = "sekret";
    H.sql.mockResolvedValueOnce([{ n: 0 }]).mockResolvedValueOnce([]);
    const res = await reportGet({ authorization: "Bearer sekret" });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ would_delete_total: 0, rooms_affected: 0, would_delete_by_room: [] });
  });
});
