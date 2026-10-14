'use client';
/**
 * "Record outcome" (PX Phase 2 PRD §5.3) — the loop that records what ACTUALLY happened against a
 * stored prognosis block. Renders only when the report carries one (the server page gates it).
 *
 * Client component because it owns a form and a fetch — the review-panel posture. Everything that
 * needs Node crypto (hashing, authoritative classification) happens SERVER-side: the page computes
 * each complication's hash and each stored row's resolution and passes them down; the API route
 * re-derives the classification from form state. The tiny `derivedView` mirror below is for the
 * live "Classification" chip ONLY — shown, never typed, never trusted by the server.
 *
 * P-7: "Correct this entry" posts the SAME form with `supersedesId`; the store's one-statement
 * supersede flips the old row and inserts the correction atomically. History (superseded rows) is
 * behind a toggle, current rows by default.
 */
import { useState } from 'react';
import { isValidAttribution, ATTRIBUTION_LABEL, ATTRIBUTION_HELP } from '@/lib/admin-attribution';

/** Computed server-side (Node crypto) and passed down — the panel never hashes. */
export interface ComplicationOption { name: string; hash: string; index: number }

export interface OutcomeRowView {
  id: number;
  source: string;
  observed_outcome: string;
  observed_at: string | null;
  classification: string;
  reviewed_by_name: string | null;
  notes: string | null;
  superseded: boolean;
  supersedes_id: number | null;
  created_at: string | null;
  /** Resolution against the CURRENT block, computed server-side by hash — never by index. */
  resolution: { status: 'matched'; complication: string } | { status: 'unpredicted' } | { status: 'unresolved' };
}

/** The PRD's literal warning (P-6) — the only control between the typist and PHI. Verbatim. */
const PHI_WARNING = 'Do not type names, MRNs, phone numbers or addresses. Describe the outcome only. This text is stored and is readable by analysis tools.';

const SOURCES = ['complaint', 'readmission', 'revisit', 'reoperation', 'call', 'other'] as const;

const CLASSIFICATION_LABEL: Record<string, string> = {
  predicted_occurred: 'Predicted, and it occurred',
  unpredicted_occurred: 'Occurred — nobody predicted it',
  benefit_failure: 'Benefit failure',
  no_adverse_outcome: 'Followed up — no adverse outcome',
};

/** DISPLAY-ONLY mirror of lib/prognosis-outcomes-core deriveClassification (that module needs Node
 *  crypto, so it stays server-side). The server re-derives authoritatively on every write. */
function derivedView(noAdverse: boolean, benefitFailure: boolean, hash: string | null): string {
  if (noAdverse) return 'no_adverse_outcome';
  if (benefitFailure) return 'benefit_failure';
  return hash != null ? 'predicted_occurred' : 'unpredicted_occurred';
}

export default function OutcomePanel({ documentId, engineVersion, complications, initialRows, unavailable }: {
  documentId: string;
  engineVersion: string;
  complications: ComplicationOption[];
  initialRows: OutcomeRowView[];
  unavailable: boolean;
}) {
  const [rows, setRows] = useState<OutcomeRowView[]>(initialRows);
  const [showHistory, setShowHistory] = useState(false);
  const [open, setOpen] = useState(false);
  // form state
  const [source, setSource] = useState<string>('complaint');
  const [observedOutcome, setObservedOutcome] = useState('');
  const [observedAt, setObservedAt] = useState('');
  const [matchedHash, setMatchedHash] = useState<string>('');   // '' = nobody predicted this
  const [noAdverse, setNoAdverse] = useState(false);
  const [benefitFailure, setBenefitFailure] = useState(false);
  const [reviewedBy, setReviewedBy] = useState('');             // decision 17: never prefilled
  const [notes, setNotes] = useState('');
  const [supersedesId, setSupersedesId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const classification = derivedView(noAdverse, benefitFailure, matchedHash || null);
  const visible = showHistory ? rows : rows.filter((r) => !r.superseded);

  const beginCorrection = (r: OutcomeRowView) => {
    setOpen(true);
    setSupersedesId(r.id);
    setSource(SOURCES.includes(r.source as (typeof SOURCES)[number]) ? r.source : 'other');
    setObservedOutcome(r.observed_outcome);
    setObservedAt(r.observed_at ?? '');
    setNoAdverse(r.classification === 'no_adverse_outcome');
    setBenefitFailure(r.classification === 'benefit_failure');
    const match = r.resolution.status === 'matched'
      ? complications.find((c) => c.name === (r.resolution as { complication: string }).complication) : undefined;
    setMatchedHash(match?.hash ?? '');
    setNotes(r.notes ?? '');
    setReviewedBy('');   // decision 17 — the corrector types their OWN name, every time
    setError(null);
  };

  const resetForm = () => {
    setSupersedesId(null); setSource('complaint'); setObservedOutcome(''); setObservedAt('');
    setMatchedHash(''); setNoAdverse(false); setBenefitFailure(false); setNotes(''); setReviewedBy('');
  };

  const save = async () => {
    if (!observedOutcome.trim()) { setError('Describe the outcome first.'); return; }
    if (!isValidAttribution(reviewedBy)) { setError('Add your name — it is recorded with the outcome.'); return; }
    setBusy(true); setError(null);
    const selected = complications.find((c) => c.hash === matchedHash);
    try {
      const res = await fetch('/api/admin/prognosis-outcome', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceTable: 'ipd_discharge_audits',
          sourceId: documentId,
          sourceEngine: engineVersion,
          source,
          observedOutcome,
          observedAt: observedAt || null,
          matchedComplicationHash: noAdverse ? null : (matchedHash || null),
          matchedComplication: noAdverse ? null : (selected?.index ?? null),
          noAdverseOutcome: noAdverse,
          benefitFailure,
          reviewedByName: reviewedBy.trim(),
          notes: notes.trim() || null,
          ...(supersedesId != null ? { supersedesId } : {}),
        }),
      });
      const json = (await res.json()) as { ok?: boolean; id?: number; classification?: string; error?: string };
      if (!res.ok || !json.ok || typeof json.id !== 'number') { setError(json.error ?? 'Could not save — your text is still here.'); return; }
      const newRow: OutcomeRowView = {
        id: json.id,
        source,
        observed_outcome: observedOutcome.trim(),
        observed_at: observedAt || null,
        classification: json.classification ?? classification,
        reviewed_by_name: reviewedBy.trim(),
        notes: notes.trim() || null,
        superseded: false,
        supersedes_id: supersedesId,
        created_at: new Date().toISOString(),
        resolution: noAdverse || !selected
          ? { status: 'unpredicted' }
          : { status: 'matched', complication: selected.name },
      };
      setRows((prev) => [newRow, ...prev.map((r) => (supersedesId != null && r.id === supersedesId ? { ...r, superseded: true } : r))]);
      resetForm();
      setOpen(false);
    } catch {
      setError('Could not save — your text is still here.');
    } finally {
      setBusy(false);
    }
  };

  const resolutionChip = (r: OutcomeRowView) => {
    if (r.classification === 'no_adverse_outcome') return null;
    if (r.resolution.status === 'matched') {
      return <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">{r.resolution.complication}</span>;
    }
    if (r.resolution.status === 'unresolved') {
      return <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700" title="The prognosis block changed under this outcome — the linked complication no longer appears. Never re-pointed by index.">unresolved</span>;
    }
    return <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">unpredicted</span>;
  };

  return (
    <section className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13.5px] font-semibold text-slate-900">Outcomes against this prognosis</h3>
        <div className="flex items-center gap-3">
          {rows.some((r) => r.superseded) && (
            <button onClick={() => setShowHistory((v) => !v)} className="text-[11.5px] text-slate-500 hover:text-brand">
              {showHistory ? 'Hide superseded history' : 'Show superseded history'}
            </button>
          )}
          {!open && (
            <button onClick={() => { resetForm(); setOpen(true); }} className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white">
              Record outcome
            </button>
          )}
        </div>
      </div>
      <p className="mt-0.5 text-[11.5px] text-slate-400">
        What actually happened to the patient, recorded against what the prognosis pass anticipated. Append-only — corrections supersede, nothing is edited or deleted.
      </p>

      {unavailable && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-1.5 text-[12px] text-amber-800">
          Recorded outcomes are temporarily unavailable (the outcomes table may not be migrated yet). This is not the same as “none recorded”.
        </p>
      )}

      {/* recorded rows — current by default, history on toggle */}
      {!unavailable && visible.length === 0 && (
        <p className="mt-2 text-[12px] text-slate-500">No outcome recorded yet — this document is not followed up.</p>
      )}
      {visible.length > 0 && (
        <ul className="mt-2 space-y-2">
          {visible.map((r) => (
            <li key={r.id} className={`rounded-lg border px-3 py-2 ${r.superseded ? 'border-slate-100 bg-slate-50 opacity-60' : 'border-slate-200'}`}>
              <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <span className="rounded bg-slate-800 px-1.5 py-0.5 font-semibold text-white">{CLASSIFICATION_LABEL[r.classification] ?? r.classification}</span>
                <span className="text-slate-500">via {r.source}</span>
                {r.observed_at && <span className="text-slate-500">observed {r.observed_at}</span>}
                {resolutionChip(r)}
                {r.superseded && <span className="rounded-full border border-slate-300 px-2 py-0.5 text-[10.5px] text-slate-500">superseded</span>}
              </div>
              <div className="mt-1 text-[12.5px] text-slate-800">{r.observed_outcome}</div>
              {r.notes && <div className="mt-0.5 text-[11.5px] text-slate-500">{r.notes}</div>}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
                <span>
                  {/* attestation, not authentication — the shared-token honesty rule (§12.4) */}
                  {r.reviewed_by_name ?? 'Unknown'}{r.created_at ? ` · ${new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''}
                </span>
                {!r.superseded && (
                  <button onClick={() => beginCorrection(r)} className="text-brand hover:underline">Correct this entry</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {open && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-baseline justify-between">
            <h4 className="text-[12.5px] font-semibold text-slate-800">{supersedesId != null ? `Correcting entry #${supersedesId} — this writes a new entry and marks the old one superseded` : 'New outcome'}</h4>
            <button onClick={() => { setOpen(false); resetForm(); }} className="text-[11.5px] text-slate-500 hover:text-brand">Cancel</button>
          </div>

          <label className="mt-2 block text-[12px] font-semibold text-slate-800">
            Source
            <select value={source} onChange={(e) => setSource(e.target.value)} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-[13px] font-normal">
              {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          {/* P-6 — the literal warning, directly above the free-text field. It is the only control. */}
          <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11.5px] font-medium text-amber-900">
            {PHI_WARNING}
          </p>
          <label className="block text-[12px] font-semibold text-slate-800">
            Observed outcome
            <textarea value={observedOutcome} onChange={(e) => setObservedOutcome(e.target.value)} rows={3}
              placeholder="What happened, when, and how it was established"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] font-normal" />
          </label>

          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <label className="block text-[12px] font-semibold text-slate-800">
              Observed date
              <input type="date" value={observedAt} onChange={(e) => setObservedAt(e.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-[13px] font-normal" />
            </label>
            <label className={`block text-[12px] font-semibold ${noAdverse ? 'text-slate-400' : 'text-slate-800'}`}>
              Matched complication
              <select value={matchedHash} onChange={(e) => setMatchedHash(e.target.value)} disabled={noAdverse}
                className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-[13px] font-normal disabled:bg-slate-100 disabled:text-slate-400">
                <option value="">Nobody predicted this</option>
                {complications.map((c) => <option key={c.hash} value={c.hash}>{c.name}</option>)}
              </select>
            </label>
          </div>

          <div className="mt-2 flex flex-wrap gap-4 text-[12px] text-slate-800">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={noAdverse} onChange={(e) => setNoAdverse(e.target.checked)} />
              Followed up — nothing happened
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={benefitFailure} onChange={(e) => setBenefitFailure(e.target.checked)} disabled={noAdverse} />
              This is a benefit failure
            </label>
          </div>

          {/* §5.3 — classification is DERIVED and shown, never typed. The server re-derives it. */}
          <div className="mt-2 text-[12px] text-slate-600">
            Classification: <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] font-semibold text-white">{CLASSIFICATION_LABEL[classification]}</span>
            <span className="ml-1.5 text-[11px] text-slate-400">derived from the fields above</span>
          </div>

          <label className="mt-2 block text-[12px] font-semibold text-slate-800">
            Notes <span className="font-normal text-slate-400">(optional — the warning above applies here too)</span>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] font-normal" />
          </label>

          <label className="mt-2 block">
            <span className="text-[12px] font-semibold text-slate-800">{ATTRIBUTION_LABEL}</span>
            <input value={reviewedBy} onChange={(e) => setReviewedBy(e.target.value)} placeholder="Dr Binita Priyambada"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-1.5 text-[13px]" />
            <span className="text-[11px] text-slate-400">{ATTRIBUTION_HELP}</span>
          </label>

          {error && <p className="mt-2 rounded-lg bg-red-50 px-3 py-1.5 text-[12.5px] text-red-700">{error}</p>}

          <div className="mt-2">
            <button onClick={save} disabled={busy}
              className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400">
              {busy ? 'Saving…' : supersedesId != null ? 'Save correction' : 'Save outcome'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
