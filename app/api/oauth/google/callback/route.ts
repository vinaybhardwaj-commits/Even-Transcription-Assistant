/**
 * GET /api/oauth/google/callback — Google sign-in lands here (OAUTH-O2). 404 while SCRIBE_MCP_OAUTH is off.
 * Needs the signed pending cookie from /authorize. Policy: the ID token verifies (Google keys, iss, aud, exp, nonce) AND hd equals the Workspace domain AND email_verified AND the
 * lowercased email has an ACTIVE mcp_person row. Any failure redirects to the client with error=access_denied and writes one refusal audit row (reason code only).
 * Success mints a one-time 60 s code bound to client, redirect_uri, challenge, resource, email and the person's scopes.
 */
import { NextRequest, NextResponse } from "next/server";
import { CODE_TTL_S, PENDING_COOKIE, PENDING_PURPOSE, mcpIssuer, mcpOauthDomain } from "@/lib/mcp/oauth/config";
import { hashSecret, randomId, safeEqual, verifyBlob } from "@/lib/mcp/oauth/crypto";
import { exchangeGoogleCode, verifyGoogleIdToken } from "@/lib/mcp/oauth/google";
import { htmlError, NO_STORE, oauthGate, redirectError } from "@/lib/mcp/oauth/http";
import { getPerson, insertCode } from "@/lib/mcp/oauth/store";
import { auditOauthRefused } from "@/lib/mcp/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Pending = { cid: string; ru: string; cc: string; st: string | null; res: string; gs: string; nonce: string; gv: string; exp: number };

function done(res: NextResponse): NextResponse {
  res.cookies.set(PENDING_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/oauth/google/callback", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const blocked = oauthGate({ google: true });
  if (blocked) return blocked.status === 404 ? blocked : htmlError(503, "server_error");

  const pending = verifyBlob<Pending>(PENDING_PURPOSE, req.cookies.get(PENDING_COOKIE)?.value);
  if (!pending || typeof pending.exp !== "number" || pending.exp < Math.floor(Date.now() / 1000)) {
    void auditOauthRefused(null, "pending_missing");
    return done(htmlError(400, "invalid_request"));
  }
  const refuse = async (email: string | null, reason: string) => {
    await auditOauthRefused(email, reason);
    return done(redirectError(pending.ru, "access_denied", pending.st));
  };

  const q = req.nextUrl.searchParams;
  const state = q.get("state") ?? "";
  if (!state || !safeEqual(state, pending.gs)) return refuse(null, "state_mismatch");
  if (q.get("error")) return refuse(null, "google_declined");
  const code = q.get("code") ?? "";
  if (!code || code.length > 2048) return refuse(null, "google_code_missing");

  const idToken = await exchangeGoogleCode(code, pending.gv);
  if (!idToken) return refuse(null, "google_exchange_failed");
  const v = await verifyGoogleIdToken(idToken, pending.nonce);
  if (!v.ok) return refuse(null, v.reason);
  const { email, hd, emailVerified } = v.identity;
  if (hd !== mcpOauthDomain()) return refuse(email, "wrong_domain");
  if (!emailVerified) return refuse(email, "email_unverified");

  try {
    const person = await getPerson(email);
    if (!person) return refuse(email, "not_allowlisted");
    if (person.status !== "active") return refuse(email, "revoked");

    const raw = randomId(32);
    await insertCode({
      code_hash: hashSecret(raw), client_id: pending.cid, email, code_challenge: pending.cc,
      redirect_uri: pending.ru, resource: pending.res, scopes: person.scopes, ttl_s: CODE_TTL_S,
    });
    const u = new URL(pending.ru);
    u.searchParams.set("code", raw);
    if (pending.st) u.searchParams.set("state", pending.st);
    u.searchParams.set("iss", mcpIssuer());
    return done(new NextResponse(null, { status: 302, headers: { location: u.toString(), ...NO_STORE } }));
  } catch {
    return done(redirectError(pending.ru, "server_error", pending.st));
  }
}
