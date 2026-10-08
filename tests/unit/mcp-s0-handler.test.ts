/**
 * Operator MCP S0 (8 Oct 2026) — door hygiene: GET 405 (S0.1), no listChanged (S0.2), audit honesty
 * (S0.3), the request log line (S0.4), structuredContent kept (S0.5: a consumer exists).
 * The tool surface is replaced by four fakes so each err_kind is reachable on purpose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const auditInserts: unknown[][] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (/^\s*INSERT INTO audit_log/.test(strings.join("?"))) auditInserts.push(values);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

vi.mock("@/lib/mcp/surface", async () => {
  const mk = (name: string, handler: () => Promise<unknown>) => ({
    name, description: name, scope: "read" as const, inputSchema: { type: "object" as const, properties: {} }, handler,
  });
  const ok = mk("t_ok", async () => ({ rooms: [] }));
  const resultError = mk("t_result_error", async () => ({ error: "kb_unreachable", rooms: [] }));
  const degraded = mk("t_degraded", async () => ({ degraded: true, rows: [] }));
  const boom = mk("t_throws", async () => { throw new Error("kaboom"); });
  const grouped = { ...mk("t_group", async () => ({ fine: true })), memberFor: () => "t_member" };
  const all = [ok, resultError, degraded, boom, grouped];
  return { LISTED_TOOLS: all, LAB_TOOLS: all, groupProbes: () => [], CALLABLE_TOOLS: new Map(all.map((t) => [t.name, t])) };
});

const { handleMcpRpc, mcpMethodNotAllowedResponse } = await import("@/lib/mcp/handler");
const { GET: headerGet, OPTIONS: headerOptionsMaybe } = (await import("@/app/api/mcp/route")) as { GET: () => Promise<Response>; OPTIONS?: () => Promise<Response> };
const { GET: pathGet, OPTIONS: pathOptions } = await import("@/app/api/mcp/[key]/route");

const rpc = async (body: unknown) => {
  const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await handleMcpRpc(req, { token_id: "op-test", scopes: new Set(["read"]) });
  return { status: res.status, body: (await res.json()) as Row };
};
const callTool = (name: string, args: Row = {}) => rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
const metaOf = (values: unknown[]) => JSON.parse(values.find((v) => typeof v === "string" && v.startsWith("{")) as string) as Row;
const flush = () => new Promise((r) => setTimeout(r, 0));

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  auditInserts.length = 0;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("S0.1 — GET is 405 on both doors", () => {
  it.each([
    ["header door", () => headerGet()],
    ["path-key door", () => pathGet()],
  ])("%s answers 405 with Allow: POST, OPTIONS and the fixed body", async (_n, get) => {
    const res = await get();
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
    expect(await res.json()).toEqual({ error: "method_not_allowed", hint: "Even Scribe MCP speaks JSON-RPC over POST" });
  });

  it("the path-key door still carries CORS on the 405, and OPTIONS is unchanged (204)", async () => {
    const res = await pathGet();
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const opt = await pathOptions();
    expect(opt.status).toBe(204);
    expect(opt.headers.get("access-control-allow-origin")).toBe("*");
    // S3.4: the header door now answers OPTIONS explicitly too (204, Allow, no CORS — it never had any).
    const hopt = await headerOptionsMaybe!();
    expect(hopt.status).toBe(204);
    expect(hopt.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("the 405 helper is static: no auth state, no tool names", async () => {
    const text = JSON.stringify(await mcpMethodNotAllowedResponse().json());
    expect(text).not.toMatch(/t_ok|scribe_|token/i);
  });
});

describe("S0.2 — initialize", () => {
  it("advertises tools:{} (no listChanged), keeps serverInfo and instructions", async () => {
    const { body } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const r = body.result as Row;
    expect(r.capabilities).toEqual({ tools: {} });
    expect((r.serverInfo as Row).name).toBe("even-scribe-mcp");
    expect(typeof (r.serverInfo as Row).version).toBe("string");
    expect(String(r.instructions)).toContain("Even Scribe operator door (S2)");
  });

  it("serverInfo.version is the git sha (7 chars) when VERCEL_GIT_COMMIT_SHA is set", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef0123456789");
    const { body } = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(((body.result as Row).serverInfo as Row).version).toBe("abcdef0");
    vi.unstubAllEnvs();
  });
});

describe("S0.3 — audit honesty (isError for callers is unchanged)", () => {
  it("a clean result audits ok:true, err_kind:null", async () => {
    const { body } = await callTool("t_ok");
    expect((body.result as Row).isError).toBe(false);
    await flush();
    expect(metaOf(auditInserts[0]!)).toMatchObject({ ok: true, err_kind: null });
  });

  it("a handler THROW audits ok:false, err_kind:'throw', and isError stays true", async () => {
    const { body } = await callTool("t_throws");
    expect((body.result as Row).isError).toBe(true);
    await flush();
    expect(metaOf(auditInserts[0]!)).toMatchObject({ ok: false, err_kind: "throw" });
  });

  it("a result {error:'…'} audits ok:false, err_kind:'result_error', and isError stays FALSE", async () => {
    const { body } = await callTool("t_result_error");
    expect((body.result as Row).isError).toBe(false);
    await flush();
    expect(metaOf(auditInserts[0]!)).toMatchObject({ ok: false, err_kind: "result_error" });
  });

  it("a result {degraded:true} audits ok:false, err_kind:'result_error', and isError stays false", async () => {
    const { body } = await callTool("t_degraded");
    expect((body.result as Row).isError).toBe(false);
    await flush();
    expect(metaOf(auditInserts[0]!)).toMatchObject({ ok: false, err_kind: "result_error" });
  });
});

describe("S0.4 — one log line per tools/call, no args", () => {
  const lines = () => logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("{") && l.includes('"mcp":"call"')).map((l) => JSON.parse(l) as Row);

  it("logs exactly {mcp,tool,variant,ms,ok,err_kind,actor,bytes_out}", async () => {
    await callTool("t_group", { secret_room: "OPD 7", q: "free text" });
    const [line] = lines();
    expect(Object.keys(line!).sort()).toEqual(["actor", "bytes_out", "err_kind", "mcp", "ms", "ok", "tool", "variant"]);
    expect(line).toMatchObject({ mcp: "call", tool: "t_group", variant: "t_member", ok: true, err_kind: null, actor: "mcp:op-test" });
    expect(line!.bytes_out).toBe(JSON.stringify({ fine: true }).length);
    expect(typeof line!.ms).toBe("number");
  });

  it("never contains arguments, a request path, a key or the user agent", async () => {
    const req = new NextRequest("https://x/api/mcp/SUPER-SECRET-KEY", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "claude-connector/9.9" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "t_ok", arguments: { room_id: "r_leak", q: "needle" } } }),
    });
    await handleMcpRpc(req, { token_id: "op-test", scopes: new Set(["read"]) });
    const raw = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    for (const forbidden of ["r_leak", "needle", "SUPER-SECRET-KEY", "claude-connector", "arguments", '"args"']) expect(raw).not.toContain(forbidden);
  });

  it("records err_kind for a throw and a result error", async () => {
    await callTool("t_throws");
    await callTool("t_result_error");
    expect(lines().map((l) => [l.ok, l.err_kind])).toEqual([[false, "throw"], [false, "result_error"]]);
  });
});

describe("S0.5 — structuredContent is kept (lib/overnight-translate/door.ts reads it)", () => {
  it("tools/call still returns structuredContent beside content", async () => {
    const { body } = await callTool("t_ok");
    const r = body.result as Row;
    expect(r.structuredContent).toEqual({ rooms: [] });
    expect(JSON.parse(((r.content as Row[])[0] as Row).text as string)).toEqual({ rooms: [] });
  });
});
