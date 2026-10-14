'use client';
// "Audit now" — the single-doc primitive's surface affordance (S3.5). POSTs the documentId to
// /api/admin/ipd-audit-now (admin-cookie authed), shows progress, then links to the report.
// The run is ~3-4 min of Gemini; the button makes that explicit so it is never a casual click.
import { useState } from 'react';

export default function AuditNowButton({ documentId }: { documentId: string }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [id, setId] = useState<string | null>(null);

  async function run() {
    if (state === 'running') return;
    setState('running'); setMsg('auditing… (~3 min)');
    try {
      const res = await fetch('/api/admin/ipd-audit-now', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId }),
      });
      const j = await res.json();
      if (!j.ok) { setState('error'); setMsg(j.error || 'failed'); return; }
      setId(j.id); setState('done'); setMsg(`${j.band} · ${j.careValueIndex}`);
    } catch (e) {
      setState('error'); setMsg(String((e as Error).message));
    }
  }

  if (state === 'done' && id) {
    return <a href={`/admin/ipd-audit/${id}`} className="rounded-md bg-brand px-2 py-1 text-[11px] font-semibold text-white hover:opacity-90">Open report · {msg}</a>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <button onClick={run} disabled={state === 'running'}
        className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${state === 'running' ? 'cursor-wait border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand/5'}`}>
        {state === 'running' ? 'Auditing…' : 'Audit now'}
      </button>
      {msg && <span className={`text-[10.5px] ${state === 'error' ? 'text-red-600' : 'text-slate-400'}`}>{msg}</span>}
    </span>
  );
}
