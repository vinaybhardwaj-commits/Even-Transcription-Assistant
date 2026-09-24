/**
 * Ruling 135 / #391 — the repo is PUBLIC, so the bootstrap route carries no built-in admin address. The request body wins; else BOOTSTRAP_ADMIN_EMAIL;
 * else the route refuses before touching the database. (There is no admin allowlist: this was only a default for a one-off, bearer-guarded route.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const DB = vi.hoisted(() => ({ calls: [] as unknown[][], stopAfterFirst: true }));
vi.mock("@/lib/db", () => ({
  sql: async (_s: TemplateStringsArray, ...v: unknown[]) => { DB.calls.push(v); throw new Error("stop: first query seen"); },
}));

import { POST } from "@/app/api/admin/bootstrap/route";
import { NextRequest } from "next/server";

const req = (body: Record<string, unknown>) =>
  new NextRequest("https://x.test/api/admin/bootstrap", { method: "POST", headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: JSON.stringify(body) });

const SAVED = { ADMIN_TOKEN: process.env.ADMIN_TOKEN, BOOTSTRAP_ADMIN_EMAIL: process.env.BOOTSTRAP_ADMIN_EMAIL };
beforeEach(() => { DB.calls.length = 0; process.env.ADMIN_TOKEN = "tok"; delete process.env.BOOTSTRAP_ADMIN_EMAIL; vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.restoreAllMocks();
});

describe("POST /api/admin/bootstrap — no built-in admin email", () => {
  it("no admin_email and no env → refused as VALIDATION_FAILED, and the database is never touched", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/VALIDATION_FAILED/);
    expect(DB.calls, "no query ran").toHaveLength(0);
  });
  it("BOOTSTRAP_ADMIN_EMAIL is used when the body omits it", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "ops@example.test";
    await POST(req({}));
    expect(DB.calls[0]).toEqual(["ops@example.test"]);
  });
  it("the body's admin_email wins over the env", async () => {
    process.env.BOOTSTRAP_ADMIN_EMAIL = "ops@example.test";
    await POST(req({ admin_email: "body@example.test" }));
    expect(DB.calls[0]).toEqual(["body@example.test"]);
  });
  it("the source carries no personal address any more", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["app/api/admin/bootstrap/route.ts", "app/admin/page.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/vinay\.bhardwaj@even\.in/);
    }
    expect(readFileSync("docs/SPRINT-0-EXIT.md", "utf8"), "the Cloudflare account id is gone from the doc").not.toMatch(/\b[0-9a-f]{32}\b/);
  });
});
