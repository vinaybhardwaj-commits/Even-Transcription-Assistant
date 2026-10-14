'use client';
// EpisodeState (#4) SL5 — per-phase reconstruction-fidelity rating. Reuses the shipped
// finding-triage UX (same pills, auto-note-on-problem, optimistic "Saved ✓") with the
// builder-fidelity vocabulary: faithful / missed-material-fact / mis-phased / over-included. Posts
// to /api/admin/episode-recon-rating → the DEDICATED episode_recon_ratings store (never
// ipd_audit_feedback, never ipd_gold_adjudication). Phase-level by default; factRef drills a fact.
import { useState } from 'react';

type Pill = { key: string; label: string; tip: string; on: string };
const PILLS: Pill[] = [
  { key: 'faithful', label: 'Faithful', tip: 'This phase captures the documented course.',
    on: 'border-emerald-400 bg-emerald-50 text-emerald-800' },
  { key: 'missed_material_fact', label: 'Missed fact', tip: 'The summary states something the builder dropped.',
    on: 'border-red-400 bg-red-50 text-red-700' },
  { key: 'mis_phased', label: 'Mis-phased', tip: 'A captured fact is in the wrong phase.',
    on: 'border-violet-400 bg-violet-50 text-violet-700' },
  { key: 'over_included', label: 'Over-included', tip: 'A fact that should not be in this phase.',
    on: 'border-amber-400 bg-amber-50 text-amber-700' },
];
const OFF = 'border-slate-200 text-slate-500 hover:bg-slate-50';

export default function ReconTriage(
  { documentId, ipUid, version, phase, factRef, initial }:
  { documentId: string; ipUid: string | null; version: string; phase: string; factRef?: string | null; initial?: string | null },
) {
  const [selected, setSelected] = useState<string | null>(initial ?? null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');

  async function post(verdict: string, noteText: string | null) {
    setBusy(true); setErr(''); setSaved(false);
    try {
      const res = await fetch('/api/admin/episode-recon-rating', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId, ipUid, version, phase, ...(factRef ? { factRef } : {}), verdict, ...(noteText ? { note: noteText } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) throw new Error(j.error || `status ${res.status}`);
      setSelected(verdict); setSaved(true);
    } catch (e) { setErr(String((e as Error).message).slice(0, 60)); }
    finally { setBusy(false); }
  }

  function tap(key: string) {
    if (busy || key === selected) return;
    setNoteOpen(key !== 'faithful');
    void post(key, null);
  }
  function submitNote() {
    if (!selected || !note.trim() || busy) return;
    void post(selected, note.trim()); setNote(''); setNoteOpen(false);
  }

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
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
          <input value={note} onChange={(e) => setNote(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
            placeholder="What was missed / mis-phased? (optional)"
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
