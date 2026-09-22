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
} from "@/lib/bench-levels";
import { GET, POST } from "@/app/api/admin/bench/levels-retention/route";

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
    expect(String(text)).toMatch(/ist_date\s*<.*::date/i);
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
