/**
 * lib/mcp/oauth/google.ts — O2: Google OIDC (authorization code + PKCE), ID token validation against Google's JWKS.
 * Google tokens are used here and dropped: never stored, logged, forwarded or accepted anywhere else.
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { GOOGLE_CLIENT_ID_ENV, GOOGLE_CLIENT_SECRET_ENV, mcpIssuer, mcpOauthDomain } from "./config";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_TIMEOUT_MS = 6000;

export const googleConfigured = (): boolean => Boolean(process.env[GOOGLE_CLIENT_ID_ENV] && process.env[GOOGLE_CLIENT_SECRET_ENV]);
export const googleRedirectUri = (): string => `${mcpIssuer()}/api/oauth/google/callback`;

export function googleAuthUrl(p: { state: string; nonce: string; challenge: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", process.env[GOOGLE_CLIENT_ID_ENV] ?? "");
  u.searchParams.set("redirect_uri", googleRedirectUri());
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", p.state);
  u.searchParams.set("nonce", p.nonce);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("hd", mcpOauthDomain()); // a UI hint only: the callback enforces the hd claim
  u.searchParams.set("prompt", "select_account");
  return u.toString();
}

/** Exchange the Google authorization code for an ID token. Returns null on any failure (the caller refuses with one reason code). */
export async function exchangeGoogleCode(code: string, verifier: string): Promise<string | null> {
  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env[GOOGLE_CLIENT_ID_ENV] ?? "",
        client_secret: process.env[GOOGLE_CLIENT_SECRET_ENV] ?? "",
        redirect_uri: googleRedirectUri(),
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      redirect: "error",
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { id_token?: unknown };
    return typeof j.id_token === "string" && j.id_token.length < 8192 ? j.id_token : null;
  } catch {
    return null;
  }
}

let jwks: JWTVerifyGetKey | null = null;
let jwksOverride: JWTVerifyGetKey | null = null;
/** test seam: a local JWKS so no network is touched */
export function setJwksForTests(k: JWTVerifyGetKey | null): void {
  jwksOverride = k;
}
const keys = (): JWTVerifyGetKey => jwksOverride ?? (jwks ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), { timeoutDuration: GOOGLE_TIMEOUT_MS }));

export type GoogleIdentity = { email: string; hd: string | null; emailVerified: boolean };
export type IdTokenResult = { ok: true; identity: GoogleIdentity } | { ok: false; reason: "id_token_invalid" | "nonce_mismatch" };

/** Signature (Google's keys), iss, aud = our client id, exp (jose checks these) and nonce. hd and email_verified are policy and are checked by the caller. */
export async function verifyGoogleIdToken(idToken: string, nonce: string): Promise<IdTokenResult> {
  try {
    const { payload } = await jwtVerify(idToken, keys(), {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: process.env[GOOGLE_CLIENT_ID_ENV] ?? "",
      algorithms: ["RS256"],
    });
    if (typeof payload.nonce !== "string" || payload.nonce !== nonce) return { ok: false, reason: "nonce_mismatch" };
    if (typeof payload.email !== "string") return { ok: false, reason: "id_token_invalid" };
    return {
      ok: true,
      identity: {
        email: payload.email.trim().toLowerCase(),
        hd: typeof payload.hd === "string" ? payload.hd.toLowerCase() : null,
        emailVerified: payload.email_verified === true,
      },
    };
  } catch {
    return { ok: false, reason: "id_token_invalid" };
  }
}
