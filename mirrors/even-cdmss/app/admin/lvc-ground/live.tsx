'use client';

/**
 * Live admin monitor body for the Even-LVC grounding worker (CDMSS-EVEN-LVC-GROUNDING-WORKER §7 +
 * Phase 2.2 heartbeat). Server-rendered initial data (props); polls /api/care/lvc/ground-status every
 * 10s; a 1s client clock moves the "last tick Xs ago" + "next tick ~mm:ss" independently. Pulsing
 * state dot while draining, a "live" pill, a new-tick flash on the Citations counter, and a subtle
 * "reconnecting…" on a failed poll (keeps the last good state). Pause + Run-one-tick unchanged.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Zap } from 'lucide-react';
import { formatAgo, nextTickInSec } from '@/lib/even-ground-core';
import { StateDot, LivePill } from '@/components/care/GroundingPanel';

type Tick = { ts: string; status: string; processed: number; citations_added: number; epoch: number | null; note: string | null };
type Status = {
  state: 'draining' | 'idle' | 'paused' | 'disabled'; epoch: number; paused: boolean;
  active_assertions: number | null; total_lv_notes: number | null; grounded_at_epoch: number | null;
  citations_added_total: number | null; last_tick: Tick | null; recent_ticks: Tick[]; drain_pct: number | null;
};

const STATE_LABEL: Record<string, { text: string; label: string }> = {
  draining: { text: 'text-sky-700', label: 'Draining' },
  idle: { text: 'text-emerald-700', label: 'Idle — fully grounded' },
  paused: { text: 'text-amber-700', label: 'Paused' },
  disabled: { text: 'text-slate-500', label: 'Disabled' },
};
const TICK_TONE: Record<string, string> = { ok: 'bg-sky-500', idle: 'bg-emerald-400', paused: 'bg-amber-400', locked: 'bg-slate-300', error: 'bg-red-500' };
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const shortTs = (ts: string) => ts.replace('T', ' ').slice(5, 16);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function GroundingLive({ initialStatus, initialTicks, batch, cadenceMin }: {
  initialStatus: Status | null; initialTicks: Tick[]; batch: number; cadenceMin: number;
}) {
  const [st, setSt] = useState<Status | null>(initialStatus);
  const [ticks, setTicks] = useState<Tick[]>(initialTicks);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => 0);
  const [flash, setFlash] = useState(false);
  const lastTs = useRef<string | null>(initialStatus?.last_tick?.ts ?? null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/care/lvc/ground-status');
      const j = await r.json();
      if (r.ok && j.ok) { setSt(j); setTicks(j.recent_ticks ?? []); setReconnecting(false); }
      else setReconnecting(true);
    } catch { setReconnecting(true); }
  }, []);

  useEffect(() => {
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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
    setBusy('pause');
    try { await fetch('/api/care/lvc/ground-status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: !st.paused }) }); await load(); }
    catch { /* soft */ } finally { setBusy(null); }
  };
  const probe = async () => {
    setBusy('probe'); setMsg(null);
    try {
      const r = await fetch('/api/care/lvc/ground', { method: 'POST' });
      const j = await r.json();
      setMsg(j.ok ? `Tick: ${j.status} · ${j.processed} notes · +${j.citations_added} cites (epoch ${j.epoch})` : `Probe: ${j.error || 'failed'}`);
      await load();
    } catch (e) { setMsg(String((e as Error).message)); } finally { setBusy(null); }
  };

  const style = STATE_LABEL[st?.state ?? 'idle'] ?? STATE_LABEL.idle;
  const remaining = st && st.total_lv_notes != null && st.grounded_at_epoch != null ? Math.max(0, st.total_lv_notes - st.grounded_at_epoch) : null;
  const perTick = st?.last_tick?.processed || batch;
  const etaMin = remaining == null ? null : remaining === 0 ? 0 : perTick > 0 ? Math.ceil(remaining / perTick) * cadenceMin : null;
  const maxCites = Math.max(1, ...ticks.map((t) => t.citations_added));
  const ago = st?.last_tick && nowMs ? formatAgo(st.last_tick.ts, nowMs) : '—';
  const nextIn = nowMs ? nextTickInSec(nowMs, cadenceMin) : null;

  return (
    <div className="mt-5">
      {/* header */}
      <div className="flex flex-wrap items-center gap-3">
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium ${style.text}`}>
          <StateDot state={st?.state ?? 'idle'} />{style.label}
        </span>
        {st && st.state !== 'disabled' && <LivePill reconnecting={reconnecting} />}
        <span className="text-[12px] text-slate-500">epoch {st?.epoch ?? '—'} · {num(st?.active_assertions)} active assertions · last tick {ago}{nextIn != null ? ` · next ~${mmss(nextIn)}` : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          {st && st.state !== 'disabled' && (
            <button onClick={togglePause} disabled={busy === 'pause'} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">
              {st.paused ? <><Play className="h-3.5 w-3.5" />Resume</> : <><Pause className="h-3.5 w-3.5" />Pause</>}
            </button>
          )}
          <button onClick={probe} disabled={busy === 'probe'} className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-slate-700 disabled:opacity-50">
            <Zap className="h-3.5 w-3.5" />{busy === 'probe' ? 'Running…' : 'Run one tick'}
          </button>
        </div>
      </div>
      {msg && <p className="mt-2 text-[12px] text-slate-500">{msg}</p>}

      {/* counters + drain */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Notes grounded / total" value={`${num(st?.grounded_at_epoch)} / ${num(st?.total_lv_notes)}`} />
        <Stat label="Citations added (total)" value={num(st?.citations_added_total)} flash={flash} />
        <Stat label="Drain %" value={st?.drain_pct == null ? '—' : `${st.drain_pct}%`} />
        <Stat label="ETA @ current rate" value={etaMin == null ? '—' : etaMin === 0 ? 'drained' : `~${etaMin} min`} />
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${st?.drain_pct ?? 0}%` }} />
      </div>

      {/* throughput (citations/tick) */}
      <div className="mt-5">
        <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-slate-500">Throughput · citations per tick</div>
        <div className="flex h-16 items-end gap-0.5 overflow-hidden rounded-lg border border-slate-100 bg-slate-50 p-2">
          {[...ticks].reverse().slice(-60).map((t, i) => (
            <div key={i} className={`w-1.5 shrink-0 rounded-sm ${TICK_TONE[t.status] ?? 'bg-slate-300'}`}
              style={{ height: `${Math.max(4, Math.round((t.citations_added / maxCites) * 100))}%` }}
              title={`${shortTs(t.ts)} · ${t.status} · ${t.processed} notes · +${t.citations_added} cites`} />
          ))}
          {ticks.length === 0 && <span className="text-[12px] text-slate-400">No ticks yet.</span>}
        </div>
      </div>

      {/* full tick feed */}
      <div className="mt-5">
        <div className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-slate-500">Tick feed</div>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          {ticks.length === 0 && <div className="px-3 py-3 text-[12px] text-slate-400">No ticks recorded yet.</div>}
          {ticks.slice(0, 60).map((t, i) => (
            <div key={i} className={`flex items-center gap-3 px-3 py-1.5 text-[12px] ${i ? 'border-t border-slate-100' : ''}`}>
              <span className="w-28 shrink-0 tabular-nums text-slate-400">{shortTs(t.ts)}</span>
              <span className={`inline-flex h-1.5 w-1.5 shrink-0 rounded-full ${TICK_TONE[t.status] ?? 'bg-slate-300'}`} />
              <span className="w-14 shrink-0 font-medium text-slate-600">{t.status}</span>
              <span className="text-slate-500">{t.processed} notes · +{t.citations_added} cites{t.epoch != null ? ` · epoch ${t.epoch}` : ''}</span>
              {t.note && <span className="ml-auto truncate text-[11px] text-slate-400">{t.note}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, flash }: { label: string; value: string; flash?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2 transition-colors duration-700 ${flash ? 'border-emerald-300 bg-emerald-100' : 'border-slate-200 bg-white'}`}>
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className="mt-0.5 text-[15px] font-semibold tabular-nums text-slate-900">{value}</div>
    </div>
  );
}
