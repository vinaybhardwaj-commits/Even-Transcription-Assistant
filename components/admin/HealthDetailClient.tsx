"use client";

import * as React from "react";

type Service = { ok: boolean; latency_ms: number; error?: string };
type HealthResp = {
  ok: boolean;
  sha: string;
  region: string;
  now: string;
  services: Record<string, Service>;
};

const PRETTY: Record<string, string> = {
  db:      "Neon · APP_DATABASE",
  kb:      "Neon · KB_DATABASE",
  llm:     "Ollama LLM tunnel · llm.llmvinayminihome.uk",
  whisper: "Whisper tunnel · whisper.llmvinayminihome.uk",
  resend:  "Resend · email API",
  r2:      "Cloudflare R2 · eta-audio bucket",
};

export function HealthDetailClient() {
  const [data, setData] = React.useState<HealthResp | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const fetchHealth = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      const j = await res.json();
      setData(j as HealthResp);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void fetchHealth(); }, [fetchHealth]);

  if (loading && !data) return <p className="text-body text-even-ink-500">Probing…</p>;
  if (error) return <div className="rounded-md border border-danger-500 bg-danger-100/40 p-3 text-body text-danger-700">{error}</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <span className={`text-label font-semibold ${data.ok ? "text-success-700" : "text-danger-700"}`}>
          {data.ok ? "● All systems green" : "⚠ Degraded"}
        </span>
        <span className="text-caption text-even-ink-500 font-mono">sha {data.sha}</span>
        <span className="text-caption text-even-ink-500">{data.region}</span>
        <span className="text-caption text-even-ink-500" suppressHydrationWarning>{new Date(data.now).toLocaleString()}</span>
        <button
          type="button"
          onClick={() => void fetchHealth()}
          disabled={loading}
          className="ml-auto px-2.5 py-1 rounded-md text-caption bg-even-ink-100 text-even-ink-700 hover:bg-even-ink-200"
        >
          ↻ Re-probe
        </button>
      </div>

      <div className="rounded-xl border border-even-ink-100 bg-even-white overflow-hidden">
        <table className="w-full text-left">
          <thead className="text-[10px] uppercase tracking-[0.14em] text-even-ink-500 bg-even-ink-50/40 border-b border-even-ink-100">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Service</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
              <th className="px-4 py-2.5 font-semibold text-right">Latency</th>
              <th className="px-4 py-2.5 font-semibold">Error</th>
            </tr>
          </thead>
          <tbody className="text-body">
            {Object.entries(data.services).map(([key, s]) => (
              <tr key={key} className="border-t border-even-ink-100">
                <td className="px-4 py-2.5 text-even-navy-800">{PRETTY[key] ?? key}</td>
                <td className="px-4 py-2.5">
                  <span className={`inline-flex items-center gap-1.5 text-caption ${s.ok ? "text-success-700" : "text-danger-700"}`}>
                    <span className={`inline-block h-2 w-2 rounded-full ${s.ok ? "bg-success-500" : "bg-danger-500"}`} />
                    {s.ok ? "ok" : "down"}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-caption">{s.latency_ms}ms</td>
                <td className="px-4 py-2.5 text-caption text-even-ink-500 font-mono truncate max-w-[280px]" title={s.error ?? ""}>
                  {s.error ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
