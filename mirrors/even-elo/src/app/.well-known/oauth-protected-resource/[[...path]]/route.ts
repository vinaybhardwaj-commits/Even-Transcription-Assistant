import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
function origin(req: NextRequest) { return `https://${req.headers.get("host")}`; }
export async function GET(req: NextRequest) {
  const o = origin(req);
  return NextResponse.json({
    resource: `${o}/api/mcp`,
    authorization_servers: [o],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  }, { headers: H });
}
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: { ...H, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" } }); }
