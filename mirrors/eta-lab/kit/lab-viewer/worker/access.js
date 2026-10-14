// Defence in depth behind Cloudflare Access: verify the Cf-Access-Jwt-Assertion on EVERY request.
// RS256 only, JWKS from the team domain, iss exact, aud contains our tag, exp/nbf/iat, exact email allowlist.
// Fails CLOSED on any doubt (missing config, JWKS unreachable, bad token). Callers return a bare 403.

const enc = new TextEncoder();
const b64uToBytes = (s) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const parseJson = (s) => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

const SKEW_S = 60;
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache = { at: 0, team: null, keys: null };

async function jwks(team, fetchImpl) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.team === team && now - jwksCache.at < JWKS_TTL_MS) return jwksCache.keys;
  const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("jwks fetch failed");
  const keys = (await r.json()).keys;
  if (!Array.isArray(keys) || !keys.length) throw new Error("jwks empty");
  jwksCache = { at: now, team, keys };
  return keys;
}

export function resetJwksCache() { jwksCache = { at: 0, team: null, keys: null }; }

// Returns {ok:true, email} or {ok:false}. Never throws; never says why.
export async function verifyAccess(request, env, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  try {
    const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
    const allowed = String(env.ALLOWED_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
    if (!team || !/^[a-z0-9.-]+$/i.test(team) || !aud || allowed.length === 0) return { ok: false };
    const token = request.headers.get("cf-access-jwt-assertion");
    if (!token) return { ok: false };
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false };
    const header = parseJson(parts[0]);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return { ok: false };
    const jwk = (await jwks(team, fetchImpl)).find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) return { ok: false };
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const good = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64uToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
    if (!good) return { ok: false };
    const c = parseJson(parts[1]);
    const now = Math.floor(nowMs / 1000);
    if (c.iss !== `https://${team}`) return { ok: false };
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!auds.includes(aud)) return { ok: false };
    if (typeof c.exp !== "number" || c.exp <= now) return { ok: false };
    if (c.nbf !== undefined && (typeof c.nbf !== "number" || c.nbf > now + SKEW_S)) return { ok: false };
    if (c.iat !== undefined && (typeof c.iat !== "number" || c.iat > now + SKEW_S)) return { ok: false };
    const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
    if (!email || !allowed.includes(email)) return { ok: false };
    return { ok: true, email };
  } catch {
    return { ok: false };
  }
}
