/**
 * OAUTH-O3-FIX1 MUST-2 (V: the audit is MANDATORY): for a person principal the audit row is AWAITED before the response is returned (no after()), and when it cannot be written the
 * client gets {code:-32003,"audit_unavailable"} instead of data. A response that is already a refusal stands. Static principals are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ events: [] as string[], failAll: false, failNth: new Set<number>(), delayMs: 0, n: 0, inserts: [] as unknown[][], afterCalls: 0 }));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: () => { H.afterCalls += 1; throw new Error("after() must not be used for person audit rows"); } };
});
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (_s: TemplateStringsArray, ...v: unknown[]) => {
    const i = ++H.n;
    H.events.push(`insert-start-${i}`);
    if (H.delayMs) await new Promise((r) => setTimeout(r, H.delayMs));
    if (H.failAll || H.failNth.has(i)) { H.events.push(`insert-fail-${i}`); throw new Error("db boom with secret-looking value xyz"); }
    H.inserts.push(v);
    H.events.push(`insert-done-${i}`);
    return [];
  }),
}));

import { NextRequest } from "next/server";
import { handleMcpRpc } from "@/lib/mcp/handler";
import { auditToolCall } from "@/lib/mcp/audit";

const SESSION = "f_order-session";
const person = (scopes: string[] = ["read", "invoke", "write"]) => ({ token_id: "person:user@example.test", scopes: new Set(scopes) as never, person: { email: "user@example.test", session_id: SESSION } });
const req = (body: unknown) => new NextRequest("https://www.evenscribe.app/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
const call = (id: number, name = "scribe_help", args: Record<string, unknown> = { tool: "scribe_now" }) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

let logs: string[];
beforeEach(() => {
  H.events.length = 0; H.failAll = false; H.failNth.clear(); H.delayMs = 0; H.n = 0; H.inserts.length = 0; H.afterCalls = 0;
  logs = [];
  for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});

describe("a successful call has its row written BEFORE the response returns", () => {
  it("the insert starts and completes before handleMcpRpc resolves, even when the insert is slow; after() is never called", async () => {
    H.delayMs = 40;
    const t0 = Date.now();
    const res = await handleMcpRpc(req(call(1)), person() as never);
    H.events.push("response-returned");
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBeDefined();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    expect(H.events).toEqual(["insert-start-1", "insert-done-1", "response-returned"]);
    expect(H.afterCalls).toBe(0);
  });

  it("a batch writes each row before its item is answered, in order, and before the response returns", async () => {
    await handleMcpRpc(req([call(1), { jsonrpc: "2.0", id: 2, method: "tools/list" }]), person() as never);
    H.events.push("response-returned");
    expect(H.events).toEqual(["insert-start-1", "insert-done-1", "insert-start-2", "insert-done-2", "response-returned"]);
  });
});

describe("a failing insert: the client gets audit_unavailable, not data", () => {
  it("single call: HTTP 503, JSON-RPC error -32003 audit_unavailable, no result, no data anywhere in the body", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req(call(7)), person() as never);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32003, message: "audit_unavailable" } });
    expect(JSON.stringify(body)).not.toContain("tools");
  });

  it("tools/list and initialize are held to the same rule", async () => {
    H.failAll = true;
    for (const method of ["tools/list", "initialize", "ping"]) {
      const res = await handleMcpRpc(req({ jsonrpc: "2.0", id: 1, method }), person() as never);
      expect(res.status, method).toBe(503);
      expect((await res.json()).error.message, method).toBe("audit_unavailable");
    }
  });

  it("batch, every row fails: each item is audit_unavailable (HTTP 503)", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req([call(1), { jsonrpc: "2.0", id: 2, method: "tools/list" }, call(3)]), person() as never);
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.map((b: any) => b.error?.message)).toEqual(["audit_unavailable", "audit_unavailable", "audit_unavailable"]);
    expect(body.map((b: any) => b.id)).toEqual([1, 2, 3]);
  });

  it("batch, only the second row fails: that item is audit_unavailable and the others keep their data (HTTP 200)", async () => {
    H.failNth.add(2);
    const res = await handleMcpRpc(req([call(1), call(2), call(3)]), person() as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body[0].result).toBeDefined();
    expect(body[1].error).toEqual({ code: -32003, message: "audit_unavailable" });
    expect(body[2].result).toBeDefined();
  });

  it("a WRITE tool: the side effect ran, the client still gets audit_unavailable, and an ops error is logged with the tool and session_id only", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req(call(1, "scribe_job_cancel", { job_id: "job_value_one" })), person() as never);
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe("audit_unavailable");
    const line = logs.find((l) => l.includes("AUDIT_UNAVAILABLE"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toEqual({ mcp: "AUDIT_UNAVAILABLE", tool: "scribe_job_cancel", method: "tools/call", session_id: SESSION, side_effect_ran: true });
    const all = logs.join("\n");
    expect(all).not.toContain("job_value_one");
    expect(all).not.toContain("secret-looking value xyz"); // the driver's error text never reaches a log line
    expect(line).not.toContain("user@example.test"); // (the pre-existing per-call log line carries the actor, as it does for static principals)
  });

  it("a read tool's failure log says side_effect_ran false", async () => {
    H.failAll = true;
    await handleMcpRpc(req(call(1)), person() as never);
    expect(JSON.parse(logs.find((l) => l.includes("AUDIT_UNAVAILABLE"))!)).toMatchObject({ tool: "scribe_help", side_effect_ran: false });
  });

  it("a notification whose row fails answers HTTP 503 audit_unavailable (there is no item to carry the error)", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req({ jsonrpc: "2.0", method: "notifications/initialized" }), person() as never);
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe("audit_unavailable");
  });
});

describe("refusals stand when their own row fails", () => {
  it("a scope refusal (403) is still the scope refusal, not audit_unavailable; the failure is logged", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req(call(1, "scribe_job_cancel", { job_id: "x" })), person(["read"]) as never);
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("scope_or_tool_unavailable");
    expect(logs.some((l) => l.includes("AUDIT_UNAVAILABLE"))).toBe(true);
  });

  it("a parse error is still a parse error", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req("{not json"), person() as never);
    expect(res.status).toBe(200);
    expect((await res.json()).error.message).toBe("parse_error");
  });

  it("an unknown method (JSON-RPC error) stands", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req({ jsonrpc: "2.0", id: 1, method: "nope/nothing" }), person() as never);
    expect((await res.json()).error.message).toBe("method_not_found");
  });
});

describe("static principals are unchanged", () => {
  it("a static principal's call returns its data even if the audit insert fails, and writes no person row", async () => {
    H.failAll = true;
    const res = await handleMcpRpc(req(call(1)), { token_id: "operator-v1", scopes: new Set(["read"]) } as never);
    expect(res.status).toBe(200);
    expect((await res.json()).result).toBeDefined();
    expect(logs.some((l) => l.includes("AUDIT_UNAVAILABLE"))).toBe(false);
  });

  it("auditToolCall for a person returns false on failure and never throws", async () => {
    H.failAll = true;
    await expect(auditToolCall({ tool: "scribe_help", args: {}, ok: true, ms: 1, actor: "person:user@example.test", person: { session_id: SESSION } })).resolves.toBe(false);
  });
});
