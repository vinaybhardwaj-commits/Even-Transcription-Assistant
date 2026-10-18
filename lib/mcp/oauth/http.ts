/** lib/mcp/oauth/http.ts — O2: the flag/pepper/Resend gates and the response shapes shared by the five OAuth routes. */
import { NextResponse } from "next/server";
import { mcpIssuer, oauthEnabled } from "./config";
import { resendConfigured } from "./email";
import { pepper } from "./crypto";

export const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

/** Flag off = 404 (empty). Pepper missing (or Resend env, when `email`) = 503 server_error. Otherwise null: carry on. */
export function oauthGate(opts: { email?: boolean } = {}): NextResponse | null {
  if (!oauthEnabled()) return new NextResponse(null, { status: 404 });
  if (!pepper() || (opts.email && !resendConfigured())) return jsonError(503, "server_error");
  return null;
}

export function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

const PAGE_MESSAGES: Record<string, string> = {
  invalid_request: "The sign-in request was not valid.",
  invalid_client: "The application asking to sign in is not recognised.",
  invalid_redirect: "The return address for this sign-in is not allowed.",
  server_error: "Sign-in is not available right now. Try again later.",
};

/** A plain HTML error page, used whenever the redirect URI cannot be trusted. Static text only: nothing from the request is echoed. */
export function htmlError(status: number, code: keyof typeof PAGE_MESSAGES): NextResponse {
  const msg = PAGE_MESSAGES[code] ?? PAGE_MESSAGES.invalid_request;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign-in error</title></head><body><main><h1>Sign-in error</h1><p>${msg}</p><p>Code: ${code}</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...NO_STORE, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}

/** Redirect back to the (already trusted) client with error, state and iss (RFC 9207). */
export function redirectError(redirectUri: string, error: string, state: string | null, status: 302 | 303 = 302): NextResponse {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", mcpIssuer());
  return new NextResponse(null, { status, headers: { location: u.toString(), ...NO_STORE } });
}

export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim().slice(0, 64) || "unknown";
}
