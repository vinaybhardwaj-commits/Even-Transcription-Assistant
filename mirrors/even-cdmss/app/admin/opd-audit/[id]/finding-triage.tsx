'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { planTap, makeAttempt, revertOnFail, savedLabel, type Attempt } from '@/lib/opd-feedback-ux-core';
import { IMPACT_TAGS } from '@/lib/opd-feedback-core';

// Review-Mode §1.2 / §3 — the TP-only optional second tap (impact tag). Posted as its own append row
// (scope='impact') so the base verdict stays a clean true_positive; the case view and Review Mode
// stay write-compatible. Non-blocking: a failed impact post never disturbs the verdict state machine.
const IMPACT_LABELS: Record<string, string> = { changes_management: 'Changes management', chart_hygiene: 'Chart hygiene' };

// PRD §9.1–§9.3 (strip) + OPD-FEEDBACK-UX-POLISH §1A (state machine). Per-finding "Your call" strip
// on every finding that FIRED. Four pills; one tap = one append-row POST. Reviewer name is set once
// (ReviewerBar) in localStorage and rides every tap as `author`. State machine: idle → posting
// (pill fills + inline spinner) → saved (✓ pulse, then persistent "Saved HH:MM · name") | failed
// (pill REVERTS + persistent "Not saved — retry" that re-posts the exact payload). No toggle-off.

const REVIEWER_KEY = 'opd-reviewer';
const REVIEWER_EVENT = 'opd-reviewer-changed';
// Roster identity (REVIEW-GAMIFICATION §2.5): the picker replaces free-text. Fallback mirrors the seed.
const FALLBACK_ROSTER = ['V', 'Zaki', 'Aravind', 'Binita'];

function getReviewer(): string {
  if (typeof window === 'undefined') return '';
  try { return (window.localStorage.getItem(REVIEWER_KEY) || '').trim(); } catch { return ''; }
}

type Pill = { key: string; label: string; tip: string; on: string };
const PILLS: Pill[] = [
  { key: 'true_positive', label: 'True positive', tip: 'Correct and worth surfacing.',
    on: 'border-emerald-400 bg-emerald-50 text-emerald-800' },
  { key: 'nitpick', label: 'Nitpick', tip: 'Technically correct but low-value noise.',
    on: 'border-slate-400 bg-slate-100 text-slate-700' },
  { key: 'false', label: 'False', tip: 'Wrong / not supported by the note.',
    on: 'border-red-400 bg-red-50 text-red-700' },
  { key: 'contested', label: 'Contested', tip: 'Guideline-correct but patient-demand / context-constrained.',
    on: 'border-violet-400 bg-violet-50 text-violet-700' },
];
const OFF = 'border-slate-200 text-slate-500 hover:bg-slate-50';

/** §2.5 — "Reviewing as" roster PICKER (no free text). Pills fed by app_settings review_roster (via
 *  the stats route; fallback constant on error); selection stored in the SAME localStorage key +
 *  broadcast on the SAME event, so every existing consumer keeps working. A `clear` affordance resets. */
export function ReviewerBar() {
  const [name, setName] = useState('');
  const [roster, setRoster] = useState<string[]>(FALLBACK_ROSTER);
  useEffect(() => { setName(getReviewer()); }, []);
  // reflect a pick made in another card
  useEffect(() => {
    const h = () => setName(getReviewer());
    window.addEventListener(REVIEWER_EVENT, h);
    return () => window.removeEventListener(REVIEWER_EVENT, h);
  }, []);
  // roster from app_settings (fail-safe → fallback constant)
  useEffect(() => {
    let live = true;
    fetch('/api/care/review-stats', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (live && Array.isArray(j?.roster) && j.roster.length) setRoster(j.roster.map((x: unknown) => String(x))); })
      .catch(() => { /* keep fallback */ });
    return () => { live = false; };
  }, []);
  function pick(v: string) {
    const val = v.trim();
    setName(val);
    try { window.localStorage.setItem(REVIEWER_KEY, val); } catch { /* ignore */ }
    try { window.dispatchEvent(new CustomEvent(REVIEWER_EVENT)); } catch { /* ignore */ }
  }
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-medium text-slate-500">Reviewing as</span>
      {roster.map((who) => (
        <button key={who} type="button" onClick={() => pick(who)}
          className={`rounded-full border px-2.5 py-[3px] text-[11px] font-medium ${name === who ? 'border-brand/50 bg-brand-faint text-brand' : 'border-slate-200 text-slate-500 hover:bg-slate-50'}`}>
          {who}
        </button>
      ))}
      {name
        ? <button type="button" onClick={() => pick('')} className="text-[10.5px] text-slate-400 hover:text-slate-600">clear</button>
        : <span className="text-[10.5px] text-slate-400">Pick your name so your calls are attributable.</span>}
    </div>
  );
}

export function FindingTriage({ auditId, findingRef, signalType, current }: {
  auditId: string; findingRef?: string; signalType?: string; current?: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(current ?? null);
  const [impact, setImpact] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // saved metadata (persists across router.refresh — kept in client state, not derived from props)
  const [savedBy, setSavedBy] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [pulse, setPulse] = useState(false);
  // failure (persistent until a retry succeeds)
  const [failed, setFailed] = useState<Attempt | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the confirmation label live if the reviewer sets/changes their name in another card.
  const [, force] = useState(0);
  useEffect(() => {
    const h = () => force((x) => x + 1);
    window.addEventListener(REVIEWER_EVENT, h);
    return () => { window.removeEventListener(REVIEWER_EVENT, h); if (pulseTimer.current) clearTimeout(pulseTimer.current); };
  }, []);

  if (!findingRef) return null; // legacy finding without identity — nothing to key on

  async function post(attempt: Attempt) {
    setBusy(true); setFailed(null); setErrMsg('');
    const author = getReviewer() || null; // re-read at post time so a mid-session name change applies
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'finding', auditId, finding_ref: findingRef, signal_type: signalType || null, verdict: attempt.verdict, comment: attempt.comment, author }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `status ${r.status}`);
      // saved: ✓ pulse (client-state, survives the refresh re-render) → persistent metadata
      setSavedBy(author || 'anon');
      setSavedAt(new Date());
      setPulse(true);
      if (pulseTimer.current) clearTimeout(pulseTimer.current);
      pulseTimer.current = setTimeout(() => setPulse(false), 1200);
      try { window.dispatchEvent(new CustomEvent('opd-feedback-saved', { detail: { findingRef, verdict: attempt.verdict, scope: 'finding' } })); } catch { /* ignore */ }
      router.refresh();
    } catch (e) {
      // failed: revert the pill to its previous state; keep a persistent retry of the exact payload
      setSelected(revertOnFail(attempt));
      setFailed(attempt);
      setErrMsg(String((e as Error).message).slice(0, 60));
    }
    setBusy(false);
  }

  function tap(key: string) {
    if (busy) return;
    const plan = planTap(selected, key);
    if (plan.noop) return;                 // no toggle-off: re-tapping the selected pill does nothing
    setSelected(key);                      // optimistic
    if (key !== 'true_positive') setImpact(null); // impact is TP-only
    setNoteOpen(key === 'false' || key === 'contested');
    void post(makeAttempt(plan.prev, key, null));
  }

  async function pickImpact(tag: string) {
    if (busy || !findingRef) return;
    const nextTag = impact === tag ? null : tag; // toggle off locally (no retraction row; latest wins)
    setImpact(nextTag);
    if (!nextTag) return;
    const author = getReviewer() || null;
    try {
      const r = await fetch('/api/opd-audit/feedback', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'impact', auditId, finding_ref: findingRef, signal_type: signalType || null, verdict: tag, author }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `status ${r.status}`);
    } catch { setImpact((cur) => (cur === tag ? null : cur)); } // revert the tag on failure; non-blocking
  }

  function retry() {
    if (!failed || busy) return;
    setSelected(failed.verdict);           // re-apply optimistic
    setNoteOpen(failed.verdict === 'false' || failed.verdict === 'contested');
    void post(failed);
  }

  function submitNote() {
    if (!selected || !note.trim() || busy) return;
    void post(makeAttempt(selected, selected, note.trim()));
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
        {busy && <span className="tri-spin" aria-label="saving" />}
        {pulse && <span className="tri-pulse" aria-hidden>✓</span>}
        {selected && !noteOpen && !busy && (
          <button type="button" onClick={() => setNoteOpen(true)} className="text-[10.5px] text-slate-400 hover:text-brand">Add note</button>
        )}
        <span className="ml-auto flex items-center gap-2">
          {failed && (
            <button type="button" onClick={retry} className="text-[10.5px] font-semibold text-red-600 hover:underline">Not saved — retry</button>
          )}
          {failed && errMsg && <span className="text-[10px] text-red-400">{errMsg}</span>}
          {!failed && savedAt && <span className="text-[10.5px] text-slate-400">{savedLabel(savedBy, savedAt)}</span>}
        </span>
      </div>
      {selected === 'true_positive' && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-slate-400">Impact</span>
          {IMPACT_TAGS.map((tag) => (
            <button key={tag} type="button" onClick={() => pickImpact(tag)} disabled={busy}
              className={`rounded-full border px-2 py-[3px] text-[11px] font-medium ${impact === tag ? 'border-emerald-400 bg-emerald-50 text-emerald-800' : OFF}`}>
              {IMPACT_LABELS[tag]}
            </button>
          ))}
          <span className="text-[10px] text-slate-300">optional</span>
        </div>
      )}
      {noteOpen && selected && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <input
            value={note} onChange={(e) => setNote(e.target.value)} autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') submitNote(); }}
            placeholder={selected === 'false' ? 'Why is this wrong? (optional)' : selected === 'contested' ? 'Why contested? (optional)' : 'Note (optional)'}
            className="h-7 flex-1 rounded-lg border border-slate-200 bg-white px-2.5 text-[11.5px] text-slate-700 outline-none focus:border-brand/50" />
          <button type="button" disabled={busy || !note.trim()} onClick={submitNote}
            className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium ${busy || !note.trim() ? 'border-slate-200 text-slate-400' : 'border-brand/40 text-brand hover:bg-brand-faint'}`}>
            Save note
          </button>
        </div>
      )}
      <style jsx>{`
        .tri-spin { width: 10px; height: 10px; border: 2px solid #cbd5e1; border-top-color: #0f766e; border-radius: 50%; display: inline-block; animation: triSpin 0.6s linear infinite; }
        @keyframes triSpin { to { transform: rotate(360deg); } }
        .tri-pulse { display: inline-block; font-size: 12px; line-height: 1; color: #059669; animation: triPulse 1.2s ease forwards; }
        @keyframes triPulse { 0% { opacity: 0; transform: scale(0.6); } 25% { opacity: 1; transform: scale(1.1); } 45% { transform: scale(1); } 75% { opacity: 1; } 100% { opacity: 0; } }
      `}</style>
    </div>
  );
}
