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
 * GET returns the existing banner WITHOUT checking the key — static text, reveals nothing.
 * OPTIONS answers 204 with CORS headers and Access-Control-Allow-Origin is * on every
 * response: connector setup probes from a browser and fails without it.
 *
 * ⚠️ THIS ROUTE'S URL CONTAINS A SECRET. Nothing here logs the request path, the full URL, or
 * the key — in any branch, including error handlers. The only logging on this path is the
 * shared handler's per-tools/call audit row (tool name + allow-listed id/flag args, client IP,
 * user agent — never a path or URL) and lib/mcp/audit's console fallback, which carries the
 * same fields. Do not add logging here without keeping that true.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkMcpBearer } from "@/lib/mcp/auth";
import { handleMcpRpc, mcpAuthFailureResponse, mcpBannerResponse } from "@/lib/mcp/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // same ceiling as the header form

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
};

/** The existing auth, fed the path key as a synthetic Bearer header — one comparison, one
 *  401/503 mapping, zero new token handling. An empty/missing key fails the Bearer shape.
 *  A key with header-illegal bytes cannot be a real token: the Request constructor throws,
 *  and the check re-runs with no header at all, which yields the same 503 (env unset) or
 *  401 (env set) mapping from the same code — never a 500, never a pass. */
function checkPathKey(key: string) {
  try {
    return checkMcpBearer(new Request("https://mcp.internal/", { headers: { authorization: `Bearer ${key}` } }));
  } catch {
    return checkMcpBearer(new Request("https://mcp.internal/"));
  }
}

function withCors(res: NextResponse): NextResponse {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET() {
  // The banner is static and reveals nothing — same body as GET /api/mcp, no key check.
  return withCors(mcpBannerResponse());
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const auth = checkPathKey(typeof key === "string" ? key : "");
  if (!auth.ok) return withCors(mcpAuthFailureResponse(auth.failure));
  return withCors(await handleMcpRpc(req, auth.principal));
}
