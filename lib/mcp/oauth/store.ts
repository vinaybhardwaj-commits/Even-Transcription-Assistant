/**
 * lib/mcp/oauth/store.ts — O2: every database statement the authorization server runs. Hashes only; no value that could be a token is ever a column.
 * family_id of a code's tokens is "f_" + the first 32 hex of the code hash, so a replayed code can revoke exactly what it issued with no extra column.
 */
import { sql } from "@/lib/db";
import { auditOauthRefused } from "@/lib/mcp/audit";
import { EMAIL_LOCK_S, REFRESH_FAMILY_MAX_AGE_S, SESSION_MAX_AGE_S } from "./config";

export type PersonRow = { email: string; scopes: string[]; status: "active" | "revoked"; granted_at?: string };
export type ClientRow = { client_id: string; kind: "cimd" | "dcr"; redirect_uris: string[]; metadata_url: string | null; client_name: string | null; created_at: string };
export type CodeRow = { code_hash: string; client_id: string; email: string; code_challenge: string; redirect_uri: string; resource: string; scopes: string[]; expires_at: string; used_at: string | null; key_id?: string | null };
export type TokenRow = { token_hash: string; kind: "access" | "refresh"; email: string; client_id: string; scopes: string[]; resource: string; family_id: string; expires_at: string; created_at?: string; revoked_at: string | null; rotated_to: string | null; key_id?: string | null };

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

export async function insertCode(c: { code_hash: string; client_id: string; email: string; code_challenge: string; redirect_uri: string; resource: string; scopes: string[]; ttl_s: number; key_id?: string | null }): Promise<void> {
  await sql`
    INSERT INTO mcp_oauth_code (code_hash, client_id, email, code_challenge, redirect_uri, resource, scopes, key_id, expires_at)
    VALUES (${c.code_hash}, ${c.client_id}, ${c.email}, ${c.code_challenge}, ${c.redirect_uri}, ${c.resource}, ${c.scopes}::text[], ${c.key_id ?? null}, now() + (${c.ttl_s} * interval '1 second'))
  `;
}

// ─── email codes (migration 0170, mcp_oauth_email_code): hashes only, never the code ─────────────────────────────────────────────────────────────

/**
 * Inserts a code row UNLESS the address already has `maxPerEmail` rows in the last `windowS` seconds, or this pending flow has already burned `maxAttempts` wrong tries (it is dead).
 * ADDRESS LOCK: when the address has burned `maxAttempts` wrong tries whose LAST try is within `lock_s` (15 min, anchored on the try, R3 F3) across ANY pending flow, nothing is issued. One statement, so the rate limit holds across instances. Returns the new row id, or null when refused (the caller answers identically either way).
 */
export async function insertEmailCode(c: { pending_id: string; email: string; code_hash: string; ttl_s: number; lock_s?: number; max_per_email: number; window_s: number; max_attempts: number }): Promise<string | null> {
  const lockS = c.lock_s ?? EMAIL_LOCK_S;
  const rows = (await sql`
    INSERT INTO mcp_oauth_email_code (pending_id, email, code_hash, expires_at)
    SELECT ${c.pending_id}, ${c.email}, ${c.code_hash}, now() + (${c.ttl_s} * interval '1 second')
    WHERE (SELECT count(*) FROM mcp_oauth_email_code WHERE email = ${c.email} AND created_at > now() - (${c.window_s} * interval '1 second')) < ${c.max_per_email}
      AND (SELECT COALESCE(sum(attempts), 0) FROM mcp_oauth_email_code WHERE pending_id = ${c.pending_id}) < ${c.max_attempts}
      AND (SELECT COALESCE(sum(attempts), 0) FROM mcp_oauth_email_code WHERE email = ${c.email} AND last_attempt_at > now() - (${lockS} * interval '1 second')) < ${c.max_attempts}
      AND NOT EXISTS (SELECT 1 FROM mcp_oauth_email_lock l WHERE l.email = ${c.email} AND l.locked_until > now())
    RETURNING id
  `) as Array<{ id: string | number }>;
  return rows[0] ? String(rows[0].id) : null;
}

/** The same read-side query the qualifying path pays for, run for a non-qualifying address so the two paths cost the same. Returns the count. */
export async function countRecentEmailCodes(email: string, windowS: number): Promise<number> {
  const rows = (await sql`SELECT count(*)::int AS n FROM mcp_oauth_email_code WHERE email = ${email} AND created_at > now() - (${windowS} * interval '1 second')`) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** The code could not be sent: the row is not kept. */
export async function deleteEmailCode(id: string): Promise<void> {
  await sql`DELETE FROM mcp_oauth_email_code WHERE id = ${id}`;
}

/**
 * Spends one attempt on the newest live code of this pending flow and returns it. Live = unused, unexpired, fewer than `maxAttempts` tries on the row, and fewer than `maxAttempts` tries
 * across the WHOLE pending flow (so asking for a new code never resets the budget). The increment happens BEFORE the compare, atomically, so parallel guesses cannot exceed the cap.
 * Null = nothing to try: expired, used, none issued, or the flow is dead.
 */
export async function takeEmailAttempt(pendingId: string, maxAttempts: number, lockS: number = EMAIL_LOCK_S): Promise<{ id: string; email: string; code_hash: string } | null> {
  const rows = (await sql`
    UPDATE mcp_oauth_email_code SET attempts = attempts + 1, last_attempt_at = now()
    WHERE id = (
      SELECT id FROM mcp_oauth_email_code
      WHERE pending_id = ${pendingId} AND used_at IS NULL AND expires_at > now() AND attempts < ${maxAttempts}
      ORDER BY created_at DESC, id DESC LIMIT 1
    )
      AND attempts < ${maxAttempts}
      AND (SELECT COALESCE(sum(attempts), 0) FROM mcp_oauth_email_code WHERE pending_id = ${pendingId}) < ${maxAttempts}
      AND (SELECT COALESCE(sum(x.attempts), 0) FROM mcp_oauth_email_code x WHERE x.email = mcp_oauth_email_code.email AND x.last_attempt_at > now() - (${lockS} * interval '1 second')) < ${maxAttempts}
      AND NOT EXISTS (SELECT 1 FROM mcp_oauth_email_lock l WHERE l.email = mcp_oauth_email_code.email AND l.locked_until > now())
    RETURNING id, email, code_hash
  `) as Array<{ id: string | number; email: string; code_hash: string }>;
  const r = rows[0];
  if (r) {
    // R4 F3: the try that makes 5 across the address (any flow, any code) starts the 15-minute lock FROM THIS MOMENT; later tries and codes are refused until locked_until, so an older flow ageing out cannot reopen it.
    await sql`
      INSERT INTO mcp_oauth_email_lock (email, locked_until)
      SELECT ${r.email}, now() + (${lockS} * interval '1 second')
       WHERE (SELECT COALESCE(sum(attempts), 0) FROM mcp_oauth_email_code WHERE email = ${r.email} AND last_attempt_at > now() - (${lockS} * interval '1 second')) >= ${maxAttempts}
      ON CONFLICT (email) DO UPDATE SET locked_until = GREATEST(mcp_oauth_email_lock.locked_until, EXCLUDED.locked_until)
    `;
  }
  return r ? { id: String(r.id), email: r.email, code_hash: r.code_hash } : null;
}

/** Atomic single-use claim of a verified code. True only for the first caller. */
export async function consumeEmailCode(id: string): Promise<boolean> {
  const rows = (await sql`UPDATE mcp_oauth_email_code SET used_at = now() WHERE id = ${id} AND used_at IS NULL RETURNING id`) as unknown[];
  return rows.length > 0;
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
    RETURNING code_hash, client_id, email, code_challenge, redirect_uri, resource, scopes, expires_at, used_at, key_id
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

export async function insertToken(t: { token_hash: string; kind: "access" | "refresh"; email: string; client_id: string; scopes: string[]; resource: string; family_id: string; ttl_s: number; key_id?: string | null }): Promise<boolean> {
  const rows = (await sql`
    INSERT INTO mcp_oauth_token (token_hash, kind, email, client_id, scopes, resource, family_id, key_id, expires_at)
    SELECT ${t.token_hash}, ${t.kind}, ${t.email}, ${t.client_id}, ${t.scopes}::text[], ${t.resource}, ${t.family_id}, ${t.key_id ?? null}, now() + (${t.ttl_s} * interval '1 second')
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
    SELECT t.token_hash, t.kind, t.email, t.client_id, t.scopes, t.resource, t.family_id, t.key_id, t.expires_at, t.revoked_at, t.rotated_to, (t.expires_at <= now()) AS expired,
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

export type AccessLookup = TokenRow & { family_expired?: boolean; expired: boolean; family_revoked: boolean; predates_grant: boolean; person_status: "active" | "revoked" | null; person_scopes: string[] | null };

/** One query: the token row plus the person's CURRENT status and scopes. No cache: a revoke is visible to the very next call. */
export async function lookupAccessToken(tokenHash: string): Promise<AccessLookup | null> {
  const rows = (await sql`
    SELECT t.token_hash, t.kind, t.email, t.client_id, t.scopes, t.resource, t.family_id, t.key_id, t.expires_at, t.revoked_at, t.rotated_to,
           (t.expires_at <= now()) AS expired,
           COALESCE((SELECT min(f2.created_at) FROM mcp_oauth_token f2 WHERE f2.family_id = t.family_id) <= now() - (${SESSION_MAX_AGE_S} * interval '1 second'), false) AS family_expired, EXISTS (SELECT 1 FROM mcp_oauth_family f WHERE f.family_id = t.family_id) AS family_revoked,
           COALESCE(t.created_at < p.granted_at, false) AS predates_grant, p.status AS person_status, p.scopes AS person_scopes
      FROM mcp_oauth_token t
      LEFT JOIN mcp_person p ON p.email = t.email
     WHERE t.token_hash = ${tokenHash} AND t.kind = 'access'
  `) as AccessLookup[];
  return rows[0] ?? null;
}

export type PersonView = { email: string; scopes: string[]; status: "active" | "revoked"; granted_at: string; revoked_at: string | null };

let grantRefusalLogged = false;
export const resetGrantRefusalLogForTests = () => { grantRefusalLogged = false; };

/** True when the address is a BLACKLISTED mcp_identity (the applied blacklist), whatever SCRIBE_MCP_IDENTITY says. A DB that predates mcp_identity has no blacklist; any other error propagates (a grant is not made blind). */
export async function addressBlacklisted(email: string): Promise<boolean> {
  try {
    return ((await sql`SELECT 1 AS x FROM mcp_identity WHERE email = ${email} AND status = 'blacklisted'`) as unknown[]).length > 0;
  } catch (e) {
    if (/relation "mcp_identity" does not exist|42P01/.test(String((e as { message?: string; code?: string })?.message ?? "") + String((e as { code?: string })?.code ?? ""))) return false;
    throw e;
  }
}

/** Upsert an ACTIVE person. A re-grant of a REVOKED person reactivates them and bumps granted_at, which kills every token created before it (acceptance and refresh refuse created_at < granted_at). Changing the scopes of an active person keeps granted_at: tokens stay valid and read the new scopes. */
export async function grantPerson(email: string, scopes: string[], grantedBy: string): Promise<PersonView & { previous_status: string | null }> {
  if (await addressBlacklisted(email)) {
    await auditOauthRefused(email, "grant_blacklisted"); // counted (rate-limited rows carry a suppressed count)
    if (!grantRefusalLogged) { grantRefusalLogged = true; console.error("[mcp-oauth] person grant refused: the address is on the applied blacklist (count=1)"); }
    throw new Error("blacklisted");
  }
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
