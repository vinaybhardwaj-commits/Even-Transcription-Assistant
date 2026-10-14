'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function MineButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function run() {
    if (busy) return;
    setBusy(true); setMsg('mining recent audits + reviewer signal…');
    try {
      const r = await fetch('/api/learning/mine?days=90', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setMsg('error: ' + (j.error || `status ${r.status}`));
      else {
        const probes = `${j.probed ?? 0} corpus probe${(j.probed ?? 0) === 1 ? '' : 's'}${j.deferredProbes ? ` · ${j.deferredProbes} deferred to tomorrow` : ''}`;
        const adj = (j.adjudicatedFix || j.adjudicatedSuppress) ? ` · adjudicated fix ×${j.adjudicatedFix} / suppress ×${j.adjudicatedSuppress}` : '';
        setMsg(`scanned ${j.scanned} audits · ${j.candidates} finding + ${j.missed} missed + ${j.suppressions} false clusters cleared the gates · ${probes} · ${j.inserted} new · ${j.refreshed} refreshed${adj}`);
        router.refresh();
      }
    } catch (e) { setMsg('failed: ' + String((e as Error).message)); }
    setBusy(false);
  }
  return (
    <span className="flex items-center gap-2">
      <button onClick={run} disabled={busy}
        className={`whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs ${busy ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
        {busy ? 'Mining…' : '↻ Run miner'}
      </button>
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </span>
  );
}

function useReview(id: string) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [note, setNote] = useState('');
  const [who, setWho] = useState('');
  async function act(action: 'approve' | 'reject' | 'harvest') {
    if (busy) return;
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/learning/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, action, reviewer: who.trim() || null, note: note.trim() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) setMsg('error: ' + (j.error || `status ${r.status}`));
      else router.refresh();
    } catch (e) { setMsg('failed: ' + String((e as Error).message)); }
    setBusy(false);
  }
  return { busy, msg, note, setNote, who, setWho, act };
}

function IdentityInputs({ who, setWho, note, setNote }: { who: string; setWho: (v: string) => void; note: string; setNote: (v: string) => void }) {
  return (
    <>
      <input value={who} onChange={(e) => setWho(e.target.value)} placeholder="reviewer (optional)"
        className="h-7 w-36 rounded border border-slate-200 px-2 text-[11px] text-slate-700 outline-none focus:border-brand/50" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)"
        className="h-7 min-w-[8rem] flex-1 rounded border border-slate-200 px-2 text-[11px] text-slate-700 outline-none focus:border-brand/50" />
    </>
  );
}

/** approve / reject — for finding-mined lvc_rule + harvest_topic. approveLabel names the effect. */
export function ReviewButtons({ id, approveLabel = 'Approve' }: { id: string; approveLabel?: string }) {
  const { busy, msg, note, setNote, who, setWho, act } = useReview(id);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <IdentityInputs who={who} setWho={setWho} note={note} setNote={setNote} />
      <button onClick={() => act('approve')} disabled={busy}
        className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-100">{approveLabel}</button>
      <button onClick={() => act('reject')} disabled={busy}
        className="rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-[11.5px] font-medium text-red-700 hover:bg-red-100">Reject</button>
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </div>
  );
}

/** missed_rule — approve (draft → Right Care) / harvest (route to corpus instead) / dismiss. */
export function MissedRuleButtons({ id }: { id: string }) {
  const { busy, msg, note, setNote, who, setWho, act } = useReview(id);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <IdentityInputs who={who} setWho={setWho} note={note} setNote={setNote} />
      <button onClick={() => act('approve')} disabled={busy}
        className="rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-100">Draft rule → Right Care</button>
      <button onClick={() => act('harvest')} disabled={busy}
        className="rounded-lg border border-sky-300 bg-sky-50 px-2.5 py-1 text-[11.5px] font-medium text-sky-700 hover:bg-sky-100">Send to harvest instead</button>
      <button onClick={() => act('reject')} disabled={busy}
        className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11.5px] font-medium text-slate-500 hover:bg-slate-100">Dismiss</button>
      {msg && <span className="text-[11px] text-slate-500">{msg}</span>}
    </div>
  );
}

/** suppression — propose (runs the dual-label safety gate) / keep firing. A refusal surfaces the reason. */
export function SuppressionButtons({ id }: { id: string }) {
  const { busy, msg, note, setNote, who, setWho, act } = useReview(id);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <IdentityInputs who={who} setWho={setWho} note={note} setNote={setNote} />
      <button onClick={() => act('approve')} disabled={busy}
        className="rounded-lg border border-rose-300 bg-rose-50 px-2.5 py-1 text-[11.5px] font-medium text-rose-700 hover:bg-rose-100">Propose suppression</button>
      <button onClick={() => act('reject')} disabled={busy}
        className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11.5px] font-medium text-slate-500 hover:bg-slate-100">Keep firing</button>
      {msg && <span className="text-[11px] text-slate-600">{msg}</span>}
    </div>
  );
}
