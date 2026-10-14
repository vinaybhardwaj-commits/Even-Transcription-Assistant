'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type MbState = {
  enabled: boolean; window: 'night' | 'always'; cursor: string | null;
  floor: string; tag: string; n: number;
};

const DAY = 86400000;
function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a + 'T00:00:00Z'), tb = Date.parse(b + 'T00:00:00Z');
  if (!isFinite(ta) || !isFinite(tb)) return 0;
  return Math.round((tb - ta) / DAY);
}
function fmtDay(d: string): string {
  const t = Date.parse(d + 'T00:00:00Z');
  return isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : d;
}

export default function MiniBackfillControls({ state }: { state: MbState }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(state.cursor || '');
  const [floor, setFloor] = useState(state.floor);
  const [tag, setTag] = useState(state.tag);

  async function post(body: Record<string, string>) {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/admin/mini-backfill-settings', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setMsg('Error: ' + (j.error || r.status));
      else { setMsg('Saved.'); router.refresh(); }
    } catch (e) { setMsg('Failed: ' + String((e as Error).message)); }
    setBusy(false);
  }

  // Backfill progress: the cursor walks BACKWARDS from today toward the floor. % done = how much of
  // the today→floor span it has already covered.
  const today = new Date().toISOString().slice(0, 10);
  const total = Math.max(1, daysBetween(state.floor, today));
  const done = state.cursor ? Math.max(0, Math.min(total, daysBetween(state.cursor, today))) : 0;
  const pct = Math.round((done / total) * 100);

  const inputCls = 'h-9 rounded-lg border border-slate-200 bg-white px-2.5 text-[13px] text-slate-700 outline-none focus:border-brand/50';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      {/* primary controls */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy} onClick={() => post({ enabled: state.enabled ? '0' : '1' })}
          className={`rounded-lg px-4 py-2 text-[13px] font-medium text-white ${state.enabled ? 'bg-red-600 hover:bg-red-700' : 'bg-brand hover:bg-brand-dark'}`}>
          {state.enabled ? '⏸ Pause' : '▶ Start'}
        </button>
        <span className="flex overflow-hidden rounded-lg border border-slate-200 text-[12px]">
          {(['night', 'always'] as const).map((w) => (
            <button key={w} type="button" disabled={busy} onClick={() => post({ window: w })}
              className={`px-3 py-1.5 ${state.window === w ? 'bg-brand text-white' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
              {w === 'night' ? 'Night only · 00–05 IST' : 'Anytime'}
            </button>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[12.5px] font-medium">
          <span className={`inline-block h-2 w-2 rounded-full ${state.enabled ? 'bg-teal-500' : 'bg-slate-300'}`} />
          <span className={state.enabled ? 'text-teal-700' : 'text-slate-400'}>
            {state.enabled ? `Running · ${state.window === 'always' ? 'anytime' : 'night only'}` : 'Paused'}
          </span>
          {msg && <span className="text-[11px] font-normal text-slate-400">· {msg}</span>}
        </span>
      </div>

      {/* backfill progress — replaces the old cursor/floor cards */}
      <div className="mt-4">
        <div className="mb-1.5 flex items-center justify-between text-[11.5px] text-slate-500">
          <span>Backfill progress{state.cursor ? ` · reached ${fmtDay(state.cursor)}` : ' · not started'}</span>
          <span>{pct}% of history · stops at {fmtDay(state.floor)}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-teal-500 transition-all" style={{ width: `${Math.max(1.5, pct)}%` }} />
        </div>
        <div className="mt-1 text-[10.5px] text-slate-400">Sweep position at page load — on each engine upgrade the sweep restarts from today. Live re-score coverage (notes now at the current engine) is in the monitor below.</div>
      </div>

      {/* advanced — only the controls with a real reason to change */}
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-100">
        <button type="button" onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between px-3 py-2 text-[12.5px] font-medium text-slate-600 hover:bg-slate-50">
          <span>Advanced · re-audit a specific period</span>
          <span className={`text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
        </button>
        {open && (
          <div className="border-t border-slate-100 bg-slate-50/60 px-3 py-3">
            <p className="mb-3 text-[11.5px] leading-relaxed text-slate-500">
              Only needed to re-run a chosen date range under a new engine version. Everyday use never touches these — start/pause and the window above are all you need.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-[12px] font-medium text-slate-600">Work backwards from
                <span className="mt-0.5 block text-[11px] font-normal text-slate-400">Newest date to start at (it walks toward the past).</span>
                <input type="date" value={cursor} onChange={(e) => setCursor(e.target.value)} className={`${inputCls} mt-1.5 w-full`} />
              </label>
              <label className="text-[12px] font-medium text-slate-600">Stop at
                <span className="mt-0.5 block text-[11px] font-normal text-slate-400">Oldest date to audit back to.</span>
                <input type="date" value={floor} onChange={(e) => setFloor(e.target.value)} className={`${inputCls} mt-1.5 w-full`} />
              </label>
              <label className="text-[12px] font-medium text-slate-600">Generation label
                <span className="mt-0.5 block text-[11px] font-normal text-slate-400">Name for this re-run. Leave as “mini” unless comparing engine versions side by side.</span>
                <input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="mini" className={`${inputCls} mt-1.5 w-full`} />
              </label>
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" disabled={busy} onClick={() => {
                const body: Record<string, string> = { tag };
                if (cursor) body.cursor = cursor;
                if (floor) body.floor = floor;
                post(body);
              }} className="rounded-lg border border-brand/40 px-3 py-1.5 text-[12.5px] font-medium text-brand hover:bg-brand-faint">Save range &amp; label</button>
              <span className="text-[11px] text-slate-400">Sets the cursor to the period end, the floor to its start, and tags the run.</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
