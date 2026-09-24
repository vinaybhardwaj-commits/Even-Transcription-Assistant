/**
 * lib/mcp/auth.ts — bearer auth for /api/mcp (Operator MCP PRD §15; Tier 2 §2.3).
 *
 * `Authorization: Bearer <token>` — constant-time compare (same technique as lib/brain/auth.ts:
 * SHA-256 both sides + timingSafeEqual so a length mismatch cannot short-circuit). Bad/absent →
 * 401 unauthorized. Neither env configured → 503 mcp_token_not_configured (fail closed). Not
 * doctor JWT, not room cookie, not admin password.
 *
 * ─── TIER 2 §2.3 — PER-TOKEN SCOPES ────────────────────────────────────────────────────────────
 * `SCRIBE_MCP_TOKENS` is a JSON object keyed by the SHA-256 HEX of the token, so the env var never
 * holds a usable credential — a leaked copy of it grants nothing:
 *
 *   { "<sha256 hex of token>": { "actor": "operator-v", "scopes": ["read","invoke","write"] }, … }
 *
 * Resolved FIRST. `SCRIBE_MCP_TOKEN` remains as the fallback and still resolves to actor
 * `operator-v1` with all three scopes, so nothing that works today stops working. A watcher can be
 * given a `["read"]` entry and will then get -32001 scope_or_tool_unavailable on every write tool.
 *
 * THE LOOKUP IS BY HASH, NOT BY COMPARISON, so the map is O(1) and the timing of a miss does not
 * depend on how many tokens are configured. The single-token fallback keeps its timing-safe compare
 * because there the secret itself is in the environment.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { mcpActorId, MCP_AUDIT_ACTOR } from "./actor-id";

export const MCP_TOKEN_ENV = "SCRIBE_MCP_TOKEN";
export const MCP_TOKENS_ENV = "SCRIBE_MCP_TOKENS";
/**
 * ADDITIVE TOKENS (24 Sep 2026, Fable ruling 137: the room-alert relay needs its own read-only token). `SCRIBE_MCP_TOKENS` is a write-only Vercel
 * Secret: a pull returns a placeholder, so nobody can read it, add ONE entry and write it back without destroying every existing token, and a write
 * cannot be undone. This second variable takes the SAME hash-keyed JSON, holds no usable credential either, and is merged in BEHIND the primary map:
 * on a collision the primary entry wins whole (actor AND scopes), so nothing here can widen, rename or shadow an existing token. Every actor from it is prefixed
 * `extra:` so audit rows say where a token came from, and the whole map is ignored when the primary is not fully readable (fail closed). Absent = nothing changes.
 */
export const MCP_TOKENS_EXTRA_ENV = "SCRIBE_MCP_TOKENS_EXTRA";
export const MCP_TOKEN_ID = "operator-v1";

export type McpScope = "read" | "invoke" | "write";
export const ALL_SCOPES: readonly McpScope[] = ["read", "invoke", "write"];

export type McpPrincipal = { token_id: string; scopes: ReadonlySet<McpScope> };

export type McpAuthFailure = { status: 401 | 503; code: "unauthorized" | "mcp_token_not_configured" };

const sha256Hex = (v: string): string => createHash("sha256").update(v).digest("hex");

/** PURE — one entry of the token map, or null for anything this build cannot read. */
function parseEntry(raw: unknown): { actor: string; scopes: Set<McpScope> } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const actor = typeof o.actor === "string" && o.actor.trim() ? o.actor.trim().slice(0, 64) : null;
  if (!actor) return null;
  // An entry with no readable scope list gets NOTHING. A malformed scope list must never widen
  // access, and a token that can do nothing is a loud, safe failure.
  const listed = Array.isArray(o.scopes) ? o.scopes : [];
  const scopes = new Set<McpScope>(
    listed.filter((x): x is McpScope => typeof x === "string" && (ALL_SCOPES as readonly string[]).includes(x)),
  );
  return { actor, scopes };
}

type TokenMap = Record<string, { actor: string; scopes: Set<McpScope> }>;

/** PURE — the configured map, keyed by sha256 hex. `{}` for absent or unreadable JSON. `envName` only names the variable in the warning. */
export function parseTokenMap(raw: string | undefined, envName: string = MCP_TOKENS_ENV): TokenMap {
  if (!raw || !raw.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    console.warn(`[mcp-auth] ${envName} is not valid JSON; ignoring it`);
    return {};
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, { actor: string; scopes: Set<McpScope> }> = {};
  for (const [hash, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) continue; // keys are sha256 hex; anything else is a typo
    const parsed = parseEntry(entry);
    if (parsed) out[hash.toLowerCase()] = parsed;
  }
  return out;
}

/** Every principal that came from the additive map carries this prefix on its actor, so an audit row names WHERE the token came from (Fable ruling 154). */
export const EXTRA_ACTOR_PREFIX = "extra:";

/**
 * PURE — is the PRIMARY value completely understood? True when it is absent or blank (there is no primary to misread), or a JSON object every one of whose keys is a
 * sha256 hex and every one of whose entries has an actor and a scope LIST. False for anything else: invalid JSON, a non-object, a key that is not a hash, an entry with no
 * actor or with scopes that are not a list. When the primary is not fully understood the additive map is IGNORED WHOLE (fail closed, Fable ruling 154): a token whose
 * primary entry this build cannot read must not be reachable through a side door, and a half-read primary is exactly when nobody knows what it was meant to say.
 * (The primary map's own tolerance for a bad entry is unchanged: the bad entry is simply not a token.)
 */
export function primaryFullyParsed(raw: string | undefined): boolean {
  if (!raw || !raw.trim()) return true;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const [hash, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[0-9a-f]{64}$/i.test(hash)) return false;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const o = entry as Record<string, unknown>;
    if (typeof o.actor !== "string" || !o.actor.trim() || !Array.isArray(o.scopes)) return false;
  }
  return true;
}

/**
 * PURE — the primary map with the additive one behind it. The additive map can only ADD a token:
 *  - if the primary is not fully understood (`primaryOk` false) the additive map is ignored whole;
 *  - a hash the primary map holds is never touched (the primary entry wins whole, actor and scopes);
 *  - every added entry's actor is prefixed `extra:`, so audit rows from an additive token can always be told from the old ones; an entry whose prefixed AUDIT id
 *    still equals a primary actor's (or the single-token actor's) is skipped, so nothing can be made to look like an existing principal.
 * What was skipped is logged as COUNTS only, never a hash or an actor name.
 */
export function mergeTokenMaps(primary: TokenMap, extra: TokenMap, primaryOk: boolean = true): TokenMap {
  const extraCount = Object.keys(extra).length;
  if (!primaryOk) {
    if (extraCount > 0) console.warn(`[mcp-auth] ${MCP_TOKENS_ENV} is not fully readable; ignoring all ${extraCount} entr${extraCount === 1 ? "y" : "ies"} in ${MCP_TOKENS_EXTRA_ENV} (fail closed)`);
    return { ...primary };
  }
  const out: TokenMap = { ...primary };
  const takenAudit = new Set<string>([MCP_AUDIT_ACTOR, ...Object.values(primary).map((e) => mcpActorId(e.actor))]);
  let shadowed = 0;
  let clash = 0;
  for (const [hash, entry] of Object.entries(extra)) {
    if (hash in out) { shadowed += 1; continue; }
    const actor = `${EXTRA_ACTOR_PREFIX}${entry.actor}`;
    if (takenAudit.has(mcpActorId(actor))) { clash += 1; continue; }
    out[hash] = { actor, scopes: entry.scopes };
  }
  if (shadowed > 0) console.warn(`[mcp-auth] ${shadowed} entr${shadowed === 1 ? "y" : "ies"} in ${MCP_TOKENS_EXTRA_ENV} shadowed by ${MCP_TOKENS_ENV}; the primary entry wins`);
  if (clash > 0) console.warn(`[mcp-auth] ${clash} entr${clash === 1 ? "y" : "ies"} in ${MCP_TOKENS_EXTRA_ENV} skipped: the audit actor would equal an existing principal's`);
  return out;
}

/** Returns the principal when authorized, else the failure to send. Never throws. */
export function checkMcpBearer(req: Request): { ok: true; principal: McpPrincipal } | { ok: false; failure: McpAuthFailure } {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const map = mergeTokenMaps(
    parseTokenMap(process.env[MCP_TOKENS_ENV]),
    parseTokenMap(process.env[MCP_TOKENS_EXTRA_ENV], MCP_TOKENS_EXTRA_ENV),
    primaryFullyParsed(process.env[MCP_TOKENS_ENV]),
  );
  const single = process.env[MCP_TOKEN_ENV];
  const configured = Object.keys(map).length > 0 || Boolean(single);
  if (!configured) return { ok: false, failure: { status: 503, code: "mcp_token_not_configured" } };
  if (!m) return { ok: false, failure: { status: 401, code: "unauthorized" } };
  const presented = m[1]!;

  // §2.3 — the map first. Hash lookup: no comparison, so no timing signal from the map's size.
  const hit = map[sha256Hex(presented)];
  if (hit) return { ok: true, principal: { token_id: hit.actor, scopes: hit.scopes } };

  // Fallback: the original single token, unchanged — all three scopes, actor operator-v1.
  if (single) {
    const a = createHash("sha256").update(presented).digest();
    const b = createHash("sha256").update(single).digest();
    if (timingSafeEqual(a, b)) return { ok: true, principal: { token_id: MCP_TOKEN_ID, scopes: new Set(ALL_SCOPES) } };
  }
  return { ok: false, failure: { status: 401, code: "unauthorized" } };
}
