'use client';

import { useEffect, useState, useRef } from 'react';

type HealthState = {
  ok: boolean;
  checks: {
    neon: { status: string; latency_ms?: number; chunks?: number; books?: number; error?: string };
    llm:  { status: string; latency_ms?: number; http?: number; models?: string[]; error?: string };
  };
  timestamp: string;
};

function pillState(d: HealthState | null, loading: boolean): { color: string; label: string } {
  if (loading || !d) return { color: 'bg-slate-300', label: 'Checking' };
  if (!d.ok) return { color: 'bg-rose-500', label: 'Down' };
  const llmL = d.checks.llm.latency_ms ?? 0;
  const neonL = d.checks.neon.latency_ms ?? 0;
  if (llmL > 2000 || neonL > 1500) return { color: 'bg-amber-400', label: 'Slow' };
  return { color: 'bg-emerald-500', label: 'Healthy' };
}

export default function HealthPill() {
  const [data, setData] = useState<HealthState | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  async function fetchHealth() {
    try {
      const r = await fetch('/api/health', { cache: 'no-store' });
      const d = await r.json();
      setData(d);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
      setData({ ok: false, checks: { neon: { status: 'error' }, llm: { status: 'error' } }, timestamp: new Date().toISOString() });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchHealth();
    const t = setInterval(fetchHealth, 30_000);
    return () => clearInterval(t);
  }, []);

  // Click-outside to close
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!open) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const { color, label } = pillState(data, loading);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen((p) => !p)}
        className="group flex items-center gap-1.5 rounded text-[11px] font-medium text-slate-500 hover:text-brand"
        aria-label={`Bridge status: ${label}`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color} ${loading ? 'animate-pulse' : ''}`} />
        <span className="lowercase tracking-tight">{label.toLowerCase()}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[17rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700 shadow-xl">
          {error && <div className="mb-2 rounded border border-rose-200 bg-rose-50 p-2 text-rose-800">Fetch error: {error}</div>}
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Bridge health</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              !data ? 'bg-slate-100 text-slate-500'
              : !data.ok ? 'bg-rose-100 text-rose-800'
              : (data.checks.llm.latency_ms ?? 0) > 2000 || (data.checks.neon.latency_ms ?? 0) > 1500 ? 'bg-amber-100 text-amber-900'
              : 'bg-emerald-100 text-emerald-800'
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${color}`} /> {label}
            </span>
          </div>
          {data && (
            <>
              <div className="space-y-2">
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold text-slate-700">Neon</span>
                    <span className={data.checks.neon.status === 'ok' ? 'text-emerald-700' : 'text-rose-700'}>
                      {data.checks.neon.status} · {data.checks.neon.latency_ms ?? '?'}ms
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {data.checks.neon.chunks?.toLocaleString() ?? '?'} chunks · {data.checks.neon.books ?? '?'} sources
                  </div>
                </div>
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold text-slate-700">LLM tunnel</span>
                    <span className={data.checks.llm.status === 'ok' ? 'text-emerald-700' : 'text-rose-700'}>
                      {data.checks.llm.status} · {data.checks.llm.latency_ms ?? '?'}ms
                    </span>
                  </div>
                  <div className="mt-0.5 text-[10px] text-slate-500">
                    {data.checks.llm.models?.slice(0, 4).join(' · ') ?? '?'}
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between border-t pt-2 text-[10px] text-slate-400">
                <span>{new Date(data.timestamp).toLocaleTimeString()}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); fetchHealth(); }}
                  className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-200"
                >
                  Recheck
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
