/**
 * /api/mcp/<SCRIBE_MCP_TOKEN>/lab — the path-key twin with the LAB tools/list profile (S3).
 * Identical to ../route.ts in auth, CORS and handler; the only difference is the profile flag.
 *
 * ⚠️ THIS ROUTE'S URL CONTAINS A SECRET. Nothing here logs the request path, the full URL or the key.
 */
import { NextRequest } from "next/server";
import { checkPathKey, optionsResponse, withCors } from "@/lib/mcp/doors";
import { handleMcpRpc, mcpAuthFailureResponse, mcpMethodNotAllowedResponse } from "@/lib/mcp/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function OPTIONS() {
  return optionsResponse(true);
}

export async function GET() {
  return withCors(mcpMethodNotAllowedResponse());
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const auth = checkPathKey(typeof key === "string" ? key : "");
  if (!auth.ok) return withCors(mcpAuthFailureResponse(auth.failure));
  return withCors(await handleMcpRpc(req, auth.principal, { profile: "lab" }));
}
