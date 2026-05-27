"use client";

/**
 * TracesListClient — table + KPI cards + filter chips + LIVE TAIL polling.
 *
 * Per Sprint 6.2 Q4 lock (27 May 2026): polling refresh every 10s, paused
 * when the tab is hidden (document.visibilitychange). Toggle off by default
 * — admin must click LIVE TAIL to opt in.
 *
 * Fetches /api/admin/traces and renders the response. Filter chip clicks
 * update query state and re-fetch.
 */

import * as React from "react";
import Link from "next/link";

type TraceStatus = "in_progress" | "completed" | "errored" | "aborted";
type Window = "today" | "last24h" | "all";

type AdminTraceRow = {
  id: string;
  surface: string;
  status: TraceStatus;
  total_ms: number | null;
  started_at: string;
  completed_at: string | null;
  error_message: string | null;
  encounter_id: string | null;
  model_summary: string | null;
  tokens_total: number | null;
};
type Aggregates = {
  count_window: number;
  errored_window: number;
  p50_ms: number | null;
  tokens_window: number;
};
type ListResp = {
  traces: AdminTraceRow[];
  total: number;
  aggregates: Aggregates;
  surfaces: Array<{ surface: string; count: number }>;
  filter: {
    surface: string | null;
    status: TraceStatus | null;
    window: Window;
    limit: number;
    offset: number;
  };
};

const PAGE_SIZE = 50;
const POLL_MS = 10_000;

export function TracesListClient() {
  const [surface, setSurface] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<TraceStatus | null>(null);
  const [window, setWindow] = React.useState<Window>("last24h");
  const [offset, setOffset] = React.useState(0);
  const [data, setData] = React.useState<ListResp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [liveTail, setLiveTail] = React.useState(false);
  const [lastFetchAt, setLastFetchAt] = React.useState<number | null>(null);

  const fetchOnce = React.useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (surface) qs.set("surface", surface);
      if (status)  qs.set("status", status);
      qs.set("window", window);
      qs.set("limit",  String(PAGE_SIZE));
      qs.set("offset", String(offset));
      const res = await fetch(`/api/admin/traces?${qs.toString()}`, {
        cache: "no-store",
      });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setData(j as ListResp);
      setError(null);
      setLastFetchAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [surface, status, window, offset]);

  // Initial + filter-change fetch
  React.useEffect(() => {
    void fetchOnce();
  }, [fetchOnce]);

  // LIVE TAIL polling — visibility-aware (pauses when tab hidden).
  React.useEffect(() => {
    if (!liveTail) return;
    let cancelled = false;
    const tick = async () => {
      if (document.hidden) return;
      if (cancelled) return;
      await fetchOnce();
    };
    const interval = globalThis.setInterval(tick, POLL_MS);
    const onVis = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      globalThis.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [liveTail, fetchOnce]);

  const onChipSurface = (s: string | null) => {
    setSurface(s);
    setOffset(0);
  };
  const onChipStatus = (s: TraceStatus | null) => {
    setStatus(s);
    setOffset(0);
  };
  const onChangeWindow = (w: Window) => {
    setWindow(w);
    setOffset(0);
  };

  const fmtMs = (ms: number | null) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };
  const fmtTokens = (t: number | null) => {
    if (t == null || t === 0) return "—";
    if (t < 1000) return String(t);
    return `${(t / 1000).toFixed(1)}k`;
  };
  const fmtTime = (iso: string) => {
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        month: "short",
        day:   "2-digit",
        hour:  "2-digit",
        minute:"2-digit",
        second:"2-digit",
      });
    } catch {
      return iso;
    }
  };
  const statusBadge = (s: TraceStatus) => {
    switch (s) {
      case "completed":   return "bg-success-100/60 text-success-700 border-success-500/40";
      case "errored":     return "bg-danger-100/60 text-danger-700 border-danger-500/40";
      case "aborted":     return "bg-amber-100 text-amber-800 border-amber-300";
      case "in_progress": return "bg-even-blue-100 text-even-blue-700 border-even-blue-300";
      default:            return "bg-even-ink-100 text-even-ink-700 border-even-ink-200";
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Traces today" value={data?.aggregates.count_window ?? "—"} />
        <KpiCard label="Avg latency p50" value={fmtMs(data?.aggregates.p50_ms ?? null)} />
        <KpiCard label="Errored today" value={data?.aggregates.errored_window ?? "—"} />
        <KpiCard label="Tokens today" value={fmtTokens(data?.aggregates.tokens_window ?? null)} />
      </div>

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Window picker */}
        <div className="flex items-center gap-1 mr-2">
          {(["today", "last24h", "all"] as Window[]).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => onChangeWindow(w)}
              className={`px-2.5 py-1 rounded-md text-caption transition-colors ${
                window === w
                  ? "bg-even-navy-800 text-even-white"
                  : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
              }`}
            >
              {w === "today" ? "Today" : w === "last24h" ? "Last 24h" : "All"}
            </button>
          ))}
        </div>

        {/* Surface chips */}
        <Chip active={surface === null} onClick={() => onChipSurface(null)}>
          All stages {data ? `· ${data.surfaces.reduce((a, b) => a + b.count, 0)}` : ""}
        </Chip>
        {data?.surfaces.map((s) => (
          <Chip
            key={s.surface}
            active={surface === s.surface}
            onClick={() => onChipSurface(s.surface)}
          >
            {s.surface} · {s.count}
          </Chip>
        ))}

        <span className="mx-2 text-even-ink-300">·</span>

        {/* Status chips */}
        <Chip active={status === null} onClick={() => onChipStatus(null)}>Any status</Chip>
        <Chip active={status === "completed"} onClick={() => onChipStatus("completed")}>OK</Chip>
        <Chip active={status === "errored"} onClick={() => onChipStatus("errored")}>Errored</Chip>
        <Chip active={status === "aborted"} onClick={() => onChipStatus("aborted")}>Aborted</Chip>
        <Chip active={status === "in_progress"} onClick={() => onChipStatus("in_progress")}>In progress</Chip>

        <div className="ml-auto flex items-center gap-2">
          {lastFetchAt ? (
            <span className="text-caption text-even-ink-400" suppressHydrationWarning>
              Last refresh: {new Date(lastFetchAt).toLocaleTimeString()}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setLiveTail((v) => !v)}
            className={`px-2.5 py-1 rounded-md text-caption font-medium transition-colors ${
              liveTail
                ? "bg-even-blue-600 text-even-white"
                : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
            }`}
            title="Refresh every 10s while tab is visible"
          >
            ● LIVE TAIL {liveTail ? "ON" : "OFF"}
          </button>
          <button
            type="button"
            onClick={() => void fetchOnce()}
            className="px-2.5 py-1 rounded-md text-caption bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">
          Could not load traces: {error}
        </div>
      ) : null}

      {/* Table */}
      <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 bg-even-ink-50/40 border-b border-even-ink-100">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Trace ID</th>
              <th className="px-4 py-2.5 font-semibold">Time</th>
              <th className="px-4 py-2.5 font-semibold">Surface</th>
              <th className="px-4 py-2.5 font-semibold">Models</th>
              <th className="px-4 py-2.5 font-semibold text-right">Latency</th>
              <th className="px-4 py-2.5 font-semibold text-right">Tokens</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold">Encounter</th>
            </tr>
          </thead>
          <tbody className="text-body">
            {loading && !data ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-even-ink-400">Loading…</td>
              </tr>
            ) : data && data.traces.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-even-ink-400">
                  No traces in this window.
                  <p className="mt-1 text-caption text-even-ink-400">
                    Traces will appear once doctors process new encounters.
                  </p>
                </td>
              </tr>
            ) : (
              data?.traces.map((t) => (
                <tr key={t.id} className="border-t border-even-ink-100 hover:bg-even-ink-50/40">
                  <td className="px-4 py-2 font-mono text-caption">
                    <Link
                      href={`/admin/traces/${t.id}`}
                      className="text-even-blue-600 hover:underline"
                    >
                      {t.id.slice(0, 12)}…
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-caption text-even-ink-700 whitespace-nowrap" suppressHydrationWarning>
                    {fmtTime(t.started_at)}
                  </td>
                  <td className="px-4 py-2 text-caption text-even-ink-700">{t.surface}</td>
                  <td className="px-4 py-2 text-caption text-even-ink-700 font-mono">
                    {t.model_summary ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-caption">
                    {fmtMs(t.total_ms)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-caption">
                    {fmtTokens(t.tokens_total)}
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusBadge(t.status)}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-caption font-mono text-even-ink-500">
                    {t.encounter_id ? t.encounter_id.slice(0, 14) + "…" : "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data && data.total > 0 ? (
        <div className="flex items-center justify-between text-caption text-even-ink-500">
          <span>
            Showing {offset + 1}–{Math.min(offset + data.traces.length, data.total)} of {data.total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
              className="px-2.5 py-1 rounded-md bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ‹ Prev
            </button>
            <button
              type="button"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= data.total}
              className="px-2.5 py-1 rounded-md bg-even-ink-100 hover:bg-even-ink-200 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next ›
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-even-ink-100 bg-even-white p-4">
      <p className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 mb-1">
        {label}
      </p>
      <p className="text-heading text-even-navy-800 font-semibold">{value}</p>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-caption transition-colors ${
        active
          ? "bg-even-navy-800 text-even-white"
          : "bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
      }`}
    >
      {children}
    </button>
  );
}
