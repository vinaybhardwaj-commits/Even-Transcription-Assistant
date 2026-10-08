/**
 * /api/mcp/lab — the header-door twin with the LAB tools/list profile (S3). Same auth, same handler,
 * same callable surface as /api/mcp; only tools/list differs (lib/mcp/profile). A header
 * `X-Scribe-Profile: operator` or `?profile=operator` still wins over this path flag.
 */
import { NextRequest } from "next/server";
import { checkMcpBearer } from "@/lib/mcp/auth";
import { optionsResponse } from "@/lib/mcp/doors";
import { handleMcpRpc, mcpAuthFailureResponse, mcpMethodNotAllowedResponse } from "@/lib/mcp/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return mcpMethodNotAllowedResponse();
}

export async function OPTIONS() {
  return optionsResponse(false);
}

export async function POST(req: NextRequest) {
  const auth = checkMcpBearer(req);
  if (!auth.ok) return mcpAuthFailureResponse(auth.failure);
  return handleMcpRpc(req, auth.principal, { profile: "lab" });
}
