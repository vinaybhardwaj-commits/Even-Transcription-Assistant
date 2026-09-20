/**
 * POST /api/admin/bench/clip-urls — THE QUERY, AGAINST A REAL POSTGRES.
 *
 * tests/unit/operator-token-bench.test.ts drives the route with a mocked `sql`, which can show that
 * the route builds a statement but not that Postgres accepts it. `id = ANY($1::text[])` with a JS
 * array bound as one parameter is exactly the kind of line a mock lets through, so this file runs
 * the real route against the repo's Docker Postgres (tests/support/s1-pg.ts binds values as $1..$n,
 * like the app's driver). Only the auth doors and R2 presigning are stubbed.
 *
 * The table is bench_window as the live schema has it for the two columns the route reads:
 * id text NOT NULL (primary key), clip_r2_key text NULL.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  sign: vi.fn(async (o: { key: string; expiresInSeconds?: number }) => `https://r2.example/${o.key}?exp=${o.expiresInSeconds}`),
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: (o: { key: string; expiresInSeconds?: number }) => H.sign(o) }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => null }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: async () => ({ admin_id: "unused" }) }));

import { POST } from "@/app/api/admin/bench/clip-urls/route";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-operator-token-clip-urls");
const TOKEN = "fixture-operator-token-0123456789abcdef";

describe("REQUIRED PROOF — the clip-urls query runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/operator-token-clip-urls-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to skip on purpose.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  process.env.OPERATOR_TOKEN = TOKEN;
  pg.start();
  pg.exec(`
    CREATE TABLE bench_window (id text PRIMARY KEY, clip_r2_key text);
    INSERT INTO bench_window (id, clip_r2_key) VALUES
      ('bw_present_1', 'clips/one.webm'),
      ('bw_present_2', 'clips/two.webm'),
      ('bw_null_1', NULL),
      ('bw_null_2', NULL),
      ('bw_blank', '   ');
  `);
  H.sql = pg.sql;
});
afterAll(() => {
  delete process.env.OPERATOR_TOKEN;
  if (HAVE_DOCKER) pg.stop();
});

const ask = async (ids: string[]) => {
  const res = await POST(new NextRequest("http://localhost/api/admin/bench/clip-urls", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ window_ids: ids }),
  }));
  return { status: res.status, json: (await res.json()) as { urls: Record<string, string>; missing: number } };
};

describe.runIf(HAVE_DOCKER)("clip-urls against real rows", () => {
  it("present, null, blank and non-existent ids: urls for the present, missing counts null and blank, ghosts are omitted", async () => {
    const { status, json } = await ask(["bw_present_1", "bw_null_1", "bw_blank", "bw_ghost", "bw_present_2", "bw_null_2"]);
    expect(status).toBe(200);
    expect(Object.keys(json.urls).sort()).toEqual(["bw_present_1", "bw_present_2"]);
    expect(json.missing).toBe(3);
    expect(json.urls.bw_present_1).toContain("clips/one.webm");
    expect(json.urls.bw_present_1).toContain("exp=3600");
  }, 120_000);

  it("only ghosts: 200, nothing, missing 0", async () => {
    expect(await ask(["bw_nope_1", "bw_nope_2"])).toEqual({ status: 200, json: { urls: {}, missing: 0 } });
  }, 120_000);

  it("an id that looks like SQL is just an id: it is bound, not interpolated", async () => {
    const { status, json } = await ask(["bw_present_1'; DROP TABLE bench_window; --", "bw_present_1"]);
    expect(status).toBe(200);
    expect(Object.keys(json.urls)).toEqual(["bw_present_1"]);
    // the table is still there
    expect(await ask(["bw_present_2"])).toMatchObject({ status: 200, json: { urls: { bw_present_2: expect.any(String) } } });
  }, 120_000);

  it("the full 50 ids in one call are accepted by the driver's array binding", async () => {
    const ids = ["bw_present_1", ...Array.from({ length: 49 }, (_, i) => `bw_g${i}`)];
    const { status, json } = await ask(ids);
    expect(status).toBe(200);
    expect(Object.keys(json.urls)).toEqual(["bw_present_1"]);
  }, 120_000);
});
