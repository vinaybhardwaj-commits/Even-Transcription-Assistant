// ============================================================================
// Minimal OAuth 2.1 helpers for the governance MCP server.
// Authorization-code + PKCE (S256), public client (no client secret).
// Codes / access / refresh tokens are stateless JWTs (HS256, JWT_SECRET) with a
// `typ` claim so they can't be confused with app session cookies. The human gate
// is the shared secret MCP_BEARER_TOKEN, entered on the /api/oauth/authorize page.
// ============================================================================
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "crypto";

function secretKey(): Uint8Array {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET not configured");
  return new TextEncoder().encode(s);
}

/** The shared access secret (also the static bearer for curl). */
export function mcpSecret(): string | null {
  return process.env.MCP_BEARER_TOKEN || null;
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function sign(payload: Record<string, unknown>, typ: string, exp: string): Promise<string> {
  return new SignJWT({ ...payload, typ })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(secretKey());
}

async function verify(token: string, typ: string): Promise<Record<string, unknown> | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    if ((payload as Record<string, unknown>).typ !== typ) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const signAuthCode = (p: { redirect_uri: string; code_challenge: string; scope: string; client_id: string }) =>
  sign(p, "mcp_code", "5m");
export const verifyAuthCode = (t: string) => verify(t, "mcp_code");

export const signAccess = () => sign({ scope: "mcp" }, "mcp_access", "30d");
export const verifyAccess = (t: string) => verify(t, "mcp_access");

export const signRefresh = () => sign({ scope: "mcp" }, "mcp_refresh", "90d");
export const verifyRefresh = (t: string) => verify(t, "mcp_refresh");
