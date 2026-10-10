/**
 * /admin/jev — Bench ops view v0 for the Jev worker (PRD §11, P1.6). Admin-only. One row per use: flags, live and shadow set versions, queue,
 * last success, calls and USD today against the cap, latency, band mix, 24 h error classes, breaker, mock share, drift alerts. Numbers, ids and
 * closed codes: NEVER text. It reads the same snapshot as scribe_jev_health.
 */
import { redirect } from "next/navigation";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { AdminShell } from "@/components/admin/AdminShell";
import { jevHealth, type JevHealth } from "@/lib/jev/worker/health";

export const dynamic = "force-dynamic";

const fmt = (o: Record<string, number>): string => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(" · ") || "—";
const flag = (v: boolean | "invalid" | null): string => (v === null ? "n/a" : v === "invalid" ? "INVALID" : v ? "on" : "off");

export default async function AdminJevPage() {
  const cookie = await readAdminCookie();
  if (!cookie) redirect("/admin");
  let email = "";
  try { email = String((await verifyAdminJwt(cookie)).email ?? ""); } catch { redirect("/admin"); }
  let h: JevHealth | null = null;
  let err: string | null = null;
  try { h = await jevHealth(); } catch (e) { const c = (e as { code?: unknown })?.code; err = typeof c === "string" && /^[0-9A-Z]{5}$/.test(c) ? `db_error:${c}` : "health_unavailable"; }
  return (
    <AdminShell adminEmail={email} active="jev" pageTitle="Jev worker">
      {err || !h ? (
        <p className="text-sm text-red-700">Jev health could not be read ({err}).</p>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-even-ink-600">
            IST {h.ist_date} · spent ${h.budget.spent_usd.toFixed(4)} of ${h.budget.cap_usd} (soft ${h.budget.soft_usd}) · left ${h.budget.left_usd.toFixed(4)} · last sweep job {h.sweeper_last_job_at ?? "never"}
          </p>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-even-ink-600">
                  {["use", "flags (worker/use/text/live)", "sets", "queue", "last ok", "calls · usd · p50/p95", "bands", "errors 24h", "breaker", "mock", "drift"].map((c) => <th key={c} className="px-2 py-1 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {h.uses.map((u) => (
                  <tr key={u.use} className="border-t border-even-ink-200 align-top">
                    <td className="px-2 py-1 font-medium">{u.use}</td>
                    <td className="px-2 py-1">{[u.flags.worker, u.flags.use, u.flags.text_lane, u.flags.live].map(flag).join(" / ")}</td>
                    <td className="px-2 py-1">{u.sets.length ? u.sets.map((s) => `${s.id}@${s.version} ${s.status} ${s.sha8}`).join("; ") : "—"}</td>
                    <td className="px-2 py-1">{u.queue.queued} queued · {u.queue.running} running</td>
                    <td className="px-2 py-1">{u.last_success_at ?? "—"}</td>
                    <td className="px-2 py-1">{u.today.calls} · ${u.today.usd.toFixed(4)} · {u.today.p50_ms ?? "—"}/{u.today.p95_ms ?? "—"} ms</td>
                    <td className="px-2 py-1">{fmt(u.band_mix)}</td>
                    <td className="px-2 py-1">{fmt(u.error_classes_24h)}{u.last_error_class ? ` (last ${u.last_error_class})` : ""}</td>
                    <td className="px-2 py-1">{u.breaker.state}{u.breaker.reason_class ? ` (${u.breaker.reason_class})` : ""}</td>
                    <td className={`px-2 py-1 ${u.mock_share > 0 ? "text-red-700 font-medium" : ""}`}>{(u.mock_share * 100).toFixed(1)}%</td>
                    <td className="px-2 py-1">{u.drift_alerts.length ? u.drift_alerts.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </AdminShell>
  );
}
