/**
 * /admin/mcp-keys — V only. Issue, rotate and revoke per-email MCP keys; revoke or blacklist an address. Forms post to /api/admin/mcp-keys; a new key is shown once, on the page that answers the post.
 */
import { notFound } from "next/navigation";
import { AdminShell } from "@/components/admin/AdminShell";
import { listIdentities, listKeys } from "@/lib/mcp/identity";
import { ownerFromCookie } from "@/lib/mcp/owner-gate";

export const dynamic = "force-dynamic";

export default async function McpKeysPage() {
  const owner = await ownerFromCookie();
  if (!owner) notFound();
  let keys: Awaited<ReturnType<typeof listKeys>> = [];
  let ids: Awaited<ReturnType<typeof listIdentities>> = [];
  let err: string | null = null;
  try { [keys, ids] = await Promise.all([listKeys(), listIdentities()]); } catch { err = "keys_unavailable"; }
  const post = (fields: Record<string, string>, label: string) => (
    <form method="post" action="/api/admin/mcp-keys" className="inline">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" className="border px-2 py-0.5 text-xs">{label}</button>
    </form>
  );
  return (
    <AdminShell adminEmail={owner} active="mcp-keys" pageTitle="MCP keys">
      {err ? <p className="text-sm text-red-700">Could not be read ({err}).</p> : (
        <div className="space-y-6 text-sm">
          <form method="post" action="/api/admin/mcp-keys" className="flex flex-wrap gap-2">
            <input type="hidden" name="action" value="issue" />
            <input name="email" type="email" placeholder="email" required className="border px-2 py-1" />
            <select name="scope" className="border px-2 py-1"><option value="read">read</option><option value="admin">admin</option></select>
            <button type="submit" className="border px-3 py-1">Issue key</button>
          </form>
          <table className="min-w-full">
            <thead><tr className="text-left text-even-ink-600">{["email", "identity", "key", "scope", "issued", "state", ""].map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.key_id} className="border-t border-even-ink-200">
                  <td className="px-2 py-1">{k.email}</td><td className="px-2 py-1">{k.identity_status}</td><td className="px-2 py-1">{k.key_id}</td><td className="px-2 py-1">{k.scope}</td><td className="px-2 py-1">{k.issued_at}</td>
                  <td className="px-2 py-1">{k.revoked_at ? `revoked ${k.revoked_at}` : "live"}</td>
                  <td className="px-2 py-1">{k.revoked_at ? null : <>{post({ action: "rotate", key_id: k.key_id }, "Rotate")} {post({ action: "revoke", key_id: k.key_id }, "Revoke")}</>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="min-w-full">
            <thead><tr className="text-left text-even-ink-600">{["identity", "status", "by", "created", ""].map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}</tr></thead>
            <tbody>
              {ids.map((i) => (
                <tr key={i.email} className="border-t border-even-ink-200">
                  <td className="px-2 py-1">{i.email}</td><td className="px-2 py-1">{i.status}</td><td className="px-2 py-1">{i.created_by ?? "—"}</td><td className="px-2 py-1">{i.created_at}</td>
                  <td className="px-2 py-1">{i.status === "blacklisted" ? null : <>{post({ action: "identity", email: i.email, status: "revoked" }, "Revoke")} {post({ action: "identity", email: i.email, status: "blacklisted" }, "Blacklist")}</>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminShell>
  );
}
