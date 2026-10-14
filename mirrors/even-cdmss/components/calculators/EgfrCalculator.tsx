'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Activity, Pill, GraduationCap, ArrowRightCircle } from 'lucide-react';
import CalculatorShell from './CalculatorShell';
import type { CalculatorConfig, CalculatorResult } from '@/lib/calculators/types';

// v2.0 — eGFR is mostly numeric (LLM-native interpretation), so no liveScore.
// Two enums (sex, displayed_equation) get subtitles + per-option descriptions
// to make the picker self-explanatory without hovering ⓘ.

const EGFR_CONFIG: CalculatorConfig = {
  name: 'egfr',
  displayTitle: 'eGFR — CKD-EPI 2021 + Cockcroft-Gault',
  moduleHome: 'drugs',
  pasteModeEnabled: false,
  apiPath: '/api/calculators/egfr',
  resultSections: ['interpretation'],
  typicalLatencySec: 3,
  pushesContext: 'renal_ctx',
  fields: [
    {
      key: 'age',
      label: 'Age',
      type: 'integer',
      unit: 'years',
      required: true,
      hardMin: 18,
      hardMax: 110,
      subtitle: 'Used in both CKD-EPI 2021 and Cockcroft-Gault.',
      staticTooltip: 'Age in years. Used in both CKD-EPI 2021 and Cockcroft-Gault.',
    },
    {
      key: 'sex',
      label: 'Sex',
      type: 'enum',
      required: true,
      subtitle: 'Both equations apply a sex-specific coefficient.',
      options: [
        { value: 'F', label: 'Female' },
        { value: 'M', label: 'Male' },
      ],
      staticTooltip: 'Biological sex. Both equations apply a sex-specific coefficient.',
    },
    {
      key: 'scr',
      label: 'Serum creatinine',
      type: 'number',
      unit: 'mg/dL',
      required: true,
      hardMin: 0.1,
      hardMax: 25,
      softMin: 0.4,
      softMax: 15,
      subtitle: 'Use today\'s steady-state value; if SCr is changing > 0.3 mg/dL in 48 h, this is AKI and the equations\' steady-state assumption is violated.',
      staticTooltip:
        "Most recent stable serum creatinine in mg/dL. Use today's steady-state value; if SCr is changing >0.3 mg/dL in 48 h, this is AKI and the equations' steady-state assumption is violated.",
    },
    {
      key: 'weight_kg',
      label: 'Weight',
      type: 'number',
      unit: 'kg',
      required: false,
      hardMin: 25,
      hardMax: 300,
      subtitle: 'Required only for Cockcroft-Gault. For obese patients consider IBW or adjusted body weight.',
      staticTooltip:
        'Actual body weight in kg. Required only for Cockcroft-Gault. For obese patients, consider IBW or adjusted body weight — see your renal pharmacy reference.',
    },
    {
      key: 'displayed_equation',
      label: 'Primary equation',
      type: 'enum',
      required: false,
      defaultValue: 'ckd-epi-2021',
      subtitle: 'Both compute in parallel either way — this just picks which one shows as the headline.',
      options: [
        { value: 'ckd-epi-2021',   label: 'CKD-EPI 2021 (recommended)', description: 'Race-free; current KDIGO standard for CKD staging' },
        { value: 'cockcroft-gault', label: 'Cockcroft-Gault',           description: 'Still what most drug-dosing references cite' },
      ],
      staticTooltip:
        'CKD-EPI 2021 (race-free) is the current KDIGO standard for staging. Cockcroft-Gault is still what most drug-dosing references cite — both compute in parallel either way.',
    },
  ],
};

type EgfrDeterministic = {
  ckdepi_2021_ml_min_173: number;
  cg_crcl_ml_min: number | null;
  stage: string;
  conservative_for_nti: number;
  displayed_equation: string;
};

function StageChip({ stage }: { stage: string }) {
  const color =
    stage === 'G1' || stage === 'G2'
      ? 'bg-emerald-100 text-emerald-700'
      : stage === 'G3a'
      ? 'bg-amber-100 text-amber-700'
      : stage === 'G3b'
      ? 'bg-orange-100 text-orange-700'
      : stage === 'G4'
      ? 'bg-red-100 text-red-700'
      : 'bg-red-200 text-red-800';
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold ${color}`}>
      CKD {stage}
    </span>
  );
}

function EgfrResult({ result }: { result: CalculatorResult & { deterministic: EgfrDeterministic } }) {
  const d = result.deterministic;
  const primary = d.displayed_equation === 'cockcroft-gault' ? d.cg_crcl_ml_min : d.ckdepi_2021_ml_min_173;
  const primaryLabel = d.displayed_equation === 'cockcroft-gault' ? 'Cockcroft-Gault' : 'CKD-EPI 2021';
  const secondary = d.displayed_equation === 'cockcroft-gault' ? d.ckdepi_2021_ml_min_173 : d.cg_crcl_ml_min;
  const secondaryLabel = d.displayed_equation === 'cockcroft-gault' ? 'CKD-EPI 2021' : 'Cockcroft-Gault';
  const interp = result.sections.find((s) => s.section === 'interpretation')?.text ?? '';

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="text-4xl font-bold tracking-tight text-slate-900">{primary ?? '—'}</span>
          <span className="text-sm text-slate-500">
            {d.displayed_equation === 'cockcroft-gault' ? 'mL/min' : 'mL/min/1.73 m²'} ({primaryLabel})
          </span>
          <span className="ml-auto"><StageChip stage={d.stage} /></span>
        </div>
        {secondary !== null && (
          <div className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
            <span className="font-medium">{secondaryLabel}:</span>
            <span>{secondary} {d.displayed_equation === 'cockcroft-gault' ? 'mL/min/1.73 m²' : 'mL/min'}</span>
          </div>
        )}
        {d.cg_crcl_ml_min !== null && d.cg_crcl_ml_min !== d.ckdepi_2021_ml_min_173 && (
          <div className="mt-2 text-xs text-slate-500">
            For narrow-therapeutic-window drugs (digoxin, vancomycin, aminoglycosides, DOACs, lithium), use the more conservative value:{' '}
            <span className="font-medium text-slate-700">{d.conservative_for_nti} mL/min</span>.
          </div>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-2 flex items-center gap-2">
          <Activity className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-semibold text-slate-900">Clinical interpretation</h2>
          {result.llm_failed && (
            <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">Synthesis fallback</span>
          )}
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{interp}</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/drugs"
          className="inline-flex items-center gap-1.5 rounded-md border border-brand bg-brand-faint px-3 py-1.5 text-sm text-brand hover:bg-brand hover:text-white"
        >
          <Pill className="h-4 w-4" /> Open Drugs with this renal context <ArrowRightCircle className="h-4 w-4" />
        </Link>
        <Link
          href="/coach?topic=CKD%20staging%20and%20management%20implications"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand"
        >
          <GraduationCap className="h-4 w-4" /> Coach me on CKD staging
        </Link>
        <Link
          href={`/ask?q=${encodeURIComponent('Explain why my eGFR is ' + (primary ?? '?') + ' for a ' + (d.stage) + ' patient with these inputs')}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand hover:text-brand"
        >
          <ArrowRightCircle className="h-4 w-4" /> Ask: why is this eGFR what it is?
        </Link>
      </div>

      <div className="text-xs text-slate-400">
        Trace: <code className="rounded bg-slate-100 px-1.5 py-0.5">{result.trace_id}</code>
      </div>
    </div>
  );
}

export default function EgfrCalculator() {
  const [renalCtxPresent, setRenalCtxPresent] = useState(false);
  useEffect(() => {
    try {
      setRenalCtxPresent(!!sessionStorage.getItem('cdmss_renal_ctx'));
    } catch {}
  }, []);
  return (
    <div>
      {renalCtxPresent && (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          A renal context is already active in your Drugs session. Computing a new eGFR will replace it.
        </div>
      )}
      <CalculatorShell<EgfrDeterministic> config={EGFR_CONFIG} renderResult={EgfrResult} />
    </div>
  );
}
