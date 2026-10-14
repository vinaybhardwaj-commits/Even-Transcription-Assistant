'use client';

/**
 * Concept Coder worker status panel (CDMSS-CONCEPT-CODER-PRD v1.0). Deliberately a SIBLING of
 * components/care/GroundingPanel — same card, same state pills, same tick feed, same flag-off
 * behaviour (it renders a disabled state explaining itself rather than vanishing). StateDot and
 * LivePill are imported from that panel rather than re-implemented, so the two can never drift.
 *
 * PHASE 1 ONLY: read-only status. No ruling, no verdicts, no review sheet, no evidence drawer —
 * those are Phase 2 and gated on the PRD §10 dependency. No doctor identifier is rendered or
 * requested; the payload carries counts only.
 *
 * ZERO-STATE is a first-class case, not an afterthought: 0 ticks, 0 stamped, seed loaded is exactly
 * the state this ships in, and it must read as "ready, nothing has run yet" — never as broken.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Boxes, Pause, Play, Gauge, AlertTriangle } from 'lucide-react';
import { formatAgo, nextTickInSec } from '@/lib/even-ground-core';
import { CONCEPT_CRON_MIN } from '@/lib/even-concept-core';
import { StateDot, LivePill } from './GroundingPanel';

type Tick = { ts: string; status: string; processed: number; stamped: number; extracted: number; rejected: number; epoch: number | null; note: string | null };
type Status = {
  ok: boolean; state: 'draining' | 'idle' | 'paused' | 'disabled'; epoch: number; paused: boolean;
  coded: number | null; candidates: number | null; not_yet_coded: number | null;
  cache_hit_pct: number | null; strings_extracted_7d: number | null; rejected_recent: number;
  concepts: number | null; strings_seed: number | null;
  last_tick: Tick | null; recent_ticks: Tick[]; coded_pct: number | null;
};

const STATE_STYLE: Record<string, { text: string; label: string }> = {
  draining: { text: 'text-sky-700', label: 'Draining' },
  idle: { text: 'text-emerald-700', label: 'Idle — all findings coded' },
  paused: { text: 'text-amber-700', label: 'Paused' },
  disabled: { text: 'text-slate-500', label: 'Disabled (flag off)' },
};
const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const shortTs = (ts: string) => ts.replace('T', ' ').slice(5, 16);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export default function ConceptWorkerPanel() {
  const [st, setSt] = useState<Status | null>(null);
  const [hardErr, setHardErr] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => 0);
  const [flash, setFlash] = useState(false);
  const lastTs = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/care/concept/status');
      const j = (await r.json()) as Status;
      if (!r.ok || !j.ok) { setReconnecting(true); if (r.status === 404) setHardErr(true); return; }
      setSt(j); setReconnecting(false); setHardErr(false);
    } catch { setReconnecting(true); }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 10000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // flash the Coded counter when a new tick lands
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
      await fetch('/api/care/concept/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paused: !st.paused }) });
      await load();
    } catch { /* soft */ } finally { setBusy(false); }
  };

  if (hardErr && !st) return null;   // surface flag off ⇒ render nothing (the page itself 404s)
  if (!st) {
    return (
      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-slate-400" />
          <h2 className="text-[14px] font-semibold text-slate-800">Coder worker</h2>
          <LivePill reconnecting />
        </div>
        <p className="mt-2 text-[12px] text-slate-400">Loading worker status…</p>
      </section>
    );
  }

  const style = STATE_STYLE[st.state] ?? STATE_STYLE.idle;
  const ago = st.last_tick && nowMs ? formatAgo(st.last_tick.ts, nowMs) : null;
  const nextIn = nowMs ? nextTickInSec(nowMs, CONCEPT_CRON_MIN) : null;
  const noTicksYet = (st.recent_ticks?.length ?? 0) === 0;
  const rejected = st.rejected_recent ?? 0;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Boxes className="h-4 w-4 text-slate-400" />
          <h2 className="text-[14px] font-semibold text-slate-800">Coder worker</h2>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.text}`}>
            <StateDot state={st.state} size="h-1.5 w-1.5" />{style.label}
          </span>
          {st.state !== 'disabled' && <LivePill reconnecting={reconnecting} />}
        </div>
        {st.state !== 'disabled' && (
          <button onClick={togglePause} disabled={busy}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            {st.paused ? <><Play className="h-3.5 w-3.5" />Resume</> : <><Pause className="h-3.5 w-3.5" />Pause</>}
          </button>
        )}
      </div>

      {st.state === 'disabled' && (
        <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-500">
          The worker is switched off at the environment flag (<span className="font-medium">LVC_CONCEPT_ENABLED</span>), so no tick will run and
          nothing is being coded. The tables below are still live — seeded vocabulary is loaded and ready.
        </p>
      )}

      {/* coded-vs-candidates progress */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11.5px] text-slate-500">
          <span className="inline-flex items-center gap-1"><Gauge className="h-3.5 w-3.5" />Findings coded</span>
          <span>{pct(st.coded_pct)}</span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-sky-500 transition-all" style={{ width: `${st.coded_pct ?? 0}%` }} />
        </div>
      </div>

      {/* five tiles — each earns its place (see the kickoff) */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Tile label="Coded" value={`${num(st.coded)} / ${num(st.candidates)}`} flash={flash} />
        <Tile label="Cache hits" value={pct(st.cache_hit_pct)} sub="stamps needing no model call" />
        <Tile label="New strings (7d)" value={num(st.strings_extracted_7d)} sub="the cost line" />
        <Tile label="Rejected" value={num(rejected)} sub="tried and failed" warn={rejected > 0} />
        <Tile label="Not yet coded" value={num(st.not_yet_coded)} sub="not reached yet" />
      </div>

      {rejected > 0 && (
        <p className="mt-2 inline-flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {rejected.toLocaleString()} extraction{rejected === 1 ? '' : 's'} failed across the recent ticks — a call error, an unreadable
            response, or a direction outside the closed vocabulary. Each was skipped and left <span className="font-medium">unstamped</span>,
            so no finding was changed. Sustained rejections mean the prompt is misfiring on real strings the seed never exposed.
          </span>
        </p>
      )}

      {/* recent ticks — all four counts */}
      <div className="mt-3">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400">Recent ticks</div>
        {noTicksYet ? (
          <p className="text-[11.5px] text-slate-400">
            No ticks yet{st.state === 'disabled' ? '' : ` — the worker runs every ${CONCEPT_CRON_MIN} minutes${nextIn != null ? `, next in ~${mmss(nextIn)}` : ''}`}.
            {' '}Vocabulary is loaded: {num(st.concepts)} concepts, {num(st.strings_seed)} seeded strings.
          </p>
        ) : (
          <div className="space-y-0.5">
            {st.recent_ticks.slice(0, 6).map((t, i) => (
              <div key={i} className="flex items-center gap-2 text-[11.5px] text-slate-500">
                <span className="w-24 shrink-0 tabular-nums text-slate-400">{shortTs(t.ts)}</span>
                <span className={`w-16 shrink-0 font-medium ${t.status === 'ok' ? 'text-sky-600' : t.status === 'paused' ? 'text-amber-600' : t.status === 'error' ? 'text-red-600' : 'text-slate-500'}`}>{t.status}</span>
                <span className="tabular-nums text-slate-500">
                  {t.processed} notes · {t.stamped} stamped · {t.extracted} extracted ·{' '}
                  <span className={t.rejected > 0 ? 'font-medium text-amber-700' : ''}>{t.rejected} rejected</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="mt-3 text-[11px] text-slate-400">
        {num(st.concepts)} concepts · {num(st.strings_seed)} seeded strings
        {ago ? ` · last tick ${ago}` : ''}
        {nextIn != null && st.state !== 'disabled' && st.state !== 'paused' ? ` · next ~${mmss(nextIn)}` : ''}
        {' '}· stamps <span className="font-medium text-slate-500">concept_id</span> only — never a score.
      </p>
    </section>
  );
}

function Tile({ label, value, sub, flash, warn }: { label: string; value: string; sub?: string; flash?: boolean; warn?: boolean }) {
  const tone = warn ? 'bg-amber-50 ring-1 ring-amber-200' : flash ? 'bg-emerald-100 ring-1 ring-emerald-300' : 'bg-slate-50';
  return (
    <div className={`rounded-xl px-3 py-2 transition-colors duration-700 ${tone}`}>
      <div className={`text-[11px] ${warn ? 'text-amber-700' : 'text-slate-400'}`}>{label}</div>
      <div className={`mt-0.5 text-[13.5px] font-semibold tabular-nums ${warn ? 'text-amber-900' : 'text-slate-800'}`}>{value}</div>
      {sub && <div className={`text-[10px] ${warn ? 'text-amber-600' : 'text-slate-400'}`}>{sub}</div>}
    </div>
  );
}
