/**
 * /admin/mcp-audit — V only. "What did X open and when": per-user MCP calls from audit_log, filtered by address and date. Ids and closed codes, never text. V's own calls are not here (mcp_owner_seclog).
 */
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { auditByUser, type AuditViewRow } from "@/lib/mcp/audit-views";
import { ownerFromCookie } from "@/lib/mcp/owner-gate";

export const dynamic = "force-dynamic";

export default async function McpAuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const owner = await ownerFromCookie();
  if (!owner) notFound();
  const sp = await searchParams;
  const one = (k: string): string => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  let rows: AuditViewRow[] = [];
  let err: string | null = null;
  try { rows = await auditByUser({ user: one("user") || null, from: one("from") || null, to: one("to") || null }); } catch { err = "audit_unavailable"; }
  return (
    <AdminShell adminEmail={owner} active="mcp-audit" pageTitle="MCP audit">
      <form method="get" className="mb-4 flex flex-wrap gap-2 text-sm">
        <input name="user" defaultValue={one("user")} placeholder="email" className="border px-2 py-1" />
        <input name="from" defaultValue={one("from")} placeholder="from YYYY-MM-DD" className="border px-2 py-1" />
        <input name="to" defaultValue={one("to")} placeholder="to YYYY-MM-DD" className="border px-2 py-1" />
        <button type="submit" className="border px-3 py-1">Filter</button>
      </form>
      {err ? <p className="text-sm text-red-700">The audit could not be read ({err}).</p> : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="text-left text-even-ink-600">{["time", "user", "key", "door", "action", "tool", "outcome", "subject ids"].map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-even-ink-200 align-top">
                  <td className="px-2 py-1">{r.ts}</td><td className="px-2 py-1">{r.email ?? "—"}</td><td className="px-2 py-1">{r.key_id ?? "—"}</td><td className="px-2 py-1">{r.door ?? "—"}</td>
                  <td className="px-2 py-1">{r.action}</td><td className="px-2 py-1">{r.tool}</td><td className="px-2 py-1">{r.outcome}</td><td className="px-2 py-1">{JSON.stringify(r.subject)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 ? <p className="mt-2 text-sm text-even-ink-600">No rows for this filter.</p> : null}
        </div>
      )}
    </AdminShell>
  );
}
