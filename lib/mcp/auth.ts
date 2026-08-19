/**
 * lib/mcp/auth.ts — bearer auth for /api/mcp (Operator MCP PRD §15).
 *
 * `Authorization: Bearer <SCRIBE_MCP_TOKEN>` — constant-time compare (same technique as
 * lib/brain/auth.ts: SHA-256 both sides + timingSafeEqual so a length mismatch cannot
 * short-circuit). Missing env → 503 mcp_token_not_configured (fail closed). Bad/absent →
 * 401 unauthorized. Not doctor JWT, not room cookie, not admin password.
 *
 * Scopes: the v1 token carries read + invoke + write (PRD §7). Slice 1 registers READ tools
 * only; a tools/call on a tool that is not registered (or whose scope the token lacks)
 * answers 403 scope_or_tool_unavailable at the route.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const MCP_TOKEN_ENV = "SCRIBE_MCP_TOKEN";
export const MCP_TOKEN_ID = "operator-v1";

export type McpScope = "read" | "invoke" | "write";
export const ALL_SCOPES: readonly McpScope[] = ["read", "invoke", "write"];

export type McpPrincipal = { token_id: string; scopes: ReadonlySet<McpScope> };

export type McpAuthFailure = { status: 401 | 503; code: "unauthorized" | "mcp_token_not_configured" };

/** Returns the principal when authorized, else the failure to send. Never throws. */
export function checkMcpBearer(req: Request): { ok: true; principal: McpPrincipal } | { ok: false; failure: McpAuthFailure } {
  const expected = process.env[MCP_TOKEN_ENV];
  if (!expected) return { ok: false, failure: { status: 503, code: "mcp_token_not_configured" } };
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return { ok: false, failure: { status: 401, code: "unauthorized" } };
  const a = createHash("sha256").update(m[1]!).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(a, b)) return { ok: false, failure: { status: 401, code: "unauthorized" } };
  // v1: one full-access operator token (PRD §19.1 leaves per-operator tokens for later).
  return { ok: true, principal: { token_id: MCP_TOKEN_ID, scopes: new Set(ALL_SCOPES) } };
}
