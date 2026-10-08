/**
 * /api/mcp/<SCRIBE_MCP_TOKEN> — the PATH-KEY form of the Even Scribe MCP door (path-key
 * addendum, 20 Aug 2026; the CDMSS lab MCP's [key] shape, copied). Claude's custom-connector
 * UI accepts only a URL — no header field — so the same token rides as the last path segment.
 * V chose this over porting OAuth, knowing the trade: the token sits in the connector's saved
 * address and therefore in server request logs.
 *
 * SAME token (SCRIBE_MCP_TOKEN — no second env, no second name), SAME comparison (the key is
 * wrapped in a synthetic `Bearer` request and handed to lib/mcp/auth's checkMcpBearer, so the
 * constant-time SHA-256 + timingSafeEqual and the 401/503 mapping are the existing code, not a
 * copy), SAME handler (lib/mcp/handler, shared with /api/mcp — the two doors cannot drift),
 * SAME answers (wrong key → the header form's 401; unset env → its 503).
 *
 * GET returns 405 (Allow: POST, OPTIONS) WITHOUT checking the key — static text, reveals nothing.
 * OPTIONS answers 204 with CORS headers and Access-Control-Allow-Origin is * on every
 * response: connector setup probes from a browser and fails without it.
 *
 * ⚠️ THIS ROUTE'S URL CONTAINS A SECRET. Nothing here logs the request path, the full URL, or
 * the key — in any branch, including error handlers. The only logging on this path is the
 * shared handler's per-tools/call audit row (tool name + allow-listed id/flag args, client IP,
 * user agent — never a path or URL) and lib/mcp/audit's console fallback, which carries the
 * same fields. Do not add logging here without keeping that true.
 */
import { NextRequest } from "next/server";
import { checkPathKey, optionsResponse, withCors } from "@/lib/mcp/doors";
import { handleMcpRpc, mcpAuthFailureResponse, mcpMethodNotAllowedResponse } from "@/lib/mcp/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // same ceiling as the header form (raised for U2 joining)

export async function OPTIONS() {
  return optionsResponse(true);
}

export async function GET() {
  // Static 405, reveals nothing — same body as GET /api/mcp, no key check.
  return withCors(mcpMethodNotAllowedResponse());
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const auth = checkPathKey(typeof key === "string" ? key : "");
  if (!auth.ok) return withCors(mcpAuthFailureResponse(auth.failure));
  return withCors(await handleMcpRpc(req, auth.principal));
}
