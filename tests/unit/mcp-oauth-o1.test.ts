/**
 * OAUTH-O1 — discovery documents and the 401 challenge. Drives the REAL route modules. Synthetic tokens only; no database is touched
 * (auth failures and the .well-known routes never query), so the db module is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));

import { GET as prmRootGet, OPTIONS as prmRootOptions } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as prmPathGet, OPTIONS as prmPathOptions } from "@/app/.well-known/oauth-protected-resource/api/mcp/route";
import { GET as asGet, OPTIONS as asOptions } from "@/app/.well-known/oauth-authorization-server/route";
import { POST as headerPost } from "@/app/api/mcp/route";
import { POST as labPost } from "@/app/api/mcp/lab/route";
import { POST as pathKeyPost } from "@/app/api/mcp/[key]/route";
import { POST as pathKeyLabPost } from "@/app/api/mcp/[key]/lab/route";
import { MCP_TOKENS_DENY_ENV } from "@/lib/mcp/auth";
import { resetDeniedAuditForTests } from "@/lib/mcp/audit";
import { resetOauthFlagWarningForTests } from "@/lib/mcp/oauth/config";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const GOOD = "g".repeat(24);
const BAD = "b".repeat(24);
const DENIED = "d".repeat(24);
const CHALLENGE = 'Bearer resource_metadata="https://www.evenscribe.app/.well-known/oauth-protected-resource/api/mcp"';
const PRM = {
  resource: "https://www.evenscribe.app/api/mcp",
  authorization_servers: ["https://www.evenscribe.app"],
  bearer_methods_supported: ["header"],
  scopes_supported: ["read", "invoke", "write", "admin"],
};
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const post = (path: string, token?: string) =>
  new NextRequest(`https://scribe.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
const ctx = (key: string) => ({ params: Promise.resolve({ key }) });
const dump = async (r: Response) => ({ status: r.status, headers: [...r.headers.entries()].sort(), text: await r.text() });

const ENV = { ...process.env };
beforeEach(() => {
  for (const k of ["SCRIBE_MCP_TOKEN", "SCRIBE_MCP_TOKENS", "SCRIBE_MCP_TOKENS_EXTRA", "SCRIBE_MCP_TOKENS_ADMIN", "SCRIBE_MCP_TOKENS_ADMIN_2", MCP_TOKENS_DENY_ENV, "SCRIBE_MCP_OAUTH", "SCRIBE_MCP_RESOURCE_URL", "SCRIBE_MCP_OAUTH_ISSUER"]) delete process.env[k];
  process.env.SCRIBE_MCP_TOKEN = GOOD;
  process.env[MCP_TOKENS_DENY_ENV] = JSON.stringify([sha(DENIED)]);
  resetDeniedAuditForTests();
  resetOauthFlagWarningForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

describe("flag on: discovery documents", () => {
  beforeEach(() => { process.env.SCRIBE_MCP_OAUTH = "on"; });

  it("protected resource metadata body is exact on both paths", async () => {
    for (const get of [prmRootGet, prmPathGet]) {
      const res = await get();
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PRM);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
  });

  it("authorization server metadata has exactly the specified keys and values", async () => {
    const res = await asGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({
      issuer: "https://www.evenscribe.app",
      authorization_endpoint: "https://www.evenscribe.app/api/oauth/authorize",
      token_endpoint: "https://www.evenscribe.app/api/oauth/token",
      registration_endpoint: "https://www.evenscribe.app/api/oauth/register",
      revocation_endpoint: "https://www.evenscribe.app/api/oauth/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["read", "invoke", "write", "admin", "offline_access"],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("OPTIONS answers 204 with CORS allowing GET from any origin, on all three routes", async () => {
    for (const opt of [prmRootOptions, prmPathOptions, asOptions]) {
      const res = await opt();
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    }
  });

  it("env overrides move resource and issuer (previews); a non-https or garbage value is ignored", async () => {
    process.env.SCRIBE_MCP_RESOURCE_URL = "https://preview-abc.example.test/api/mcp";
    process.env.SCRIBE_MCP_OAUTH_ISSUER = "https://preview-abc.example.test/";
    expect(await (await prmPathGet()).json()).toEqual({ ...PRM, resource: "https://preview-abc.example.test/api/mcp", authorization_servers: ["https://preview-abc.example.test"] });
    expect((await (await asGet()).json()).token_endpoint).toBe("https://preview-abc.example.test/api/oauth/token");
    const res = await headerPost(post("/api/mcp"));
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://preview-abc.example.test/.well-known/oauth-protected-resource/api/mcp"');

    process.env.SCRIBE_MCP_RESOURCE_URL = "http://insecure.example.test/api/mcp";
    process.env.SCRIBE_MCP_OAUTH_ISSUER = "not a url";
    expect(await (await prmRootGet()).json()).toEqual(PRM);
  });

  const REJECTED = [
    "https://p.example.test/api/mcp?x=1", "https://p.example.test/api/mcp#frag", "https://p.example.test/api/mcp?", "https://p.example.test/api/mcp#",
    "https://user" + "@" + "p.example.test/api/mcp", "https://user:pw" + "@" + "p.example.test/api/mcp", "https://p.example.test/a" + "@" + "b",
    "https://p.example.test/api /mcp", "https://p.example.test/api\tmcp", 'https://p.example.test/api/"mcp', "https://p.example.test/api/'mcp", "https://p.example.test/api/`mcp",
    "https://p.example.test\\evil.example.test/x", "ftp://p.example.test/api/mcp", "//p.example.test/api/mcp", "https://",
  ];
  it("each rejected override shape falls back to the default, for resource and for issuer", async () => {
    for (const bad of REJECTED) {
      process.env.SCRIBE_MCP_RESOURCE_URL = bad;
      process.env.SCRIBE_MCP_OAUTH_ISSUER = bad;
      expect(await (await prmRootGet()).json(), bad).toEqual(PRM);
      expect((await (await asGet()).json()).issuer, bad).toBe("https://www.evenscribe.app");
    }
  });

  it("an accepted override is normalised to the lowercase origin plus the pathname without trailing slashes", async () => {
    process.env.SCRIBE_MCP_RESOURCE_URL = "https://Preview-ABC.Example.TEST/api/mcp///";
    process.env.SCRIBE_MCP_OAUTH_ISSUER = "https://Preview-ABC.Example.TEST///";
    expect(await (await prmRootGet()).json()).toEqual({ ...PRM, resource: "https://preview-abc.example.test/api/mcp", authorization_servers: ["https://preview-abc.example.test"] });
    expect((await (await asGet()).json()).issuer).toBe("https://preview-abc.example.test");
    process.env.SCRIBE_MCP_RESOURCE_URL = "https://preview-abc.example.test:8443/api/mcp/";
    expect((await (await prmRootGet()).json()).resource).toBe("https://preview-abc.example.test:8443/api/mcp");
  });
});

describe("flag on: the 401 challenge", () => {
  beforeEach(() => { process.env.SCRIBE_MCP_OAUTH = "on"; });

  it("no header, bad bearer and denied bearer all get the same 401 body and the challenge on /api/mcp", async () => {
    const seen = [];
    for (const tok of [undefined, BAD, DENIED]) {
      const res = await headerPost(post("/api/mcp", tok));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
      seen.push(await res.text());
    }
    expect(new Set(seen).size).toBe(1); // no oracle: denied is indistinguishable
  });

  it("/api/mcp/lab gets NO challenge (lead ruling): same 401 status and body, no www-authenticate, with the flag on", async () => {
    const main = await (await headerPost(post("/api/mcp", BAD))).text();
    for (const tok of [undefined, BAD, DENIED]) {
      const res = await labPost(post("/api/mcp/lab", tok));
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
      expect(await res.text()).toBe(main);
    }
  });

  it("a valid static bearer is a 200 with no challenge", async () => {
    for (const [handler, path] of [[headerPost, "/api/mcp"], [labPost, "/api/mcp/lab"]] as const) {
      const res = await handler(post(path, GOOD));
      expect(res.status).toBe(200);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("the 503 not-configured path is unchanged: no challenge", async () => {
    delete process.env.SCRIBE_MCP_TOKEN;
    const res = await headerPost(post("/api/mcp", BAD));
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("path-key doors never carry the challenge", async () => {
    const a = await pathKeyPost(post("/api/mcp/x"), ctx(BAD));
    const b = await pathKeyLabPost(post("/api/mcp/x/lab"), ctx(DENIED));
    for (const res of [a, b]) {
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });
});

describe("flag off (default): byte-identical to today", () => {
  it("the 401 has no challenge and its headers and body are exactly the pre-slice shape", async () => {
    for (const tok of [undefined, BAD, DENIED]) {
      const d = await dump(await headerPost(post("/api/mcp", tok)));
      expect(d.status).toBe(401);
      expect(d.headers.map(([k]) => k)).toEqual(["cache-control", "content-type"]);
      expect(d.headers).toEqual([["cache-control", "no-store"], ["content-type", "application/json; charset=utf-8"]]);
      expect(JSON.parse(d.text)).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized" } });
    }
  });

  it("flag-off and flag-on 401 bodies and statuses are equal (only the header differs)", async () => {
    const off = await dump(await headerPost(post("/api/mcp", BAD)));
    process.env.SCRIBE_MCP_OAUTH = "on";
    const on = await dump(await headerPost(post("/api/mcp", BAD)));
    expect(on.text).toBe(off.text);
    expect(on.status).toBe(off.status);
    expect(on.headers.filter(([k]) => k !== "www-authenticate")).toEqual(off.headers);
  });

  it("every .well-known route answers 404 to GET and OPTIONS", async () => {
    for (const fn of [prmRootGet, prmPathGet, asGet, prmRootOptions, prmPathOptions, asOptions]) {
      const res = await fn();
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
    }
  });

  it('explicit "off", blank and an unknown value all count as off; unknown logs one count-only line', async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const v of ["off", "", "  "]) {
      process.env.SCRIBE_MCP_OAUTH = v;
      expect((await prmRootGet()).status).toBe(404);
    }
    expect(warn).not.toHaveBeenCalled();
    process.env.SCRIBE_MCP_OAUTH = "yes-please";
    expect((await prmRootGet()).status).toBe(404);
    expect((await asGet()).status).toBe(404);
    expect((await headerPost(post("/api/mcp", BAD))).headers.get("www-authenticate")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("yes-please");
  });

  it("a valid static bearer is unchanged", async () => {
    expect((await headerPost(post("/api/mcp", GOOD))).status).toBe(200);
  });
});
