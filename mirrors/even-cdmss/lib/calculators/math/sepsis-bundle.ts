// CALC.5 — Surviving Sepsis Campaign 1-hour bundle compliance math. PRD §4.5.
// All deterministic, no LLM. Locked decision #8: t0 defaults to 'now' on client;
// the math here just takes whatever t0 the client sends.

export type SepsisBundleInputs = {
  recognition_time: string;            // ISO datetime
  weight_kg?: number;
  lactate_done: boolean;
  lactate_value?: number;              // mmol/L
  cultures_done: boolean;
  abx_given: boolean;
  hypotension_or_lactate_high: boolean;  // MAP <65 OR lactate ≥4 → gates fluid requirement
  fluids_done: boolean;
  fluid_volume_ml?: number;
  vasopressors_started: boolean;
  qsofa?: number;
  sofa?: number;
};

export type ElementStatus = 'green' | 'amber' | 'red' | 'overdue';

export type BundleElement = {
  key: 'lactate' | 'cultures' | 'abx' | 'fluids' | 'vasopressors';
  label: string;
  complete: boolean;
  required: boolean;
  status: ElementStatus;
  why_matters: string;
};

export type BundleResult = {
  elapsed_min: number;
  remaining_min: number;
  recognition_iso: string;
  elements: BundleElement[];
  compliance_pct: number;             // 0-100, over required-only elements
  required_count: number;
  complete_required_count: number;
  bundle_complete: boolean;
  banner: { tone: 'amber' | 'red'; text: string; cta?: { label: string; href: string } } | null;
  // Optional consumed scores
  qsofa: number | null;
  sofa: number | null;
};

const WINDOW_MIN = 60;

function statusFor(complete: boolean, required: boolean, elapsedMin: number): ElementStatus {
  if (!required) return 'green';      // not required for this patient
  if (complete) return 'green';
  if (elapsedMin > WINDOW_MIN) return 'overdue';
  if (elapsedMin < WINDOW_MIN * 0.5) return 'amber';   // <30 min: early-warning amber
  return 'red';                       // ≥30 min and still incomplete: red
}

// Per-element "why this matters" — static strings, displayed via tooltip in UI.
const WHY_MATTERS: Record<BundleElement['key'], string> = {
  lactate:     'Quantifies tissue hypoperfusion. Lactate ≥4 mmol/L is a sepsis red flag and gates the fluid bolus requirement.',
  cultures:    'Drawn BEFORE first antibiotic. One dose can sterilize cultures within hours — drops diagnostic yield from ~50% to 20-30%. Preserves your ability to narrow therapy at 48-72 h.',
  abx:         'The single biggest mortality lever in the bundle. Each hour of delay in septic shock is associated with 7-8% absolute mortality increase across observational cohorts.',
  fluids:      '30 mL/kg crystalloid for hypotension or lactate ≥4 within the first hour. Re-assess after the initial bolus; phenotype-tailor in CHF/ESRD/cirrhosis.',
  vasopressors:'Early norepinephrine is associated with improved outcomes when MAP remains <65 after the initial fluid bolus. Do not delay waiting for "enough fluid".',
};

export function computeBundle(inputs: SepsisBundleInputs, nowIso?: string): BundleResult {
  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  const recognized = new Date(inputs.recognition_time).getTime();
  const elapsedMin = Math.max(0, Math.round((now - recognized) / 60000));
  const remainingMin = Math.max(0, WINDOW_MIN - elapsedMin);

  // Required-element gating
  // - lactate, cultures, abx: always required
  // - fluids: required iff hypotension_or_lactate_high
  // - vasopressors: required iff hypotension_or_lactate_high AND fluids already done
  //   (i.e. patient still hypotensive after initial bolus)
  const fluidsRequired = inputs.hypotension_or_lactate_high;
  const vasopressorsRequired = inputs.hypotension_or_lactate_high && inputs.fluids_done;

  const elements: BundleElement[] = [
    { key: 'lactate',      label: 'Lactate measured',           complete: inputs.lactate_done,         required: true,  status: 'green', why_matters: WHY_MATTERS.lactate },
    { key: 'cultures',     label: 'Blood cultures × 2 drawn (pre-abx)', complete: inputs.cultures_done, required: true,  status: 'green', why_matters: WHY_MATTERS.cultures },
    { key: 'abx',          label: 'Broad-spectrum antibiotics given',   complete: inputs.abx_given,    required: true,  status: 'green', why_matters: WHY_MATTERS.abx },
    { key: 'fluids',       label: '30 mL/kg crystalloid given',          complete: inputs.fluids_done,  required: fluidsRequired, status: 'green', why_matters: WHY_MATTERS.fluids },
    { key: 'vasopressors', label: 'Vasopressors started',                complete: inputs.vasopressors_started, required: vasopressorsRequired, status: 'green', why_matters: WHY_MATTERS.vasopressors },
  ];
  for (const e of elements) e.status = statusFor(e.complete, e.required, elapsedMin);

  // Compliance % over required-only elements
  const requiredEls = elements.filter((e) => e.required);
  const completeReq = requiredEls.filter((e) => e.complete).length;
  const compliancePct = requiredEls.length === 0 ? 100 : Math.round((completeReq / requiredEls.length) * 100);
  const bundleComplete = requiredEls.every((e) => e.complete);

  // PRD §4.5 auto-banner
  let banner: BundleResult['banner'] = null;
  if (elapsedMin > WINDOW_MIN && !bundleComplete) {
    banner = {
      tone: 'red',
      text: `Bundle window exceeded (${elapsedMin} min elapsed) with ${requiredEls.length - completeReq} required element${requiredEls.length - completeReq === 1 ? '' : 's'} still incomplete.`,
      cta: { label: 'Coach me on the SSC bundle', href: '/coach?topic=SSC%20sepsis%20one-hour%20bundle' },
    };
  } else if (elapsedMin > 30 && compliancePct < 50) {
    banner = {
      tone: 'amber',
      text: `${compliancePct}% bundle compliance at ${elapsedMin} min — closing in on the 1 h window.`,
      cta: { label: 'Walk me through the bundle', href: '/coach?topic=SSC%20sepsis%20one-hour%20bundle' },
    };
  }

  return {
    elapsed_min: elapsedMin,
    remaining_min: remainingMin,
    recognition_iso: new Date(recognized).toISOString(),
    elements,
    compliance_pct: compliancePct,
    required_count: requiredEls.length,
    complete_required_count: completeReq,
    bundle_complete: bundleComplete,
    banner,
    qsofa: inputs.qsofa ?? null,
    sofa: inputs.sofa ?? null,
  };
}
