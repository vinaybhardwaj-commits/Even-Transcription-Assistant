import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { safeEqual } from "./util.js";

const SKEW_S = 60;
const JWKS_TTL_MS = 60 * 60 * 1000;

export interface Jwks {
  keys?: JsonWebKey[];
}

export interface AccessClient {
  id: string;
  secret?: string;
  class?: string;
}

export interface VerifiedAccess {
  commonName: string;
  className: string;
}

/** https://<team>.cloudflareaccess.com/cdn-cgi/access/certs */
export function jwksUrlForTeam(teamDomain: string | undefined): string | null {
  if (!teamDomain) return null;
  let host = teamDomain.trim().replace(/\/+$/, "");
  host = host.replace(/^https?:\/\//i, "");
  if (!host || host.toUpperCase().startsWith("REPLACE_")) return null;
  if (!/^[a-z0-9.-]+$/i.test(host)) return null;
  return `https://${host}/cdn-cgi/access/certs`;
}

export function expectedIssuer(teamDomain: string | undefined): string | null {
  const url = jwksUrlForTeam(teamDomain);
  if (!url) return null;
  return new URL(url).origin;
}

export async function defaultFetchJwks(url: string): Promise<Jwks> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  return (await res.json()) as Jwks;
}

/** Cache the team JWKS. A failed fetch is not cached. */
export class JwksCache {
  private at = 0;
  private url = "";
  private keys: JsonWebKey[] = [];

  constructor(
    private fetchJwks: (url: string) => Promise<Jwks> = defaultFetchJwks,
    private ttlMs = JWKS_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  async keysFor(url: string): Promise<JsonWebKey[]> {
    if (this.url === url && this.keys.length && this.now() - this.at < this.ttlMs) return this.keys;
    const body = await this.fetchJwks(url);
    const keys = Array.isArray(body.keys) ? body.keys : [];
    this.keys = keys;
    this.url = url;
    this.at = this.now();
    return keys;
  }
}

/**
 * Verify a Cloudflare Access JWT (RS256) and map common_name to a service-token client id.
 * Access strips CF-Access-Client-Id/Secret before origin, so the JWT is the remaining proof.
 * The client id must still be listed in the token file. The secret is not in the JWT and is not re-checked.
 */
export async function verifyAccessJwt(input: {
  token: string;
  teamDomain?: string;
  audience?: string;
  clients: AccessClient[];
  cache: JwksCache;
  now?: number;
}): Promise<VerifiedAccess | null> {
  const audience = input.audience?.trim() || "";
  if (!audience || audience.toUpperCase().startsWith("REPLACE_")) return null;
  const url = jwksUrlForTeam(input.teamDomain);
  const iss = expectedIssuer(input.teamDomain);
  if (!url || !iss) return null;
  let keys: JsonWebKey[];
  try {
    keys = await input.cache.keysFor(url);
  } catch {
    return null;
  }
  const claims = verifyRs256(input.token, keys, input.now ?? Date.now());
  if (!claims) return null;
  if (claims.iss !== iss) return null;
  if (!audienceMatches(claims.aud, audience)) return null;
  const commonName = typeof claims.common_name === "string" ? claims.common_name : "";
  if (!commonName) return null;
  for (const client of input.clients) {
    if (!client.id || client.id.startsWith("REPLACE_")) continue;
    if (safeEqual(client.id, commonName)) return { commonName, className: client.class || "cloudflare" };
  }
  return null;
}

export function verifyRs256(token: string, keys: JsonWebKey[], nowMs: number): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(b64urlDecode(h).toString("utf8")) as { alg?: string; kid?: string };
  } catch {
    return null;
  }
  if (header.alg !== "RS256") return null;
  const jwk = selectKey(keys, header.kid);
  if (!jwk || jwk.kty !== "RSA") return null;
  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    return null;
  }
  const ok = cryptoVerify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, b64urlDecode(s));
  if (!ok) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(b64urlDecode(p).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const now = Math.floor(nowMs / 1000);
  const exp = typeof claims.exp === "number" ? claims.exp : NaN;
  if (!Number.isFinite(exp) || exp + SKEW_S < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) return null;
  return claims;
}

function selectKey(keys: JsonWebKey[], kid: string | undefined): JsonWebKey | undefined {
  if (kid) return keys.find((k) => k.kid === kid);
  return keys.length === 1 ? keys[0] : undefined;
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.some((item) => item === expected);
  return false;
}

function b64urlDecode(input: string): Buffer {
  return Buffer.from(input, "base64url");
}
