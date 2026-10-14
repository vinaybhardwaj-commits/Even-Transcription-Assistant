'use client';

/**
 * Even-LVC grounding worker status panel (CDMSS-EVEN-LVC-GROUNDING-WORKER §7 + Phase 2.2 heartbeat) —
 * rendered by LvcBoard on /care/lvc, ABOVE the library. State badge (pulsing dot while draining), a
 * "live" pill, drain bar, four counters (Citations-added flashes when a new tick lands), a live
 * "last tick Xs ago" + "next tick ~mm:ss" clock (updates every 1s, independent of the 10s poll), a
 * recent-tick feed, Pause/Resume, and a deeper-logs pointer. Soft-fails: a failed poll keeps the last
 * good state + shows "reconnecting…" rather than blanking.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Pause, Play, Gauge } from 'lucide-react';
import { formatAgo, nextTickInSec } from '@/lib/even-ground-core';

type Tick = { ts: string; status: string; processed: number; citations_added: number; epoch: number | null; note: string | null };
type Status = {
  ok: boolean; state: 'draining' | 'idle' | 'paused' | 'disabled'; epoch: number; paused: boolean;
  active_assertions: number | null; total_lv_notes: number | null; grounded_at_epoch: number | null;
  citations_added_total: number | null; last_tick: Tick | null; recent_ticks: Tick[]; drain_pct: number | null;
};

const STATE_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  draining: { dot: 'bg-sky-500', text: 'text-sky-700', label: 'Draining' },
  idle: { dot: 'bg-emerald-500', text: 'text-emerald-700', label: 'Idle — fully grounded' },
  paused: { dot: 'bg-amber-500', text: 'text-amber-700', label: 'Paused' },
  disabled: { dot: 'bg-slate-400', text: 'text-slate-500', label: 'Disabled (flag off)' },
};
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const shortTs = (ts: string) => ts.replace('T', ' ').slice(5, 16);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** State dot — pulses (Tailwind animate-ping overlay) ONLY while draining; steady otherwise. */
export function StateDot({ state, size = 'h-2 w-2' }: { state: string; size?: string }) {
  const dot = (STATE_STYLE[state] ?? STATE_STYLE.idle).dot;
  return (
    <span className={`relative flex ${size}`}>
      {state === 'draining' && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dot} opacity-75`} />}
      <span className={`relative inline-flex rounded-full ${size} ${dot}`} />
    </span>
  );
}

/** "live / reconnecting" pill signalling the view auto-refreshes. */
export function LivePill({ reconnecting }: { reconnecting: boolean }) {
  if (reconnecting) return <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">reconnecting…</span>;
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
      </span>
      live
    </span>
  );
}

export default function GroundingPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [hardErr, setHardErr] = useState(false);      // never got a good response
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => 0);        // client clock (set on mount to avoid SSR mismatch)
  const [flash, setFlash] = useState(false);
  const lastTs = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/care/lvc/ground-status');
      const j = (await r.json()) as Status;
      if (!r.ok || !j.ok) { setReconnecting(true); return; }
      setSt(j); setReconnecting(false); setHardErr(false);
    } catch { setReconnecting(true); }
  }, []);

  // 10s poll
  useEffect(() => {
    void load().then(() => setHardErr((h) => (st ? false : h)));
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // 1s client clock — moves "ago" / countdown between polls
  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // new-tick flash on the Citations counter
  useEffect(() => {
    const ts = st?.last_tick?.ts ?? null;
    if (ts && lastTs.current && ts !== lastTs.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1000);
      lastTs.current = ts;
      return () => clearTimeout(t);
    }
    lastTs.current = ts;
  }, [st?.last_tick?.ts]);

  const togglePause = async () => {
    if (!st) return;
    setBusy(true);
    try {
      await fetch('/api/care/lvc/ground-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: !st.paused }) });
      await load();
    } catch { /* soft */ } finally { setBusy(false); }
  };

  if (hardErr && !st) return null;   // never reached the endpoint (disabled surface) ⇒ render nothing
  const style = STATE_STYLE[st?.state ?? 'idle'] ?? STATE_STYLE.idle;
  const pct = st?.drain_pct ?? null;
  const ago = st?.last_tick && nowMs ? formatAgo(st.last_tick.ts, nowMs) : '—';
  const nextIn = nowMs ? nextTickInSec(nowMs, 10) : null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-slate-400" />
          <h2 className="text-[14px] font-semibold text-slate-800">Grounding worker</h2>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.text}`}>
            <StateDot state={st?.state ?? 'idle'} size="h-1.5 w-1.5" />{style.label}
          </span>
          {st && st.state !== 'disabled' && <LivePill reconnecting={reconnecting} />}
        </div>
        {st && st.state !== 'disabled' && (
          <button onClick={togglePause} disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {st.paused ? <><Play className="h-3.5 w-3.5" />Resume</> : <><Pause className="h-3.5 w-3.5" />Pause</>}
          </button>
        )}
      </div>

      {/* drain progress */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11.5px] text-slate-500">
          <span className="inline-flex items-center gap-1"><Gauge className="h-3.5 w-3.5" />Drain at epoch {st?.epoch ?? '—'}</span>
          <span>{pct == null ? '—' : `${pct}%`}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>

      {/* four counters */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Counter label="Notes grounded" value={`${num(st?.grounded_at_epoch)} / ${num(st?.total_lv_notes)}`} />
        <Counter label="Citations added" value={num(st?.citations_added_total)} flash={flash} />
        <Counter label="Active assertions" value={num(st?.active_assertions)} />
        <Counter label="Last tick" value={ago} sub={nextIn != null ? `next ~${mmss(nextIn)}` : undefined} />
      </div>

      {/* recent tick feed */}
      {st?.recent_ticks && st.recent_ticks.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Recent ticks</div>
          <div className="space-y-0.5">
            {st.recent_ticks.slice(0, 6).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[11.5px] text-slate-500">
                <span className="w-24 shrink-0 tabular-nums text-slate-400">{shortTs(t.ts)}</span>
                <span className={`w-16 shrink-0 font-medium ${t.status === 'ok' ? 'text-sky-600' : t.status === 'paused' ? 'text-amber-600' : t.status === 'error' ? 'text-red-600' : 'text-slate-500'}`}>{t.status}</span>
                <span className="text-slate-500">{t.processed} notes · +{t.citations_added} cites{t.epoch != null ? ` · epoch ${t.epoch}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-400">Deterministic, no-LLM · appends citations only (never a score) · deeper logs in <span className="font-medium text-slate-500">/admin/lvc-ground</span>.</p>
    </section>
  );
}

function Counter({ label, value, sub, flash }: { label: string; value: string; sub?: string; flash?: boolean }) {
  return (
    <div className={`rounded-xl px-3 py-2 transition-colors duration-700 ${flash ? 'bg-emerald-100 ring-1 ring-emerald-300' : 'bg-slate-50'}`}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[13.5px] font-semibold tabular-nums text-slate-800">{value}</div>
      {sub && <div className="text-[10px] tabular-nums text-slate-400">{sub}</div>}
    </div>
  );
}
