/**
 * /admin/mcp-seclog — V only. The owner security log: ts, key id, tool, outcome of V's own MCP calls. Nothing about what V looked at (no subject ids, no args). 30-day retention.
 */
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { seclogRows, type SeclogRow } from "@/lib/mcp/audit-views";
import { ownerFromCookie } from "@/lib/mcp/owner-gate";

export const dynamic = "force-dynamic";

export default async function McpSeclogPage() {
  const owner = await ownerFromCookie();
  if (!owner) notFound();
  let rows: SeclogRow[] = [];
  let err: string | null = null;
  try { rows = await seclogRows(); } catch { err = "seclog_unavailable"; }
  return (
    <AdminShell adminEmail={owner} active="mcp-seclog" pageTitle="MCP owner security log">
      {err ? <p className="text-sm text-red-700">The log could not be read ({err}).</p> : (
        <table className="min-w-full text-sm">
          <thead><tr className="text-left text-even-ink-600">{["time", "key", "tool", "outcome"].map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-even-ink-200"><td className="px-2 py-1">{r.ts}</td><td className="px-2 py-1">{r.key_id}</td><td className="px-2 py-1">{r.tool}</td><td className="px-2 py-1">{r.outcome}</td></tr>)}</tbody>
        </table>
      )}
    </AdminShell>
  );
}
