/**
 * lib/mcp/handler.ts — the ONE Even Scribe MCP handler (Operator MCP PRD §7, §15; path-key
 * addendum, 20 Aug 2026). Lifted verbatim out of app/api/mcp/route.ts so the two doors —
 * header (`Authorization: Bearer <SCRIBE_MCP_TOKEN>` at /api/mcp) and path key
 * (/api/mcp/<SCRIBE_MCP_TOKEN>, for Claude's custom-connector UI, which takes only a URL) —
 * dispatch into ONE function and can never drift apart in what they expose.
 *
 * Hand-rolled JSON-RPC 2.0 over HTTP POST (stateless; MCP Streamable-HTTP JSON responses, no
 * SSE, no session ids). GET answers 405 (S0.1).
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
import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import type { McpAuthFailure, McpPrincipal } from "@/lib/mcp/auth";
import { auditDeniedCall, auditToolCall, logOwnerCall, mcpActorId, type ErrKind } from "@/lib/mcp/audit";
import type { McpTool, ToolArgs, ToolContext } from "@/lib/mcp/registry";
import { ToolScopeError, ToolRoomError, ROOM_RESTRICTED_ALLOWED_TOOLS } from "@/lib/mcp/registry";
import { CALLABLE_TOOLS } from "@/lib/mcp/surface";
import { mcpChallengeHeader, oauthEnabled } from "@/lib/mcp/oauth/config";
import { resolveProfile, toolsForProfile, type McpProfile } from "@/lib/mcp/profile";

const SERVER_NAME = "even-scribe-mcp";
const SLICE = "S3";
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const LATEST_PROTOCOL = PROTOCOL_VERSIONS[0];
const TOOL_TIMEOUT_MS = 55_000;
const INVOKE_TOOL_TIMEOUT_MS = 115_000; // invoke tools (extract/transcribe) may wait on the Mini
const MAX_BODY_BYTES = 256 * 1024;

// Registry (PRD §12). Names are the contract. Slice E: tools/list publishes the grouped surface;
// tools/call still accepts every name the door ever published (lib/mcp/surface).
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

/** OAUTH-O3: what one JSON-RPC item did, filled by dispatch/callTool so a person principal's ONE audit row per item can be written in handleMcpRpc. */
type CallInfo = { method?: string; tool?: string; args?: unknown; variant?: string | null; ok?: boolean; errKind?: ErrKind; bytes?: number; ms?: number };

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
  // Only a real IP address ever reaches the inet column (O3-FIX1 MUST-1): "1.2.3.999", "deadbeef" and ":::::" used to pass a loose regex and then fail the insert. A zone id (%eth0) is not inet either.
  return first !== "" && !first.includes("%") && isIP(first) !== 0 ? first : null;
}

/**
 * S0.1 (8 Oct 2026) — GET on either door. The old 200 JSON banner told a probe "up" with no auth
 * and no tool names, which hid a dead token behind a green GET. The door speaks JSON-RPC over POST
 * only: 405 + `Allow`. Static text, no auth check, reveals nothing.
 */
export function mcpMethodNotAllowedResponse(): NextResponse {
  return NextResponse.json(
    { error: "method_not_allowed", hint: "Even Scribe MCP speaks JSON-RPC over POST" },
    { status: 405, headers: { ...NO_STORE, allow: "POST, OPTIONS" } },
  );
}

/** The 401/503 the routes send on failed auth — one shape for header and path alike. */
export function mcpAuthFailureResponse(failure: McpAuthFailure, opts: { challenge?: boolean } = {}): NextResponse {
  if (failure.denied) void auditDeniedCall(failure.denied); // key denylist: one rate-limited audit row; the response below is the plain 401 (no ip or user agent: this function has no request)
  // OAUTH-O1: only /api/mcp passes `challenge` (not /api/mcp/lab: lead ruling, FIX1), only a 401 carries it (denied and unknown alike: no oracle), and only with SCRIBE_MCP_OAUTH on. Body and status never change.
  const headers: Record<string, string> = { ...NO_STORE };
  if (opts.challenge && failure.status === 401 && oauthEnabled()) headers["www-authenticate"] = mcpChallengeHeader();
  return NextResponse.json(rpcError(null, -32000, failure.code), { status: failure.status, headers });
}

/** Parse + dispatch one POST body for an ALREADY-AUTHORIZED principal. */
export async function handleMcpRpc(req: NextRequest, principal: McpPrincipal, opts: { profile?: McpProfile } = {}): Promise<NextResponse> {
  // S3 — which tools/list this request gets. tools/call ignores it.
  const profile = resolveProfile(req, opts.profile);
  const person = principal.person;
  // SPEC 18 Oct (SCRIBE_MCP_IDENTITY on): `identity` = a resolved non-V caller on ANY door (static key, issued key or OAuth session), `owner` = V. Both get the awaited, fail-closed per-item path below;
  // the difference is the row: a user writes audit_log (email, key_id, door, tool, subject ids), V writes ONLY mcp_owner_seclog (ts, key_id, tool, outcome) and a failed seclog write never refuses V.
  const user = principal.identity;
  const owner = principal.owner;
  const tracked = Boolean(person || user || owner);
  // OAUTH-O3 (spec §12, FIX1): a person principal writes EXACTLY ONE audit row per JSON-RPC item (or one for a body that does not parse), AWAITED BEFORE the response is sent (no after()).
  // If the row cannot be written the client gets {code:-32003,"audit_unavailable"} instead of the result. A write tool's side effect has already run by then: that is logged loudly
  // (tool + session_id only). A response that is already a refusal or an error stands: the refusal is not replaced by audit_unavailable (its failed row is still logged).
  const auditItem = async (info: CallInfo, t0: number): Promise<boolean> => {
    if (!tracked) return true;
    const isCall = info.method === "tools/call" && typeof info.tool === "string";
    if (owner) {
      await logOwnerCall(owner.key_id, isCall ? (info.tool as string) : info.method ?? "invalid", info.ok ? "ok" : info.errKind === "refused" ? "refused" : "error");
      return true;
    }
    const ok = await auditToolCall({
      tool: info.tool ?? "", args: info.args, ok: info.ok ?? false, ms: info.ms ?? Date.now() - t0, ip: clientIp(req), userAgent: req.headers.get("user-agent"),
      actor: user ? `person:${user.email}` : principal.token_id, variant: info.variant ?? null, errKind: info.errKind ?? null,
      person: { session_id: person?.session_id ?? null, ...(isCall ? {} : { method: info.method ?? "invalid" }), bytes_out: info.bytes ?? null, ...(user ? { email: user.email, key_id: user.key_id, door: user.door } : {}) },
    });
    if (!ok) {
      const scope = isCall ? TOOL_BY_NAME.get(info.tool ?? "")?.scope : undefined;
      console.error(JSON.stringify({ mcp: "AUDIT_UNAVAILABLE", tool: isCall ? info.tool : null, method: isCall ? "tools/call" : info.method ?? null, door: user?.door ?? null, session_id: person?.session_id ?? null, side_effect_ran: Boolean(isCall && scope && scope !== "read") }));
    }
    return ok;
  };
  const auditDown = (id: JsonRpcId): JsonRpcResponse => rpcError(id, -32003, "audit_unavailable");
  const bail = async (code: number, message: string, extra: Record<string, unknown> | undefined, method: string): Promise<NextResponse> => {
    const res = NextResponse.json(rpcError(null, code, message, extra), { status: 200, headers: NO_STORE });
    await auditItem({ method, ok: false, errKind: "refused" }, Date.now()); // a refusal stands even if its row fails (logged above)
    return res;
  };
  // 1. Parse.
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return bail(-32700, "parse_error", undefined, "parse_error");
  }
  if (raw.length > MAX_BODY_BYTES) {
    return bail(-32600, "invalid_request", { reason: "body_too_large" }, "invalid_request");
  }
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw) : null;
  } catch {
    return bail(-32700, "parse_error", undefined, "parse_error");
  }
  if (body === null || typeof body !== "object") {
    return bail(-32600, "invalid_request", undefined, "invalid_request");
  }

  // 2. Dispatch (single or batch). Notifications (no id) produce no response.
  const requests: JsonRpcRequest[] = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  if (requests.length === 0) {
    return bail(-32600, "invalid_request", undefined, "invalid_request");
  }
  const responses: JsonRpcResponse[] = [];
  let httpStatus = 200;
  let auditFailures = 0;
  let replaced = 0;
  for (const r of requests) {
    const info: CallInfo = {};
    const t0 = Date.now();
    let out: JsonRpcResponse | null = null;
    try {
      out = await dispatch(r, principal, req, profile, info);
      if (info.bytes === undefined && out) info.bytes = JSON.stringify(out).length;
      if (info.ok === undefined) { info.ok = !out?.error; if (!info.ok) info.errKind = "refused"; }
    } catch (e) {
      if (e instanceof HttpStatusError) {
        out = e.rpc;
        if (e.status > httpStatus) httpStatus = e.status;
        info.ok = false;
        info.errKind = "refused";
      } else {
        out = rpcError(idOf(r), -32603, "internal_error", { detail: String((e as Error)?.message ?? e).slice(0, 200) });
        info.ok = false;
        info.errKind = "throw";
      }
    }
    if (tracked) {
      if (info.method === undefined) info.method = typeof r?.method === "string" ? r.method : "invalid";
      const written = await auditItem(info, t0);
      if (!written) {
        auditFailures += 1;
        if (!out?.error) { out = auditDown(idOf(r)); replaced += 1; } // data is never returned without its row
      }
    }
    if (out) responses.push(out);
  }
  if (tracked && auditFailures > 0) {
    // single call, or a batch in which every item came back as audit_unavailable: HTTP 503. A mixed batch stays 200 with the error on the items that failed.
    if (replaced > 0 && (requests.length === 1 || replaced === responses.length)) httpStatus = Math.max(httpStatus, 503);
    if (responses.length === 0) return NextResponse.json(auditDown(null), { status: 503, headers: NO_STORE }); // notification only: nothing to answer, but say the row failed
  }
  if (responses.length === 0) return new NextResponse(null, { status: 202, headers: { "cache-control": "no-store" } });
  const payload = Array.isArray(body) ? responses : responses[0];
  return NextResponse.json(payload, { status: httpStatus, headers: NO_STORE });
}

/** S1A — one tool list for every caller (V's Q3 ruling). The profile selectors still resolve but do not change tools/list. Never carries a path or key. */
function listInstructions(): string {
  return `One tool list for every caller, short descriptions; scribe_help returns any tool's full contract. The profile selectors (header X-Scribe-Profile, ?profile=, the /lab URL) are accepted and return this same list. tools/call accepts every tool name ever published.`;
}

function idOf(r: JsonRpcRequest): JsonRpcId {
  return typeof r?.id === "string" || typeof r?.id === "number" ? r.id : null;
}

async function dispatch(r: JsonRpcRequest, principal: McpPrincipal, req: NextRequest, profile: McpProfile, info: CallInfo): Promise<JsonRpcResponse | null> {
  const id = idOf(r);
  const isNotification = r?.id === undefined;
  if (typeof r !== "object" || r === null || r.jsonrpc !== "2.0" || typeof r.method !== "string") {
    if (isNotification) return null;
    return rpcError(id, -32600, "invalid_request");
  }
  const method = r.method;
  info.method = method;
  const params = (typeof r.params === "object" && r.params !== null ? r.params : {}) as Record<string, unknown>;

  if (method.startsWith("notifications/")) return null; // initialized, cancelled, progress — accepted, no reply

  switch (method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : LATEST_PROTOCOL;
      const protocolVersion = (PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL;
      return rpcResult(id, {
        protocolVersion,
        // S0.2 (8 Oct 2026) — listChanged is no longer advertised. The tool list is built at module
        // load, so it changes only on a deploy, never inside a live session; the server never sends
        // notifications/tools/list_changed, so advertising it promised a push that cannot arrive
        // (stateless JSON responses, no SSE). Clients that cache their manifest still need
        // reconnecting after a deploy — docs/operator-mcp/TOOL-NOTES.md.
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: version() },
        instructions:
          listInstructions() +
          " Even Scribe operator door (S3): read tools over rooms, brain state/cues, Bench sessions/recordings, STT lab, voice, encounters, traces, stores, jobs and the audit log; plus room control through scribe_room_command, whose description lists every kind and where each executes. Related tools are grouped behind one selector argument; every tool name published before the grouping, scribe_start_recording included, is still accepted by tools/call. Defaults are summaries + pointers; pass include_payload / include_text / include_prompts / include_identity / include_urls explicitly.",
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: toolsForProfile(profile).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: t.scope === "read", destructiveHint: false, openWorldHint: false, ...t.annotations },
        })),
      });
    case "tools/call":
      return callTool(id, params, principal, req, info);
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, "method_not_found", { method });
  }
}

async function callTool(id: JsonRpcId, params: Record<string, unknown>, principal: McpPrincipal, req: NextRequest, info: CallInfo): Promise<JsonRpcResponse> {
  const name = typeof params.name === "string" ? params.name : "";
  info.tool = TOOL_BY_NAME.has(name) ? name : "unknown"; // the row never carries a client-chosen string (O3-FIX1 LOW-2)
  if (!name) return rpcError(id, -32602, "invalid_params", { reason: "name_required" });
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs))) {
    return rpcError(id, -32602, "invalid_params", { reason: "arguments_must_be_object" });
  }
  const args = (rawArgs ?? {}) as ToolArgs;
  info.args = args;

  const tool = TOOL_BY_NAME.get(name);
  if (!tool || !principal.scopes.has(tool.scope)) {
    // Not registered in this slice (e.g. write tools) or outside the token's scopes.
    throw new HttpStatusError(403, rpcError(id, -32001, "scope_or_tool_unavailable", { tool: name, slice: SLICE }));
  }
  // A room-restricted token (registry.ts's ROOM_RESTRICTED_ALLOWED_TOOLS) may reach ONLY a tool
  // vetted to enforce ctx.rooms itself — default deny, not "did this particular tool remember to
  // check" (eta-refuter-2 #5114: several tools resolved a room from an id without checking it).
  if (principal.rooms && !ROOM_RESTRICTED_ALLOWED_TOOLS.has(name)) {
    throw new HttpStatusError(403, rpcError(id, -32001, "scope_or_tool_unavailable", { tool: name, slice: SLICE, room_restricted: true }));
  }
  // Per-token narrowing (28 Sep 2026): a room-restricted token whose entry ALSO names `tools`
  // (lib/mcp/auth.ts) may reach only the intersection — this can only remove from the set the
  // room gate above already admitted, never add to it (a name not in ROOM_RESTRICTED_ALLOWED_TOOLS
  // is refused above regardless of `tools`).
  if (principal.rooms && principal.tools && !principal.tools.has(name)) {
    throw new HttpStatusError(403, rpcError(id, -32001, "scope_or_tool_unavailable", { tool: name, slice: SLICE, room_restricted: true, tool_restricted: true }));
  }

  const t0 = Date.now();
  let result: unknown;
  let isError = false;
  // Tier 2 Slice B fix-up (3) — the resolved principal reaches the handler, so a tool that writes
  // a durable row can record who asked for it. `mcpActorId` applies the one `mcp:` prefix rule.
  const ctx: ToolContext = {
    origin: requestOrigin(req),
    actor: mcpActorId(principal.token_id),
    scopes: principal.scopes,
    rooms: principal.rooms,
  };
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
    if (e instanceof ToolRoomError) {
      throw new HttpStatusError(403, rpcError(id, -32001, "scope_or_tool_unavailable", { tool: name, room: e.room.slug }));
    }
    isError = true;
    result = { error: String((e as Error)?.message ?? e).slice(0, 200), degraded: true };
  }
  const ms = Date.now() - t0;

  let text: string;
  try {
    text = JSON.stringify(result);
  } catch {
    text = JSON.stringify({ error: "result_not_serializable" });
    isError = true;
  }

  // S0.3 — audit honesty. isError (what the CALLER sees) is unchanged: it is true only when the
  // handler threw. But fail-safe tools answer `{ error }` / `{ degraded:true }` without throwing, and
  // the audit row used to call all of those ok. `ok` now also falls when the result says it failed.
  const resultHasError =
    typeof result === "object" && result !== null && !Array.isArray(result) &&
    (typeof (result as Record<string, unknown>).error === "string" || (result as Record<string, unknown>).degraded === true);
  const errKind: ErrKind = isError ? "throw" : resultHasError ? "result_error" : null;
  const ok = !isError && !resultHasError;
  const variant = tool.memberFor?.(args) ?? null;
  if (principal.person || principal.identity || principal.owner) Object.assign(info, { variant, ok, errKind, bytes: text.length, ms }); // handleMcpRpc writes the one row (a user's audit_log row, or V's seclog row)
  else void auditToolCall({ tool: name, args, ok, ms, ip: clientIp(req), userAgent: req.headers.get("user-agent"), actor: principal.token_id, variant, errKind });

  // S0.4 — one structured line per tools/call for the log drain. Never args, never the request
  // path or key, never the user agent: the path-key door's URL is a secret.
  console.log(JSON.stringify({ mcp: "call", tool: name, variant, ms, ok, err_kind: errKind, actor: ctx.actor, bytes_out: text.length }));

  return rpcResult(id, {
    content: [{ type: "text", text }],
    structuredContent: typeof result === "object" && result !== null && !Array.isArray(result) ? result : { value: result },
    isError,
    _meta: { tool: name, ms, token_id: principal.token_id },
  });
}
