// app/admin/ipd-audit/[id]/med-rec-panel.tsx — MemberState admission adapter (#5) SL3.
//
// The "Medication reconciliation (admission)" panel — the read-time med-rec VIEW rendered on the IPD
// audit report, behind MEMBERSTATE_ADMISSION_ADAPTER (the page computes it only when the flag is on).
// ADVISORY + human-reviewed: a reconciliation VIEW for the reviewer, never an auto-action, never a
// clinical assertion.
//
// TWO BRANCHES (honest reach — the reconciliation only has a baseline for the OPD-linked ~half):
//   reconciliation → continued / newly-started / stopped / changed / GAP vs the OPD baseline, with
//                    provenance link-back on BOTH sides.
//   admission_only → NO baseline. The admission medication list + an explicit banner. Zero gap/stop
//                    rows are NEVER shown as a clean reconciliation — the missing baseline is visible.
//
// MED-REC ONLY: no problem-continuity / allergy panel (Gate D scope; v1.1). Palette is teal/slate —
// never the scored A–E band ramp (a reconciliation is not a verdict).
import type { MedRecView, MedRecStatus, MedRecSide } from '@/lib/member-state-adapters/med-rec-view';

const STATUS_LABEL: Record<MedRecStatus, string> = {
  reconciliation_gap: 'Reconciliation gap',
  dose_or_frequency_changed: 'Dose / frequency changed',
  newly_started: 'Newly started',
  continued: 'Continued',
  stopped: 'Stopped',
};

// gap = rose (the actionable signal); changed = amber; started = teal; continued = slate; stopped = neutral.
const STATUS_CLS: Record<MedRecStatus, string> = {
  reconciliation_gap: 'border-rose-200 bg-rose-50 text-rose-700',
  dose_or_frequency_changed: 'border-amber-200 bg-amber-50 text-amber-700',
  newly_started: 'border-teal-200 bg-teal-50 text-teal-700',
  continued: 'border-slate-200 bg-slate-50 text-slate-600',
  stopped: 'border-slate-200 bg-slate-100 text-slate-500',
};

const provTitle = (s: MedRecSide) =>
  `${s.encounterRef} · ${s.date || 'undated'} · ${s.sourceField} · ${s.extractionMethod} · confidence ${s.confidence}`;

const doseFreq = (s: MedRecSide) => [s.dose, s.frequency].filter(Boolean).join(' · ');

/** One side of a reconciliation row — the provenance link-back. A null side (no occurrence on that
 *  side) is rendered as an explicit em-dash, never blank. */
function Side({ label, side }: { label: string; side: MedRecSide | null }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="text-[9.5px] font-semibold uppercase tracking-[0.06em] text-slate-400">{label}</div>
      {side ? (
        <div title={provTitle(side)} className="cursor-default truncate text-[11.5px] text-slate-700">
          <span className="text-slate-400">{side.date || 'undated'}</span>
          {doseFreq(side) && <span className="ml-1.5 text-slate-500">{doseFreq(side)}</span>}
          <span className="ml-1.5 text-[10px] text-slate-400">↳ {side.sourceField}</span>
        </div>
      ) : (
        <div className="text-[11.5px] text-slate-300">—</div>
      )}
    </div>
  );
}

function ReconRow({ drug, status, opd, adm }: { drug: string; status: MedRecStatus; opd: MedRecSide | null; adm: MedRecSide | null }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-slate-100 px-3 py-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-2 sm:w-[38%]">
        <span className={`whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLS[status]}`}>{STATUS_LABEL[status]}</span>
        <span className="truncate text-[13px] font-medium text-slate-800">{drug}</span>
      </div>
      <div className="flex flex-1 items-start gap-3">
        <Side label="OPD baseline" side={opd} />
        <span className="mt-3 text-slate-300">→</span>
        <Side label="At discharge" side={adm} />
      </div>
    </div>
  );
}

function Counts({ view }: { view: MedRecView }) {
  const order: MedRecStatus[] = ['reconciliation_gap', 'dose_or_frequency_changed', 'newly_started', 'continued', 'stopped'];
  const shown = order.filter((s) => view.counts[s] > 0);
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((s) => (
        <span key={s} className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLS[s]}`}>{view.counts[s]} {STATUS_LABEL[s].toLowerCase()}</span>
      ))}
    </div>
  );
}

const HEADER = (
  <>
    <span className="text-[13px] font-semibold text-slate-800">Medication reconciliation (admission)</span>
    <span className="rounded-full border border-teal-200 bg-teal-50 px-1.5 py-[1px] text-[10px] font-medium text-teal-700">advisory · reviewer view</span>
  </>
);

/** The panel. `view` is the read-time-composed med-rec view (behind the flag). */
export default function MedRecPanel({ view }: { view: MedRecView }) {
  if (view.mode === 'admission_only') {
    return (
      <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">{HEADER}</div>
        <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800">
          {view.linked
            ? 'No prior OPD medications at Even before this admission — this is the admission medication list, not a reconciliation. No baseline to compare against.'
            : 'No prior OPD footprint at Even — this is the admission medication list, not a reconciliation. No baseline to compare against.'}
        </div>
        {view.admissionMedications.length ? (
          <div className="mt-2 rounded-xl border border-slate-100">
            {view.admissionMedications.map((m, i) => (
              <div key={i} className="flex items-center gap-2 border-t border-slate-100 px-3 py-1.5 first:border-t-0">
                <span className="text-[13px] font-medium text-slate-800">{m.drug}</span>
                <span title={provTitle(m.occurrence)} className="cursor-default text-[10px] text-slate-400">↳ {m.occurrence.sourceField}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-[12px] italic text-slate-400">No discharge medications documented.</div>
        )}
        <p className="mt-2 text-[10.5px] text-slate-400">Reviewer view · not a clinical assertion · {view.admissionRef}</p>
      </div>
    );
  }

  return (
    <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">{HEADER}</div>
        <Counts view={view} />
      </div>
      <p className="mt-0.5 text-[11px] text-slate-400">
        Admission / discharge medications reconciled against the prior-OPD baseline. A <span className="font-medium text-rose-600">gap</span> is an OPD baseline drug absent at discharge with no documented stop — hover either side for provenance.
      </p>
      <p className="mt-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[10.5px] text-slate-500">
        Matched on documented medication text: discharge meds are recorded as free-text lines (drug + dose + schedule), so the same drug in a different format can appear as a <span className="text-rose-600">gap</span> + <span className="text-teal-600">newly-started</span> pair. Concept normalization + V-ratification of these gaps is SL4 — review each before acting.
      </p>
      <div className="mt-2 overflow-hidden rounded-xl border border-slate-100">
        {view.rows.length ? (
          view.rows.map((r, i) => <ReconRow key={i} drug={r.drug} status={r.status} opd={r.opdBaseline} adm={r.admission} />)
        ) : (
          <div className="px-3 py-2 text-[12px] italic text-slate-400">No medications on either side to reconcile.</div>
        )}
      </div>
      <p className="mt-2 text-[10.5px] text-slate-400">Reviewer view · human-adjudicated, never an auto-action · composed read-time from the OPD baseline + this admission · {view.admissionRef}</p>
    </div>
  );
}
