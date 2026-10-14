'use client';

import Link from 'next/link';
import { Activity, AlertTriangle, GraduationCap, Stethoscope } from 'lucide-react';
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult } from '@/lib/calculators/types';
import { computeNews2, type News2Inputs, type Consciousness, type Spo2Scale } from '@/lib/calculators/math/news2';

const NEWS2_CONFIG: CalculatorConfig = {
  name: 'news2',
  displayTitle: 'NEWS2 — National Early Warning Score',
  moduleHome: 'ask',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/news2',
  resultSections: ['interpretation'],
  typicalLatencySec: 2,
  fields: [
    { key: 'rr', label: 'Respiratory rate', type: 'integer', unit: 'breaths/min', required: true, hardMin: 5, hardMax: 60, softMin: 8, softMax: 40,
      subtitle: 'Count for a full 60 s when abnormal. Score breaks: ≤ 8, 9-11, 12-20, 21-24, ≥ 25.',
      staticTooltip: 'Counted over a full 60 s when abnormal. Score breaks: ≤8, 9-11, 12-20, 21-24, ≥25.' },
    { key: 'spo2_scale', label: 'SpO2 scale', type: 'enum', required: true, defaultValue: '1',
      subtitle: 'Use Scale 2 only for patients with target sats 88-92% (known Type 2 respiratory failure / chronic CO₂ retainers). Otherwise Scale 1.',
      options: [
        { value: '1', label: 'Scale 1 (standard)', description: 'Default for most patients' },
        { value: '2', label: 'Scale 2 (target 88-92% / chronic CO₂ retainer)', description: 'Known Type 2 respiratory failure, COPD on home O₂' },
      ],
      staticTooltip: 'Scale 2 is for patients with target saturations 88-92 % — typically known Type 2 respiratory failure / chronic CO2 retainers on home oxygen. Otherwise Scale 1.' },
    { key: 'spo2', label: 'SpO2', type: 'integer', unit: '%', required: true, hardMin: 50, hardMax: 100, softMin: 80,
      subtitle: 'Pulse oximetry on room air or current supplemental O₂. Scale 1 breaks: ≤ 91, 92-93, 94-95, ≥ 96.',
      staticTooltip: 'Pulse oximetry on room air or current supplemental O2. Scale 1 breaks: ≤91, 92-93, 94-95, ≥96.' },
    { key: 'o2_supp', label: 'On supplemental O2', type: 'bool', required: true, defaultValue: false,
      subtitle: 'Any form of supplemental O₂ at the time of vitals. Adds 2 points and changes Scale 2 SpO2 scoring above the target window.',
      options: [
        { value: true,  label: 'Yes', points: 2 },
        { value: false, label: 'No',  points: 0 },
      ],
      staticTooltip: 'Any form of supplemental O2 at the time of vitals. Adds 2 points. Also affects Scale 2 SpO2 scoring above the target window.' },
    { key: 'temp_c', label: 'Temperature', type: 'number', unit: '°C', required: true, hardMin: 30, hardMax: 43, softMin: 34, softMax: 41,
      subtitle: 'Tympanic, oral, or axillary. Breaks: ≤ 35.0, 35.1-36.0, 36.1-38.0, 38.1-39.0, ≥ 39.1.',
      staticTooltip: 'Tympanic, oral, or axillary. Breaks: ≤35.0, 35.1-36.0, 36.1-38.0, 38.1-39.0, ≥39.1.' },
    { key: 'sbp', label: 'Systolic BP', type: 'integer', unit: 'mmHg', required: true, hardMin: 40, hardMax: 280, softMin: 70, softMax: 220,
      subtitle: 'Breaks: ≤ 90, 91-100, 101-110, 111-219, ≥ 220. Note the symmetric high-end penalty.',
      staticTooltip: 'Breaks: ≤90, 91-100, 101-110, 111-219, ≥220. Note the symmetric high-end penalty.' },
    { key: 'hr', label: 'Heart rate', type: 'integer', unit: 'bpm', required: true, hardMin: 20, hardMax: 250, softMin: 30, softMax: 200,
      subtitle: 'Breaks: ≤ 40, 41-50, 51-90, 91-110, 111-130, ≥ 131.',
      staticTooltip: 'Breaks: ≤40, 41-50, 51-90, 91-110, 111-130, ≥131.' },
    { key: 'consciousness', label: 'Consciousness', type: 'enum', required: true, defaultValue: 'A',
      subtitle: 'AVPU + new-onset Confusion (NEWS2 2017 addition). Anything other than Alert scores 3.',
      options: [
        { value: 'A', label: 'A — Alert',                        points: 0 },
        { value: 'V', label: 'V — responsive to Voice',           points: 3 },
        { value: 'P', label: 'P — responsive to Pain only',       points: 3 },
        { value: 'U', label: 'U — Unresponsive',                  points: 3 },
        { value: 'C', label: 'C — new-onset Confusion',           points: 3, description: 'NEWS2 2017 addition' },
      ],
      staticTooltip: 'AVPU + new-onset Confusion (C, NEWS2 2017 addition). Anything other than Alert scores 3.' },
  ],
};

type News2Deterministic = {
  score: number;
  band: 'low' | 'low-medium' | 'medium' | 'high';
  element_points: Record<string, number>;
  any_single_three: boolean;
};

const BAND_COLOR: Record<string, string> = {
  'low':         'bg-emerald-100 text-emerald-700',
  'low-medium':  'bg-yellow-100 text-yellow-800',
  'medium':      'bg-orange-100 text-orange-700',
  'high':        'bg-red-200 text-red-800',
};

const ELEMENT_LABEL: Record<string, string> = {
  rr: 'RR', spo2: 'SpO2', o2_supp: 'O2 supp', temp: 'Temp', sbp: 'SBP', hr: 'HR', consciousness: 'AVPU',
};

function News2Result({ result }: { result: CalculatorResult & { deterministic: News2Deterministic } }) {
  const d = result.deterministic;
  const interp = result.sections.find((s) => s.section === 'interpretation')?.text ?? '';
  const banner = result.banner as { tone: string; text: string; cta?: { label: string; href: string } } | null | undefined;

  return (
    <div className="space-y-5">
      {/* Headline */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-5xl font-bold tracking-tight text-slate-900">{d.score}</span>
          <span className="text-sm text-slate-500">NEWS2</span>
          <span className={`ml-auto inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${BAND_COLOR[d.band]}`}>
            {d.band === 'low' ? 'Low risk' : d.band === 'low-medium' ? 'Low-medium' : d.band === 'medium' ? 'Medium' : 'High'}
          </span>
        </div>
        {d.any_single_three && (
          <div className="mt-2 text-xs text-amber-700">
            Warning: one parameter scored 3 in isolation — escalation triggered per RCP NEWS2 algorithm.
          </div>
        )}
      </div>

      {/* Per-element breakdown */}
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Element contributions</h2>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(d.element_points).map(([k, v]) => (
            <div key={k} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-1.5 text-xs">
              <span className="text-slate-500">{ELEMENT_LABEL[k] ?? k}</span>
              <span className={`font-semibold ${v === 0 ? 'text-slate-400' : v === 3 ? 'text-red-600' : v === 2 ? 'text-orange-600' : 'text-amber-700'}`}>+{v}<span className="ml-0.5 text-[10px] font-normal text-slate-400">pts</span></span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[10px] text-slate-400">Each number is the NEWS2 score contribution (not the raw value).</div>
      </div>

      {banner && (
        <div className={`flex items-start gap-3 rounded-lg border p-4 ${banner.tone === 'red' ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div className="flex-1">
            <div className="text-sm font-medium">{banner.text}</div>
            {banner.cta && (
              <Link href={banner.cta.href} className="mt-1 inline-block text-sm font-semibold underline">{banner.cta.label}</Link>
            )}
          </div>
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Stethoscope className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Clinical interpretation</h2>
          {result.llm_failed && (
            <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">Synthesis fallback</span>
          )}
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{interp}</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/coach?topic=deterioration%20recognition"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand"
        >
          <GraduationCap className="h-4 w-4" /> Coach me on deterioration recognition
        </Link>
        <Link
          href={`/ask?q=${encodeURIComponent('Why does my NEWS2 of ' + d.score + ' (' + d.band + ') warrant the escalation it does?')}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand"
        >
          Ask: why is this score what it is?
        </Link>
      </div>

      <div className="text-xs text-slate-400">
        Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code>
      </div>
    </div>
  );
}

export default function News2Calculator() {
  return (
    <CalculatorShell<News2Deterministic>
      config={NEWS2_CONFIG}
      renderResult={News2Result}
      liveScore={(v) => {
        // NEWS2 requires all 8 inputs to call computeNews2. Show running tally
        // once we have at least RR + SpO2 + temp + SBP + HR; default the rest.
        const required = ['rr', 'spo2', 'temp_c', 'sbp', 'hr'] as const;
        const minSet = required.every((k) => typeof v[k] === 'number');
        if (!minSet) return null;
        const scaleRaw = v.spo2_scale;
        const spo2_scale: Spo2Scale = scaleRaw === '2' || scaleRaw === 2 ? 2 : 1;
        const inputs: News2Inputs = {
          rr:            v.rr     as number,
          spo2_scale,
          spo2:          v.spo2   as number,
          o2_supp:       v.o2_supp === true,
          temp_c:        v.temp_c as number,
          sbp:           v.sbp    as number,
          hr:            v.hr     as number,
          consciousness: ((typeof v.consciousness === 'string' ? v.consciousness : 'A') as Consciousness),
        };
        try {
          const r = computeNews2(inputs);
          const label = r.band === 'low' ? 'Low risk' : r.band === 'low-medium' ? 'Low-medium' : r.band === 'medium' ? 'Medium' : 'High';
          const complete = typeof v.spo2_scale !== 'undefined' && typeof v.consciousness === 'string' && typeof v.o2_supp === 'boolean';
          return { score: r.score, band: r.band, band_label: label, complete };
        } catch { return null; }
      }}
    />
  );
}
