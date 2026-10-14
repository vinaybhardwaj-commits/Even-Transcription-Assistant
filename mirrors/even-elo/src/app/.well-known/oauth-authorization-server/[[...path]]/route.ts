import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
function origin(req: NextRequest) { return `https://${req.headers.get("host")}`; }
export async function GET(req: NextRequest) {
  const o = origin(req);
  return NextResponse.json({
    issuer: o,
    authorization_endpoint: `${o}/api/oauth/authorize`,
    token_endpoint: `${o}/api/oauth/token`,
    registration_endpoint: `${o}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  }, { headers: H });
}
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: { ...H, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } }); }
