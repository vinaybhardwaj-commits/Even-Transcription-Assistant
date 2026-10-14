import { NextRequest, NextResponse } from "next/server";
import { verifyAuthCode, signAccess, signRefresh, verifyRefresh, pkceS256 } from "@/lib/mcp-oauth";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const H = { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };

function err(code: string, desc: string, status = 400) {
  return NextResponse.json({ error: code, error_description: desc }, { status, headers: H });
}

export async function POST(req: NextRequest) {
  // Token endpoint accepts form-encoded (OAuth default) or JSON.
  let b: Record<string, string> = {};
  const ct = req.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) { const j = await req.json(); b = Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)])); }
    else { const f = await req.formData(); f.forEach((v, k) => { b[k] = String(v); }); }
  } catch { return err("invalid_request", "Could not parse request body"); }

  const grant = b.grant_type;
  if (grant === "authorization_code") {
    const payload = await verifyAuthCode(b.code || "");
    if (!payload) return err("invalid_grant", "Authorization code is invalid or expired");
    if (b.redirect_uri && payload.redirect_uri && b.redirect_uri !== payload.redirect_uri) return err("invalid_grant", "redirect_uri mismatch");
    if (!b.code_verifier) return err("invalid_request", "code_verifier required");
    if (pkceS256(b.code_verifier) !== payload.code_challenge) return err("invalid_grant", "PKCE verification failed");
    const access_token = await signAccess();
    const refresh_token = await signRefresh();
    return NextResponse.json({ access_token, token_type: "Bearer", expires_in: 2592000, refresh_token, scope: "mcp" }, { headers: H });
  }
  if (grant === "refresh_token") {
    const payload = await verifyRefresh(b.refresh_token || "");
    if (!payload) return err("invalid_grant", "Refresh token is invalid or expired");
    const access_token = await signAccess();
    return NextResponse.json({ access_token, token_type: "Bearer", expires_in: 2592000, scope: "mcp" }, { headers: H });
  }
  return err("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}
export async function OPTIONS() { return new NextResponse(null, { status: 204, headers: { ...H, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "*" } }); }
