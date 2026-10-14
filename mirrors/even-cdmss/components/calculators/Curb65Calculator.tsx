'use client';

import Link from 'next/link';
import { Stethoscope } from "lucide-react";
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult, FormField } from '@/lib/calculators/types';
import { computeCurb65, type Curb65Inputs } from '@/lib/calculators/math/curb65';

const FIELDS: FormField[] = [
  { key: 'confusion', label: 'Confusion', type: 'bool', required: true,
    subtitle: 'New disorientation to person/place/time OR Abbreviated Mental Test Score ≤ 8 (not chronic baseline cognitive impairment).',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'New disorientation to person/place/time, or Abbreviated Mental Test Score ≤8 — not chronic baseline cognitive impairment.' },
  { key: 'urea_high', label: 'Urea high', type: 'bool', required: true,
    subtitle: 'Serum urea > 7 mmol/L (BUN > 19 mg/dL).',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Serum urea greater than 7 mmol/L, equivalent to BUN > 19 mg/dL.' },
  { key: 'rr_ge_30', label: 'Respiratory rate ≥ 30', type: 'bool', required: true,
    subtitle: 'Respiratory rate at presentation ≥ 30 breaths/min — count for a full 60 s when abnormal.',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Respiratory rate at presentation ≥30 breaths/min — count for a full 60 s when abnormal.' },
  { key: 'bp_low', label: 'Hypotension', type: 'bool', required: true,
    subtitle: 'Either SBP < 90 mmHg OR DBP ≤ 60 mmHg satisfies the criterion.',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Either systolic <90 mmHg OR diastolic ≤60 mmHg satisfies the criterion.' },
  { key: 'age_ge_65', label: 'Age ≥ 65', type: 'bool', required: true,
    subtitle: 'Patient age 65 or above at presentation.',
    options: [
      { value: true,  label: 'Yes', points: 1 },
      { value: false, label: 'No',  points: 0 },
    ],
    staticTooltip: 'Patient age 65 or above at presentation.' },
];

const CFG: CalculatorConfig = {
  name: 'curb65',
  displayTitle: 'CURB-65 — Pneumonia severity',
  moduleHome: 'ask',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/curb65',
  resultSections: ['interpretation'],
  typicalLatencySec: 2,
  fields: FIELDS,
};

type Det = {
  score: number; band: string; band_label: string;
  element_points: { confusion: number; urea: number; rr: number; bp: number; age: number };
};

const BAND_COLOR: Record<string, string> = {
  outpatient: 'bg-emerald-100 text-emerald-700',
  short_inpatient: 'bg-yellow-100 text-yellow-800',
  hospitalize_consider_icu: 'bg-red-200 text-red-800',
};

function Result({ result }: { result: CalculatorResult & { deterministic: Det } }) {
  const d = result.deterministic;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-5xl font-bold tracking-tight text-slate-900">{d.score}</span>
          <span className="text-sm text-slate-500">/ 5 CURB-65</span>
          <span className={`ml-auto inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${BAND_COLOR[d.band] ?? ''}`}>{d.band_label}</span>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Clinical interpretation</h2>
        </div>
        <div className="text-sm leading-relaxed text-slate-700">{d.band_label}.</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/ask?q=${encodeURIComponent('My CURB-65 is ' + d.score + ' (' + d.band_label + '). What antibiotic regimen and disposition fits an Indian tertiary setting?')}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
          Ask deeper about this score
        </Link>
      </div>
      <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code></div>
    </div>
  );
}

export default function Curb65Calculator() {
  return (
    <CalculatorShell<Det>
      config={CFG}
      renderResult={Result}
      liveScore={(v) => {
        const required = ['confusion', 'urea_high', 'rr_ge_30', 'bp_low', 'age_ge_65'] as const;
        const complete = required.every((k) => typeof v[k] === 'boolean');
        const inputs: Curb65Inputs = {
          confusion: v.confusion === true,
          urea_high: v.urea_high === true,
          rr_ge_30:  v.rr_ge_30  === true,
          bp_low:    v.bp_low    === true,
          age_ge_65: v.age_ge_65 === true,
        };
        try {
          const r = computeCurb65(inputs);
          return { score: r.score, max: 5, band: r.band, band_label: r.band_label, complete };
        } catch { return null; }
      }}
    />
  );
}

