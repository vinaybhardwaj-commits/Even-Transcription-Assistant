"use client";

/**
 * SttLabClient — STT Engine Lab (L0: Health tab).
 * Lists every registered engine with a live health probe, capabilities, and
 * its enabled / fan-out / cost flags. Later phases add Leaderboard / Runs /
 * Gold set / Routing / Engines tabs alongside Health.
 */
import * as React from "react";

type Capabilities = {
  tiers?: string[]; stages?: string[]; languages?: string[];
  streaming?: boolean; translates?: boolean; async?: boolean;
};
type EngineHealth = { ok: boolean; latencyMs: number; error?: string };
type EngineRow = {
  id: string; display_name: string; adapter_key: string;
  enabled: boolean; fanout_enabled: boolean; is_paid: boolean;
  cost_per_min_usd: number | null; capabilities: Capabilities;
  has_adapter: boolean; health: EngineHealth;
};
type Bundle = { engines: EngineRow[]; checked_at: string };

const TABS = ["Health", "Leaderboard", "Runs", "Gold set", "Routing", "Engines"] as const;

export function SttLabClient() {
  const [data, setData] = React.useState<Bundle | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("Health");

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/stt-lab/health", { cache: "no-store" });
      const j = await res.json();
      if (!res.ok) throw new Error((j as { error?: { message?: string } }).error?.message ?? `http_${res.status}`);
      setData(j as Bundle);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }, []);
  React.useEffect(() => { void load(); }, [load]);

  const dot = (h: EngineHealth, hasAdapter: boolean) => {
    const color = !hasAdapter ? "bg-even-ink-300" : h.ok ? "bg-success-500" : "bg-danger-500";
    return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color}`} />;
  };
  const caps = (c: Capabilities) => {
    const parts: string[] = [];
    if (c.tiers?.length) parts.push(c.tiers.join("+"));
    if (c.languages?.length) parts.push(c.languages.join("/"));
    if (c.streaming) parts.push("streaming");
    if (c.translates) parts.push("translate");
    if (c.async) parts.push("async");
    return parts.join(" · ");
  };

  return (
    <div className="space-y-6">
      {/* Tabs */}
      <div className="flex gap-1 border-b border-even-ink-100">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-label rounded-t-md ${
              tab === t ? "text-even-navy-800 border-b-2 border-even-blue-600 font-semibold" : "text-even-ink-500 hover:text-even-navy-800"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab !== "Health" ? (
        <div className="rounded-xl border border-even-ink-100 bg-even-white p-8 text-center text-body text-even-ink-400">
          {tab} — coming in a later sprint.
        </div>
      ) : (
        <section className="rounded-xl border border-even-ink-100 bg-even-white p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-label text-even-navy-800">Engine health</h3>
              <p className="text-caption text-even-ink-500">
                {data ? `Checked ${new Date(data.checked_at).toLocaleTimeString()}` : "Probing engines…"}
              </p>
            </div>
            <button onClick={() => void load()} disabled={loading} className="text-caption text-even-blue-600 hover:underline disabled:opacity-50">
              {loading ? "Checking…" : "↻ Re-check"}
            </button>
          </div>

          {error ? (
            <p className="text-body text-danger-700">Could not load: {error}</p>
          ) : !data ? (
            <p className="text-body text-even-ink-400">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-body">
                <thead>
                  <tr className="text-caption text-even-ink-500 text-left border-b border-even-ink-100">
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Engine</th>
                    <th className="py-2 pr-3">Capabilities</th>
                    <th className="py-2 pr-3">Latency</th>
                    <th className="py-2 pr-3">Enabled</th>
                    <th className="py-2 pr-3">Fan-out</th>
                    <th className="py-2 pr-3">Cost/min</th>
                  </tr>
                </thead>
                <tbody>
                  {data.engines.map((e) => (
                    <tr key={e.id} className="border-b border-even-ink-100 last:border-b-0">
                      <td className="py-2.5 pr-3">{dot(e.health, e.has_adapter)}</td>
                      <td className="py-2.5 pr-3">
                        <span className="text-even-navy-800">{e.display_name}</span>
                        <span className="text-even-ink-400 font-mono text-caption ml-2">{e.id}</span>
                        {!e.has_adapter && <span className="ml-2 text-caption text-warning-700">no adapter yet</span>}
                        {e.health.error && <div className="text-caption text-danger-600 truncate max-w-md">{e.health.error}</div>}
                      </td>
                      <td className="py-2.5 pr-3 text-caption text-even-ink-600">{caps(e.capabilities)}</td>
                      <td className="py-2.5 pr-3 font-mono text-caption text-even-ink-600">{e.has_adapter ? `${e.health.latencyMs}ms` : "—"}</td>
                      <td className="py-2.5 pr-3 text-caption">{e.enabled ? "✓" : <span className="text-even-ink-400">off</span>}</td>
                      <td className="py-2.5 pr-3 text-caption">{e.fanout_enabled ? "✓" : <span className="text-even-ink-400">off</span>}</td>
                      <td className="py-2.5 pr-3 font-mono text-caption text-even-ink-600">{e.cost_per_min_usd === 0 ? "free" : e.cost_per_min_usd === null ? "—" : `$${e.cost_per_min_usd}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
