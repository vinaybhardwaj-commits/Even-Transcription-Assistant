'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { savedLabel } from '@/lib/opd-feedback-ux-core';
import { MISSED_CATEGORIES } from '@/lib/opd-feedback-core';

// PRD §9.4 (note-level "Flag something the audit missed") + OPD-FEEDBACK-UX-POLISH §1A/§3
// (same saved/failed treatment as the pills). On success: dispatch 'opd-feedback-saved'
// { scope:'missed' } (drives the sidebar counter) + a brief "Saved HH:MM · name" line. On failure:
// a persistent "Not saved — retry" link that re-posts the exact text (never auto-dismisses).

export type MissedEntry = { id: string; created_at: string; comment: string | null; author: string | null };

function getReviewer(): string {
  if (typeof window === 'undefined') return '';
  try { return (window.localStorage.getItem('opd-reviewer') || '').trim(); } catch { return ''; }
}
function rel(ts: string): string {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function MissedFindingCapture({ auditId, initial }: { auditId: string; initial: MissedEntry[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [cat, setCat] = useState<string | null>(null); // Review-Mode §1.6 category — REQUIRED since F6 (A10.1)
  const [busy, setBusy] = useState(false);
  const [failedText, setFailedText] = useState<string | null>(null); // persistent retry payload
  const [errMsg, setErrMsg] = useState('');
  const [savedLine, setSavedLine] = useState<string | null>(null);

  async function post(comment: string) {
    // F6 (A10.1): the write path now REJECTS scope='missed' without a category, so the control gates
    // submit rather than letting the user discover it as a 400. Never defaulted, never pre-selected —
    // an auto-picked classifier would silently mislabel the recall denominator it feeds.
    if (busy || !comment.trim() || !cat) return;
    setBusy(true); setFailedText(null); setErrMsg(''); setSavedLine(null);
    const author = getReviewer() || null; // re-read at post time (mid-session name change applies)
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'missed', auditId, verdict: 'missed', comment: comment.trim(), category: cat, author }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `status ${r.status}`);
      setText(''); setCat(null); setOpen(false);
      setSavedLine(savedLabel(author, new Date()));
      try { window.dispatchEvent(new CustomEvent('opd-feedback-saved', { detail: { scope: 'missed', category: cat } })); } catch { /* ignore */ }
      router.refresh();
    } catch (e) {
      setFailedText(comment.trim());           // keep the exact text for a verbatim retry
      setErrMsg(String((e as Error).message).slice(0, 60));
    }
    setBusy(false);
  }

  return (
    <div className="mt-3">
      {!open ? (
        <button type="button" onClick={() => { setOpen(true); setSavedLine(null); }}
          className="w-full rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-left text-[11.5px] font-medium text-slate-500 hover:border-brand/40 hover:text-brand">
          + Flag something the audit missed
        </button>
      ) : (
        <div className="rounded-lg border border-dashed border-slate-300 bg-white p-2.5">
          <div className="mb-1.5 flex flex-wrap gap-1">
            {MISSED_CATEGORIES.map((c) => (
              <button key={c} type="button" onClick={() => setCat((cur) => (cur === c ? null : c))}
                className={`rounded-full border px-2 py-[3px] text-[10.5px] font-medium ${cat === c ? 'border-brand/50 bg-brand-faint text-brand' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
                {c}
              </button>
            ))}
            <span className={`self-center text-[10px] ${cat ? 'text-slate-300' : 'text-amber-600'}`}>{cat ? 'category' : 'pick a category (required)'}</span>
          </div>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} autoFocus rows={2}
            placeholder="What should the audit have caught but didn't?"
            className="w-full resize-y rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] leading-snug text-slate-700 outline-none focus:border-brand/50" />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="button" onClick={() => post(text)} disabled={busy || !text.trim() || !cat}
              title={!cat ? 'Pick a category first' : undefined}
              className={`rounded-lg border px-3 py-1 text-[11.5px] font-medium ${busy || !text.trim() || !cat ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => { setOpen(false); setText(''); setErrMsg(''); }} className="text-[11px] text-slate-400 hover:text-slate-600">Cancel</button>
          </div>
        </div>
      )}

      {(failedText || savedLine) && (
        <div className="mt-1.5 flex items-center gap-2 text-[10.5px]">
          {failedText && (
            <>
              <button type="button" onClick={() => post(failedText)} disabled={busy || !cat} className="font-semibold text-red-600 hover:underline disabled:text-red-300 disabled:no-underline">Not saved — retry</button>
              {errMsg && <span className="text-red-400">{errMsg}</span>}
            </>
          )}
          {!failedText && savedLine && <span className="text-slate-400">{savedLine}</span>}
        </div>
      )}

      {initial.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {initial.map((m) => (
            <li key={m.id} className="rounded-lg border border-slate-100 bg-slate-50/50 px-3 py-2">
              <div className="text-[10.5px] text-slate-400">Missed · {m.author || 'Anonymous'} · {rel(m.created_at)}</div>
              {m.comment && <div className="mt-0.5 text-[12px] leading-snug text-slate-700">{m.comment}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
