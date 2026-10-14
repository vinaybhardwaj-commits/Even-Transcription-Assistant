'use client';

// components/ClinicalStatePanel.tsx — the clinician-facing ClinicalState panel, moved
// VERBATIM out of app/ddx/ddx-client.tsx (Build 1c) so the Right Care client renders the
// SAME view instead of authoring a second one (Right Care × ClinicalState PRD, Part B).
// Pure consumer of the additive `clinicalState` response field (present only when
// CLINICAL_STATE_UI=1 server-side) — renders beside the mode's output, never replaces it.

import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react';
import type { ClinicalStateUiView } from '@/lib/clinical-state/ui-view';

export const FLAG_STYLE: Record<string, string> = {
  critical: 'bg-rose-100 text-rose-800',
  high: 'bg-amber-100 text-amber-900',
  low: 'bg-blue-100 text-blue-800',
  abnormal: 'bg-amber-100 text-amber-900',
  indeterminate: 'bg-slate-100 text-slate-600',
  normal: 'bg-emerald-100 text-emerald-800',
};
export const FLAG_LABEL: Record<string, string> = {
  critical: 'critical', high: 'high', low: 'low', abnormal: 'abnormal', indeterminate: '?', normal: 'normal',
};

function CsFinding({ f, status }: { f: ClinicalStateUiView['positives'][number]; status: 'present' | 'absent' | 'unknown' }) {
  const styles = {
    present: 'border-brand/30 bg-brand-faint text-brand-dark',
    absent: 'border-rose-200 bg-rose-50 text-rose-600',
    unknown: 'border-slate-200 bg-slate-100 text-slate-500',
  }[status];
  const p = f.provenance;
  const temp = f.temporality?.duration || f.temporality?.onset;
  const hasTip = status !== 'unknown' && !!p?.rawText;
  return (
    <span className={`group relative mb-1.5 mr-1.5 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12.5px] ${styles} ${hasTip ? 'cursor-help' : ''}`}>
      <span className={status === 'absent' ? 'line-through decoration-rose-300' : ''}>{f.concept}</span>
      {temp && <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10.5px] text-indigo-700">{temp}</span>}
      {status !== 'unknown' && p?.sourceField && <span className="text-[10px] opacity-60">{p.sourceField}</span>}
      {hasTip && (
        <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-52 rounded-lg bg-slate-900 px-2.5 py-2 text-left text-[11px] font-normal normal-case leading-snug text-slate-100 group-hover:block">
          <b className="text-brand-light">rawText:</b> &ldquo;{p.rawText}&rdquo;<br />
          <b className="text-brand-light">source:</b> {p.sourceField} · conf {p.confidence?.toFixed(2)} · {p.extractionMethod}
        </span>
      )}
    </span>
  );
}

function CsGroup({ label, dot, items, status }: { label: string; dot: string; items: ClinicalStateUiView['positives']; status: 'present' | 'absent' | 'unknown' }) {
  const labCls = { present: 'text-brand-dark', absent: 'text-rose-700', unknown: 'text-slate-400' }[status];
  return (
    <div className="mb-3">
      <div className={`mb-1.5 flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-wide ${labCls}`}>
        <span className={`h-2 w-2 rounded-full ${dot}`} /> {label}
      </div>
      <div>{items.map((f) => <CsFinding key={f.id} f={f} status={status} />)}</div>
    </div>
  );
}

export default function ClinicalStatePanel({ state }: { state: ClinicalStateUiView }) {
  const d = state.demographics;
  const demo = [d.age != null ? `${d.age}` : null, d.sex ?? d.sexRaw ?? null].filter(Boolean).join(' / ') + (d.ageBand ? ` · band ${d.ageBand}` : '');
  const inst = state.instability;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2.5 border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-semibold text-slate-800">Clinical State</span>
        {demo.trim() && <span className="text-[12px] text-slate-500">{demo}</span>}
        <span className="ml-auto rounded-full bg-brand-faint px-2.5 py-0.5 text-[11px] font-semibold text-brand-dark">reasoning substrate</span>
      </div>
      {inst.assessment === 'unstable' && (
        <div className="flex flex-wrap items-center gap-2 bg-rose-50 px-4 py-2 text-[12.5px] font-semibold text-rose-700">
          <AlertTriangle className="h-4 w-4 shrink-0" /> Potential instability detected
          <span className="font-medium text-rose-500">{inst.reasons.join(' · ')}</span>
        </div>
      )}
      {inst.assessment === 'no_instability_detected' && (
        <div className="flex flex-wrap items-center gap-2 bg-emerald-50 px-4 py-2 text-[12.5px] font-medium text-emerald-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" /> <span className="font-semibold">No instability criteria detected in supplied data</span>
          {inst.assessedInputs.length > 0 && (
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">assessed: {inst.assessedInputs.join(' · ')}</span>
          )}
        </div>
      )}
      {inst.assessment === 'not_assessable' && (
        <div className="flex flex-wrap items-center gap-2 bg-amber-50 px-4 py-2 text-[12.5px] font-medium text-amber-700">
          <HelpCircle className="h-4 w-4 shrink-0" /> <span className="font-semibold">Instability not assessable from supplied data</span>
          {inst.missingInputs.length > 0 && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">missing: {inst.missingInputs.join(' · ')}</span>
          )}
        </div>
      )}
      <div className="px-4 py-3">
        {state.positives.length > 0 && <CsGroup label="Present" dot="bg-brand" items={state.positives} status="present" />}
        {state.negatives.length > 0 && <CsGroup label="Explicitly absent in the supplied record" dot="bg-rose-500" items={state.negatives} status="absent" />}
        {state.unknowns.length > 0 && <CsGroup label="Not assessed" dot="bg-slate-400" items={state.unknowns} status="unknown" />}
        {state.investigations.length > 0 && (
          <div className="mt-1">
            <div className="mb-1.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">Investigations</div>
            <table className="w-full text-[12px]">
              <tbody>
                {state.investigations.map((iv, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0">
                    <td className="py-1.5 pr-2 font-medium text-slate-700">{iv.test}</td>
                    <td className="py-1.5 pr-2 text-slate-600">{iv.value}{iv.unit ? ` ${iv.unit}` : ''}</td>
                    <td className="py-1.5">{iv.flag && iv.flag !== 'normal' && iv.flag !== 'indeterminate' && (
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${FLAG_STYLE[iv.flag] ?? FLAG_STYLE.abnormal}`}>{(FLAG_LABEL[iv.flag] ?? iv.flag).toUpperCase()}</span>
                    )}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1 text-[11.5px] font-semibold text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" /> All extracted findings are source-linked · {state.rejectedSpans} unverified spans
        </div>
      </div>
    </div>
  );
}
