/**
 * /api/mcp — Even Scribe Operator MCP door (Operator MCP PRD §7, §15; Slice 1 = read tools).
 *
 * Hand-rolled JSON-RPC 2.0 over HTTP POST (stateless; MCP Streamable-HTTP JSON responses, no
 * SSE, no session ids). GET is an info stub (no tool names, no secrets).
 *
 * Auth (fails CLOSED, before anything is parsed): Bearer SCRIBE_MCP_TOKEN, constant-time
 * (lib/mcp/auth). Missing env → 503 mcp_token_not_configured. Bad/absent → 401 unauthorized.
 *
 * Methods: initialize · notifications/initialized (202, no body) · ping · tools/list ·
 * tools/call. Errors: parse -32700 · invalid request -32600 · unknown method -32601 · invalid
 * params -32602 · internal -32603. tools/call on a tool that is not registered in this slice
 * or outside the token's scopes → HTTP 403 + JSON-RPC error -32001 scope_or_tool_unavailable.
 *
 * Every tools/call writes one audit_log row (lib/mcp/audit — ids only, never payloads).
 * Tool handlers are fail-safe (degraded:true, not 500) — only auth is hard.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkMcpBearer, type McpPrincipal } from "@/lib/mcp/auth";
import { auditToolCall } from "@/lib/mcp/audit";
import type { McpTool, ToolArgs } from "@/lib/mcp/registry";
import { HEALTH_TOOLS } from "@/lib/mcp/tools/health";
import { BRAIN_TOOLS } from "@/lib/mcp/tools/brain";
import { BENCH_TOOLS } from "@/lib/mcp/tools/bench";
import { STT_TOOLS } from "@/lib/mcp/tools/stt";
import { VOICE_TOOLS } from "@/lib/mcp/tools/voice";
import { ENCOUNTER_TOOLS } from "@/lib/mcp/tools/encounters";
import { STORE_TOOLS } from "@/lib/mcp/tools/stores";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SERVER_NAME = "even-scribe-mcp";
const SLICE = "S1";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const TOOL_TIMEOUT_MS = 55_000;
const MAX_BODY_BYTES = 256 * 1024;

// S1 registry: read tools only (PRD §12). Names are the contract.
const TOOLS: McpTool[] = [...HEALTH_TOOLS, ...BRAIN_TOOLS, ...BENCH_TOOLS, ...STT_TOOLS, ...VOICE_TOOLS, ...ENCOUNTER_TOOLS, ...STORE_TOOLS];
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

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

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  const first = (xff ?? "").split(",")[0]?.trim() ?? "";
  // Only pass something Postgres' inet will accept; otherwise null.
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(first) || /^[0-9a-f:]+$/i.test(first) ? first : null;
}

export async function GET() {
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

export async function POST(req: NextRequest) {
  // 1. Auth — fail closed, before parsing.
  const auth = checkMcpBearer(req);
  if (!auth.ok) {
    return NextResponse.json(rpcError(null, -32000, auth.failure.code), { status: auth.failure.status, headers: NO_STORE });
  }
  const principal = auth.principal;

  // 2. Parse.
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

  // 3. Dispatch (single or batch). Notifications (no id) produce no response.
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
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: version() },
        instructions:
          "Even Scribe operator door, slice S1: read-only tools over rooms, brain state/cues, Bench sessions/recordings, STT lab, voice, encounters, traces, stores. Defaults are summaries + pointers; pass include_payload / include_text / include_prompts / include_identity / include_urls explicitly. Write/invoke tools arrive in later slices.",
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
  try {
    result = await Promise.race([
      tool.handler(args),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`tool_timeout_${TOOL_TIMEOUT_MS}ms`)), TOOL_TIMEOUT_MS)),
    ]);
  } catch (e) {
    isError = true;
    result = { error: String((e as Error)?.message ?? e).slice(0, 200), degraded: true };
  }
  const ms = Date.now() - t0;
  void auditToolCall({ tool: name, args, ok: !isError, ms, ip: clientIp(req), userAgent: req.headers.get("user-agent") });

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
