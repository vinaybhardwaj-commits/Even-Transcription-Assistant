/**
 * /api/mcp — Even Scribe Operator MCP door, HEADER form (Operator MCP PRD §7, §15).
 *
 * Auth (fails CLOSED, before anything is parsed): `Authorization: Bearer <SCRIBE_MCP_TOKEN>`,
 * constant-time (lib/mcp/auth). Missing env → 503 mcp_token_not_configured. Bad/absent → 401.
 *
 * ALL JSON-RPC handling lives in lib/mcp/handler — shared with the path-key form
 * /api/mcp/<SCRIBE_MCP_TOKEN> ([key]/route.ts, for Claude's custom-connector UI, which takes
 * only a URL). One handler, two doors: they cannot drift apart in what they expose.
 */
import { NextRequest } from "next/server";
import { checkMcpBearer } from "@/lib/mcp/auth";
import { handleMcpRpc, mcpAuthFailureResponse, mcpBannerResponse } from "@/lib/mcp/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120; // S3: scribe_transcribe_range = chunk download + Mini Whisper (90 s)

export async function GET() {
  return mcpBannerResponse();
}

export async function POST(req: NextRequest) {
  const auth = checkMcpBearer(req);
  if (!auth.ok) return mcpAuthFailureResponse(auth.failure);
  return handleMcpRpc(req, auth.principal);
}
