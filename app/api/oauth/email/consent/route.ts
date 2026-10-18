/**
 * POST /api/oauth/email/consent — the consent decision, after the email code was verified (R2 F2, R3). 404 while SCRIBE_MCP_OAUTH is off.
 * Allow mints a one-time 60 s code bound to client, redirect_uri, challenge, resource, email and the person's scopes; one mcp.oauth_granted row.
 * Deny redirects with error=access_denied and iss; one mcp.oauth_refused row (consent_denied). A POST without the consent cookie, with a wrong CSRF token or with a foreign Origin is a plain
 * HTML 400 that never redirects and never mints. The page answers once (R3): the first Allow or Deny burns its CSRF hash (migration 0172); a replay (a double click, Deny then Allow) mints
 * nothing and sends the person back to the client with error=access_denied, so the client can restart instead of dead-ending on an error page.
 */
import { NextRequest, NextResponse } from "next/server";
import { CODE_TTL_S, CONSENT_PURPOSE, PENDING_COOKIE, approverEmail, identityEnforced, mcpIssuer } from "@/lib/mcp/oauth/config";
import { hashSecret, randomId, safeEqual, verifyBlob } from "@/lib/mcp/oauth/crypto";
import { describeClient, type Consent } from "@/lib/mcp/oauth/consent";
import { done, readForm } from "@/lib/mcp/oauth/flow";
import { htmlError, NO_STORE, oauthGate, redirectError } from "@/lib/mcp/oauth/http";
import { burnConsent, getPerson, insertCode } from "@/lib/mcp/oauth/store";
import { auditOauthGranted, auditOauthRefused } from "@/lib/mcp/audit";
import { identityStatus } from "@/lib/mcp/identity";
import { alertSignIn } from "@/lib/mcp/notify";


export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bound to the consent cookie AND its CSRF token; a same-origin form post only. */
export async function POST(req: NextRequest) {
  const blocked = oauthGate();
  if (blocked) return blocked.status === 404 ? blocked : htmlError(503, "server_error");

  const consent = verifyBlob<Consent>(CONSENT_PURPOSE, req.cookies.get(PENDING_COOKIE)?.value);
  if (!consent || typeof consent.exp !== "number" || consent.exp < Math.floor(Date.now() / 1000) || typeof consent.csrf !== "string") {
    await auditOauthRefused(null, "consent_missing");
    return htmlError(400, "invalid_request");
  }
  const origin = req.headers.get("origin");
  const form = await readForm(req);
  const csrf = form?.get("csrf") ?? "";
  if ((origin !== null && origin !== req.nextUrl.origin) || !form || !csrf || !safeEqual(csrf, consent.csrf)) {
    await auditOauthRefused(consent.email, "consent_csrf");
    return htmlError(400, "invalid_request"); // the cookie is kept: the real page can still be answered
  }
  const decision = form.get("decision");
  if (decision !== "allow" && decision !== "deny") return htmlError(400, "invalid_request");
  // R3: the consent page answers ONCE. The first Allow or Deny burns the CSRF hash; a replay, a double click or Deny-then-Allow mints nothing.
  let first: boolean;
  try {
    first = await burnConsent(hashSecret(`consent:${consent.csrf}`));
  } catch {
    return done(redirectError(consent.ru, "server_error", consent.st, 303));
  }
  if (!first) {
    await auditOauthRefused(consent.email, "consent_replay");
    return done(redirectError(consent.ru, "access_denied", consent.st, 303));
  }
  if (decision === "deny") {
    await auditOauthRefused(consent.email, "consent_denied");
    return done(redirectError(consent.ru, "access_denied", consent.st, 303));
  }

  try {
    const person = await getPerson(consent.email);
    if (!person || person.status !== "active") {
      await auditOauthRefused(consent.email, person ? "revoked" : "not_allowlisted");
      return done(redirectError(consent.ru, "access_denied", consent.st, 303));
    }
    if (identityEnforced()) {
      const ident = await identityStatus(person.email);
      if (ident !== "active") {
        await auditOauthRefused(consent.email, ident ?? "no_identity");
        return done(redirectError(consent.ru, "access_denied", consent.st, 303));
      }
    }
    const raw = randomId(32);
    await insertCode({
      code_hash: hashSecret(raw), client_id: consent.cid, email: consent.email, code_challenge: consent.cc,
      redirect_uri: consent.ru, resource: consent.res, scopes: person.scopes, ttl_s: CODE_TTL_S,
    });
    const u = new URL(consent.ru);
    const who = await describeClient(consent.cid);
    await auditOauthGranted(consent.email, who.audit, u.host);
    if (consent.email !== approverEmail()) await alertSignIn(consent.email, u.host); // every non-V sign-in is mailed to V at once (best-effort)
    u.searchParams.set("code", raw);
    if (consent.st) u.searchParams.set("state", consent.st);
    u.searchParams.set("iss", mcpIssuer());
    return done(new NextResponse(null, { status: 303, headers: { location: u.toString(), ...NO_STORE } }));
  } catch {
    return done(redirectError(consent.ru, "server_error", consent.st, 303));
  }
}
