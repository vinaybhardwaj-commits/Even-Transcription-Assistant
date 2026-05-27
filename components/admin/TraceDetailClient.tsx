"use client";

/**
 * TraceDetailClient — forensic view of a single llm_traces row.
 *
 * Fetches /api/admin/traces/{id} once on mount; renders KPI cards (latency,
 * prompt tokens, completion tokens, retries) + per-stage event list +
 * model_calls breakdown. No live polling for the detail view; users hit
 * Refresh if they want fresh data.
 */

import * as React from "react";
import Link from "next/link";

type TraceStatus = "in_progress" | "completed" | "errored" | "aborted";
type TraceEventLog = {
  ts: number;
  stage: string;
  msg: string;
  ms?: number;
  done?: boolean;
  error?: boolean;
};
type ModelCall = {
  model: string;
  latency_ms: number;
  tokens_in?: number;
  tokens_out?: number;
};
type TraceFull = {
  id: string;
  surface: string;
  encounter_id: string | null;
  patient_id: string | null;
  doctor_email: string | null;
  request_input: unknown;
  events: TraceEventLog[];
  result_summary: unknown;
  model_calls: unknown;
  total_ms: number | null;
  status: TraceStatus;
  error_message: string | null;
  started_at: string;
  completed_at: string | null;
};

export function TraceDetailClient({ traceId }: { traceId: string }) {
  const [trace, setTrace] = React.useState<TraceFull | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/traces/${traceId}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) {
        const msg = (j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`;
        throw new Error(msg);
      }
      setTrace((j as { trace: TraceFull }).trace);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [traceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const onCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(traceId);
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard denied — silent */
    }
  }, [traceId]);

  const modelCalls: ModelCall[] = Array.isArray(trace?.model_calls)
    ? (trace?.model_calls as ModelCall[])
    : [];
  const promptTok = modelCalls.reduce((a, c) => a + (c.tokens_in ?? 0), 0);
  const completionTok = modelCalls.reduce((a, c) => a + (c.tokens_out ?? 0), 0);

  const fmtMs = (ms: number | null | undefined) => {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
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
      <div>
        <Link
          href="/admin/traces"
          className="text-caption text-even-blue-600 hover:underline"
        >
          ‹ Back to traces
        </Link>
      </div>

      {loading && !trace ? (
        <p className="text-body text-even-ink-500">Loading…</p>
      ) : error ? (
        <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">
          Could not load trace: {error}
        </div>
      ) : trace ? (
        <>
          {/* Hero with ID + copy + status */}
          <div className="flex items-center gap-3 flex-wrap">
            <code className="text-body font-mono text-even-navy-800">{trace.id}</code>
            <button
              type="button"
              onClick={onCopy}
              className="text-caption text-even-blue-600 hover:underline"
            >
              {copied ? "✓ Copied" : "⎘ Copy ID"}
            </button>
            <span
              className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-medium ${statusBadge(trace.status)}`}
            >
              {trace.status}
            </span>
          </div>

          <div className="text-caption text-even-ink-500 flex flex-wrap gap-x-4 gap-y-1" suppressHydrationWarning>
            <span><strong className="text-even-ink-700">Surface:</strong> {trace.surface}</span>
            <span><strong className="text-even-ink-700">Started:</strong> {new Date(trace.started_at).toLocaleString()}</span>
            {trace.completed_at ? (
              <span><strong className="text-even-ink-700">Completed:</strong> {new Date(trace.completed_at).toLocaleString()}</span>
            ) : null}
            {trace.encounter_id ? (
              <span><strong className="text-even-ink-700">Encounter:</strong> <code className="font-mono">{trace.encounter_id}</code></span>
            ) : null}
            {trace.doctor_email ? (
              <span><strong className="text-even-ink-700">Doctor:</strong> {trace.doctor_email}</span>
            ) : null}
          </div>

          {trace.error_message ? (
            <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3">
              <p className="text-label text-danger-700 mb-1">Error</p>
              <p className="text-body text-danger-700 font-mono whitespace-pre-wrap">
                {trace.error_message}
              </p>
            </div>
          ) : null}

          {/* KPI cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Latency" value={fmtMs(trace.total_ms)} />
            <KpiCard label="Prompt tokens" value={promptTok || "—"} />
            <KpiCard label="Completion tokens" value={completionTok || "—"} />
            <KpiCard label="Model calls" value={modelCalls.length || "—"} />
          </div>

          {/* Events */}
          <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
            <h2 className="text-label text-even-navy-800 mb-3">
              Pipeline events · {trace.events.length}
            </h2>
            {trace.events.length === 0 ? (
              <p className="text-body text-even-ink-400">(no events captured)</p>
            ) : (
              <ul className="space-y-1">
                {trace.events.map((e, i) => {
                  const t = trace.events[0]?.ts ? e.ts - trace.events[0].ts : 0;
                  const dot = e.error
                    ? "bg-danger-500"
                    : e.done
                    ? "bg-success-500"
                    : "bg-even-blue-500";
                  return (
                    <li key={i} className="flex items-center gap-3 text-body">
                      <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${dot}`} aria-hidden="true" />
                      <span className="font-mono text-caption text-even-ink-400 w-16 shrink-0">
                        +{(t / 1000).toFixed(2)}s
                      </span>
                      <span className="text-even-ink-700 w-32 shrink-0 truncate">{e.stage}</span>
                      <span className="flex-1 text-even-ink-700">{e.msg}</span>
                      {e.ms != null ? (
                        <span className="font-mono text-caption text-even-ink-500 shrink-0">{fmtMs(e.ms)}</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* Model calls */}
          {modelCalls.length > 0 ? (
            <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
              <h2 className="text-label text-even-navy-800 mb-3">Model calls</h2>
              <table className="w-full text-left text-body">
                <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500">
                  <tr>
                    <th className="px-2 py-1.5">Model</th>
                    <th className="px-2 py-1.5 text-right">Latency</th>
                    <th className="px-2 py-1.5 text-right">Tokens in</th>
                    <th className="px-2 py-1.5 text-right">Tokens out</th>
                  </tr>
                </thead>
                <tbody>
                  {modelCalls.map((c, i) => (
                    <tr key={i} className="border-t border-even-ink-100">
                      <td className="px-2 py-1.5 font-mono text-caption">{c.model}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-caption">{fmtMs(c.latency_ms)}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-caption">{c.tokens_in ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right font-mono text-caption">{c.tokens_out ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          {/* Raw JSON dumps for full forensic */}
          <details className="rounded-md border border-even-ink-100 bg-even-ink-50/40">
            <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">
              Raw request input
            </summary>
            <pre className="px-3 pb-3 text-caption text-even-ink-700 whitespace-pre-wrap font-mono overflow-x-auto">
              {JSON.stringify(trace.request_input, null, 2) || "(none)"}
            </pre>
          </details>
          <details className="rounded-md border border-even-ink-100 bg-even-ink-50/40">
            <summary className="cursor-pointer select-none px-3 py-2 text-caption text-even-ink-500">
              Raw result summary
            </summary>
            <pre className="px-3 pb-3 text-caption text-even-ink-700 whitespace-pre-wrap font-mono overflow-x-auto">
              {JSON.stringify(trace.result_summary, null, 2) || "(none)"}
            </pre>
          </details>

          <div>
            <button
              type="button"
              onClick={() => void load()}
              className="px-3 py-1.5 rounded-md bg-even-ink-100 hover:bg-even-ink-200 text-caption"
            >
              ↻ Refresh
            </button>
          </div>
        </>
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
