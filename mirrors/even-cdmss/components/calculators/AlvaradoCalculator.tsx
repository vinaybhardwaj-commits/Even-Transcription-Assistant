'use client';

import Link from 'next/link';
import { Stethoscope } from 'lucide-react';
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult, FormField } from '@/lib/calculators/types';
import { computeAlvarado, type AlvaradoInputs } from '@/lib/calculators/math/alvarado';

const YN = (pts: number) => [
  { value: true,  label: 'Yes', points: pts },
  { value: false, label: 'No',  points: 0 },
];

const FIELDS: FormField[] = [
  { key: 'migration_rlq', label: 'M: Migration of pain to RLQ', type: 'bool', required: true,
    subtitle: 'Periumbilical or epigastric pain that has migrated to the right lower quadrant.',
    options: YN(1),
    staticTooltip: 'Periumbilical or epigastric pain that has migrated to the right lower quadrant.' },
  { key: 'anorexia', label: 'A: Anorexia', type: 'bool', required: true,
    subtitle: 'Loss of appetite during the current illness.',
    options: YN(1),
    staticTooltip: 'Loss of appetite during the current illness.' },
  { key: 'nausea_vomiting', label: 'N: Nausea or vomiting', type: 'bool', required: true,
    subtitle: 'Either nausea or vomiting (or both) during the current episode.',
    options: YN(1),
    staticTooltip: 'Either nausea or vomiting (or both) during the current episode.' },
  { key: 'tenderness_rlq', label: 'T: Tenderness in RLQ', type: 'bool', required: true,
    subtitle: 'Direct palpable tenderness in the right lower quadrant on examination — worth 2 points.',
    options: YN(2),
    staticTooltip: 'Direct palpable tenderness in the right lower quadrant on examination — worth 2 points.' },
  { key: 'rebound_pain', label: 'R: Rebound pain', type: 'bool', required: true,
    subtitle: 'Pain on release of pressure over the RLQ (rebound tenderness).',
    options: YN(1),
    staticTooltip: 'Pain on release of pressure over the RLQ (rebound tenderness).' },
  { key: 'elevated_temp', label: 'E: Elevated temperature ≥ 37.3 °C', type: 'bool', required: true,
    subtitle: 'Measured temperature ≥ 37.3 °C / 99.1 °F.',
    options: YN(1),
    staticTooltip: 'Measured temperature ≥ 37.3 °C / 99.1 °F.' },
  { key: 'leukocytosis', label: 'L: Leukocytosis WBC > 10,000/µL', type: 'bool', required: true,
    subtitle: 'WBC count above 10,000/µL on CBC — worth 2 points.',
    options: YN(2),
    staticTooltip: 'WBC count above 10,000 /µL on CBC — worth 2 points.' },
  { key: 'shift_to_left', label: 'S: Shift to left (neutrophilia > 75%)', type: 'bool', required: true,
    subtitle: 'Neutrophil predominance > 75% on the differential.',
    options: YN(1),
    staticTooltip: 'Neutrophil predominance > 75% on the differential.' },
];

const CFG: CalculatorConfig = {
  name: 'alvarado',
  displayTitle: 'Alvarado (MANTRELS) — appendicitis',
  moduleHome: 'ask',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/alvarado',
  resultSections: ['interpretation'],
  typicalLatencySec: 2,
  fields: FIELDS,
};

type Det = {
  score: number; band: string; band_label: string;
  element_points: Record<string, number>;
};

const BAND_COLOR: Record<string, string> = {
  unlikely:    'bg-emerald-100 text-emerald-700',
  compatible:  'bg-yellow-100 text-yellow-800',
  probable:    'bg-orange-200 text-orange-800',
  very_likely: 'bg-red-200 text-red-800',
};

const ELEMENT_LABEL: Record<string, string> = {
  migration_rlq: 'M', anorexia: 'A', nausea_vomiting: 'N', tenderness_rlq: 'T',
  rebound_pain: 'R', elevated_temp: 'E', leukocytosis: 'L', shift_to_left: 'S',
};

const ALV_KEYS: Array<keyof AlvaradoInputs> = [
  'migration_rlq', 'anorexia', 'nausea_vomiting', 'tenderness_rlq',
  'rebound_pain', 'elevated_temp', 'leukocytosis', 'shift_to_left',
];

function Result({ result }: { result: CalculatorResult & { deterministic: Det } }) {
  const d = result.deterministic;
  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-5xl font-bold tracking-tight text-slate-900">{d.score}</span>
          <span className="text-sm text-slate-500">/ 10 Alvarado</span>
          <span className={`ml-auto inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${BAND_COLOR[d.band] ?? ''}`}>{d.band_label}</span>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 text-sm font-semibold text-slate-900">MANTRELS contributions</div>
        <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
          {Object.entries(d.element_points).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-md border border-slate-200 px-2 py-1.5 text-xs">
              <span className="text-slate-500">{ELEMENT_LABEL[k] ?? k}</span>
              <span className={`font-semibold ${v === 0 ? 'text-slate-400' : v === 2 ? 'text-orange-600' : 'text-amber-700'}`}>+{v}</span>
            </div>
          ))}
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
        <Link href={`/ask?q=${encodeURIComponent('My Alvarado score is ' + d.score + ' (' + d.band_label + '). Should I image first, observe, or proceed to surgery?')}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand">
          Ask deeper about this score
        </Link>
      </div>
      <div className="text-xs text-slate-400">Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code></div>
    </div>
  );
}

export default function AlvaradoCalculator() {
  return (
    <CalculatorShell<Det>
      config={CFG}
      renderResult={Result}
      liveScore={(v) => {
        const complete = ALV_KEYS.every((k) => typeof v[k] === 'boolean');
        const inputs = Object.fromEntries(ALV_KEYS.map((k) => [k, v[k] === true])) as unknown as AlvaradoInputs;
        try {
          const r = computeAlvarado(inputs);
          return { score: r.score, max: 10, band: r.band, band_label: r.band_label, complete };
        } catch { return null; }
      }}
    />
  );
}
