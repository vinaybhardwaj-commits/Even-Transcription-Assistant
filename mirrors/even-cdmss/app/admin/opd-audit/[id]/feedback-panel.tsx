'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

// PRD §9.6 — the coarse whole-audit agree/disagree/needs_action buttons are RETIRED (superseded by
// the per-finding "Your call" pills). The general free-text comment box stays at the #verdict foot
// for anything not tied to a single finding (posts scope='audit'). Legacy rows that carried a
// verdict still read back unchanged via VERDICT_BADGE below.

export type FeedbackEntry = {
  id: string;
  created_at: string;
  verdict: string | null;
  comment: string | null;
  author: string | null;
};

const VERDICT_BADGE: Record<string, { label: string; cls: string }> = {
  agree:        { label: 'Agree',        cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  disagree:     { label: 'Disagree',     cls: 'bg-red-50 text-red-700 border-red-200' },
  needs_action: { label: 'Needs action', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
};

function rel(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// §2.5 — the roster identity picked in ReviewerBar (localStorage) rides this comment too; no free text.
function getReviewer(): string {
  if (typeof window === 'undefined') return '';
  try { return (window.localStorage.getItem('opd-reviewer') || '').trim(); } catch { return ''; }
}

export default function FeedbackPanel({ auditId, uid, initial }: { auditId: string; uid: string | null; initial: FeedbackEntry[] }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function submit() {
    if (busy) return;
    if (!comment.trim()) { setMsg('Add a comment.'); return; }
    setBusy(true); setMsg('');
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'audit', auditId, uid, comment: comment.trim(), author: getReviewer() || null }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { setMsg('Error: ' + (j.error || `status ${r.status}`)); }
      else { setComment(''); router.refresh(); }
    } catch (e) {
      setMsg('Failed: ' + String((e as Error).message));
    }
    setBusy(false);
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">General comment</span>
        <input value={comment} onChange={(e) => setComment(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="Anything about this audit not tied to a single finding?"
          className="h-8 min-w-[180px] flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[12px] text-slate-700 outline-none focus:border-brand/50" />
        <button type="button" onClick={submit} disabled={busy}
          className={`whitespace-nowrap rounded-lg border px-3 py-1.5 text-[12px] font-medium ${busy ? 'border-slate-200 text-slate-400' : 'border-brand/40 bg-white text-brand hover:bg-brand-faint'}`}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="mt-1 text-[10.5px] text-slate-400">Use the per-finding “Your call” pills above for finding-specific calls. Attributed to your picked reviewer identity above.</div>
      {msg && <div className="mt-1 text-[11px] text-slate-500">{msg}</div>}

      {initial.length > 0 && (
        <details className="mt-1.5" open={initial.length <= 2}>
          <summary className="cursor-pointer select-none text-[11px] font-medium text-slate-500 hover:text-brand">{initial.length} earlier review{initial.length > 1 ? 's' : ''}</summary>
          <ul className="mt-1.5 space-y-1.5">
            {initial.map((f) => (
              <li key={f.id} className="rounded-lg border border-slate-100 bg-white px-3 py-2">
                <div className="flex items-center gap-2">
                  {f.verdict && VERDICT_BADGE[f.verdict] && (
                    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${VERDICT_BADGE[f.verdict].cls}`}>{VERDICT_BADGE[f.verdict].label}</span>
                  )}
                  <span className="text-[10.5px] text-slate-400">{f.author || 'Anonymous'} · {rel(f.created_at)}</span>
                </div>
                {f.comment && <div className="mt-1 text-[12px] leading-snug text-slate-700">{f.comment}</div>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
