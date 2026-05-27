"use client";

/**
 * AdminDashboardOverview — Sprint 9 dashboard chrome at /admin (Figma S1).
 *
 * Hosts: KPI row + Needs-your-attention panel + 7-day chart + System
 * health card + Recent activity feed. Polls /api/admin/dashboard every
 * 30s (visibility-aware — paused when tab is hidden).
 *
 * Layout responsibility ends here; the doctors-management section
 * is rendered by AdminDashboard below this component (V's Q1 lock).
 */

import * as React from "react";
import Link from "next/link";

type Kpi = { value: number; delta_vs_yesterday: number; active_total?: number };

type AttentionItem = {
  kind: string;
  severity: "warn" | "info";
  title: string;
  detail: string;
  age_minutes: number;
  action: { label: string; href: string } | null;
};

type ActivityItem = {
  kind: string;
  title: string;
  detail: string;
  age_minutes: number;
};

type HealthServiceRow = { name: string; ok: boolean; p50_ms: number | null };

type DashboardResp = {
  kpi: {
    encounters_today:  Kpi;
    sent_successfully: Kpi;
    failed_sends:      Kpi;
    active_doctors:    Kpi;
  };
  attention: AttentionItem[];
  chart_7d: { day: string; count: number }[];
  chart_total: number;
  chart_avg_per_day: number;
  health: { status: "ok" | "degraded"; services: HealthServiceRow[] };
  activity: ActivityItem[];
};

const POLL_MS = 30_000;

export function AdminDashboardOverview({ adminName }: { adminName: string }) {
  const [data, setData] = React.useState<DashboardResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [lastFetchAt, setLastFetchAt] = React.useState<number | null>(null);

  const fetchOnce = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/dashboard`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setData(j as DashboardResp);
      setError(null);
      setLastFetchAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void fetchOnce(); }, [fetchOnce]);

  React.useEffect(() => {
    const interval = globalThis.setInterval(() => {
      if (!document.hidden) void fetchOnce();
    }, POLL_MS);
    return () => globalThis.clearInterval(interval);
  }, [fetchOnce]);

  const now = new Date();
  const greeting = (() => {
    const hour = now.getHours();
    if (hour < 5)  return "Working late";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  })();

  return (
    <section className="space-y-6">
      {/* Greeting / context row */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500" suppressHydrationWarning>
            LIVE · {now.toLocaleString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })} · {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </p>
          <h1 className="text-heading text-even-navy-800">
            {greeting}{adminName ? `, ${adminName.split(" ")[0]}` : ""}.
          </h1>
        </div>
        <div className="flex items-center gap-2 text-caption text-even-ink-400">
          {loading ? <span>Refreshing…</span> : null}
          {lastFetchAt ? (
            <span suppressHydrationWarning>updated {new Date(lastFetchAt).toLocaleTimeString()}</span>
          ) : null}
          <button
            type="button"
            onClick={() => void fetchOnce()}
            className="px-2 py-0.5 rounded-md text-caption bg-even-ink-100 hover:bg-even-ink-200"
          >
            ↻
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">
          Dashboard load failed: {error}
        </div>
      ) : null}

      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Encounters today"      kpi={data?.kpi.encounters_today  ?? null} />
        <KpiCard label="Sent successfully"     kpi={data?.kpi.sent_successfully ?? null} />
        <KpiCard label="Failed sends"          kpi={data?.kpi.failed_sends      ?? null} invertDelta />
        <KpiCard
          label="Active doctors"
          kpi={data?.kpi.active_doctors ?? null}
          fractionOf={data?.kpi.active_doctors?.active_total ?? null}
          hideDelta
        />
      </div>

      {/* Needs your attention */}
      <AttentionPanel items={data?.attention ?? []} loading={loading && !data} />

      {/* Chart + Health row */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr,320px] gap-4">
        <Chart7Days
          rows={data?.chart_7d ?? []}
          total={data?.chart_total ?? 0}
          avg={data?.chart_avg_per_day ?? 0}
        />
        <HealthCard health={data?.health ?? { status: "degraded", services: [] }} />
      </div>

      {/* Activity feed */}
      <ActivityFeed items={data?.activity ?? []} />
    </section>
  );
}

// ---------- subcomponents ----------

function KpiCard({
  label,
  kpi,
  fractionOf,
  hideDelta,
  invertDelta,
}: {
  label: string;
  kpi: Kpi | null;
  fractionOf?: number | null;
  hideDelta?: boolean;
  invertDelta?: boolean;
}) {
  const delta = kpi?.delta_vs_yesterday ?? 0;
  const isGood = invertDelta ? delta < 0 : delta > 0;
  const isBad  = invertDelta ? delta > 0 : delta < 0;
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  const sign  = delta > 0 ? "+" : "";

  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1">{label}</p>
      <p className="text-heading text-even-navy-800 font-semibold">
        {kpi ? (
          <>
            {kpi.value}
            {typeof fractionOf === "number" ? <span className="text-even-ink-400 text-body font-normal">/{fractionOf}</span> : null}
          </>
        ) : (
          <span className="text-even-ink-400">—</span>
        )}
      </p>
      {!hideDelta && kpi ? (
        <p className={`text-caption mt-1 ${isGood ? "text-success-700" : isBad ? "text-danger-700" : "text-even-ink-500"}`}>
          {arrow} {sign}{delta} vs. yesterday
        </p>
      ) : (
        <p className="text-caption text-even-ink-400 mt-1">—</p>
      )}
    </div>
  );
}

function AttentionPanel({ items, loading }: { items: AttentionItem[]; loading: boolean }) {
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-5">
      <div className="flex items-center justify-between mb-3">
        <p className="text-label text-even-navy-800">
          {items.length > 0 ? <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-amber-100 text-amber-800 text-caption mr-2">{items.length}</span> : null}
          Needs your attention
        </p>
      </div>
      {loading ? (
        <p className="text-body text-even-ink-400">Checking…</p>
      ) : items.length === 0 ? (
        <p className="text-body text-even-ink-400">Nothing flagged. System is calm.</p>
      ) : (
        <ul className="space-y-3">
          {items.map((it, i) => {
            const dot =
              it.severity === "warn"
                ? "text-danger-700 bg-danger-100/60"
                : "text-even-blue-700 bg-even-blue-100";
            return (
              <li key={`${it.kind}-${i}`} className="flex items-start gap-3 py-2 border-b border-even-ink-100 last:border-b-0">
                <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full ${dot} shrink-0 text-caption font-bold`}>
                  {it.severity === "warn" ? "⚠" : "ⓘ"}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-body text-even-navy-800 font-medium">{it.title}</p>
                  <p className="text-caption text-even-ink-600">{it.detail}</p>
                </div>
                <div className="shrink-0 flex items-center gap-3">
                  <span className="text-caption text-even-ink-400">{fmtAge(it.age_minutes)}</span>
                  {it.action ? (
                    <Link
                      href={it.action.href}
                      className="text-caption text-even-blue-600 hover:underline whitespace-nowrap"
                    >
                      {it.action.label} →
                    </Link>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Chart7Days({
  rows,
  total,
  avg,
}: {
  rows: { day: string; count: number }[];
  total: number;
  avg: number;
}) {
  const maxCount = rows.reduce((m, r) => Math.max(m, r.count), 0);
  // Inline SVG bar chart. 7 bars across, 100px tall, hover tooltip on each.
  const barWidth = 32;
  const gap = 12;
  const chartHeight = 100;
  const chartWidth = rows.length * (barWidth + gap) - gap;
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">Encounters · Last 7 days</p>
        <p className="text-caption text-even-ink-700">
          <strong className="text-even-navy-800">{total}</strong> total · avg <strong className="text-even-navy-800">{avg.toFixed(1)}</strong>/day
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-body text-even-ink-400 py-6">No data yet.</p>
      ) : (
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight + 22}`}
          preserveAspectRatio="xMidYMid meet"
          className="w-full h-32"
          role="img"
          aria-label="Encounter count for each of the last 7 days"
        >
          {rows.map((r, i) => {
            const h = maxCount > 0 ? (r.count / maxCount) * chartHeight : 0;
            const x = i * (barWidth + gap);
            const y = chartHeight - h;
            const d = new Date(r.day);
            const dayLabel = d.toLocaleString(undefined, { weekday: "short" });
            return (
              <g key={r.day}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(h, 1)}
                  rx={4}
                  className={r.count > 0 ? "fill-even-blue-600" : "fill-even-ink-200"}
                >
                  <title>{`${d.toLocaleDateString()} — ${r.count} encounter${r.count === 1 ? "" : "s"}`}</title>
                </rect>
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  textAnchor="middle"
                  className="text-[10px] fill-even-ink-700 font-mono"
                  style={{ fontSize: 10 }}
                >
                  {r.count > 0 ? r.count : ""}
                </text>
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 16}
                  textAnchor="middle"
                  className="text-[10px] fill-even-ink-500"
                  style={{ fontSize: 10 }}
                >
                  {dayLabel}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function HealthCard({ health }: { health: { status: "ok" | "degraded"; services: HealthServiceRow[] } }) {
  const PRETTY_NAME: Record<string, string> = {
    db:      "Neon · APP_DATABASE",
    kb:      "Neon · KB_DATABASE",
    llm:     "Ollama · LLM tunnel",
    whisper: "Whisper · self-hosted",
    resend:  "Resend · email API",
    r2:      "Cloudflare R2",
  };
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-5">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">System health</p>
        <span className={`text-caption font-medium ${health.status === "ok" ? "text-success-700" : "text-danger-700"}`}>
          {health.status === "ok" ? "All green" : "Degraded"}
        </span>
      </div>
      {health.services.length === 0 ? (
        <p className="text-body text-even-ink-400">No health probes available.</p>
      ) : (
        <ul className="space-y-2">
          {health.services.map((s) => (
            <li key={s.name} className="flex items-center justify-between gap-2 text-caption">
              <span className="flex items-center gap-2 truncate">
                <span className={`inline-block h-2 w-2 rounded-full ${s.ok ? "bg-success-500" : "bg-danger-500"}`} aria-hidden="true" />
                <span className="text-even-ink-700">{PRETTY_NAME[s.name] ?? s.name}</span>
              </span>
              <span className="font-mono text-even-ink-500 shrink-0">
                {s.p50_ms != null ? `p50 ${s.p50_ms}ms` : "—"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-5">
      <p className="text-label text-even-navy-800 mb-3">Recent activity</p>
      {items.length === 0 ? (
        <p className="text-body text-even-ink-400">Quiet. Activity will appear here as it happens.</p>
      ) : (
        <ul className="space-y-2">
          {items.map((it, i) => {
            const dot = it.kind.startsWith("send.failed") || it.kind.startsWith("send.bounced")
              ? "bg-danger-500"
              : it.kind.startsWith("send.")
              ? "bg-success-500"
              : it.kind.startsWith("encounter.")
              ? "bg-even-blue-500"
              : "bg-even-ink-300";
            return (
              <li key={i} className="flex items-start gap-3 py-1">
                <span className={`mt-1.5 inline-block h-2 w-2 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
                <div className="flex-1 min-w-0">
                  <p className="text-body text-even-navy-800 truncate">{it.title}</p>
                  <p className="text-caption text-even-ink-500 truncate">{it.detail}</p>
                </div>
                <span className="text-caption text-even-ink-400 shrink-0">{fmtAge(it.age_minutes)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function fmtAge(min: number): string {
  if (min < 1)    return "just now";
  if (min < 60)   return `${min}m ago`;
  if (min < 1440) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}
