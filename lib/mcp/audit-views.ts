/**
 * lib/mcp/audit-views.ts — the reads behind /admin/mcp-audit, /admin/mcp-seclog and the 20:00 IST digest.
 * Governance reads audit_log rows of actor_type 'person' only (V's calls are never there: they go to mcp_owner_seclog). Subject ids appear in the audit view for V, never in the digest mail.
 */
import { sql } from "@/lib/db";
import { SECLOG_RETENTION_DAYS } from "./oauth/config";

export type AuditViewRow = { ts: string; email: string | null; key_id: string | null; door: string | null; action: string; tool: string; outcome: string; subject: unknown };

const ISO = /^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]{1,20})?$/;
export const dateParam = (v: string | null | undefined): string | null => (v && ISO.test(v.trim()) ? v.trim() : null);

/** "What did X open and when": newest first, filtered by address and an optional date range (inclusive start, exclusive end). */
export async function auditByUser(f: { user?: string | null; from?: string | null; to?: string | null; limit?: number }): Promise<AuditViewRow[]> {
  const user = f.user ? f.user.trim().toLowerCase().slice(0, 254) : null;
  const from = dateParam(f.from);
  const to = dateParam(f.to);
  const limit = Math.max(1, Math.min(f.limit ?? 200, 1000));
  return (await sql`
    SELECT created_at::text AS ts, metadata_json->>'email' AS email, metadata_json->>'key_id' AS key_id, metadata_json->>'door' AS door,
           action, target_id AS tool, COALESCE(metadata_json->>'outcome', CASE WHEN (metadata_json->>'ok') = 'true' THEN 'ok' ELSE 'error' END) AS outcome,
           COALESCE(metadata_json->'subject', '{}'::jsonb) AS subject
      FROM audit_log
     WHERE actor_type::text = 'person' AND action IN ('mcp.tools/call', 'mcp.rpc', 'mcp.refused', 'mcp.denied')
       AND (${user}::text IS NULL OR actor_id = ${"person:" + (user ?? "")})
       AND (${from}::timestamptz IS NULL OR created_at >= ${from}::timestamptz)
       AND (${to}::timestamptz IS NULL OR created_at < ${to}::timestamptz)
     ORDER BY created_at DESC, id DESC LIMIT ${limit}
  `) as AuditViewRow[];
}

export type SeclogRow = { ts: string; key_id: string; tool: string; outcome: string };

export async function seclogRows(limit = 300): Promise<SeclogRow[]> {
  return (await sql`SELECT ts::text AS ts, key_id, tool, outcome FROM mcp_owner_seclog ORDER BY ts DESC, id DESC LIMIT ${Math.max(1, Math.min(limit, 2000))}`) as SeclogRow[];
}

/** The retention purge (30 days). The table's trigger refuses a delete of anything younger. Returns the rows removed. */
export async function purgeSeclog(): Promise<number> {
  const rows = (await sql`DELETE FROM mcp_owner_seclog WHERE ts < now() - (${SECLOG_RETENTION_DAYS} * interval '1 day') RETURNING id`) as unknown[];
  return rows.length;
}

export type DigestLine = { email: string; calls: number; refused: number; errors: number; tools: Record<string, number>; first: string; last: string };

/** Per-user activity since a moment: counts per tool, refusals, first and last time. No subject ids, no seclog. */
export async function digestSince(sinceIso: string): Promise<DigestLine[]> {
  const rows = (await sql`
    SELECT COALESCE(metadata_json->>'email', substr(actor_id, 8)) AS email, action, target_id AS tool,
           COALESCE(metadata_json->>'outcome', CASE WHEN (metadata_json->>'ok') = 'true' THEN 'ok' ELSE 'error' END) AS outcome,
           count(*)::int AS n, min(created_at)::text AS first, max(created_at)::text AS last
      FROM audit_log
     WHERE actor_type::text = 'person' AND action IN ('mcp.tools/call', 'mcp.refused') AND created_at >= ${sinceIso}::timestamptz
     GROUP BY 1, 2, 3, 4 ORDER BY 1
  `) as Array<{ email: string; action: string; tool: string; outcome: string; n: number; first: string; last: string }>;
  const by = new Map<string, DigestLine>();
  for (const r of rows) {
    const d = by.get(r.email) ?? { email: r.email, calls: 0, refused: 0, errors: 0, tools: {}, first: r.first, last: r.last };
    if (r.action === "mcp.refused" || r.outcome === "refused") d.refused += r.n;
    else {
      d.calls += r.n;
      if (r.outcome === "error") d.errors += r.n;
      d.tools[r.tool] = (d.tools[r.tool] ?? 0) + r.n;
    }
    if (r.first < d.first) d.first = r.first;
    if (r.last > d.last) d.last = r.last;
    by.set(r.email, d);
  }
  return [...by.values()];
}

export function digestText(lines: DigestLine[], sinceIso: string): string {
  if (lines.length === 0) return `EvenScribe MCP daily digest (since ${sinceIso}): no activity by anyone but you.`;
  const body = lines.map((l) => `${l.email}: ${l.calls} calls (${l.errors} errors), ${l.refused} refused. ${Object.entries(l.tools).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} x${n}`).join(", ") || "no tool calls"}. First ${l.first}, last ${l.last}.`).join("\n");
  return `EvenScribe MCP daily digest (since ${sinceIso}). Details: /admin/mcp-audit.\n\n${body}`;
}
