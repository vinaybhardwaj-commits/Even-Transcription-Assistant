/**
 * mcp-path-key.test.ts — the path-key MCP door (/api/mcp/<SCRIBE_MCP_TOKEN>; path-key
 * addendum, 20 Aug 2026). Drives the REAL route modules end to end (no DB is touched:
 * tools/list and auth paths never query), asserting the kickoff's five behaviours:
 * correct key authorises · wrong key 401 · empty/missing key 401 · unset token 503 with
 * no key able to pass · the path route and the header route expose an identical tool list.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET as pathGet, OPTIONS as pathOptions, POST as pathPost } from "@/app/api/mcp/[key]/route";
import { GET as headerGet, POST as headerPost } from "@/app/api/mcp/route";

const TOKEN = "test-scribe-token-1234";
const ORIGINAL = process.env.SCRIBE_MCP_TOKEN;

const rpc = (method: string, id = 1) => JSON.stringify({ jsonrpc: "2.0", id, method });

function pathReq(body: string): NextRequest {
  // The URL's own path segment is irrelevant to the route function — Next passes the key
  // via ctx.params — but keep it realistic.
  return new NextRequest("https://scribe.test/api/mcp/some-key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

const ctxWith = (key: string) => ({ params: Promise.resolve({ key }) });

function headerReq(body: string, token?: string): NextRequest {
  return new NextRequest("https://scribe.test/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    body,
  });
}

beforeEach(() => {
  process.env.SCRIBE_MCP_TOKEN = TOKEN;
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SCRIBE_MCP_TOKEN;
  else process.env.SCRIBE_MCP_TOKEN = ORIGINAL;
});

describe("path-key auth (same token, same comparison, same answers)", () => {
  it("a correct key on the path authorises — ping answers as the header form does", async () => {
    const res = await pathPost(pathReq(rpc("ping")), ctxWith(TOKEN));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("a wrong key returns the same 401 as a wrong header", async () => {
    const viaPath = await pathPost(pathReq(rpc("ping")), ctxWith("wrong-key"));
    const viaHeader = await headerPost(headerReq(rpc("ping"), "wrong-key"));
    expect(viaPath.status).toBe(401);
    expect(viaHeader.status).toBe(401);
    const [p, h] = [await viaPath.json(), await viaHeader.json()];
    expect(p).toEqual(h);
    expect(p.error).toMatchObject({ code: -32000, message: "unauthorized" });
  });

  it("an empty or missing key returns 401, never authorises", async () => {
    for (const key of ["", "   ", undefined as unknown as string]) {
      const res = await pathPost(pathReq(rpc("ping")), ctxWith(key));
      expect(res.status).toBe(401);
      expect((await res.json()).error.message).toBe("unauthorized");
    }
    // header-illegal bytes in the key degrade to 401 too — never a 500, never a pass
    const weird = await pathPost(pathReq(rpc("ping")), ctxWith("bad\r\nkey"));
    expect(weird.status).toBe(401);
  });

  it("an unset SCRIBE_MCP_TOKEN returns the same 503 as the header form, and no key value can pass", async () => {
    delete process.env.SCRIBE_MCP_TOKEN;
    for (const key of [TOKEN, "", "anything", "bad\r\nkey"]) {
      const res = await pathPost(pathReq(rpc("ping")), ctxWith(key));
      expect(res.status).toBe(503);
      expect((await res.json()).error.message).toBe("mcp_token_not_configured");
    }
    const viaHeader = await headerPost(headerReq(rpc("ping"), TOKEN));
    expect(viaHeader.status).toBe(503);
  });
});

describe("one handler, two doors", () => {
  it("the path route and the header route expose an identical tool list", async () => {
    const viaPath = await pathPost(pathReq(rpc("tools/list", 7)), ctxWith(TOKEN));
    const viaHeader = await headerPost(headerReq(rpc("tools/list", 7), TOKEN));
    expect(viaPath.status).toBe(200);
    expect(viaHeader.status).toBe(200);
    const [p, h] = [await viaPath.json(), await viaHeader.json()];
    expect(p.result.tools.length).toBeGreaterThan(0);
    // identical: names, descriptions, schemas, annotations — the whole surface
    expect(p.result).toEqual(h.result);
  });

  it("GET returns the existing banner without a key check, and OPTIONS answers 204 with CORS", async () => {
    const viaPath = await pathGet();
    const viaHeader = await headerGet();
    const [p, h] = [await viaPath.json(), await viaHeader.json()];
    expect(p).toEqual(h); // same static banner, no tool names, no secrets
    expect(viaPath.headers.get("access-control-allow-origin")).toBe("*");
    const opt = await pathOptions();
    expect(opt.status).toBe(204);
    expect(opt.headers.get("access-control-allow-origin")).toBe("*");
    expect(opt.headers.get("access-control-allow-headers")).toContain("content-type");
  });
});
