/**
 * GET /api/oauth/authorize — OAuth 2.1 authorization endpoint (OAUTH-O2). 404 while SCRIBE_MCP_OAUTH is off.
 *
 * Order: response_type, client_id, redirect_uri (errors up to here are a plain HTML page: the return address is not yet trusted), then code_challenge (S256 only), resource,
 * state (errors redirect with error, state and iss). On success the pending request is stored in a SIGNED HttpOnly Secure SameSite=Lax cookie (HMAC key derived from the pepper,
 * path-scoped to /api/oauth/email, 10 min, carrying a random pending id) and the page "enter your even.in email" is rendered. The identity step is a one-time email code
 * (email/start, email/verify), then the consent page (email/consent). No database row, no token, no secret in the URL.
 */
import { NextRequest, NextResponse } from "next/server";
import { EMAIL_PATH, PENDING_COOKIE, PENDING_PURPOSE, PENDING_TTL_S, mcpResourceUrl } from "@/lib/mcp/oauth/config";
import { randomId, signBlob, validChallenge } from "@/lib/mcp/oauth/crypto";
import { emailEntryPage } from "@/lib/mcp/oauth/email";
import { htmlError, NO_STORE, oauthGate, redirectError } from "@/lib/mcp/oauth/http";
import { resolveClient } from "@/lib/mcp/oauth/clients";
import { redirectMatches } from "@/lib/mcp/oauth/redirects";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const blocked = oauthGate({ email: true });
  if (blocked) return blocked.status === 404 ? blocked : htmlError(503, "server_error");

  const q = req.nextUrl.searchParams; // NOTE: NextRequest rewrites a loopback IP inside a query value to localhost (seen in tests, Next NextURL); redirectMatches is unit-tested on the IP form directly
  if (q.get("response_type") !== "code") return htmlError(400, "invalid_request");

  const clientId = q.get("client_id") ?? "";
  let client;
  try {
    client = await resolveClient(clientId);
  } catch {
    return htmlError(503, "server_error");
  }
  if (!client.ok) return htmlError(400, "invalid_client");

  const redirectUri = q.get("redirect_uri") ?? "";
  if (!redirectUri || redirectUri.length > 512 || !redirectMatches(client.client.redirect_uris, redirectUri)) return htmlError(400, "invalid_redirect");

  // The return address is trusted from here on.
  const state = q.get("state");
  if (state !== null && state.length > 512) return redirectError(redirectUri, "invalid_request", null);
  const challenge = q.get("code_challenge") ?? "";
  if (q.get("code_challenge_method") !== "S256" || !validChallenge(challenge)) return redirectError(redirectUri, "invalid_request", state);
  if (q.get("resource") !== mcpResourceUrl()) return redirectError(redirectUri, "invalid_target", state);

  const pending = signBlob(PENDING_PURPOSE, {
    cid: clientId, ru: redirectUri, cc: challenge, st: state, res: mcpResourceUrl(),
    pid: randomId(24), exp: Math.floor(Date.now() / 1000) + PENDING_TTL_S,
  });
  const res = emailEntryPage();
  res.cookies.set(PENDING_COOKIE, pending, { httpOnly: true, secure: true, sameSite: "lax", path: EMAIL_PATH, maxAge: PENDING_TTL_S });
  return res;
}
