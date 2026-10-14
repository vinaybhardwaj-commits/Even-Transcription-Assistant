'use client';
// Per-finding adjudication for the IPD audit report (S3.2 fix): OPD-grade vocabulary —
// True positive / Nitpick / False / Contested — on EVERY finding, mirroring the OPD
// finding-triage UX (same pills, same tooltips; the OPD component itself is untouched —
// it is OPD-coupled via reviewer roster + impact tags + its own API). Notes box opens
// automatically on False/Contested, and on any pill via "Add note". Appends to
// ipd_audit_feedback via /api/admin/ipd-audit-feedback; latest row per finding wins on read.
// Pill palette is the OPD one (emerald/slate/red/violet) — disjoint from the scored A–E
// palette; advisory verdicts never borrow the scored language (CI-asserted).
import { useState } from 'react';

type Pill = { key: string; label: string; tip: string; on: string };
const PILLS: Pill[] = [
  { key: 'true_positive', label: 'True positive', tip: 'Correct and worth surfacing.',
    on: 'border-emerald-400 bg-emerald-50 text-emerald-800' },
  { key: 'nitpick', label: 'Nitpick', tip: 'Technically correct but low-value noise.',
    on: 'border-slate-400 bg-slate-100 text-slate-700' },
  { key: 'false', label: 'False', tip: 'Wrong / not supported by the document.',
    on: 'border-red-400 bg-red-50 text-red-700' },
  { key: 'contested', label: 'Contested', tip: 'Guideline-correct but patient-demand / context-constrained.',
    on: 'border-violet-400 bg-violet-50 text-violet-700' },
];
const OFF = 'border-slate-200 text-slate-500 hover:bg-slate-50';

export default function FindingTriage({ auditId, findingRef, initial }: { auditId: string; findingRef: string; initial?: string | null }) {
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  async function post(verdict: string, noteText: string | null) {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const res = await fetch('/api/admin/ipd-audit-feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ auditId, findingRef, verdict, ...(noteText ? { note: noteText } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `status ${res.status}`);
      setSelected(verdict);
      setSaved(true);
    } catch (e) {
      setErr(String((e as Error).message).slice(0, 60));
    } finally {
      setBusy(false);
    }
  }

  function tap(key: string) {
    if (busy || key === selected) return;   // no toggle-off (the OPD rule)
    setNoteOpen(key === 'false' || key === 'contested');
    void post(key, null);
  }

  function submitNote() {
    if (!selected || !note.trim() || busy) return;
    void post(selected, note.trim());
    setNote(''); setNoteOpen(false);
  }

  return (
    <div className="mt-2 border-t border-slate-100 pt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">Your call</span>
        {PILLS.map((p) => (
          <button key={p.key} type="button" onClick={() => tap(p.key)} title={p.tip} disabled={busy}
            className={`rounded-full border px-2 py-[3px] text-[11px] font-medium ${selected === p.key ? p.on : OFF} ${busy ? 'opacity-80' : ''}`}>
            {p.label}
          </button>
        ))}
        {selected && !noteOpen && !busy && (
          <button type="button" onClick={() => setNoteOpen(true)} className="text-[10.5px] text-slate-400 hover:text-brand">Add note</button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {err && <span className="text-[10px] font-semibold text-red-600">Not saved — {err}</span>}
          {!err && saved && <span className="text-[10.5px] text-slate-400">Saved ✓</span>}
        </span>
      </div>
      {noteOpen && selected && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={note} onChange={(e) => setNote(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
            placeholder={selected === 'false' ? 'Why is this wrong? (optional)' : selected === 'contested' ? 'Why contested? (optional)' : 'Note (optional)'}
            className="h-7 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11.5px] text-slate-700 outline-none focus:border-brand/50" />
          <button type="button" disabled={busy || !note.trim()} onClick={submitNote}
            className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium ${busy || !note.trim() ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand/5'}`}>
            Save note
          </button>
        </div>
      )}
    </div>
  );
}
