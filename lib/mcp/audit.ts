/**
 * lib/mcp/audit.ts — one audit_log row per tools/call (Operator MCP PRD §5, §15).
 *
 * audit_log (migration 0001): actor_type actor_type ENUM('admin','doctor','system'), actor_id,
 * action, target_type, target_id, metadata_json, ip, user_agent, created_at. The enum has no
 * 'mcp' member and this slice adds no migration, so: actor_type='system',
 * actor_id='mcp:operator-v1', action='mcp.tools/call', target_type='mcp_tool', target_id=<tool
 * name>, metadata_json = SAFE args only — an allow-list of id / filter / flag keys. Never cue
 * text, never payloads, never audio URLs, never free-text queries.
 *
 * Best-effort: a failed insert logs to console and never fails the tool call.
 */

import { sql } from "@/lib/db";

export const MCP_AUDIT_ACTOR = "mcp:operator-v1";

// Keys that may be echoed into the audit row (ids, dates, filters, flags — nothing free-text).
const SAFE_ARG_KEYS = new Set([
  "room_id", "room_slug", "session_id", "encounter_id", "trace_id", "clinician_id", "engine_id",
  "run_id", "ist_date", "since", "type", "status", "limit", "offset", "mode", "chunk_idx", "idx",
  "bucket", "window", "surface", "note_type", "doctor_id", "topK", "top_k",
  "include_payload", "include_text", "include_prompts", "include_identity", "include_urls",
]);
const MAX_SAFE_STRING = 128;

export function safeArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (!SAFE_ARG_KEYS.has(k)) continue;
    if (typeof v === "string") out[k] = v.slice(0, MAX_SAFE_STRING);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
  }
  // Record that a free-text query was present without storing it.
  const a = args as Record<string, unknown>;
  if (typeof a.q === "string") out.q_len = a.q.length;
  return out;
}

export async function auditToolCall(input: {
  tool: string;
  args: unknown;
  ok: boolean;
  ms: number;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  const meta = { args: safeArgs(input.args), ok: input.ok, ms: input.ms };
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json, ip, user_agent)
      VALUES ('system', ${MCP_AUDIT_ACTOR}, 'mcp.tools/call', 'mcp_tool', ${input.tool},
              ${JSON.stringify(meta)}::jsonb, ${input.ip ?? null}::inet, ${input.userAgent ? input.userAgent.slice(0, 256) : null})
    `;
  } catch (e) {
    console.warn("[mcp-audit] audit_log insert failed (console fallback)", JSON.stringify({ tool: input.tool, ...meta, err: String((e as Error)?.message ?? e).slice(0, 160) }));
  }
}
