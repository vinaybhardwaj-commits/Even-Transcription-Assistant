/**
 * lib/mcp/oauth/person-auth.ts — OAUTH-O3: the async door check. A bearer starting `esp_` is an OAuth person token and is NEVER looked up in the static maps; anything else is checkMcpBearer unchanged.
 *
 * Order (flag on): denylist (plain sha256, the same hash form as static keys) -> pepper present -> lookup by sha256(pepper||token) -> kind access, not revoked (row or family tombstone), not expired, resource equal,
 * person row active -> principal. Flag off: the whole thing is checkMcpBearer, so an esp_ token is an unknown token exactly as before. A database failure is a 503, never an accept.
 * No cache: a revoke (or a person flip) is seen by the very next call.
 */
import { createHash } from "node:crypto";
import { MCP_TOKENS_DENY_ENV, checkMcpBearer, parseDenyList, type McpPrincipal, type McpScope, type McpAuthFailure } from "@/lib/mcp/auth";
import { auditPersonDenied } from "@/lib/mcp/audit";
import { mcpResourceUrl, oauthEnabled } from "./config";
import { hashSecret, pepper } from "./crypto";
import { lookupAccessToken } from "./store";

export type McpAuthResult = { ok: true; principal: McpPrincipal } | { ok: false; failure: McpAuthFailure };

const VALID_SCOPES: ReadonlySet<string> = new Set(["read", "invoke", "write", "admin"]);
const unauthorized: McpAuthResult = { ok: false, failure: { status: 401, code: "unauthorized" } };

export async function authenticateMcp(req: Request): Promise<McpAuthResult> {
  const m = /^Bearer\s+(.+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  const presented = m?.[1];
  if (!presented || !presented.startsWith("esp_") || !oauthEnabled()) return checkMcpBearer(req);

  const plain = createHash("sha256").update(presented).digest("hex");
  if (parseDenyList(process.env[MCP_TOKENS_DENY_ENV]).has(plain)) return { ok: false, failure: { status: 401, code: "unauthorized", denied: plain.slice(0, 8) } };
  if (!pepper()) return { ok: false, failure: { status: 503, code: "auth_unavailable" } };
  if (presented.length > 128) return unauthorized;

  let row;
  try {
    row = await lookupAccessToken(hashSecret(presented));
  } catch {
    return { ok: false, failure: { status: 503, code: "auth_unavailable" } };
  }
  if (!row) return unauthorized; // unknown: no row, no oracle

  const deny = async (reason: "expired" | "revoked" | "inactive" | "resource"): Promise<McpAuthResult> => {
    await auditPersonDenied(row.email, reason);
    return unauthorized;
  };
  if (row.revoked_at || row.family_revoked || row.predates_grant) return deny("revoked"); // predates_grant: created before the person's last (re)grant, e.g. a token a racing redemption slipped past revoke_person // the family tombstone (O2-FIX1) kills a token a racing redemption left unswept
  if (row.expired || row.family_expired) return deny("expired"); // family_expired: the 30-day session ends on day 30 however it was refreshed (no sliding)
  if (row.resource !== mcpResourceUrl()) return deny("resource");
  if (row.person_status !== "active") return deny("inactive");
  const personScopes = new Set(row.person_scopes ?? []);
  const scopes = new Set<McpScope>(row.scopes.filter((s): s is McpScope => VALID_SCOPES.has(s) && personScopes.has(s)));
  if (scopes.size === 0) return deny("inactive");
  return { ok: true, principal: { token_id: `person:${row.email}`, scopes, person: { email: row.email, session_id: row.family_id, key_id: row.key_id ?? null } } };
}
