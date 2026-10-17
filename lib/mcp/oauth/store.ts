/**
 * lib/mcp/oauth/store.ts — O2: every database statement the authorization server runs. Hashes only; no value that could be a token is ever a column.
 * family_id of a code's tokens is "f_" + the first 32 hex of the code hash, so a replayed code can revoke exactly what it issued with no extra column.
 */
import { sql } from "@/lib/db";
import { REFRESH_FAMILY_MAX_AGE_S } from "./config";

export type PersonRow = { email: string; scopes: string[]; status: "active" | "revoked"; granted_at?: string };
export type ClientRow = { client_id: string; kind: "cimd" | "dcr"; redirect_uris: string[]; metadata_url: string | null; client_name: string | null; created_at: string };
export type CodeRow = { code_hash: string; client_id: string; email: string; code_challenge: string; redirect_uri: string; resource: string; scopes: string[]; expires_at: string; used_at: string | null };
export type TokenRow = { token_hash: string; kind: "access" | "refresh"; email: string; client_id: string; scopes: string[]; resource: string; family_id: string; expires_at: string; created_at?: string; revoked_at: string | null; rotated_to: string | null };

export const familyOfCode = (codeHash: string): string => `f_${codeHash.slice(0, 32)}`;

export async function getPerson(email: string): Promise<PersonRow | null> {
  const rows = (await sql`SELECT email, scopes, status, granted_at::text AS granted_at FROM mcp_person WHERE email = ${email}`) as PersonRow[];
  return rows[0] ?? null;
}

export async function getClient(clientId: string): Promise<ClientRow | null> {
  const rows = (await sql`
    SELECT client_id, kind, redirect_uris, metadata_url, client_name, created_at FROM mcp_oauth_client WHERE client_id = ${clientId}
  `) as ClientRow[];
  return rows[0] ?? null;
}

/** Insert or refresh a client. For a CIMD client created_at is bumped to now() on every refetch: it is the fetch time that the 24 h cache reads. */
export async function upsertClient(c: { client_id: string; kind: "cimd" | "dcr"; redirect_uris: string[]; metadata_url: string | null; client_name: string | null }): Promise<void> {
  await sql`
    INSERT INTO mcp_oauth_client (client_id, kind, redirect_uris, metadata_url, client_name)
    VALUES (${c.client_id}, ${c.kind}, ${c.redirect_uris}::text[], ${c.metadata_url}, ${c.client_name})
    ON CONFLICT (client_id) DO UPDATE
      SET redirect_uris = EXCLUDED.redirect_uris, metadata_url = EXCLUDED.metadata_url, client_name = EXCLUDED.client_name, created_at = now()
      WHERE mcp_oauth_client.kind = 'cimd'
  `;
}

export async function touchClient(clientId: string): Promise<void> {
  await sql`UPDATE mcp_oauth_client SET last_used_at = now() WHERE client_id = ${clientId}`;
}

export async function insertCode(c: { code_hash: string; client_id: string; email: string; code_challenge: string; redirect_uri: string; resource: string; scopes: string[]; ttl_s: number }): Promise<void> {
  await sql`
    INSERT INTO mcp_oauth_code (code_hash, client_id, email, code_challenge, redirect_uri, resource, scopes, expires_at)
    VALUES (${c.code_hash}, ${c.client_id}, ${c.email}, ${c.code_challenge}, ${c.redirect_uri}, ${c.resource}, ${c.scopes}::text[], now() + (${c.ttl_s} * interval '1 second'))
  `;
}

/** R3: atomic single-use claim of a consent page (migration 0172). True only for the FIRST Allow or Deny that presents this CSRF hash; every replay gets false. */
export async function burnConsent(csrfHash: string): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO mcp_oauth_consent_burn (csrf_hash) VALUES (${csrfHash}) ON CONFLICT (csrf_hash) DO NOTHING RETURNING csrf_hash
  `) as unknown[];
  return rows.length > 0;
}

/** Atomic single-use claim. Returns the row only for the first caller within the TTL. */
export async function claimCode(codeHash: string): Promise<CodeRow | null> {
  const rows = (await sql`
    UPDATE mcp_oauth_code SET used_at = now()
    WHERE code_hash = ${codeHash} AND used_at IS NULL AND expires_at > now()
    RETURNING code_hash, client_id, email, code_challenge, redirect_uri, resource, scopes, expires_at, used_at
  `) as CodeRow[];
  return rows[0] ?? null;
}

/** True when the code exists and was already used (a replay). */
export async function codeWasUsed(codeHash: string): Promise<boolean> {
  const rows = (await sql`SELECT 1 AS x FROM mcp_oauth_code WHERE code_hash = ${codeHash} AND used_at IS NOT NULL`) as unknown[];
  return rows.length > 0;
}

/** Inserts a token UNLESS its family is tombstoned. True when a row was written. */
/**
 * LOW-7: true when the person was (re)granted at or after the moment this code was minted (the code has no created_at column: created = expires_at - ttl). A code issued before a revoke and
 * re-grant must not be redeemable afterwards. Compared in SQL so timestamp text is never parsed in JS.
 */
export async function personGrantedSinceCode(email: string, codeHash: string, ttlS: number): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS x FROM mcp_person p, mcp_oauth_code c
     WHERE p.email = ${email} AND c.code_hash = ${codeHash} AND p.granted_at >= c.expires_at - (${ttlS} * interval '1 second')
  `) as unknown[];
  return rows.length > 0;
}

export async function insertToken(t: { token_hash: string; kind: "access" | "refresh"; email: string; client_id: string; scopes: string[]; resource: string; family_id: string; ttl_s: number }): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO mcp_oauth_token (token_hash, kind, email, client_id, scopes, resource, family_id, expires_at)
    SELECT ${t.token_hash}, ${t.kind}, ${t.email}, ${t.client_id}, ${t.scopes}::text[], ${t.resource}, ${t.family_id}, now() + (${t.ttl_s} * interval '1 second')
     WHERE NOT EXISTS (SELECT 1 FROM mcp_oauth_family WHERE family_id = ${t.family_id})
    RETURNING token_hash
  `) as unknown[];
  return rows.length > 0;
}

export async function familyRevoked(familyId: string): Promise<boolean> {
  const rows = (await sql`SELECT 1 AS x FROM mcp_oauth_family WHERE family_id = ${familyId}`) as unknown[];
  return rows.length > 0;
}

/**
 * The token row plus its verdict flags. family_expired (R2 F3): the family's FIRST token (min created_at over the family, indexed by family_id) is at least `familyMaxAgeS` old, so a refresh
 * chain has an absolute end however often it rotates.
 */
export async function getToken(tokenHash: string, familyMaxAgeS: number = REFRESH_FAMILY_MAX_AGE_S): Promise<(TokenRow & { expired: boolean; family_revoked: boolean; predates_grant: boolean; family_expired: boolean }) | null> {
  const rows = (await sql`
    SELECT t.token_hash, t.kind, t.email, t.client_id, t.scopes, t.resource, t.family_id, t.expires_at, t.revoked_at, t.rotated_to, (t.expires_at <= now()) AS expired,
           EXISTS (SELECT 1 FROM mcp_oauth_family f WHERE f.family_id = t.family_id) AS family_revoked,
           COALESCE(t.created_at < p.granted_at, false) AS predates_grant,
           COALESCE((SELECT min(f2.created_at) FROM mcp_oauth_token f2 WHERE f2.family_id = t.family_id) <= now() - (${familyMaxAgeS} * interval '1 second'), false) AS family_expired
    FROM mcp_oauth_token t LEFT JOIN mcp_person p ON p.email = t.email WHERE t.token_hash = ${tokenHash}
  `) as Array<TokenRow & { expired: boolean; family_revoked: boolean; predates_grant: boolean; family_expired: boolean }>;
  return rows[0] ?? null;
}

/** Atomic rotation claim: only the first presenter of a live refresh token wins. */
export async function claimRefresh(oldHash: string, newHash: string): Promise<boolean> {
  const rows = (await sql`
    UPDATE mcp_oauth_token SET rotated_to = ${newHash}
    WHERE token_hash = ${oldHash} AND kind = 'refresh' AND rotated_to IS NULL AND revoked_at IS NULL AND expires_at > now()
      AND NOT EXISTS (SELECT 1 FROM mcp_oauth_family WHERE family_id = mcp_oauth_token.family_id)
    RETURNING token_hash
  `) as unknown[];
  return rows.length > 0;
}

/**
 * Revoke a whole family. TWO statements, in this order, on purpose: (1) the tombstone, committed; (2) the sweep, whose snapshot is therefore taken after the tombstone is visible.
 * A redemption that started before (1) and inserts after it is caught by the issuer's post-insert re-check, which calls this again and sweeps its own rows.
 */
export async function revokeFamily(familyId: string, reason: string = "revoked"): Promise<void> {
  await sql`INSERT INTO mcp_oauth_family (family_id, reason) VALUES (${familyId}, ${reason.slice(0, 40)}) ON CONFLICT (family_id) DO NOTHING`;
  await sql`UPDATE mcp_oauth_token SET revoked_at = now() WHERE family_id = ${familyId} AND revoked_at IS NULL`;
}

// ─── O3: access-token lookup and the person admin actions ─────────────────────────────────────────────────────────────────────────────────────────────────

export type AccessLookup = TokenRow & { expired: boolean; family_revoked: boolean; predates_grant: boolean; person_status: "active" | "revoked" | null; person_scopes: string[] | null };

/** One query: the token row plus the person's CURRENT status and scopes. No cache: a revoke is visible to the very next call. */
export async function lookupAccessToken(tokenHash: string): Promise<AccessLookup | null> {
  const rows = (await sql`
    SELECT t.token_hash, t.kind, t.email, t.client_id, t.scopes, t.resource, t.family_id, t.expires_at, t.revoked_at, t.rotated_to,
           (t.expires_at <= now()) AS expired, EXISTS (SELECT 1 FROM mcp_oauth_family f WHERE f.family_id = t.family_id) AS family_revoked,
           COALESCE(t.created_at < p.granted_at, false) AS predates_grant, p.status AS person_status, p.scopes AS person_scopes
      FROM mcp_oauth_token t
      LEFT JOIN mcp_person p ON p.email = t.email
     WHERE t.token_hash = ${tokenHash} AND t.kind = 'access'
  `) as AccessLookup[];
  return rows[0] ?? null;
}

export type PersonView = { email: string; scopes: string[]; status: "active" | "revoked"; granted_at: string; revoked_at: string | null };

/** Upsert an ACTIVE person. A re-grant of a REVOKED person reactivates them and bumps granted_at, which kills every token created before it (acceptance and refresh refuse created_at < granted_at). Changing the scopes of an active person keeps granted_at: tokens stay valid and read the new scopes. */
export async function grantPerson(email: string, scopes: string[], grantedBy: string): Promise<PersonView & { previous_status: string | null }> {
  const rows = (await sql`
    WITH prev AS (SELECT status FROM mcp_person WHERE email = ${email}),
    up AS (
      INSERT INTO mcp_person (email, scopes, status, granted_by, granted_at)
      VALUES (${email}, ${scopes}::text[], 'active', ${grantedBy}, now())
      ON CONFLICT (email) DO UPDATE
        SET scopes = EXCLUDED.scopes, status = 'active', granted_by = EXCLUDED.granted_by,
            granted_at = CASE WHEN mcp_person.status = 'revoked' THEN now() ELSE mcp_person.granted_at END, revoked_at = NULL, revoked_by = NULL
      RETURNING email, scopes, status, granted_at::text AS granted_at, revoked_at::text AS revoked_at
    )
    SELECT up.*, (SELECT status FROM prev) AS previous_status FROM up
  `) as Array<PersonView & { previous_status: string | null }>;
  return rows[0]!;
}

export async function listPeople(): Promise<PersonView[]> {
  return (await sql`
    SELECT email, scopes, status, granted_at::text AS granted_at, revoked_at::text AS revoked_at FROM mcp_person ORDER BY email
  `) as PersonView[];
}

/**
 * ONE statement (one transaction): the person goes to revoked, EVERY family of that email is tombstoned, and every live token of that email is revoked. Data-modifying CTEs always run, so a repeat
 * call still sweeps strays. A token a racing redemption inserts after this statement's snapshot is not seen here; it is refused anyway (person revoked), and after a re-grant it is refused
 * because created_at < granted_at (O3-FIX1 SHOULD-1).
 */
export async function revokePerson(email: string, revokedBy: string): Promise<{ person_found: boolean; was_active: boolean; tokens_revoked: number; families_tombstoned: number }> {
  const rows = (await sql`
    WITH before AS (SELECT status FROM mcp_person WHERE email = ${email}),
    p AS (
      UPDATE mcp_person SET status = 'revoked', revoked_at = now(), revoked_by = ${revokedBy}
       WHERE email = ${email} AND status <> 'revoked' RETURNING email
    ),
    f AS (
      INSERT INTO mcp_oauth_family (family_id, reason)
      SELECT DISTINCT family_id, 'person_revoked' FROM mcp_oauth_token WHERE email = ${email}
      ON CONFLICT (family_id) DO NOTHING RETURNING family_id
    ),
    t AS (
      UPDATE mcp_oauth_token SET revoked_at = now() WHERE email = ${email} AND revoked_at IS NULL RETURNING token_hash
    )
    SELECT (SELECT count(*) FROM before)::int AS found, (SELECT count(*) FROM p)::int AS flipped, (SELECT count(*) FROM t)::int AS tokens, (SELECT count(*) FROM f)::int AS fams
  `) as Array<{ found: number; flipped: number; tokens: number; fams: number }>;
  const r = rows[0] ?? { found: 0, flipped: 0, tokens: 0, fams: 0 };
  return { person_found: r.found > 0, was_active: r.flipped > 0, tokens_revoked: r.tokens, families_tombstoned: r.fams };
}
