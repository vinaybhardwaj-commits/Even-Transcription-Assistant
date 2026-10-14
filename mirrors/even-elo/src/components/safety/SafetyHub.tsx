"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/* ---------- types ---------- */
type KN = { k: string; n: number; cat?: string };
/** Closure SLA against the 7-working-day clock (PRD Addendum A1, A1-D16). */
type SlaState = "closed" | "overdue" | "due_soon" | "on_track" | null;
type Stats = {
  totals: { total: number; open: number; near_miss: number; high_sev: number; with_rca: number; overdue?: number; due_soon?: number };
  capa: { rcas: number; verified: number; closed: number };
  sla?: { overdue: number; due_soon: number };
  bySeverity: KN[]; byStatus: KN[]; byType: KN[]; byDept: KN[]; byCategory: KN[]; byImpact: KN[];
  series: KN[]; topClusters: { label: string; recurrence_count: number; risk_score: number | null }[];
};
type Incident = {
  id: string; reported_at: string; severity: string | null; near_miss: boolean; status: string;
  type_name: string | null; dept_name: string | null; location_name: string | null; narrative_snippet: string; rca_count: number;
  due_at?: string | null; closed_at?: string | null; sla_state?: SlaState;
  /** A1-D26 — five hospitals share this queue. Optional: absent on the degraded upstream row shape. */
  unit_code?: string | null; unit_name?: string | null;
};
type Cluster = { id: string; label: string; recurrence_count: number; risk_score: number | null; last_seen: string | null; member_count: number; rca_count: number };

/* ---------- constants ---------- */
const SEV_ORDER: [string, string, string][] = [
  ["catastrophic", "Catastrophic", "#dc2626"], ["major", "Major", "#ea580c"], ["moderate", "Moderate", "#d97706"],
  ["minor", "Minor", "#2563eb"], ["negligible", "Negligible / no-harm", "#64748b"], ["unrated", "Unrated", "#cbd5e1"],
];
const SEV_COLOR: Record<string, string> = Object.fromEntries(SEV_ORDER.map(([k, , c]) => [k, c]));
const STATUS_ORDER: [string, string][] = [
  ["open", "Open"], ["under_investigation", "Investigating"], ["capa_assigned", "CAPA assigned"], ["closed", "Closed"], ["verified", "Verified"],
];

/* ---------- small UI helpers ---------- */
function Card({ title, children, right }: { title?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      {title && (
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
function Kpi({ n, label, accent }: { n: React.ReactNode; label: string; accent?: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4">
      <div className="text-3xl font-bold tracking-tight" style={accent ? { color: accent } : undefined}>{n}</div>
      <div className="mt-1 text-[13px] text-stone-500">{label}</div>
    </div>
  );
}
/**
 * Closure-SLA badge (A1-D16). Rendered only when there is something to say:
 * a closed incident and an on-track one both show nothing, so the badge means
 * "this needs attention" wherever it appears. sla_state is computed upstream in
 * even-incident; a null due_at yields null and renders nothing at all.
 *
 * The countdown is CALENDAR days remaining, which is what a reader wants to see
 * on a row ("Due in 3d"); the due_soon window itself is working days.
 */
function SlaBadge({ state, dueAt }: { state?: SlaState; dueAt?: string | null }) {
  if (state !== "overdue" && state !== "due_soon") return null;
  if (state === "overdue") {
    return <span className="rounded bg-red-100 px-1.5 py-0.5 text-[11px] font-bold text-red-700">Overdue</span>;
  }
  const ms = dueAt ? new Date(dueAt).getTime() - Date.now() : NaN;
  const label = !Number.isFinite(ms) ? "Due soon" : ms <= 0 ? "Due today" : `Due in ${Math.ceil(ms / 86400000)}d`;
  return <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-700">{label}</span>;
}

function RankBars({ rows, color = "#0f766e" }: { rows: KN[]; color?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  if (!rows.length) return <div className="text-sm text-stone-400">No data yet.</div>;
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.k} className="flex items-center gap-3">
          <div className="w-36 shrink-0 truncate text-[13px] text-stone-700" title={r.k}>{r.k}</div>
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-stone-100">
            <div className="h-full rounded-full" style={{ width: `${(r.n / max) * 100}%`, background: r.cat === "clinical" ? "#0d9488" : r.cat === "non_clinical" ? "#6366f1" : color }} />
          </div>
          <div className="w-7 text-right text-[13px] font-semibold tabular-nums">{r.n}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- main ---------- */
export default function SafetyHub() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [scanning, setScanning] = useState(false);
  const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [sev, setSev] = useState("");
  const [unit, setUnit] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  // A safety queue that silently shows stale data is worse than one that shows
  // nothing: an incident reported minutes ago must never be invisible here.
  // (a) never let the browser HTTP cache serve these reads; (b) this component
  // used to fetch on mount ONLY, so a tab left open before a report was filed
  // never re-fetched — refresh on focus/visibility and on an explicit control.
  const jget = (path: string) => fetch(path, { cache: "no-store" }).then((r) => r.json());

  const loadClusters = useCallback(() => {
    jget("/api/safety/office/clusters").then((j) => { if (j.ok) setClusters(j.clusters); });
  }, []);

  const loadAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const [st, inc] = await Promise.all([
        jget("/api/safety/office/stats"),
        jget("/api/safety/office/incidents"),
      ]);
      if (st.ok) setStats(st);
      if (inc.ok) setIncidents(inc.incidents);
      loadClusters();
      setLoadedAt(new Date());
    } finally { setRefreshing(false); }
  }, [loadClusters]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const onFocus = () => loadAll();
    const onVis = () => { if (document.visibilityState === "visible") loadAll(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => { window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onVis); };
  }, [loadAll]);

  async function scan() {
    setScanning(true);
    try { await fetch("/api/safety/office/recurrence/scan", { method: "POST", cache: "no-store" }); await loadAll(); }
    finally { setScanning(false); }
  }

  /**
   * A1-D26 — the unit list is derived from the loaded rows, client-side, in the
   * same spirit as the status/severity filters: no extra endpoint, and the
   * dropdown can only ever offer units that actually appear in the queue.
   */
  const unitOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of incidents || []) {
      const code = (r.unit_code || "").trim();
      if (!code || m.has(code)) continue;
      m.set(code, (r.unit_name || "").trim() || code);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [incidents]);

  const filtered = useMemo(() => {
    if (!incidents) return [];
    const ql = q.trim().toLowerCase();
    return incidents.filter((r) => (!status || r.status === status) && (!sev || r.severity === sev) &&
      (!unit || r.unit_code === unit) &&
      (!ql || [r.id, r.unit_code, r.unit_name, r.type_name, r.dept_name, r.location_name, r.narrative_snippet].some((v) => (v || "").toLowerCase().includes(ql))));
  }, [incidents, q, status, sev, unit]);

  const sevCount = (k: string) => stats?.bySeverity.find((x) => x.k === k)?.n ?? 0;
  const statusCount = (k: string) => stats?.byStatus.find((x) => x.k === k)?.n ?? 0;
  const t = stats?.totals; const cap = stats?.capa;
  const nearMissPct = t && t.total ? Math.round((t.near_miss / t.total) * 100) : 0;
  const rcaPct = t && t.total ? Math.round((t.with_rca / t.total) * 100) : 0;
  // Reads either shape: stats.sla.overdue or totals.overdue. 0 before migration
  // 009 is applied, which is correct — nothing is overdue if nothing has a due date.
  const overdue = stats?.sla?.overdue ?? t?.overdue ?? 0;
  const catMax = Math.max(1, ...(stats?.byCategory || []).map((c) => c.n));
  const sevMax = Math.max(1, ...SEV_ORDER.map(([k]) => sevCount(k)));
  const seriesMax = Math.max(1, ...(stats?.series || []).map((s) => s.n));

  return (
    <div>
      {/* ===================== DASHBOARD ===================== */}
      <section id="dashboard" className="scroll-mt-32">
        <h2 className="mb-4 text-lg font-semibold">Overview</h2>
        <div className="mb-5 flex flex-col gap-4 rounded-xl border border-teal-200 bg-gradient-to-r from-teal-50 to-emerald-50 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-base font-semibold text-stone-900">File a hospital incident</div>
            <p className="mt-1 text-sm text-stone-600">
              Clinical or operational — your report will appear in this queue for the safety team.
            </p>
          </div>
          <a
            href="/safety/report"
            className="shrink-0 rounded-lg bg-teal-700 px-5 py-2.5 text-center text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800"
          >
            Report an incident
          </a>
        </div>

        {!stats ? <div className="text-sm text-stone-400">Loading…</div> : (
          <>
            <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
              <Kpi n={t!.total} label="Incidents" />
              <Kpi n={t!.open} label="Open" />
              {/* 7-working-day closure clock (A1-D16). Red only when non-zero. */}
              <Kpi n={overdue} label="Overdue" accent={overdue ? "#dc2626" : undefined} />
              <Kpi n={`${nearMissPct}%`} label="Near-miss / caught" />
              <Kpi n={t!.high_sev} label="Major or worse" accent={t!.high_sev ? "#dc2626" : undefined} />
              <Kpi n={`${rcaPct}%`} label="With RCA" />
              <Kpi n={`${cap!.verified}/${cap!.rcas}`} label="CAPAs verified" />
            </div>

            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="Severity profile (harm pyramid)">
                <div className="space-y-1.5">
                  {SEV_ORDER.filter(([k]) => k !== "unrated" || sevCount("unrated")).map(([k, label, color]) => {
                    const n = sevCount(k);
                    return (
                      <div key={k} className="flex items-center gap-3">
                        <div className="w-36 shrink-0 text-[12.5px] text-stone-600">{label}</div>
                        <div className="h-3 flex-1 overflow-hidden rounded bg-stone-100">
                          <div className="h-full rounded" style={{ width: `${(n / sevMax) * 100}%`, background: color }} />
                        </div>
                        <div className="w-7 text-right text-[13px] font-semibold tabular-nums">{n}</div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 text-[12.5px] text-stone-500">
                  {nearMissPct >= 40 ? `${nearMissPct}% reported as near-miss/no-harm — healthy reporting culture.` : `${nearMissPct}% near-miss/no-harm.`}
                  {t!.high_sev > 0 && <span className="font-medium text-red-600"> {t!.high_sev} major+ need review.</span>}
                </div>
              </Card>

              <Card title="Who / what is affected">
                <RankBars rows={(stats.byImpact || []).map((r) => ({ ...r, k: r.k.replace(/_/g, " ") }))} color="#0ea5e9" />
              </Card>
            </div>

            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="By department"><RankBars rows={stats.byDept} /></Card>
              <Card title="By type (teal = clinical, indigo = operational)"><RankBars rows={stats.byType} /></Card>
            </div>

            <div className="mb-4 grid gap-4 lg:grid-cols-2">
              <Card title="Reporting trend (weekly)">
                {stats.series.length === 0 ? <div className="text-sm text-stone-400">No data yet.</div> : (
                  <div className="flex h-32 items-end gap-2">
                    {stats.series.map((s) => (
                      <div key={s.k} className="flex flex-1 flex-col items-center gap-1">
                        <div className="w-full rounded-t bg-teal-600" style={{ height: `${(s.n / seriesMax) * 100}%`, minHeight: 4 }} title={`${s.n}`} />
                        <div className="text-[10px] text-stone-400">{s.k.slice(5)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card title="Clinical vs operational + pipeline">
                <div className="mb-3">
                  <div className="flex h-3 overflow-hidden rounded bg-stone-100">
                    {(stats.byCategory || []).map((c) => (
                      <div key={c.k} style={{ width: `${(c.n / (stats.byCategory.reduce((a, b) => a + b.n, 0) || 1)) * 100}%`, background: c.k === "clinical" ? "#0d9488" : c.k === "non_clinical" ? "#6366f1" : "#cbd5e1" }} title={`${c.k}: ${c.n}`} />
                    ))}
                  </div>
                  <div className="mt-1.5 flex gap-3 text-[11.5px] text-stone-500">
                    <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "#0d9488" }} />Clinical</span>
                    <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "#6366f1" }} />Operational</span>
                    <span><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: "#cbd5e1" }} />Unclassified</span>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {STATUS_ORDER.map(([k, label]) => {
                    const n = statusCount(k); const mx = Math.max(1, ...STATUS_ORDER.map(([s]) => statusCount(s)));
                    return (
                      <div key={k} className="flex items-center gap-3">
                        <div className="w-28 shrink-0 text-[12.5px] text-stone-600">{label}</div>
                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-stone-100"><div className="h-full rounded-full bg-stone-400" style={{ width: `${(n / mx) * 100}%` }} /></div>
                        <div className="w-6 text-right text-[12.5px] font-semibold tabular-nums">{n}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>

            {stats.topClusters.length > 0 && (
              <Card title="Top recurring risks" right={<a href="#recurring" className="text-[12.5px] font-medium text-teal-700 hover:underline">View all →</a>}>
                <div className="space-y-2">
                  {stats.topClusters.map((c, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <div className={"w-6 text-center text-sm font-bold " + (c.recurrence_count >= 3 ? "text-red-600" : "text-orange-600")}>{c.recurrence_count}×</div>
                      <div className="flex-1 text-[13.5px] text-stone-800">{c.label}</div>
                      <div className="text-[12px] text-stone-400">risk {c.risk_score ?? "—"}</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}
          </>
        )}
      </section>

      {/* ===================== QUEUE ===================== */}
      <section id="queue" className="scroll-mt-32 pt-10">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-lg font-semibold">Incident queue</h2>
          <div className="flex items-center gap-3">
            <div className="text-[13px] font-medium text-stone-500">{incidents ? `${incidents.filter((r) => r.status !== "closed" && r.status !== "verified").length} open` : ""}</div>
            {loadedAt && <span className="text-[12px] text-stone-400">updated {loadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
            {/* Saturday review register (A1.2). A plain link, never a fetch —
                the browser must stream it straight to disk as an attachment. */}
            <a href="/api/safety/register" download
              className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50">
              Download register
            </a>
            <button onClick={() => loadAll()} disabled={refreshing}
              className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[13px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-50">
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          <input className="flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" style={{ minWidth: 240 }} placeholder="Search id, type, department, text…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>{STATUS_ORDER.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" value={sev} onChange={(e) => setSev(e.target.value)}>
            <option value="">All severities</option>{SEV_ORDER.slice(0, 5).map(([k]) => <option key={k} value={k}>{k}</option>)}
          </select>
          {/* A1-D26 — hidden entirely on a single-unit estate, where it would
              be a control with exactly one choice. */}
          {unitOptions.length > 1 && (
            <select className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm" value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="">All units</option>{unitOptions.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
            </select>
          )}
        </div>
        {!incidents ? <div className="text-sm text-stone-400">Loading…</div> : filtered.length === 0 ? <div className="text-sm text-stone-400">No incidents match.</div> : (
          <div className="space-y-2.5">
            {filtered.map((r) => (
              <a key={r.id} href={`/safety/incidents/${r.id}`} className="block rounded-xl border border-stone-200 bg-white p-3.5 hover:border-stone-300">
                <div className="flex flex-wrap items-center gap-2.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SEV_COLOR[r.severity || ""] || "#cbd5e1" }} />
                  <span className="font-mono text-[13px] font-bold">{r.id}</span>
                  {/* A1-D26 — which hospital. Muted: it is context, not status. */}
                  {r.unit_code && (
                    <span title={r.unit_name || r.unit_code} className="font-mono text-[11px] font-semibold text-stone-400">{r.unit_code}</span>
                  )}
                  {r.near_miss &&<span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] font-bold text-sky-700">near miss</span>}
                  <span className="rounded bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-600">{STATUS_ORDER.find(([k]) => k === r.status)?.[1] || r.status}</span>
                  {r.rca_count > 0 && <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-bold text-green-700">RCA</span>}
                  <SlaBadge state={r.sla_state} dueAt={r.due_at} />
                  <span className="ml-auto text-[12px] text-stone-400">{new Date(r.reported_at).toLocaleDateString()}</span>
                </div>
                <div className="mt-2 text-[15px] font-semibold">{r.type_name || "Unclassified"} · {r.dept_name || "—"}{r.location_name ? ` · ${r.location_name}` : ""}</div>
                <div className="mt-1 text-[13.5px] leading-relaxed text-stone-500">{r.narrative_snippet}</div>
              </a>
            ))}
          </div>
        )}
      </section>

      {/* ===================== RECURRING ===================== */}
      <section id="recurring" className="scroll-mt-32 pt-10">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-lg font-semibold">Recurring patterns</h2>
          <button onClick={scan} disabled={scanning} className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">{scanning ? "Scanning…" : "Scan now"}</button>
        </div>
        {clusters.length === 0 ? <div className="text-sm text-stone-400">No recurring patterns yet — run a scan.</div> : (
          <div className="space-y-2">
            {clusters.map((c) => {
              const max = Math.max(1, ...clusters.map((x) => x.recurrence_count));
              return (
                <div key={c.id} className="flex items-center gap-4 rounded-xl border border-stone-200 bg-white px-4 py-3">
                  <div className="h-2 w-28 shrink-0 overflow-hidden rounded-full bg-stone-100"><div className="h-full rounded-full" style={{ width: `${(c.recurrence_count / max) * 100}%`, background: c.recurrence_count >= 3 ? "#dc2626" : c.recurrence_count >= 2 ? "#ea580c" : "#94a3b8" }} /></div>
                  <div className="flex-1">
                    <div className="text-[15px] font-semibold">{c.label}</div>
                    <div className="text-[12.5px] text-stone-400">{c.recurrence_count}× · {c.rca_count} with RCA · risk {c.risk_score ?? "—"}{c.last_seen ? ` · last ${new Date(c.last_seen).toLocaleDateString()}` : ""}</div>
                  </div>
                  <div className={"text-2xl font-extrabold " + (c.recurrence_count >= 3 ? "text-red-600" : c.recurrence_count >= 2 ? "text-orange-600" : "text-stone-500")}>{c.recurrence_count}</div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
