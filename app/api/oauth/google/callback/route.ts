/**
 * GET /api/oauth/google/callback — Google sign-in lands here (OAUTH-O2). 404 while SCRIBE_MCP_OAUTH is off.
 * Needs the signed pending cookie from /authorize. Policy: the ID token verifies (Google keys, iss, aud, exp, nonce) AND hd equals the Workspace domain AND email_verified AND the
 * lowercased email has an ACTIVE mcp_person row. Any failure redirects to the client with error=access_denied and writes one refusal audit row (reason code only).
 * Success does NOT mint a code (R2 F2): it re-signs the cookie as a consent blob (5 min, with a CSRF token) and renders a same-origin page naming the client and the redirect host.
 * POST (Allow) re-checks the person and mints a one-time 60 s code bound to client, redirect_uri, challenge, resource, email and the person's scopes; one mcp.oauth_granted row.
 * POST (Deny) redirects with error=access_denied and iss; one mcp.oauth_refused row (consent_denied). A POST without the consent cookie, or with a wrong CSRF token or a foreign Origin,
 * is a plain HTML 400 that never redirects and never mints. The page answers once (R3): the first Allow or Deny burns its CSRF hash (migration 0172); a replay is a 400 consent_replay.
 */
import { NextRequest, NextResponse } from "next/server";
import { CODE_TTL_S, CONSENT_PURPOSE, CONSENT_TTL_S, PENDING_COOKIE, PENDING_PURPOSE, mcpIssuer, mcpOauthDomain } from "@/lib/mcp/oauth/config";
import { hashSecret, randomId, safeEqual, signBlob, verifyBlob } from "@/lib/mcp/oauth/crypto";
import { consentPage, describeClient, type Consent } from "@/lib/mcp/oauth/consent";
import { exchangeGoogleCode, verifyGoogleIdToken } from "@/lib/mcp/oauth/google";
import { htmlError, NO_STORE, oauthGate, redirectError } from "@/lib/mcp/oauth/http";
import { burnConsent, getPerson, insertCode } from "@/lib/mcp/oauth/store";
import { auditOauthGranted, auditOauthRefused } from "@/lib/mcp/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CALLBACK_PATH = "/api/oauth/google/callback";
const MAX_FORM_BYTES = 2048;

type Pending = { cid: string; ru: string; cc: string; st: string | null; res: string; gs: string; nonce: string; gv: string; exp: number };

function done(res: NextResponse): NextResponse {
  res.cookies.set(PENDING_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: CALLBACK_PATH, maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  const blocked = oauthGate({ google: true });
  if (blocked) return blocked.status === 404 ? blocked : htmlError(503, "server_error");

  const pending = verifyBlob<Pending>(PENDING_PURPOSE, req.cookies.get(PENDING_COOKIE)?.value);
  if (!pending || typeof pending.exp !== "number" || pending.exp < Math.floor(Date.now() / 1000)) {
    await auditOauthRefused(null, "pending_missing"); // R2 F6: awaited like every other refusal row
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

    // R2 F2: no code yet. The person must see who is asking and POST Allow from this page.
    const consent: Consent = { cid: pending.cid, ru: pending.ru, cc: pending.cc, st: pending.st, res: pending.res, email, csrf: randomId(24), exp: Math.floor(Date.now() / 1000) + CONSENT_TTL_S };
    const who = await describeClient(pending.cid);
    const res = consentPage({ clientLabel: who.label, redirectHost: new URL(pending.ru).host, email, csrf: consent.csrf, action: CALLBACK_PATH });
    res.cookies.set(PENDING_COOKIE, signBlob(CONSENT_PURPOSE, consent), { httpOnly: true, secure: true, sameSite: "lax", path: CALLBACK_PATH, maxAge: CONSENT_TTL_S });
    return res;
  } catch {
    return done(redirectError(pending.ru, "server_error", pending.st));
  }
}

/** POST — the consent decision. Allow mints the code; Deny returns access_denied. Bound to the consent cookie AND its CSRF token; a same-origin form post only. */
export async function POST(req: NextRequest) {
  const blocked = oauthGate();
  if (blocked) return blocked.status === 404 ? blocked : htmlError(503, "server_error");

  const consent = verifyBlob<Consent>(CONSENT_PURPOSE, req.cookies.get(PENDING_COOKIE)?.value);
  if (!consent || typeof consent.exp !== "number" || consent.exp < Math.floor(Date.now() / 1000) || typeof consent.csrf !== "string") {
    await auditOauthRefused(null, "consent_missing");
    return htmlError(400, "invalid_request");
  }
  const origin = req.headers.get("origin");
  let form: URLSearchParams | null = null;
  if ((req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    try {
      const raw = await req.text();
      if (raw.length <= MAX_FORM_BYTES) form = new URLSearchParams(raw);
    } catch {
      form = null;
    }
  }
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
    return done(htmlError(400, "invalid_request"));
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
    const raw = randomId(32);
    await insertCode({
      code_hash: hashSecret(raw), client_id: consent.cid, email: consent.email, code_challenge: consent.cc,
      redirect_uri: consent.ru, resource: consent.res, scopes: person.scopes, ttl_s: CODE_TTL_S,
    });
    const u = new URL(consent.ru);
    await auditOauthGranted(consent.email, (await describeClient(consent.cid)).audit, u.host);
    u.searchParams.set("code", raw);
    if (consent.st) u.searchParams.set("state", consent.st);
    u.searchParams.set("iss", mcpIssuer());
    return done(new NextResponse(null, { status: 303, headers: { location: u.toString(), ...NO_STORE } }));
  } catch {
    return done(redirectError(consent.ru, "server_error", consent.st, 303));
  }
}
