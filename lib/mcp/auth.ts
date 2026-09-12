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

export const MCP_TOKEN_ENV = "SCRIBE_MCP_TOKEN";
export const MCP_TOKENS_ENV = "SCRIBE_MCP_TOKENS";
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

/** PURE — the configured map, keyed by sha256 hex. `{}` for absent or unreadable JSON. */
export function parseTokenMap(raw: string | undefined): Record<string, { actor: string; scopes: Set<McpScope> }> {
  if (!raw || !raw.trim()) return {};
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    console.warn("[mcp-auth] SCRIBE_MCP_TOKENS is not valid JSON; falling back to the single token");
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

/** Returns the principal when authorized, else the failure to send. Never throws. */
export function checkMcpBearer(req: Request): { ok: true; principal: McpPrincipal } | { ok: false; failure: McpAuthFailure } {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  const map = parseTokenMap(process.env[MCP_TOKENS_ENV]);
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
