/**
 * POST /api/oauth/revoke — RFC 7009 (OAUTH-O2). Revokes the presented token's whole family. 200 for every call that completes, whether or not the token existed (no oracle); 503 only if the database failed, because then nothing was revoked.
 * 404 while SCRIBE_MCP_OAUTH is off; 503 with no pepper.
 */
import { NextRequest, NextResponse } from "next/server";
import { hashSecret } from "@/lib/mcp/oauth/crypto";
import { NO_STORE, oauthGate } from "@/lib/mcp/oauth/http";
import { getToken, revokeFamily } from "@/lib/mcp/oauth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = oauthGate();
  if (blocked) return blocked;
  try {
    const raw = (await req.text()).slice(0, 8192);
    const token = new URLSearchParams(raw).get("token") ?? "";
    if (token && token.length <= 512) {
      const tok = await getToken(hashSecret(token));
      if (tok) await revokeFamily(tok.family_id, "client_revoke");
    }
  } catch {
    return new NextResponse(JSON.stringify({ error: "server_error" }), { status: 503, headers: { ...NO_STORE, "content-type": "application/json" } }); // not revoked: say so (RFC 7009 §2.2.1)
  }
  return new NextResponse(null, { status: 200, headers: NO_STORE });
}
