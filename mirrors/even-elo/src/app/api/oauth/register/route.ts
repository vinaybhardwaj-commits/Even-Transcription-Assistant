import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

// Open Dynamic Client Registration (RFC 7591). We don't persist clients — the
// real gate is the secret on the authorize screen + PKCE — so we just mint a
// public client_id and echo the requested metadata back.
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* tolerate empty */ }
  const client_id = "evmcp_" + randomBytes(16).toString("hex");
  const redirect_uris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
  return NextResponse.json({
    client_id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "mcp",
    client_name: typeof body.client_name === "string" ? body.client_name : "MCP Client",
  }, { status: 201, headers: H });
}
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: { ...H, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "*" } }); }
