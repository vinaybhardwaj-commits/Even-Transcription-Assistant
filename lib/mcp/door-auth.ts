/**
 * lib/mcp/door-auth.ts — the ONE async door check for all four MCP doors (header, path-key, and their /lab twins).
 *
 * SCRIBE_MCP_IDENTITY off: exactly the pre-18-Oct behaviour (checkMcpBearer / authenticateMcp), nothing else runs.
 * SCRIBE_MCP_IDENTITY on (Fable spec 18 Oct 2026): every key must resolve to exactly ONE active email, or the call is refused 401 and the refusal is audited.
 *   - V's own keys (a token actor in SCRIBE_MCP_OWNER_ACTORS, a key whose email is the approver, an OAuth session of the approver) become `principal.owner`: their calls write only mcp_owner_seclog.
 *   - everyone else becomes `principal.identity` {email, key_id, door}: handleMcpRpc writes one fail-closed audit_log row per call.
 *   - a key that is not in the env token maps is looked up in mcp_key (keys issued by the admin CLI / /admin/mcp-keys). Scope read -> {read}; admin -> {read, admin} with actor `admin:<email>`.
 *   - no approver address configured = every call 503 (fail closed: nobody can tell who V is).
 * A database fault is a 503, never an accept. No cache: a revoke is seen by the next call.
 */
import { checkMcpBearer, type McpAuthFailure, type McpPrincipal, type McpScope, ADMIN_ACTOR_PREFIX } from "@/lib/mcp/auth";
import { checkPathKey } from "@/lib/mcp/doors";
import { auditIdentityRefused } from "@/lib/mcp/audit";
import { approverEmail, identityEnforced, ownerActors } from "@/lib/mcp/oauth/config";
import { authenticateMcp, type McpAuthResult } from "@/lib/mcp/oauth/person-auth";
import { identityStatus, sessionKeyOk, keyRefusal, lookupKey, refusalForStatus, sha256Hex } from "@/lib/mcp/identity";

export type DoorName = "header" | "lab" | "path" | "path-lab";

const unauthorized: McpAuthFailure = { status: 401, code: "unauthorized" };
const unavailable: McpAuthResult = { ok: false, failure: { status: 503, code: "auth_unavailable" } };

function presentedKey(req: Request, pathKey: string | undefined): string | null {
  if (pathKey !== undefined) return pathKey || null;
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return m?.[1] ?? null;
}

export async function authenticateDoor(req: Request, door: DoorName, opts: { pathKey?: string } = {}): Promise<McpAuthResult> {
  const isPath = opts.pathKey !== undefined;
  const base: McpAuthResult = isPath ? checkPathKey(opts.pathKey ?? "") : door === "header" ? await authenticateMcp(req) : checkMcpBearer(req);
  if (!identityEnforced()) return base;

  const approver = approverEmail();
  if (!approver) return unavailable;
  const key = presentedKey(req, opts.pathKey);
  const hash = key ? sha256Hex(key) : null;
  const hash8 = hash ? hash.slice(0, 8) : null;

  try {
    if (base.ok) {
      const p = base.principal;
      if (p.person) {
        const email = p.person.email;
        if (!(await sessionKeyOk(p.person.key_id, email))) { // the session is bound to its key: key revoked, email revoked/blacklisted or key never bound = no session
          await auditIdentityRefused({ email, key_id: p.person.key_id ?? null }, "session_key_revoked", door);
          return { ok: false, failure: unauthorized };
        }
        if (email === approver) return { ok: true, principal: { ...p, owner: { key_id: `session:${p.person.session_id.slice(0, 12)}`, door } } };
        const refusal = refusalForStatus(await identityStatus(email));
        if (refusal) {
          await auditIdentityRefused({ email }, refusal, door);
          return { ok: false, failure: unauthorized };
        }
        const keyId = p.person.key_id ?? `session:${p.person.session_id.slice(0, 12)}`;
        return { ok: true, principal: { ...p, identity: { email, key_id: keyId, door } } };
      }
      if (ownerActors().has(p.token_id)) return { ok: true, principal: { ...p, owner: { key_id: `k_${(p.key_hash ?? "").slice(0, 8)}`, door } } };
      const row = p.key_hash ? await lookupKey(p.key_hash) : null;
      const refusal = keyRefusal(row);
      if (refusal || !row) {
        await auditIdentityRefused({ email: row?.email ?? null, key_id: row?.key_id ?? null, hash8: p.key_hash?.slice(0, 8) ?? hash8 }, refusal ?? "unknown_key", door);
        return { ok: false, failure: unauthorized };
      }
      if (row.email === approver) return { ok: true, principal: { ...p, owner: { key_id: row.key_id, door } } };
      return { ok: true, principal: { ...p, identity: { email: row.email, key_id: row.key_id, door } } };
    }

    // The env maps did not know this key (or were not configured). A key issued through mcp_key still may be good. A denylisted key, and an OAuth bearer, are final.
    if (base.failure.denied || !hash || key?.startsWith("esp_")) return base;
    const row = await lookupKey(hash);
    const refusal = keyRefusal(row);
    if (refusal || !row) {
      await auditIdentityRefused({ email: row?.email ?? null, key_id: row?.key_id ?? null, hash8 }, refusal ?? "unknown_key", door);
      return { ok: false, failure: unauthorized };
    }
    const scopes = new Set<McpScope>(row.scope === "admin" ? ["read", "admin"] : ["read"]);
    const principal: McpPrincipal = { token_id: row.scope === "admin" ? `${ADMIN_ACTOR_PREFIX}${row.email}` : `user:${row.email}`, scopes, key_hash: hash };
    if (row.email === approver) return { ok: true, principal: { ...principal, owner: { key_id: row.key_id, door } } };
    return { ok: true, principal: { ...principal, identity: { email: row.email, key_id: row.key_id, door } } };
  } catch {
    return unavailable;
  }
}
