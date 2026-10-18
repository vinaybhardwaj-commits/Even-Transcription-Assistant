/**
 * lib/mcp/door-audit.ts — the per-call audit for a door that is NOT the JSON-RPC handler (today: /api/diarize-segments, which takes the same MCP keys).
 * Same rules as handleMcpRpc: SCRIBE_MCP_IDENTITY off = nothing (unchanged); a resolved non-V caller = one AWAITED audit_log row (email, key_id, door, tool, outcome, id-only subject) and the caller treats
 * a false return as "refuse the call"; V = mcp_owner_seclog only, best-effort. No text, no args beyond the subject ids.
 */
import type { McpPrincipal } from "@/lib/mcp/auth";
import { auditToolCall, logOwnerCall } from "@/lib/mcp/audit";

export async function auditDoorCall(
  principal: McpPrincipal,
  call: { tool: string; args: Record<string, unknown>; ok: boolean; refused?: boolean; ms: number; ip?: string | null; userAgent?: string | null },
): Promise<boolean> {
  if (principal.owner) {
    await logOwnerCall(principal.owner.key_id, call.tool, call.ok ? "ok" : call.refused ? "refused" : "error");
    return true;
  }
  const user = principal.identity;
  if (!user) return true;
  return auditToolCall({
    tool: call.tool, args: call.args, ok: call.ok, ms: call.ms, ip: call.ip ?? null, userAgent: call.userAgent ?? null,
    actor: `person:${user.email}`, errKind: call.ok ? null : call.refused ? "refused" : "result_error",
    person: { session_id: null, email: user.email, key_id: user.key_id, door: user.door },
  });
}
