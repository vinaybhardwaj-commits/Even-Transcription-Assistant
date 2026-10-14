import Link from 'next/link';
import { Pill, Activity, Beaker, Droplet, Timer, Brain, Wind, ZapOff, Heart, HeartPulse, ShieldAlert, Waves, Stethoscope } from 'lucide-react';
import HelpCard from '@/components/HelpCard';

export const metadata = { title: 'Calculators' };

const CALCULATORS = [
  {
    href: '/calculators/egfr',
    title: 'eGFR',
    subtitle: 'CKD-EPI 2021 + Cockcroft-Gault',
    desc: 'Renal function for drug dosing. Both equations always compute. Result pushes to Drugs session context so the next drug lookup is renal-adjusted automatically.',
    Icon: Pill,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/news2',
    title: 'NEWS2',
    subtitle: 'National Early Warning Score (RCP 2017)',
    desc: '8-element bedside deterioration score. Scale 1 + Scale 2 (COPD/Type-2 RF). Auto-banner amber at ≥5, red at ≥7.',
    Icon: Activity,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/abg',
    title: 'ABG interpreter',
    subtitle: 'Acid-base + oxygenation',
    desc: 'Winters\' / compensation, anion gap (with albumin correction), delta-delta, P/F + A-a. qwen 14b synthesizes the ranked differential and next workup.',
    Icon: Beaker,
    badge: 'LLM-native',
  },
  {
    href: '/calculators/hyponatremia',
    title: 'Hyponatremia',
    subtitle: 'Workup synthesizer',
    desc: 'Glucose-corrected Na (Katz/Hillier), tonicity, free-water excess, ODS-risk ceiling. qwen 14b ranked differential keyed to volume status + meds.',
    Icon: Droplet,
    badge: 'LLM-native',
  },
  {
    href: '/calculators/sepsis-bundle',
    title: 'Sepsis 1-h bundle',
    subtitle: 'SSC 2021 compliance tracker',
    desc: 'Live countdown + per-element status. Optional qwen 14b evidence sidebar cached 7 days per user. No LLM on the main path.',
    Icon: Timer,
    badge: 'Checklist',
  },
  // v1.8 S1 — 10 deterministic ER/ICU scoring calculators.
  {
    href: '/calculators/nihss',
    title: 'NIHSS',
    subtitle: 'NIH Stroke Scale (NINDS / AHA)',
    desc: '11-item bedside stroke severity score (0-42). Bands: no stroke / minor / moderate / moderate-severe / severe — drives tPA candidacy and disposition.',
    Icon: Brain,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/abcd2',
    title: 'ABCD\u00B2',
    subtitle: 'TIA → 2-day stroke risk',
    desc: 'Age, BP, clinical features, duration, diabetes. Three bands (low / moderate / high) drive admission vs urgent outpatient workup.',
    Icon: Activity,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/curb65',
    title: 'CURB-65',
    subtitle: 'Community-acquired pneumonia severity',
    desc: 'Confusion, Urea, RR, BP, age ≥65. Maps directly to outpatient / short inpatient / hospitalize with mortality bands.',
    Icon: Wind,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/wells_dvt',
    title: 'Wells — DVT',
    subtitle: 'Pretest probability for deep vein thrombosis',
    desc: 'Nine positive + one negative criterion (alt diagnosis). Three-tier band sets the D-dimer vs compression-US threshold.',
    Icon: ZapOff,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/wells_pe',
    title: 'Wells — PE',
    subtitle: 'Pretest probability for pulmonary embolism',
    desc: 'Decimal weights across 7 items. Reports BOTH three-tier (low / moderate / high) AND two-tier (likely vs unlikely) bands.',
    Icon: ZapOff,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/heart',
    title: 'HEART',
    subtitle: 'Chest pain — 6-week MACE',
    desc: 'History, ECG, Age, Risk factors, Troponin. 0-10 score with low / moderate / high MACE bands — discharge vs admit vs invasive.',
    Icon: Heart,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/timi',
    title: 'TIMI',
    subtitle: 'UA / NSTEMI 14-day MACE',
    desc: '7 binary items, score 0-7 with per-score 14-day MACE bands from the original TIMI 11B / ESSENCE cohorts.',
    Icon: HeartPulse,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/sofa',
    title: 'SOFA',
    subtitle: 'Sepsis-related Organ Failure Assessment',
    desc: '6 organ systems × 0-4 = 0-24. Mortality bands plus optional qSOFA chip — flags positive at ≥2/3 bedside criteria.',
    Icon: ShieldAlert,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/qtc',
    title: 'QTc',
    subtitle: 'Corrected QT — Bazett / Fridericia / Framingham',
    desc: 'All three formulas computed in parallel. Sex-specific Bazett band; any-method >500 ms flags high TdP risk.',
    Icon: Waves,
    badge: 'Deterministic',
  },
  {
    href: '/calculators/alvarado',
    title: 'Alvarado',
    subtitle: 'MANTRELS — appendicitis',
    desc: '8 clinical / lab items (T and L worth 2 pts each). Bands map directly to discharge / observe / surgical consult / surgery.',
    Icon: Stethoscope,
    badge: 'Deterministic',
  },
] as const;

const BADGE_COLOR: Record<string, string> = {
  'Deterministic': 'bg-slate-100 text-slate-600',
  'LLM-native':    'bg-brand-faint text-brand',
  'Checklist':     'bg-emerald-100 text-emerald-700',
};

export default function CalculatorsPage() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-slate-900 sm:text-3xl">Calculators</h1>
      <p className="mt-1 text-sm text-slate-500">
        Bedside math for renal function, deterioration, acid-base, sodium, and sepsis. Deterministic by default — LLM only where synthesis adds clinical leverage.
      </p>
      <HelpCard
        storageKey="calculators"
        title='Five bedside calculators with deterministic math + LLM-grounded synthesis'
        bullets={[
          'eGFR pushes its result into Drugs so the next lookup is renal-adjusted automatically',
          'NEWS2 auto-banners amber at ≥5, red at ≥7 — link straight into Coach for deterioration recognition',
          'ABG + Hyponatremia stream a 6-section interpretation (qwen 14b) grounded in MKSAP/StatPearls/UpToDate',
          'Sepsis 1-h bundle tracker uses zero LLM on main path; evidence sidebar cached 7 days per user',
        ]}
      />
      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {CALCULATORS.map((c) => {
          const Icon = c.Icon;
          return (
            <Link key={c.href} href={c.href}
                  className="group flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand hover:shadow">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-brand-faint text-brand">
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold text-slate-900 group-hover:text-brand">{c.title}</span>
                  <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${BADGE_COLOR[c.badge]}`}>{c.badge}</span>
                </div>
                <div className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">{c.subtitle}</div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{c.desc}</p>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
