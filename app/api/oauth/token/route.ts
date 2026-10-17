/**
 * POST /api/oauth/token — authorization_code and refresh_token grants (OAUTH-O2). form-urlencoded only. 404 while SCRIBE_MCP_OAUTH is off.
 * Issues opaque tokens (esp_ access 1 h, esr_ refresh 30 d) stored as sha256(pepper||token). esp_ tokens are NOT accepted at /api/mcp yet (slice O3).
 *
 * Code: claimed atomically (single use, 60 s). A replay revokes the family the first use created. PKCE S256, client_id, redirect_uri and resource must all match.
 * Refresh: rotated on every use, and refused (audited, family revoked) once the family's first token is 30 d old (R2 F3). A reused rotated token revokes the whole family. A person no longer active revokes the family. Errors are RFC 6749 JSON, no-store.
 */
import { NextRequest, NextResponse } from "next/server";
import { ACCESS_TOKEN_TTL_S, CODE_TTL_S, REFRESH_TOKEN_TTL_S, mcpResourceUrl } from "@/lib/mcp/oauth/config";
import { hashSecret, randomToken, s256, safeEqual, validVerifier } from "@/lib/mcp/oauth/crypto";
import { jsonError, NO_STORE, oauthGate } from "@/lib/mcp/oauth/http";
import { redirectsEquivalent } from "@/lib/mcp/oauth/redirects";
import { auditOauthRefused } from "@/lib/mcp/audit";
import { claimCode, claimRefresh, codeWasUsed, familyOfCode, familyRevoked, getPerson, getToken, insertToken, personGrantedSinceCode, revokeFamily } from "@/lib/mcp/oauth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_FORM_BYTES = 8192;

/**
 * Mint the pair into a family. The family tombstone makes a racing revoke safe in both orders: insertToken refuses a tombstoned family, and AFTER inserting we look again — if the
 * family was revoked meanwhile we sweep our own rows (the sweep's snapshot is after our insert) and answer invalid_grant. A revoke that lands later sweeps them itself.
 */
async function issue(p: { email: string; client_id: string; scopes: string[]; resource: string; family_id: string }, rotated?: { raw: string; hash: string }): Promise<NextResponse> {
  const access = randomToken("esp_");
  const refresh = rotated?.raw ?? randomToken("esr_");
  const base = { email: p.email, client_id: p.client_id, scopes: p.scopes, resource: p.resource, family_id: p.family_id };
  const a = await insertToken({ ...base, token_hash: hashSecret(access), kind: "access", ttl_s: ACCESS_TOKEN_TTL_S });
  const r = await insertToken({ ...base, token_hash: rotated?.hash ?? hashSecret(refresh), kind: "refresh", ttl_s: REFRESH_TOKEN_TTL_S });
  if (!a || !r || (await familyRevoked(p.family_id))) {
    await revokeFamily(p.family_id, "issue_race");
    return jsonError(400, "invalid_grant");
  }
  return NextResponse.json(
    { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: p.scopes.join(" ") },
    { status: 200, headers: NO_STORE },
  );
}

export async function POST(req: NextRequest) {
  const blocked = oauthGate();
  if (blocked) return blocked;

  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return jsonError(400, "invalid_request");
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonError(400, "invalid_request");
  }
  if (raw.length > MAX_FORM_BYTES) return jsonError(400, "invalid_request");
  const f = new URLSearchParams(raw);
  const grant = f.get("grant_type");

  try {
    if (grant === "authorization_code") return await codeGrant(f);
    if (grant === "refresh_token") return await refreshGrant(f);
    return jsonError(400, "unsupported_grant_type");
  } catch {
    return jsonError(503, "server_error");
  }
}

async function codeGrant(f: URLSearchParams): Promise<NextResponse> {
  const code = f.get("code") ?? "";
  const clientId = f.get("client_id") ?? "";
  const redirectUri = f.get("redirect_uri") ?? "";
  const verifier = f.get("code_verifier") ?? "";
  const resource = f.get("resource");
  if (!code || !clientId || !redirectUri || !verifier || code.length > 512) return jsonError(400, "invalid_request");
  if (resource !== mcpResourceUrl()) return jsonError(400, "invalid_target");

  const codeHash = hashSecret(code);
  const row = await claimCode(codeHash);
  if (!row) {
    if (await codeWasUsed(codeHash)) await revokeFamily(familyOfCode(codeHash), "code_replay"); // replay: kill what the first use issued
    return jsonError(400, "invalid_grant");
  }
  // The code is burned from here on, whatever happens next.
  if (!safeEqual(row.client_id, clientId) || !redirectsEquivalent(row.redirect_uri, redirectUri) || row.resource !== resource) return jsonError(400, "invalid_grant");
  if (!validVerifier(verifier) || !safeEqual(s256(verifier), row.code_challenge)) return jsonError(400, "invalid_grant");
  const person = await getPerson(row.email);
  if (!person || person.status !== "active") return jsonError(400, "invalid_grant");
  if (await personGrantedSinceCode(row.email, codeHash, CODE_TTL_S)) return jsonError(400, "invalid_grant"); // the person was re-granted after this code was minted (LOW-7)

  return issue({ email: row.email, client_id: row.client_id, scopes: person.scopes, resource: row.resource, family_id: familyOfCode(codeHash) });
}

async function refreshGrant(f: URLSearchParams): Promise<NextResponse> {
  const presented = f.get("refresh_token") ?? "";
  const clientId = f.get("client_id") ?? "";
  if (!presented || !clientId || presented.length > 512) return jsonError(400, "invalid_request");
  const resource = f.get("resource");
  if (resource !== null && resource !== mcpResourceUrl()) return jsonError(400, "invalid_target");

  const oldHash = hashSecret(presented);
  const tok = await getToken(oldHash);
  if (!tok || tok.kind !== "refresh") return jsonError(400, "invalid_grant");
  if (tok.rotated_to) { // a rotated token came back: theft signal
    await revokeFamily(tok.family_id, "refresh_reuse");
    return jsonError(400, "invalid_grant");
  }
  if (tok.revoked_at || tok.expired || tok.family_revoked) return jsonError(400, "invalid_grant");
  if (tok.family_expired) { // R2 F3: 30 d after the family's first token, however often it rotated
    await revokeFamily(tok.family_id, "family_expired");
    await auditOauthRefused(tok.email, "family_expired");
    return jsonError(400, "invalid_grant");
  }
  if (tok.predates_grant) { // created before the person's last (re)grant
    await revokeFamily(tok.family_id, "predates_grant");
    return jsonError(400, "invalid_grant");
  }
  if (!safeEqual(tok.client_id, clientId)) return jsonError(400, "invalid_grant");
  const person = await getPerson(tok.email);
  if (!person || person.status !== "active") {
    await revokeFamily(tok.family_id, "person_inactive");
    return jsonError(400, "invalid_grant");
  }

  const refresh = randomToken("esr_");
  const newHash = hashSecret(refresh);
  if (!(await claimRefresh(oldHash, newHash))) { // lost a race with another presenter of the same token
    await revokeFamily(tok.family_id, "refresh_race");
    return jsonError(400, "invalid_grant");
  }
  return issue({ email: tok.email, client_id: tok.client_id, scopes: person.scopes, resource: tok.resource, family_id: tok.family_id }, { raw: refresh, hash: newHash });
}
