/**
 * lib/mcp/actor-id.ts — the audit actor id for an MCP principal, on its own so lib/mcp/auth.ts can compare the EXACT form audit rows record without importing the database.
 * lib/mcp/audit.ts re-exports both names, so every existing import is unchanged.
 */

/** The single-token fallback's audit actor. */
export const MCP_AUDIT_ACTOR = "mcp:operator-v1";

/** Tier 2 §2.3 — `mcp:<actor>`, the one shape every MCP audit row's actor_id takes. Keeps an existing `mcp:` prefix and cuts to 64 characters. */
export function mcpActorId(actor: string | null | undefined): string {
  const t = typeof actor === "string" ? actor.trim() : "";
  if (!t) return MCP_AUDIT_ACTOR;
  return t.startsWith("mcp:") ? t.slice(0, 64) : `mcp:${t}`.slice(0, 64);
}
