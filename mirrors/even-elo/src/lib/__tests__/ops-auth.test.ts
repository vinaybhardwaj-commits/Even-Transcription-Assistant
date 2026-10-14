import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSql, liveFromClaims, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  /** What the database says about the session's role right now. "claims" = same as the cookie. */
  live: "claims" as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
  neonSql: null as unknown as (...a: unknown[]) => unknown,
  neon: vi.fn(),
  computeMapping: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));
vi.mock("@neondatabase/serverless", () => ({ neon: h.neon }));
vi.mock("@/lib/staff-live", async (orig) => {
  const real = await orig<typeof import("@/lib/staff-live")>();
  const { liveFromClaims: fromClaims } = await import("./helpers/fixtures");
  return { ...real, loadLiveStaff: vi.fn(async () => (h.live === "claims" ? fromClaims(h.user) : h.live)) };
});
vi.mock("@/lib/cdmss-mapping-service", () => ({ computeMapping: h.computeMapping }));

import { checkOpsAuth } from "@/lib/ops-auth";
import * as migrate from "@/app/api/admin/migrate/route";
import * as dbFresh from "@/app/api/admin/db-fresh/route";
import * as dbSnapshot from "@/app/api/admin/db-snapshot/route";
import * as wipe from "@/app/api/admin/wipe-smoke-residue/route";
import * as seedEpiBase from "@/app/api/admin/seed-epi-base/route";
import * as seedProfile from "@/app/api/admin/seed-profile/route";
import * as oppeScheduler from "@/app/api/admin/oppe-scheduler/route";
import * as oppeKickstart from "@/app/api/admin/oppe-kickstart/route";
import * as bulkImport from "@/app/api/admin/bulk-import-physicians/route";
import * as dedupe from "@/app/api/admin/dedupe-physicians/route";
import * as mapDoctors from "@/app/api/admin/map-cdmss-doctors/route";

const TOKEN = "ops-token-0123456789abcdef";
const BASE = "https://governance.test/api/admin";

function request(path: string, method: string, auth?: string): NextRequest {
  return new NextRequest(`${BASE}/${path}`, { method, headers: auth ? { authorization: auth } : {} });
}

type Handler = (req: NextRequest) => Promise<Response>;
interface Case {
  name: string;
  path: string;
  method: "GET" | "POST";
  handler: Handler;
  /** Source file, relative to src/app/api/admin. */
  file: string;
}

const CASES: Case[] = [
  { name: "migrate POST", path: "migrate", method: "POST", handler: migrate.POST as Handler, file: "migrate" },
  { name: "migrate GET", path: "migrate", method: "GET", handler: migrate.GET as Handler, file: "migrate" },
  { name: "db-fresh GET", path: "db-fresh", method: "GET", handler: dbFresh.GET as Handler, file: "db-fresh" },
  { name: "db-snapshot GET", path: "db-snapshot", method: "GET", handler: dbSnapshot.GET as Handler, file: "db-snapshot" },
  { name: "wipe-smoke-residue POST", path: "wipe-smoke-residue", method: "POST", handler: wipe.POST as Handler, file: "wipe-smoke-residue" },
  { name: "seed-epi-base POST", path: "seed-epi-base", method: "POST", handler: seedEpiBase.POST as Handler, file: "seed-epi-base" },
  { name: "seed-profile POST", path: "seed-profile", method: "POST", handler: seedProfile.POST as Handler, file: "seed-profile" },
  { name: "oppe-scheduler POST", path: "oppe-scheduler", method: "POST", handler: oppeScheduler.POST as Handler, file: "oppe-scheduler" },
  { name: "oppe-scheduler GET", path: "oppe-scheduler", method: "GET", handler: oppeScheduler.GET as Handler, file: "oppe-scheduler" },
  { name: "oppe-kickstart POST", path: "oppe-kickstart", method: "POST", handler: oppeKickstart.POST as Handler, file: "oppe-kickstart" },
  { name: "bulk-import-physicians POST", path: "bulk-import-physicians", method: "POST", handler: bulkImport.POST as Handler, file: "bulk-import-physicians" },
  { name: "dedupe-physicians POST", path: "dedupe-physicians", method: "POST", handler: dedupe.POST as Handler, file: "dedupe-physicians" },
  { name: "map-cdmss-doctors GET (dry run)", path: "map-cdmss-doctors", method: "GET", handler: mapDoctors.GET as Handler, file: "map-cdmss-doctors" },
  { name: "map-cdmss-doctors POST (apply)", path: "map-cdmss-doctors", method: "POST", handler: mapDoctors.POST as Handler, file: "map-cdmss-doctors" },
];

const MAPPING = {
  directory_count: 1,
  coverage: { before: { linked_physicians: 0 }, after: { linked_physicians: 0 } },
  already_linked: [],
  auto: [],
  alias_updates: [],
  review: [],
  unmatched: [],
};

/** Nothing reached the database, the CDMSS directory or the mapping service. */
function expectUntouched() {
  expect(h.neon).not.toHaveBeenCalled();
  expect(h.sql).not.toHaveBeenCalled();
  expect(h.computeMapping).not.toHaveBeenCalled();
}

beforeEach(() => {
  h.live = "claims";
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.user = null;
  h.neon.mockReset();
  h.computeMapping.mockReset();
  h.computeMapping.mockResolvedValue(MAPPING);
  h.sql = fakeSql(() => []);
  // Every neon client answers every query with one generic row, so a request that gets past the
  // gate runs its happy path against a stub and never against a database.
  h.neonSql = fakeSql(() => [{ id: "p1" }]);
  h.neon.mockImplementation(() => h.neonSql);
  process.env.ADMIN_OPS_TOKEN = TOKEN;
  process.env.DATABASE_URL = "postgres://stub.invalid/db";
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ADMIN_OPS_TOKEN;
  delete process.env.DATABASE_URL;
});

describe("checkOpsAuth (pure)", () => {
  it("opens for an active super admin session", () => {
    expect(checkOpsAuth(null, undefined, staff.superAdmin)).toEqual({ ok: true, via: "session" });
  });
  it("opens for the exact bearer token", () => {
    expect(checkOpsAuth(`Bearer ${TOKEN}`, TOKEN, null)).toEqual({ ok: true, via: "token" });
  });
  it("fails closed when neither is present", () => {
    expect(checkOpsAuth(null, TOKEN, null)).toMatchObject({ ok: false, status: 401 });
    expect(checkOpsAuth(undefined, undefined, undefined)).toMatchObject({ ok: false, status: 401 });
  });
  it("an unset or empty token disables the bearer path instead of opening it", () => {
    for (const header of ["Bearer ", "Bearer", "Bearer undefined", "Bearer null", "", "undefined"]) {
      expect(checkOpsAuth(header, undefined, null).ok).toBe(false);
      expect(checkOpsAuth(header, "", null).ok).toBe(false);
    }
  });
  it("refuses a short token (a guessable secret is not a secret)", () => {
    expect(checkOpsAuth("Bearer abc", "abc", null).ok).toBe(false);
  });
  it("refuses a wrong token, a different scheme and a prefix of the token", () => {
    for (const header of ["Bearer wrong-token-0123456789abc", `Basic ${TOKEN}`, `Bearer ${TOKEN.slice(0, -1)}`, `bearer ${TOKEN}`, TOKEN]) {
      expect(checkOpsAuth(header, TOKEN, null).ok).toBe(false);
    }
  });
  it("only a super admin session counts: not SMH, SGO, HR, pending accounts or a physician token", () => {
    for (const u of [staff.smh, staff.sgo, staff.hr, staff.pending, staff.physicianToken]) {
      expect(checkOpsAuth(null, TOKEN, u).ok).toBe(false);
    }
    expect(checkOpsAuth(null, TOKEN, { status: "active", is_super_admin: true, kind: "physician" }).ok).toBe(false);
  });
});

describe("every gated /api/admin handler", () => {
  for (const c of CASES) {
    describe(c.name, () => {
      it("no credentials: 401 and nothing is touched", async () => {
        const res = await c.handler(request(c.path, c.method));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ ok: false, error: "Unauthorized" });
        expectUntouched();
      });

      it("a wrong bearer token: 401 and nothing is touched", async () => {
        const res = await c.handler(request(c.path, c.method, "Bearer not-the-token-0123456789"));
        expect(res.status).toBe(401);
        expectUntouched();
      });

      it("fails closed when ADMIN_OPS_TOKEN is unset, whatever the header says", async () => {
        delete process.env.ADMIN_OPS_TOKEN;
        for (const header of ["Bearer undefined", "Bearer ", "Bearer"]) {
          expect((await c.handler(request(c.path, c.method, header))).status).toBe(401);
        }
        expectUntouched();
      });

      it("staff who are not super admins, and doctor-portal tokens, are refused", async () => {
        for (const u of [staff.smh, staff.sgo, staff.hr, staff.pending, staff.physicianToken]) {
          h.user = u;
          expect((await c.handler(request(c.path, c.method))).status).toBe(401);
        }
        expectUntouched();
      });

      it("the right token or a super admin session gets past the gate", async () => {
        for (const mode of ["token", "session"] as const) {
          h.user = mode === "session" ? staff.superAdmin : null;
          const auth = mode === "token" ? `Bearer ${TOKEN}` : undefined;
          // The body may fail against the stub (empty request body, thin fake rows); that still
          // means the gate let it through. The only thing it must not be is a 401.
          const res = await c.handler(request(c.path, c.method, auth)).catch(() => "threw" as const);
          if (res !== "threw") expect(res.status).not.toBe(401);
        }
      });
    });
  }
});

describe("wipe-smoke-residue (the destructive one)", () => {
  const url = "wipe-smoke-residue";

  it("401 without credentials and truncates nothing", async () => {
    const res = await wipe.POST(request(url, "POST"));
    expect(res.status).toBe(401);
    expect(h.neon).not.toHaveBeenCalled();
    expect(h.neonSql).not.toHaveBeenCalled();
  });

  it("401 on a bad token and truncates nothing", async () => {
    const res = await wipe.POST(request(url, "POST", "Bearer wrong-token-0123456789abc"));
    expect(res.status).toBe(401);
    expect(h.neonSql).not.toHaveBeenCalled();
  });

  it("200 with the right token (stubbed database), and the wipe statements do run", async () => {
    const res = await wipe.POST(request(url, "POST", `Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    const texts = (h.neonSql as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => (c[0] as TemplateStringsArray).join("?"));
    expect(texts.some((t) => t.includes("TRUNCATE privilege_requests"))).toBe(true);
  });

  it("200 with a super admin session and no token", async () => {
    h.user = staff.superAdmin;
    delete process.env.ADMIN_OPS_TOKEN;
    const res = await wipe.POST(request(url, "POST"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("db-fresh", () => {
  const url = "db-fresh";

  it("401 without credentials", async () => {
    const res = await dbFresh.GET(request(url, "GET"));
    expect(res.status).toBe(401);
    expect(h.neon).not.toHaveBeenCalled();
  });

  it("401 on a bad token", async () => {
    expect((await dbFresh.GET(request(url, "GET", "Bearer wrong-token-0123456789abc"))).status).toBe(401);
    expect(h.neon).not.toHaveBeenCalled();
  });

  it("200 with the right token (stubbed database)", async () => {
    const res = await dbFresh.GET(request(url, "GET", `Bearer ${TOKEN}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { id: "p1" } });
  });

  it("200 with a super admin session and no token", async () => {
    h.user = staff.superAdmin;
    delete process.env.ADMIN_OPS_TOKEN;
    expect((await dbFresh.GET(request(url, "GET"))).status).toBe(200);
  });
});

describe("map-cdmss-doctors (dry-run GET and write POST)", () => {
  const url = "map-cdmss-doctors";

  it("401 without credentials, on both verbs, before the CDMSS directory is read", async () => {
    expect((await mapDoctors.GET(request(url, "GET"))).status).toBe(401);
    expect((await mapDoctors.POST(request(url, "POST"))).status).toBe(401);
    expect((await mapDoctors.POST(request(url + "?dry_run=1", "POST"))).status).toBe(401);
    expectUntouched();
  });

  it("401 on a bad token, on both verbs", async () => {
    const bad = "Bearer wrong-token-0123456789abc";
    expect((await mapDoctors.GET(request(url, "GET", bad))).status).toBe(401);
    expect((await mapDoctors.POST(request(url, "POST", bad))).status).toBe(401);
    expectUntouched();
  });

  it("200 with the right token: the dry run reads, the apply writes only through the stubbed client", async () => {
    const dry = await mapDoctors.GET(request(url, "GET", `Bearer ${TOKEN}`));
    expect(dry.status).toBe(200);
    expect(await dry.json()).toMatchObject({ ok: true, mode: "dry_run" });
    const apply = await mapDoctors.POST(request(url, "POST", `Bearer ${TOKEN}`));
    expect(apply.status).toBe(200);
    expect(await apply.json()).toMatchObject({ ok: true, mode: "apply", applied: 0 });
    const dryPost = await mapDoctors.POST(request(url + "?dry_run=1", "POST", `Bearer ${TOKEN}`));
    expect((await dryPost.json()).mode).toBe("dry_run");
  });

  it("200 with a super admin session and no token; other staff are refused", async () => {
    delete process.env.ADMIN_OPS_TOKEN;
    h.user = staff.superAdmin;
    expect((await mapDoctors.GET(request(url, "GET"))).status).toBe(200);
    expect((await mapDoctors.POST(request(url, "POST"))).status).toBe(200);
    h.computeMapping.mockClear();
    h.user = staff.smh;
    expect((await mapDoctors.GET(request(url, "GET"))).status).toBe(401);
    expect((await mapDoctors.POST(request(url, "POST"))).status).toBe(401);
    expect(h.computeMapping).not.toHaveBeenCalled();
  });
});

describe("role is re-read from the database (L3)", () => {
  it("a super admin whose flag was revoked after login is refused on every ops route, even with a valid cookie", async () => {
    h.user = staff.superAdmin; // the 7-day cookie still says super admin
    h.live = { ...liveFromClaims(staff.superAdmin)!, is_super_admin: false };
    for (const c of CASES) expect((await c.handler(request(c.path, c.method))).status, c.name).toBe(401);
    expectUntouched();
  });

  it("a deactivated account is refused", async () => {
    h.user = staff.superAdmin;
    h.live = { ...liveFromClaims(staff.superAdmin)!, status: "deactivated" };
    expect((await dbFresh.GET(request("db-fresh", "GET"))).status).toBe(401);
    expect((await wipe.POST(request("wipe-smoke-residue", "POST"))).status).toBe(401);
    expect(h.neon).not.toHaveBeenCalled();
  });

  it("a profile that no longer exists, or a database that cannot answer, fails closed", async () => {
    h.user = staff.superAdmin;
    h.live = null;
    expect((await mapDoctors.GET(request("map-cdmss-doctors", "GET"))).status).toBe(401);
    expect(h.computeMapping).not.toHaveBeenCalled();
  });

  it("the bearer token still works when the session is revoked or the database cannot confirm a role", async () => {
    h.user = staff.superAdmin;
    h.live = null;
    expect((await dbFresh.GET(request("db-fresh", "GET", `Bearer ${TOKEN}`))).status).toBe(200);
  });

  it("the live lookup runs only for a cookie that claims super admin (nothing to confirm otherwise)", async () => {
    const { loadLiveStaff } = await import("@/lib/staff-live");
    (loadLiveStaff as unknown as { mockClear: () => void }).mockClear();
    h.user = staff.smh;
    await dbFresh.GET(request("db-fresh", "GET"));
    h.user = staff.physicianToken;
    await dbFresh.GET(request("db-fresh", "GET"));
    h.user = null;
    await dbFresh.GET(request("db-fresh", "GET"));
    expect(loadLiveStaff).not.toHaveBeenCalled();
    h.user = staff.superAdmin;
    await dbFresh.GET(request("db-fresh", "GET"));
    expect(loadLiveStaff).toHaveBeenCalledTimes(1);
  });
});

describe("/api/admin/migrate specifics", () => {
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });

  it("GET without credentials never reads the marker table", async () => {
    const res = await migrate.GET(request("migrate", "GET"));
    expect(res.status).toBe(401);
    expect(h.sql).not.toHaveBeenCalled();
  });

  it("the right token gets past the gate (POST then stops at the missing DATABASE_URL, GET reads the marker table)", async () => {
    const post = await migrate.POST(request("migrate", "POST", `Bearer ${TOKEN}`));
    expect(post.status).toBe(500);
    expect((await post.json()).error).toMatch(/DATABASE_URL/);
    const get = await migrate.GET(request("migrate", "GET", `Bearer ${TOKEN}`));
    expect(get.status).toBe(200);
    expect((await get.json()).ok).toBe(true);
  });

  it("a super admin session gets past the gate without a token", async () => {
    h.user = staff.superAdmin;
    expect((await migrate.POST(request("migrate", "POST"))).status).toBe(500);
  });

  it("the old ADMIN_MIGRATE_TOKEN name is gone from the code", () => {
    for (const rel of ["src/middleware.ts", "src/app/api/admin/migrate/route.ts", "src/lib/ops-auth.ts"]) {
      expect(readFileSync(join(process.cwd(), rel), "utf8")).not.toContain("ADMIN_MIGRATE_TOKEN");
    }
  });
});

describe("source guards (a new admin route cannot ship open)", () => {
  const adminDir = join(process.cwd(), "src/app/api/admin");
  const middleware = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf8");

  /** Routes whose handler is not behind the middleware session check, from the bootstrap list. */
  const list = middleware.match(/ADMIN_BOOTSTRAP_ROUTES = \[([\s\S]*?)\];/)?.[1] ?? "";
  const bootstrap = (list.match(/"\/api\/admin\/[^"]+"/g) ?? []).map((m) => m.replace(/"\/api\/admin\/|"/g, ""));

  function routeFiles(dir: string, prefix = ""): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...routeFiles(full, `${prefix}${name}/`));
      else if (name === "route.ts") out.push(prefix.replace(/\/$/, ""));
    }
    return out;
  }

  it("every route on the middleware bootstrap list except portal-welcome calls requireOps in EVERY handler, first", () => {
    expect(bootstrap.length).toBeGreaterThanOrEqual(11);
    for (const name of bootstrap) {
      if (name === "portal-welcome") continue;
      const src = readFileSync(join(adminDir, name, "route.ts"), "utf8");
      const handlers = src.match(/export async function (GET|POST|PUT|PATCH|DELETE)\b/g) ?? [];
      const gated =
        src.match(
          /export async function (?:GET|POST|PUT|PATCH|DELETE)\(req: (?:Request|NextRequest)\) \{\n  const denied = await requireOps\(req\);\n  if \(denied\) return denied;\n/g,
        ) ?? [];
      expect(handlers.length, name).toBeGreaterThan(0);
      expect(gated.length, `${name}: ${handlers.length} handler(s), ${gated.length} gated first`).toBe(handlers.length);
    }
  });

  it("the gated routes in this file's matrix are exactly the bootstrap list minus portal-welcome", () => {
    const covered = new Set(CASES.map((c) => c.file));
    expect(Array.from(covered).sort()).toEqual(bootstrap.filter((n) => n !== "portal-welcome").sort());
  });

  it("every other /api/admin route authenticates itself (session, role or its own token)", () => {
    const marker =
      /requireOps|getCurrentUser|actorFromRequest|requireStaff|requireSuperAdmin|EXPIRY_ALERT_TOKEN|MCP_BEARER_TOKEN|is_super_admin/;
    const bare: string[] = [];
    for (const name of routeFiles(adminDir)) {
      // clinical-metrics/template serves a static sample CSV; the middleware session check covers it.
      if (name === "clinical-metrics/template") continue;
      const src = readFileSync(join(adminDir, name, "route.ts"), "utf8");
      if (!marker.test(src)) bare.push(name);
    }
    expect(bare).toEqual([]);
  });

  it("the middleware still lets the bearer path reach the gated routes", () => {
    expect(middleware).toMatch(/ADMIN_BOOTSTRAP_ROUTES = \[\s*"\/api\/admin\/migrate"/);
    expect(middleware).toContain("ADMIN_OPS_TOKEN");
    expect(bootstrap).toContain("map-cdmss-doctors");
  });
});
