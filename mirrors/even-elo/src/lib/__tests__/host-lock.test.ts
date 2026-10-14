import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";

const APP = join(process.cwd(), "src/app");
const dirs = (d: string) => readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory());
const pageDirs = dirs(APP).filter((d) => d !== "api" && d !== "portal");
const apiDirs = dirs(join(APP, "api")).filter((d) => d !== "portal");

const req = (host: string, path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });
const doctors = "doctors.evenos.app";
const gov = "governance.evenos.app";

describe("doctors host lock: forbidden prefixes 404", () => {
  it("discovers the directories", () => {
    expect(pageDirs).toContain("admin");
    expect(apiDirs).toContain("admin");
  });
  for (const d of pageDirs) {
    it(`page /${d}`, async () => {
      for (const p of [`/${d}`, `/${d}/x`]) expect((await middleware(req(doctors, p))).status).toBe(404);
    });
  }
  for (const d of apiDirs) {
    it(`api /api/${d}`, async () => {
      for (const p of [`/api/${d}`, `/api/${d}/x`]) expect((await middleware(req(doctors, p))).status).toBe(404);
    });
  }
  it("bypass shapes", async () => {
    for (const p of ["/.well-known/oauth-authorization-server", "/admin/x.png", "/api/mcp/x.svg", "/manifest.json", "/portalx", "/apix", "/api"]) {
      expect((await middleware(req(doctors, p))).status, p).toBe(404);
    }
  });
  it("404 body names nothing", async () => {
    const r = await middleware(req(doctors, "/admin"));
    expect(await r.text()).toBe("");
    expect(r.headers.get("location")).toBeNull();
  });
  it("localhost with test header acts as doctors host", async () => {
    expect((await middleware(req("localhost:3000", "/admin", { "x-test-host": "doctors" }))).status).toBe(404);
  });
});

describe("doctors host lock: permanent probes", () => {
  it("/_next/data is blocked", async () => {
    for (const p of ["/_next/data/abc/admin.json", "/_next/data/abc/portal.json", "/_next"]) {
      expect((await middleware(req(doctors, p))).status, p).toBe(404);
    }
  });
  it("RSC requests to staff routes are 404", async () => {
    for (const p of ["/admin", "/physicians", "/api/admin/users"]) {
      expect((await middleware(req(doctors, p, { RSC: "1" }))).status, p).toBe(404);
      expect((await middleware(req(doctors, `${p}?_rsc=x`))).status, p).toBe(404);
    }
  });
  it("prefetch requests to staff pages are 404", async () => {
    for (const p of ["/admin", "/physicians", "/home"]) {
      expect((await middleware(req(doctors, p, { "Next-Router-Prefetch": "1" }))).status, p).toBe(404);
      expect((await middleware(req(doctors, p, { Purpose: "prefetch" }))).status, p).toBe(404);
    }
  });
  it("encoded and traversal shapes never reach a staff page", async () => {
    for (const p of ["/%61dmin", "/portal/../admin", "/portal/%2e%2e/admin", "/_next/../admin", "/PORTAL"]) {
      const r = await middleware(req(doctors, p));
      expect(r.status, p).not.toBe(200);
      expect(r.headers.get("x-middleware-next"), p).toBeNull();
    }
  });
});

describe("doctors host lock: allowed paths", () => {
  it("not 404", async () => {
    for (const p of ["/portal", "/portal/login", "/portal/set-pin", "/api/portal/auth/login", "/api/portal/me", "/_next/static/chunk.js", "/_next/static/media/f.woff2", "/_next/image", "/favicon.ico", "/robots.txt"]) {
      expect((await middleware(req(doctors, p))).status, p).not.toBe(404);
    }
  });
  it("/ redirects to /portal", async () => {
    const r = await middleware(req(doctors, "/"));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe("/portal");
  });
});

describe("governance host unchanged", () => {
  it("forbidden paths are not 404 from the lock", async () => {
    for (const d of [...pageDirs.map((x) => `/${x}`), ...apiDirs.map((x) => `/api/${x}`)]) {
      expect((await middleware(req(gov, d))).status, d).not.toBe(404);
    }
  });
  it("unauthenticated staff path still redirects to login", async () => {
    const r = await middleware(req(gov, "/home"));
    expect(r.status).toBe(307);
    expect(new URL(r.headers.get("location")!).pathname).toBe("/auth/login");
  });
  it("test header is ignored off localhost", async () => {
    expect((await middleware(req(gov, "/home", { "x-test-host": "doctors" }))).status).toBe(307);
  });
});
