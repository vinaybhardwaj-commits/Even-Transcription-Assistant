/**
 * lib/mcp/oauth/crypto.ts — O2: peppered hashes, random tokens, PKCE, and the signed pending-request cookie value.
 * Nothing here logs. A missing or short pepper is reported to the caller (the routes answer 503), never defaulted.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MCP_OAUTH_PEPPER_ENV } from "./config";

export const MIN_PEPPER_CHARS = 16;

export function pepper(): string | null {
  const p = process.env[MCP_OAUTH_PEPPER_ENV];
  return p && p.length >= MIN_PEPPER_CHARS ? p : null;
}

/** sha256(pepper || value), hex. Throws when there is no pepper; callers gate on pepper() first. */
export function hashSecret(value: string): string {
  const p = pepper();
  if (!p) throw new Error("pepper_missing");
  return createHash("sha256").update(p).update(value).digest("hex");
}

export const randomToken = (prefix: string): string => prefix + randomBytes(32).toString("base64url");
export const randomId = (bytes = 24): string => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export const s256 = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
/** RFC 7636: verifier is 43..128 unreserved characters. */
export const validVerifier = (v: string): boolean => /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
/** S256 challenge is the 43-char base64url of a sha256. */
export const validChallenge = (c: string): boolean => /^[A-Za-z0-9\-_]{43}$/.test(c);

/** Signed (not encrypted) blob: base64url(json).base64url(hmac). The HMAC key is derived from the pepper and a purpose label. */
function signingKey(purpose: string): Buffer {
  const p = pepper();
  if (!p) throw new Error("pepper_missing");
  return createHmac("sha256", p).update(`mcp-oauth:${purpose}`).digest();
}

export function signBlob(purpose: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", signingKey(purpose)).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyBlob<T>(purpose: string, blob: string | undefined): T | null {
  if (!blob) return null;
  const i = blob.indexOf(".");
  if (i < 1) return null;
  const body = blob.slice(0, i);
  const mac = blob.slice(i + 1);
  const want = createHmac("sha256", signingKey(purpose)).update(body).digest("base64url");
  if (!safeEqual(mac, want)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}
