/**
 * POST /api/oauth/register — RFC 7591 dynamic client registration, the fallback to CIMD (OAUTH-O2). 404 while SCRIBE_MCP_OAUTH is off.
 * Public clients only (token_endpoint_auth_method none). redirect_uris may only be https://claude.ai/api/mcp/auth_callback or a loopback /callback. 10 registrations per IP per minute (in memory per instance).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomId } from "@/lib/mcp/oauth/crypto";
import { clientIp, jsonError, NO_STORE, oauthGate } from "@/lib/mcp/oauth/http";
import { isAllowedRedirect } from "@/lib/mcp/oauth/redirects";
import { registerLimited } from "@/lib/mcp/oauth/register-limit";
import { upsertClient } from "@/lib/mcp/oauth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const err = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: NO_STORE });

export async function POST(req: NextRequest) {
  const blocked = oauthGate();
  if (blocked) return blocked;
  if (registerLimited(clientIp(req))) return NextResponse.json({ error: "slow_down" }, { status: 429, headers: { ...NO_STORE, "retry-after": "60" } });

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return err("invalid_client_metadata");
  }
  if (raw.length > 8192) return err("invalid_client_metadata");
  let b: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return err("invalid_client_metadata");
    b = parsed as Record<string, unknown>;
  } catch {
    return err("invalid_client_metadata");
  }

  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) return err("invalid_redirect_uri");
  if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") return err("invalid_client_metadata");
  const grants = b.grant_types;
  if (grants !== undefined && !(Array.isArray(grants) && grants.every((g) => g === "authorization_code" || g === "refresh_token"))) return err("invalid_client_metadata");
  const name = typeof b.client_name === "string" ? b.client_name.replace(/[^\w .\-]/g, "").slice(0, 100) : null;

  const clientId = `dcr_${randomId(24)}`;
  try {
    await upsertClient({ client_id: clientId, kind: "dcr", redirect_uris: uris as string[], metadata_url: null, client_name: name });
  } catch {
    return jsonError(503, "server_error");
  }
  return NextResponse.json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(name ? { client_name: name } : {}),
    },
    { status: 201, headers: NO_STORE },
  );
}
