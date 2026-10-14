'use client';

import Link from 'next/link';
import { Stethoscope } from 'lucide-react';
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult, FormField } from '@/lib/calculators/types';
import { computeWellsPe, type WellsPeInputs } from '@/lib/calculators/math/wells_pe';

const FIELDS: FormField[] = [
  { key: 'dvt_signs', label: 'Clinical signs / symptoms of DVT', type: 'bool', required: true,
    subtitle: 'Objective unilateral leg swelling AND tenderness on palpation along the deep veins.',
    options: [
      { value: true,  label: 'Yes', points: 3 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Objective findings of DVT — unilateral leg swelling AND tenderness on palpation along the deep veins. +3 points.' },
  { key: 'pe_most_likely_dx', label: 'PE is the most likely diagnosis (or equally likely)', type: 'bool', required: true,
    subtitle: 'After basic workup (history, exam, CXR, ECG, basic labs) PE remains the leading or tied-leading differential.',
    options: [
      { value: true,  label: 'Yes', points: 3 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'After history, exam, CXR, ECG, basic labs — PE remains the leading or tied-leading differential. +3 points.' },
  { key: 'hr_gt_100', label: 'Heart rate > 100 bpm', type: 'bool', required: true,
    subtitle: 'Resting HR > 100 bpm at presentation.',
    options: [
      { value: true,  label: 'Yes', points: 1.5 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Resting HR > 100 bpm at presentation. +1.5 points.' },
  { key: 'immob_or_surgery', label: 'Immobilization ≥ 3 d OR surgery within prior 4 weeks', type: 'bool', required: true,
    subtitle: 'Bedrest (apart from bathroom) ≥ 3 days OR surgery requiring GA/regional anaesthesia in the last 4 weeks.',
    options: [
      { value: true,  label: 'Yes', points: 1.5 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Bedrest (apart from bathroom) ≥3 days OR surgery requiring GA/regional anaesthesia in the last 4 weeks. +1.5 points.' },
  { key: 'prior_dvt_or_pe', label: 'Previous DVT or PE', type: 'bool', required: true,
    subtitle: 'Objectively-diagnosed prior VTE (any site).',
    options: [
      { value: true,  label: 'Yes', points: 1.5 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Objectively-diagnosed prior VTE. +1.5 points.' },
  { key: 'hemoptysis', label: 'Hemoptysis', type: 'bool', required: true,
    subtitle: 'Any blood in the sputum during the current episode.',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Any blood in the sputum during the current episode. +1 point.' },
  { key: 'malignancy', label: 'Malignancy', type: 'bool', required: true,
    subtitle: 'Active malignancy currently treated, treated in past 6 months, or palliative only.',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Active malignancy currently treated, treated in past 6 months, or palliative care only. +1 point.' },
];

const CFG: CalculatorConfig = {
  name: 'wells_pe',
  displayTitle: 'Wells score — PE',
  moduleHome: 'ask',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/wells_pe',
  resultSections: ['interpretation'],
  typicalLatencySec: 2,
  fields: FIELDS,
};

type Det = {
  score: number;
  three_tier: string; three_tier_label: string;
  two_tier: string; two_tier_label: string;
};

const THREE_COLOR: Record<string, string> = {
  low: 'bg-emerald-100 text-emerald-700',
  moderate: 'bg-yellow-100 text-yellow-800',
  high: 'bg-red-200 text-red-800',
};
const TWO_COLOR: Record<string, string> = {
  unlikely: 'bg-emerald-100 text-emerald-700',
  likely: 'bg-red-200 text-red-800',
};

const PE_KEYS: Array<keyof WellsPeInputs> = [
  'dvt_signs', 'pe_most_likely_dx', 'hr_gt_100',
  'immob_or_surgery', 'prior_dvt_or_pe', 'hemoptysis', 'malignancy',
];

function Result({ result }: { result: CalculatorResult & { deterministic: Det } }) {
  const d = result.deterministic;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-5xl font-bold tracking-tight text-slate-900">{d.score}</span>
          <span className="text-sm text-slate-500">Wells PE</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border border-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Three-tier</div>
            <span className={`mt-1 inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${THREE_COLOR[d.three_tier] ?? ''}`}>{d.three_tier_label}</span>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Two-tier (bedside)</div>
            <span className={`mt-1 inline-flex rounded-md px-2 py-0.5 text-xs font-semibold ${TWO_COLOR[d.two_tier] ?? ''}`}>{d.two_tier_label}</span>
          </div>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Clinical interpretation</h2>
        </div>
        <div className="text-sm leading-relaxed text-slate-700">{d.three_tier_label}. {d.two_tier_label}.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/ask?q=${encodeURIComponent('My Wells PE is ' + d.score + ' (' + d.three_tier_label + ', two-tier ' + d.two_tier_label + '). What is the optimal next test and when do I anticoagulate empirically?')}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
          Ask deeper about this score
        </Link>
      </div>
      <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code></div>
    </div>
  );
}

export default function WellsPeCalculator() {
  return (
    <CalculatorShell<Det>
      config={CFG}
      renderResult={Result}
      liveScore={(v) => {
        const complete = PE_KEYS.every((k) => typeof v[k] === 'boolean');
        const inputs = Object.fromEntries(PE_KEYS.map((k) => [k, v[k] === true])) as unknown as WellsPeInputs;
        try {
          const r = computeWellsPe(inputs);
          // Max possible = 3 + 3 + 1.5 + 1.5 + 1.5 + 1 + 1 = 12.5.
          return { score: r.score, max: 12.5, band: r.three_tier, band_label: r.three_tier_label, complete };
        } catch { return null; }
      }}
    />
  );
}
