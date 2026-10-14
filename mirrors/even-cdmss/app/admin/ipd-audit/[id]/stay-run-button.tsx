'use client';
/**
 * "Audit the whole stay" — the stay-level auditor's surface affordance
 * (CDMSS-CASE-AGENTS-SPINE-PRD-v1.0-27-AUG-2026, P3 / §5).
 *
 * POSTs the document id to /api/admin/ipd-stay-audit-now, which APPENDS a row under
 * `ipd-stay-audit/0.1`. It cannot rewrite the report on the page it sits under: that row is
 * `ipd-discharge-audit/0.2` and the two live at different keys of the same composite PK. The copy
 * says so, because a reviewer about to spend three minutes of Gemini deserves to know what the run
 * will and will not touch.
 *
 * Mirrors AuditNowButton's shape deliberately — same posture, same honesty about the wait.
 */
import { useState } from 'react';

export default function StayAuditRunButton({ documentId, alreadyRun }: { documentId: string; alreadyRun: boolean }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [id, setId] = useState<string | null>(null);

  async function run() {
    if (state === 'running') return;
    setState('running'); setMsg('reading the whole stay… (~3 min)');
    try {
      const res = await fetch('/api/admin/ipd-stay-audit-now', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const j = await res.json();
      if (!j.ok) { setState('error'); setMsg(j.error || 'failed'); return; }
      setId(j.id); setState('done');
      setMsg([j.band, j.careValueIndex, j.coverageLine].filter(Boolean).join(' · '));
    } catch (e) {
      setState('error'); setMsg(String((e as Error).message));
    }
  }

  if (state === 'done' && id) {
    return <a href={`/admin/ipd-audit/${id}`} className="rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90">Open the stay audit · {msg}</a>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={run} disabled={state === 'running'}
        className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${state === 'running' ? 'cursor-wait border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand/5'}`}>
        {state === 'running' ? 'Reading the stay…' : alreadyRun ? 'Re-run the stay audit' : 'Audit the whole stay'}
      </button>
      <span className="text-[10.5px] text-slate-400">
        ~3 min · writes a NEW reading under ipd-stay-audit/0.1 · the report above is not changed
      </span>
      {msg && <span className={`text-[10.5px] ${state === 'error' ? 'text-red-600' : 'text-slate-400'}`}>{msg}</span>}
    </div>
  );
}
