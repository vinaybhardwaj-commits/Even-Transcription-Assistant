// CALC.1 — calculator type contracts. Implementation lives in components/calculators/.
// Per PRD §5.1 + §14, every calculator uses the same shell with per-calc config.

export type CalculatorName =
  | 'egfr'
  | 'news2'
  | 'abg'
  | 'hyponatremia'
  | 'sepsis_bundle'
  // v1.8 S1 — ER/ICU deterministic scoring calculators
  | 'nihss'
  | 'abcd2'
  | 'curb65'
  | 'wells_dvt'
  | 'wells_pe'
  | 'heart'
  | 'timi'
  | 'sofa'
  | 'qtc'
  | 'alvarado';

// One field in a calculator form.
export type FormFieldType = 'number' | 'integer' | 'enum' | 'bool' | 'text' | 'datetime';

export type FormField = {
  key: string;                       // e.g. 'scr_mg_dl'
  label: string;                     // e.g. 'Serum creatinine'
  // v2.0: always-visible secondary line under the label, e.g.
  // 'Only assess horizontal gaze' for an enum field. Removes the
  // need to hover the ⓘ tooltip to understand what the field is for.
  subtitle?: string;
  type: FormFieldType;
  unit?: string;                     // 'mg/dL'
  required: boolean;
  // Hard bounds — Submit blocked outside this range.
  hardMin?: number;
  hardMax?: number;
  // Soft warning bounds — banner shown, Submit allowed.
  softMin?: number;
  softMax?: number;
  // For enum / bool fields.
  // v2.0: each option gets an optional points value (shown as a chip next
  // to the option label) + an optional description (renders smaller text
  // below the label). Allows the MDCalc-style verbose UX without forcing
  // the user to know category scores by heart.
  options?: Array<{ value: string | boolean; label: string; points?: number; description?: string }>;
  // Static fallback tooltip (used when bridge is down). Live tooltip fetched on hover.
  staticTooltip: string;
  // Default value pre-fill (e.g. 'now' for sepsis recognition time).
  defaultValue?: string | number | boolean;
};

// Calculator-level config — registered once, used by the shell + all routes.
export type CalculatorConfig = {
  name: CalculatorName;
  displayTitle: string;             // 'eGFR (CKD-EPI 2021 + Cockcroft-Gault)'
  moduleHome: 'ask' | 'drugs' | 'coach';
  pasteModeEnabled: boolean;
  fields: FormField[];
  // The endpoint POST path, e.g. '/api/calculators/egfr'
  apiPath: string;
  // Section keys this calculator's result card uses (for skeleton placeholders during stream).
  resultSections: string[];
  // For LLM-native calculators, the typical p50 wall time (seconds) for the "Synthesizing... ~Ns typical" badge.
  // Read from /api/calculators/typical-latency in production; this is the v1 seed.
  typicalLatencySec: number;
  // Whether result auto-pushes anything into a session-level context (e.g. eGFR → renal_ctx).
  pushesContext?: 'renal_ctx';
};

// v2.0 — live score preview prop. If supplied, the shell renders a sticky
// "Score: X / Y · Band" chip at the top of the form that updates on every
// input change. The function receives the current form values and returns
// the running score; can return null when inputs are incomplete.
export type LiveScoreFn = (values: Record<string, unknown>) => {
  score: number;
  max?: number;
  band?: string;
  band_label?: string;
  complete: boolean;
} | null;

// Shell props — same shape for every calculator page.
export type CalculatorShellProps = {
  config: CalculatorConfig;
  /** v2.0 — optional client-side live preview from each calc's math fn. */
  liveScore?: LiveScoreFn;
  // Render the inputs form. Shell wraps in <form>, handles submit + idempotency-key + sticky button.
  renderForm: (props: { values: Record<string, unknown>; setValue: (k: string, v: unknown) => void; errors: Record<string, string> }) => React.ReactNode;
  // Render the paste-mode textarea + confidence-chip flow. Optional (only when config.pasteModeEnabled).
  renderPasteMode?: (props: { onExtracted: (fields: Record<string, unknown>) => void }) => React.ReactNode;
  // Render the result card. Shell streams sections in via NDJSON for LLM-native; passes complete result for deterministic.
  renderResult: (props: { result: CalculatorResult; sections: ResultSection[] }) => React.ReactNode;
};

// Result schema — superset across calculators. Individual calcs use the subset they need.
export type CalculatorResult = {
  trace_id: string;
  computed_at: string;               // ISO
  // Deterministic values (e.g. eGFR, NEWS2 score, ABG primary disorder). Calculator-specific shape.
  deterministic: Record<string, unknown>;
  // Streamed sections (LLM-native only). Empty array for deterministic-only calculators.
  // For non-streaming calcs (eGFR, NEWS2), the interpretation lives in a single 'interpretation' section.
  sections: ResultSection[];
  // For eGFR specifically: the values written to sessionStorage['cdmss_renal_ctx'].
  pushed_to_context?: Record<string, unknown>;
  llm_failed?: boolean;
  // Banner state (PRD §14.3 row 1 for partial, §4.2/4.5 for abnormal-result auto-banners).
  banner?: { tone: 'amber' | 'red' | 'info'; text: string; cta?: { label: string; href: string } };
};

export type ResultSection = {
  section: string;                   // 'primary_disorder', 'compensation', 'interpretation', etc.
  text: string;
  items?: Array<Record<string, unknown>>;   // differential items, next_workup items, element-points
  citations?: Array<{ chunk_id: number; source?: string; book?: string }>;
  // Set true after stream end OR computed = true for deterministic sections.
  complete: boolean;
};

// Extraction (paste mode) per-field result.
export type ExtractedField = {
  field: string;
  value: string | number | boolean | null;
  unit?: string;
  source_snippet?: string;
  confidence: number;                // 0.0-1.0
};
