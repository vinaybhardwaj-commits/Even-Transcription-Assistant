"use client";

/**
 * SendsClient — Sprint 11 Sends dashboard (Figma S8).
 *
 * Aggregates over a chosen window: KPI strip + per-recipient top 10 +
 * per-domain rollup with bounce rates + Failed sends table with Retry
 * buttons (route to /admin/encounters/[id]?action=resend).
 */

import * as React from "react";
import Link from "next/link";

type Window = "today" | "week" | "month" | "all";

type SendsBundle = {
  aggregates: {
    sent: number; delivered: number; opened: number; failed: number;
    bounced: number; complained: number; queued: number;
    delivery_rate_pct: number | null;
    open_rate_pct: number | null;
  };
  per_recipient: Array<{ email: string; sent: number; delivered: number; opened: number; open_rate_pct: number | null }>;
  per_domain: Array<{ domain: string; total: number; delivered: number; bounced: number; bounce_rate_pct: number | null }>;
  failed_recent: Array<{ id: string; encounter_id: string; recipient_email: string; status: string; failure_reason: string | null; created_at: string; updated_at: string }>;
  window: Window;
};

export function SendsClient() {
  const [window, setWindow] = React.useState<Window>("month");
  const [data, setData] = React.useState<SendsBundle | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchOnce = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/sends?window=${window}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setData(j as SendsBundle);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [window]);

  React.useEffect(() => { void fetchOnce(); }, [fetchOnce]);

  const fmtPct = (p: number | null) => p == null ? "—" : `${p}%`;
  const fmtDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  return (
    <div className="space-y-6">
      {/* Window picker */}
      <div className="flex flex-wrap items-center gap-2">
        {(["today","week","month","all"] as Window[]).map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setWindow(w)}
            className={`px-2.5 py-1 rounded-md text-caption transition-colors ${
              window === w ? "bg-even-navy-800 text-even-white" : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
            }`}
          >
            {w === "today" ? "Today" : w === "week" ? "This week" : w === "month" ? "This month" : "All time"}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void fetchOnce()}
          className="ml-auto px-2.5 py-1 rounded-md text-caption bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
          disabled={loading}
        >
          {loading ? "↻ …" : "↻ Refresh"}
        </button>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">
          Could not load sends: {error}
        </div>
      ) : null}

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Delivery rate"
          value={data ? fmtPct(data.aggregates.delivery_rate_pct) : "—"}
          sub={data ? `${data.aggregates.delivered + data.aggregates.opened} of ${data.aggregates.delivered + data.aggregates.opened + data.aggregates.failed + data.aggregates.bounced} attempted` : ""}
        />
        <KpiCard
          label="Open rate"
          value={data ? fmtPct(data.aggregates.open_rate_pct) : "—"}
          sub={data ? `${data.aggregates.opened} opened of ${data.aggregates.delivered + data.aggregates.opened} delivered` : ""}
        />
        <KpiCard
          label="Failed"
          value={data ? data.aggregates.failed + data.aggregates.bounced + data.aggregates.complained : "—"}
          sub={data ? `${data.aggregates.failed} failed · ${data.aggregates.bounced} bounced · ${data.aggregates.complained} complained` : ""}
        />
        <KpiCard
          label="Queued"
          value={data ? data.aggregates.queued : "—"}
          sub={data && data.aggregates.queued > 0 ? "Awaiting delivery" : "—"}
        />
      </div>

      {/* Per-recipient + per-domain side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
          <h3 className="text-label text-even-navy-800 mb-3">Top recipients</h3>
          {!data || data.per_recipient.length === 0 ? (
            <p className="text-body text-even-ink-400">No sends in this window.</p>
          ) : (
            <table className="w-full text-left text-body">
              <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 border-b border-even-ink-100">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Email</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Sent</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Delivered</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Opens</th>
                </tr>
              </thead>
              <tbody>
                {data.per_recipient.map((r) => (
                  <tr key={r.email} className="border-t border-even-ink-100">
                    <td className="px-2 py-1.5 text-caption truncate max-w-[200px]" title={r.email}>{r.email}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-caption">{r.sent}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-caption">{r.delivered}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-caption">
                      {r.opened} <span className="text-even-ink-400">({fmtPct(r.open_rate_pct)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
          <h3 className="text-label text-even-navy-800 mb-3">Per domain</h3>
          {!data || data.per_domain.length === 0 ? (
            <p className="text-body text-even-ink-400">No domain data.</p>
          ) : (
            <table className="w-full text-left text-body">
              <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 border-b border-even-ink-100">
                <tr>
                  <th className="px-2 py-1.5 font-semibold">Domain</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Total</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Delivered</th>
                  <th className="px-2 py-1.5 font-semibold text-right">Bounce</th>
                </tr>
              </thead>
              <tbody>
                {data.per_domain.map((d) => (
                  <tr key={d.domain} className="border-t border-even-ink-100">
                    <td className="px-2 py-1.5 text-caption">{d.domain}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-caption">{d.total}</td>
                    <td className="px-2 py-1.5 text-right font-mono text-caption">{d.delivered}</td>
                    <td className={`px-2 py-1.5 text-right font-mono text-caption ${(d.bounce_rate_pct ?? 0) > 10 ? "text-danger-700" : "text-even-ink-700"}`}>
                      {d.bounced} <span className="text-even-ink-400">({fmtPct(d.bounce_rate_pct)})</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Failed sends */}
      <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
        <h3 className="text-label text-even-navy-800 mb-3">Failed sends · most recent</h3>
        {!data || data.failed_recent.length === 0 ? (
          <p className="text-body text-even-ink-400">No failed sends in this window.</p>
        ) : (
          <table className="w-full text-left text-body">
            <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 border-b border-even-ink-100">
              <tr>
                <th className="px-2 py-1.5 font-semibold">Recipient</th>
                <th className="px-2 py-1.5 font-semibold">Encounter</th>
                <th className="px-2 py-1.5 font-semibold">Status</th>
                <th className="px-2 py-1.5 font-semibold">Reason</th>
                <th className="px-2 py-1.5 font-semibold">When</th>
                <th className="px-2 py-1.5 font-semibold w-20"></th>
              </tr>
            </thead>
            <tbody>
              {data.failed_recent.map((f) => (
                <tr key={f.id} className="border-t border-even-ink-100">
                  <td className="px-2 py-1.5 text-caption text-even-navy-800 truncate max-w-[180px]" title={f.recipient_email}>{f.recipient_email}</td>
                  <td className="px-2 py-1.5 text-caption font-mono">
                    <Link href={`/admin/encounters/${f.encounter_id}`} className="text-even-blue-600 hover:underline">
                      {f.encounter_id.slice(0, 14)}…
                    </Link>
                  </td>
                  <td className="px-2 py-1.5 text-caption">
                    <span className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-medium ${f.status === "bounced" ? "bg-warning-100 text-warning-700" : "bg-danger-100/60 text-danger-700"}`}>
                      {f.status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-caption text-even-ink-500 truncate max-w-[280px]" title={f.failure_reason ?? ""}>{f.failure_reason ?? "—"}</td>
                  <td className="px-2 py-1.5 text-caption text-even-ink-500 whitespace-nowrap" suppressHydrationWarning>{fmtDate(f.updated_at)}</td>
                  <td className="px-2 py-1.5 text-right">
                    <Link
                      href={`/admin/encounters/${f.encounter_id}?action=resend`}
                      className="inline-block text-caption text-even-blue-600 hover:underline whitespace-nowrap"
                    >
                      Retry →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1">{label}</p>
      <p className="text-heading text-even-navy-800 font-semibold">{value}</p>
      {sub ? <p className="text-caption text-even-ink-500 mt-1">{sub}</p> : null}
    </div>
  );
}
