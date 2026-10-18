/**
 * lib/mcp/identity.ts — key-to-email identity (Fable spec 18 Oct 2026; migration 0170: mcp_identity, mcp_key).
 * One key -> exactly one email. Keys are stored as plain sha256 hex (the form of the SCRIBE_MCP_TOKENS maps), never in clear. Every read is live (no cache): a revoke is seen by the next call.
 * The CLI (scripts/mcp-keys.ts) and /api/admin/mcp-keys share issueKey / rotateKey / revokeKey / setIdentityStatus. A blacklisted address can never be issued a key from here.
 */
import { createHash, randomBytes } from "node:crypto";
import { sql } from "@/lib/db";
import { approverEmail } from "./oauth/config";

export type IdentityStatus = "active" | "revoked" | "blacklisted";
export type KeyScope = "read" | "admin";
export type KeyRow = { key_id: string; email: string; scope: KeyScope; revoked_at: string | null; identity_status: IdentityStatus };

export const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");
export const KEY_PREFIX = "esk_";
const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}$/;
export const normaliseEmail = (e: string): string | null => {
  const t = e.trim().toLowerCase();
  return t.length <= 254 && EMAIL.test(t) ? t : null;
};

/** An identity's status, or null when the address has no row. */
export async function identityStatus(email: string): Promise<IdentityStatus | null> {
  const rows = (await sql`SELECT status FROM mcp_identity WHERE email = ${email}`) as Array<{ status: IdentityStatus }>;
  return rows[0]?.status ?? null;
}

/** The key row for a presented key's sha256, joined to its identity. */
export async function lookupKey(keyHash: string): Promise<KeyRow | null> {
  const rows = (await sql`
    SELECT k.key_id, k.email, k.scope, k.revoked_at::text AS revoked_at, i.status AS identity_status
      FROM mcp_key k JOIN mcp_identity i ON i.email = k.email WHERE k.key_hash = ${keyHash}
  `) as KeyRow[];
  return rows[0] ?? null;
}

/** The newest un-revoked key id of an email (the id an OAuth session is bound to), or null. */
export async function activeKeyIdOf(email: string): Promise<string | null> {
  const rows = (await sql`SELECT key_id FROM mcp_key WHERE email = ${email} AND revoked_at IS NULL ORDER BY issued_at DESC, key_id DESC LIMIT 1`) as Array<{ key_id: string }>;
  return rows[0]?.key_id ?? null;
}

export type Refusal = "unknown_key" | "revoked_key" | "identity_revoked" | "identity_blacklisted" | "no_identity";
export const refusalForStatus = (s: IdentityStatus | null): Refusal | null => (s === "active" ? null : s === "revoked" ? "identity_revoked" : s === "blacklisted" ? "identity_blacklisted" : "no_identity");

/** Decides a looked-up key row: null = the key is live, else why it is refused. */
export function keyRefusal(row: KeyRow | null): Refusal | null {
  if (!row) return "unknown_key";
  if (row.revoked_at) return "revoked_key";
  return refusalForStatus(row.identity_status);
}

// ─── administration (V only; the callers check that) ────────────────────────────────────────────────────────────────────────────────────────────────

const newKeyId = (): string => `k_${randomBytes(6).toString("hex")}`;
export const newKeyValue = (): string => KEY_PREFIX + randomBytes(32).toString("base64url");

export type Issued = { key_id: string; email: string; scope: KeyScope; key: string };

/** Adds the identity when absent. Refuses a blacklisted one (V edits the row to lift that), and an address that is revoked stays revoked until set active explicitly. */
async function ensureIdentity(email: string, by: string): Promise<IdentityStatus> {
  await sql`INSERT INTO mcp_identity (email, status, created_by) VALUES (${email}, 'active', ${by}) ON CONFLICT (email) DO NOTHING`;
  return (await identityStatus(email)) ?? "revoked";
}

/** Issues a new key for an address. The plain key is returned ONCE and stored nowhere. Throws "blacklisted" / "identity_revoked" / "bad_email". */
export async function issueKey(emailIn: string, scope: KeyScope, by: string, rotatedFrom: string | null = null): Promise<Issued> {
  const email = normaliseEmail(emailIn);
  if (!email) throw new Error("bad_email");
  if (scope !== "read" && scope !== "admin") throw new Error("bad_scope");
  const st = await ensureIdentity(email, by);
  if (st === "blacklisted") throw new Error("blacklisted");
  if (st !== "active") throw new Error("identity_revoked");
  const key = newKeyValue();
  const key_id = newKeyId();
  await sql`INSERT INTO mcp_key (key_id, email, scope, key_hash, rotated_from) VALUES (${key_id}, ${email}, ${scope}, ${sha256Hex(key)}, ${rotatedFrom})`;
  return { key_id, email, scope, key };
}

/** Rotation: a new key for the same email and scope, the old one revoked. */
export async function rotateKey(keyId: string, by: string): Promise<Issued> {
  const rows = (await sql`SELECT email, scope, revoked_at::text AS revoked_at FROM mcp_key WHERE key_id = ${keyId}`) as Array<{ email: string; scope: KeyScope; revoked_at: string | null }>;
  const old = rows[0];
  if (!old) throw new Error("unknown_key_id");
  if (old.revoked_at) throw new Error("already_revoked");
  const issued = await issueKey(old.email, old.scope, by, keyId);
  await sql`UPDATE mcp_key SET revoked_at = now() WHERE key_id = ${keyId} AND revoked_at IS NULL`;
  await killSessions({ keyId }); // sessions signed in with the old key end with it
  return issued;
}

/** Revokes one key. True when a live key was revoked. */
export async function revokeKey(keyId: string): Promise<{ revoked: boolean; email: string | null }> {
  const rows = (await sql`UPDATE mcp_key SET revoked_at = now() WHERE key_id = ${keyId} AND revoked_at IS NULL RETURNING email`) as Array<{ email: string }>;
  if (rows.length > 0) await killSessions({ keyId });
  return { revoked: rows.length > 0, email: rows[0]?.email ?? null };
}

/** revoke or blacklist an identity: every key of the address stops working (the resolver checks identity status on every call) and its keys are stamped revoked. */
export async function setIdentityStatus(emailIn: string, status: "revoked" | "blacklisted", by: string): Promise<void> {
  const email = normaliseEmail(emailIn);
  if (!email) throw new Error("bad_email");
  await sql`INSERT INTO mcp_identity (email, status, created_by) VALUES (${email}, ${status}, ${by}) ON CONFLICT (email) DO UPDATE SET status = EXCLUDED.status WHERE mcp_identity.status <> 'blacklisted' OR EXCLUDED.status = 'blacklisted'`;
  await sql`UPDATE mcp_key SET revoked_at = now() WHERE email = ${email} AND revoked_at IS NULL`;
  await sql`UPDATE mcp_identity SET code_self_approved_at = NULL, code_self_approved_by = NULL WHERE email = ${email}`; // an approval does not survive a revoke
  await killSessions({ email });
}

/** Links an EXISTING token (by its sha256, from the Vercel token maps) to an address so it keeps working under SCRIBE_MCP_IDENTITY. Idempotent per hash. */
export async function linkExistingKey(keyHash: string, emailIn: string, scope: KeyScope, by: string): Promise<{ key_id: string } | { skipped: string }> {
  const email = normaliseEmail(emailIn);
  if (!email || !/^[0-9a-f]{64}$/.test(keyHash)) return { skipped: "bad_input" };
  const st = await ensureIdentity(email, by);
  if (st !== "active") return { skipped: st };
  const key_id = newKeyId();
  const rows = (await sql`INSERT INTO mcp_key (key_id, email, scope, key_hash) VALUES (${key_id}, ${email}, ${scope}, ${keyHash}) ON CONFLICT (key_hash) DO NOTHING RETURNING key_id`) as Array<{ key_id: string }>;
  return rows[0] ? { key_id } : { skipped: "exists" };
}

export async function listKeys(): Promise<Array<{ key_id: string; email: string; scope: KeyScope; issued_at: string; rotated_from: string | null; revoked_at: string | null; identity_status: IdentityStatus }>> {
  return (await sql`
    SELECT k.key_id, k.email, k.scope, k.issued_at::text AS issued_at, k.rotated_from, k.revoked_at::text AS revoked_at, i.status AS identity_status
      FROM mcp_key k JOIN mcp_identity i ON i.email = k.email ORDER BY k.email, k.issued_at DESC
  `) as never;
}

export async function listIdentities(): Promise<Array<{ email: string; status: IdentityStatus; created_by: string | null; created_at: string; self_approved: boolean }>> {
  return (await sql`SELECT email, status, created_by, created_at::text AS created_at, (code_self_approved_at IS NOT NULL) AS self_approved FROM mcp_identity ORDER BY email`) as never;
}

/** Re-activates a REVOKED identity. A blacklisted one is never touched here: V edits the row to lift a blacklist. Returns whether a row changed. */
export async function activateIdentity(emailIn: string): Promise<boolean> {
  const email = normaliseEmail(emailIn);
  if (!email) throw new Error("bad_email");
  const rows = (await sql`UPDATE mcp_identity SET status = 'active' WHERE email = ${email} AND status = 'revoked' RETURNING email`) as unknown[];
  return rows.length > 0;
}

// ─── sessions bound to a key (addendum 1) ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** True while the key exists, is not revoked, belongs to `email` and its identity is active. Live read, no cache. */
export async function keyLive(keyId: string, email: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS x FROM mcp_key k JOIN mcp_identity i ON i.email = k.email
     WHERE k.key_id = ${keyId} AND k.email = ${email} AND k.revoked_at IS NULL AND i.status = 'active'
  `) as unknown[];
  return rows.length > 0;
}

/** A session's bound key: live, or (V's own sessions only) no key at all. Anyone else without a bound live key has no session. */
export async function sessionKeyOk(keyId: string | null | undefined, email: string): Promise<boolean> {
  if (!keyId) return email === approverEmail();
  return keyLive(keyId, email);
}

/** Tombstones and sweeps every OAuth session family signed in with these keys (hygiene on top of the per-call check, which already refuses them). */
async function killSessions(where: { keyId?: string; email?: string }): Promise<void> {
  const rows = (where.keyId
    ? await sql`SELECT DISTINCT family_id FROM mcp_oauth_token WHERE key_id = ${where.keyId}`
    : await sql`SELECT DISTINCT family_id FROM mcp_oauth_token WHERE email = ${where.email ?? ""}`) as Array<{ family_id: string }>;
  for (const r of rows) {
    await sql`INSERT INTO mcp_oauth_family (family_id, reason) VALUES (${r.family_id}, 'key_revoked') ON CONFLICT (family_id) DO NOTHING`;
    await sql`UPDATE mcp_oauth_token SET revoked_at = now() WHERE family_id = ${r.family_id} AND revoked_at IS NULL`;
  }
}

// ─── self_after_approval code route ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function selfApproved(email: string): Promise<boolean> {
  const rows = (await sql`SELECT 1 AS x FROM mcp_identity WHERE email = ${email} AND status = 'active' AND code_self_approved_at IS NOT NULL`) as unknown[];
  return rows.length > 0;
}

/** V approves an address once (true) or withdraws that approval (false). Only an active identity can be approved. Returns whether a row changed. */
export async function setSelfApproved(emailIn: string, approved: boolean, by: string): Promise<boolean> {
  const email = normaliseEmail(emailIn);
  if (!email) throw new Error("bad_email");
  const rows = (approved
    ? await sql`UPDATE mcp_identity SET code_self_approved_at = now(), code_self_approved_by = ${by} WHERE email = ${email} AND status = 'active' RETURNING email`
    : await sql`UPDATE mcp_identity SET code_self_approved_at = NULL, code_self_approved_by = NULL WHERE email = ${email} RETURNING email`) as unknown[];
  return rows.length > 0;
}
