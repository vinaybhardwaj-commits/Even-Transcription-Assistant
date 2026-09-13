/**
 * lib/mcp/handler.ts — the ONE Even Scribe MCP handler (Operator MCP PRD §7, §15; path-key
 * addendum, 20 Aug 2026). Lifted verbatim out of app/api/mcp/route.ts so the two doors —
 * header (`Authorization: Bearer <SCRIBE_MCP_TOKEN>` at /api/mcp) and path key
 * (/api/mcp/<SCRIBE_MCP_TOKEN>, for Claude's custom-connector UI, which takes only a URL) —
 * dispatch into ONE function and can never drift apart in what they expose.
 *
 * Hand-rolled JSON-RPC 2.0 over HTTP POST (stateless; MCP Streamable-HTTP JSON responses, no
 * SSE, no session ids). GET banner is an info stub (no tool names, no secrets).
 *
 * AUTH LIVES AT THE ROUTES (fails CLOSED, before anything is parsed): both call
 * lib/mcp/auth's checkMcpBearer — the path route wraps its key in a synthetic Bearer
 * request so the constant-time comparison and the 401/503 mapping are the existing ones,
 * not a copy. handleMcpRpc runs only with an already-verified principal.
 *
 * Methods: initialize · notifications/initialized (202, no body) · ping · tools/list ·
 * tools/call. Errors: parse -32700 · invalid request -32600 · unknown method -32601 · invalid
 * params -32602 · internal -32603. tools/call on a tool that is not registered in this slice
 * or outside the token's scopes → HTTP 403 + JSON-RPC error -32001 scope_or_tool_unavailable.
 *
 * Every tools/call writes one audit_log row (lib/mcp/audit — tool name + allow-listed id/flag
 * args only; never payloads, never the request path or URL). Tool handlers are fail-safe
 * (degraded:true, not 500) — only auth is hard.
 */
import { NextRequest, NextResponse } from "next/server";
import type { McpAuthFailure, McpPrincipal } from "@/lib/mcp/auth";
import { auditToolCall, mcpActorId } from "@/lib/mcp/audit";
import type { McpTool, ToolArgs, ToolContext } from "@/lib/mcp/registry";
import { ToolScopeError } from "@/lib/mcp/registry";
import { CALLABLE_TOOLS, LISTED_TOOLS } from "@/lib/mcp/surface";

const SERVER_NAME = "even-scribe-mcp";
const SLICE = "S3";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const TOOL_TIMEOUT_MS = 55_000;
const INVOKE_TOOL_TIMEOUT_MS = 115_000; // invoke tools (extract/transcribe) may wait on the Mini
const MAX_BODY_BYTES = 256 * 1024;

// Registry (PRD §12). Names are the contract. Slice E: tools/list publishes the grouped surface;
// tools/call still accepts every name the door ever published (lib/mcp/surface).
const TOOLS: readonly McpTool[] = LISTED_TOOLS;
const TOOL_BY_NAME = CALLABLE_TOOLS;

type JsonRpcId = string | number | null;
type JsonRpcRequest = { jsonrpc?: unknown; id?: JsonRpcId; method?: unknown; params?: unknown };
type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

const NO_STORE = { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" };

const rpcError = (id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});
const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

class HttpStatusError extends Error {
  constructor(public status: number, public rpc: JsonRpcResponse) {
    super(rpc.error?.message ?? "error");
  }
}

function version(): string {
  return process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "local";
}

/** Same-origin base for in-app hops (brain cues): forwarded host/proto first, nextUrl fallback. */
function requestOrigin(req: NextRequest): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  return host ? `${proto}://${host}` : req.nextUrl.origin;
}

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  const first = (xff ?? "").split(",")[0]?.trim() ?? "";
  // Only pass something Postgres' inet will accept; otherwise null.
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(first) || /^[0-9a-f:]+$/i.test(first) ? first : null;
}

/** The GET banner — static text, no tool names, no secrets, no auth check. */
export function mcpBannerResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      service: SERVER_NAME,
      slice: SLICE,
      transport: "json-rpc-2.0 over HTTP POST (MCP streamable-http, JSON responses)",
      protocolVersion: LATEST_PROTOCOL,
      auth: "Authorization: Bearer <SCRIBE_MCP_TOKEN>",
      methods: ["initialize", "ping", "tools/list", "tools/call"],
      version: version(),
    },
    { headers: NO_STORE },
  );
}

/** The 401/503 the routes send on failed auth — one shape for header and path alike. */
export function mcpAuthFailureResponse(failure: McpAuthFailure): NextResponse {
  return NextResponse.json(rpcError(null, -32000, failure.code), { status: failure.status, headers: NO_STORE });
}

/** Parse + dispatch one POST body for an ALREADY-AUTHORIZED principal. */
export async function handleMcpRpc(req: NextRequest, principal: McpPrincipal): Promise<NextResponse> {
  // 1. Parse.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return NextResponse.json(rpcError(null, -32700, "parse_error"), { status: 200, headers: NO_STORE });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(rpcError(null, -32600, "invalid_request", { reason: "body_too_large" }), { status: 200, headers: NO_STORE });
  }
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw) : null;
  } catch {
    return NextResponse.json(rpcError(null, -32700, "parse_error"), { status: 200, headers: NO_STORE });
  }
  if (body === null || typeof body !== "object") {
    return NextResponse.json(rpcError(null, -32600, "invalid_request"), { status: 200, headers: NO_STORE });
  }

  // 2. Dispatch (single or batch). Notifications (no id) produce no response.
  const requests: JsonRpcRequest[] = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  if (requests.length === 0) {
    return NextResponse.json(rpcError(null, -32600, "invalid_request"), { status: 200, headers: NO_STORE });
  }
  const responses: JsonRpcResponse[] = [];
  let httpStatus = 200;
  for (const r of requests) {
    try {
      const out = await dispatch(r, principal, req);
      if (out) responses.push(out);
    } catch (e) {
      if (e instanceof HttpStatusError) {
        responses.push(e.rpc);
        if (e.status > httpStatus) httpStatus = e.status;
      } else {
        responses.push(rpcError(idOf(r), -32603, "internal_error", { detail: String((e as Error)?.message ?? e).slice(0, 200) }));
      }
    }
  }
  if (responses.length === 0) return new NextResponse(null, { status: 202, headers: { "cache-control": "no-store" } });
  const payload = Array.isArray(body) ? responses : responses[0];
  return NextResponse.json(payload, { status: httpStatus, headers: NO_STORE });
}

function idOf(r: JsonRpcRequest): JsonRpcId {
  return typeof r?.id === "string" || typeof r?.id === "number" ? r.id : null;
}

async function dispatch(r: JsonRpcRequest, principal: McpPrincipal, req: NextRequest): Promise<JsonRpcResponse | null> {
  const id = idOf(r);
  const isNotification = r?.id === undefined;
  if (typeof r !== "object" || r === null || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    if (isNotification) return null;
    return rpcError(id, -32600, "invalid_request");
  }
  const method = r.method;
  const params = (typeof r.params === "object" && r.params !== null ? r.params : {}) as Record<string, unknown>;

  if (method.startsWith("notifications/")) return null; // initialized, cancelled, progress — accepted, no reply

  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL;
      return rpcResult(id, {
        protocolVersion,
        // Tier 2 §2.6 — the server will re-advertise its tool set. The tool list is built at module
        // load from the registry, so a deploy changes it; a client that honours listChanged picks
        // the new set up without a reconnect. Clients that cache their manifest regardless still
        // need reconnecting — stated in docs/operator-mcp/TOOL-NOTES.md, because on 12 Sep a cached
        // manifest hid scribe_room_command from an operator while the server was serving it.
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: SERVER_NAME, version: version() },
        instructions:
          "Even Scribe operator door (S2): read tools over rooms, brain state/cues, Bench sessions/recordings, STT lab, voice, encounters, traces, stores, jobs and the audit log; plus room control through scribe_room_command, whose description lists every kind and where each executes. Related tools are grouped behind one argument (view, aspect, source, action or kind); every tool name published before the grouping, scribe_start_recording included, is still accepted by tools/call. Defaults are summaries + pointers; pass include_payload / include_text / include_prompts / include_identity / include_urls explicitly.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.scope === "read", destructiveHint: false, openWorldHint: false, title: t.name },
        })),
      });
    case "tools/call":
      return callTool(id, params, principal, req);
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, "method_not_found", { method });
  }
}

async function callTool(id: JsonRpcId, params: Record<string, unknown>, principal: McpPrincipal, req: NextRequest): Promise<JsonRpcResponse> {
  const name = typeof params.name === "string" ? params.name : "";
  if (!name) return rpcError(id, -32602, "invalid_params", { reason: "name_required" });
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    return rpcError(id, -32602, "invalid_params", { reason: "arguments_must_be_object" });
  }
  const args = (rawArgs ?? {}) as ToolArgs;

  const tool = TOOL_BY_NAME.get(name);
  if (!tool || !principal.scopes.has(tool.scope)) {
    // Not registered in this slice (e.g. write tools) or outside the token's scopes.
    throw new HttpStatusError(403, rpcError(id, -32001, "scope_or_tool_unavailable", { tool: name, slice: SLICE }));
  }

  const t0 = Date.now();
  let result: unknown;
  let isError = false;
  // Tier 2 Slice B fix-up (3) — the resolved principal reaches the handler, so a tool that writes
  // a durable row can record who asked for it. `mcpActorId` applies the one `mcp:` prefix rule.
  const ctx: ToolContext = { origin: requestOrigin(req), actor: mcpActorId(principal.token_id), scopes: principal.scopes };
  const timeoutMs = tool.scope === "invoke" ? INVOKE_TOOL_TIMEOUT_MS : TOOL_TIMEOUT_MS;
  try {
    result = await Promise.race([
      tool.handler(args, ctx),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`tool_timeout_${timeoutMs}ms`)), timeoutMs)),
    ]);
  } catch (e) {
    // A per-KIND scope refusal is the same answer an unregistered tool gets: one -32001, not two
    // different shapes for "you may not do that".
    if (e instanceof ToolScopeError) {
      const se = e as ToolScopeError;
      throw new HttpStatusError(403, rpcError(id, -32001, "scope_or_tool_unavailable", { tool: name, needed: se.needed, ...se.detail }));
    }
    isError = true;
    result = { error: String((e as Error)?.message ?? e).slice(0, 200), degraded: true };
  }
  const ms = Date.now() - t0;
  void auditToolCall({ tool: name, args, ok: !isError, ms, ip: clientIp(req), userAgent: req.headers.get("user-agent"), actor: principal.token_id, variant: tool.memberFor?.(args) ?? null });

  let text: string;
  try {
    text = JSON.stringify(result);
  } catch {
    text = JSON.stringify({ error: "result_not_serializable" });
    isError = true;
  }
  return rpcResult(id, {
    content: [{ type: "text", text }],
    structuredContent: typeof result === "object" && result !== null && !Array.isArray(result) ? result : { value: result },
    isError,
    _meta: { tool: name, ms, token_id: principal.token_id },
  });
}
