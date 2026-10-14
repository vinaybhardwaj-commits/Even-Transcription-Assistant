// CALC.1 — safety regex per PRD §5.4 and §15.4(b).
//
// Post-processes LLM synthesis output to redact drug doses, fluid volumes, and fluid rates.
// Fluid TYPES (per PRD §3.11 / locked decision #11) are NOT redacted — only the numbers.
//
// Negative lookaheads protect lab units (mg/dL, mEq/L, mmol/L, g/dL, mL/kg-of-cited-protocol)
// from false positives.
//
// Returns { redacted: string, matches: string[] } so callers can log to the trace.

const REDACTED_PLACEHOLDER = '[number intentionally omitted — confirm with your senior]';

// (1) Drug doses: <number> + dose unit, NOT followed by a lab-unit denominator.
//     Examples that match: "1 mg", "500 mcg", "5 units insulin", "0.5 g", "10 IU".
//     Examples that do NOT match: "8 mg/dL", "140 mEq/L", "3.5 g/dL".
const DRUG_DOSE_RE = /\b\d+(?:\.\d+)?\s*(?:mg|mcg|µg|units?|g|IU)\b(?!\s*\/\s*(?:dL|L|mL|mmol|hr|h))/gi;

// (2) IV fluid volumes (absolute mL/cc/L), NOT lab units or rate denominators.
//     Examples that match: "1000 mL bolus", "500 cc of saline", "2 L of crystalloid".
//     Examples that do NOT match: "30 mL/kg" (protocol citation), "5 cc/dL".
const FLUID_VOLUME_RE = /\b\d+(?:\.\d+)?\s*(?:mL|cc|L)\b(?!\s*\/\s*(?:dL|min|kg|hr|h))/gi;

// (3) IV fluid rates — always match.
//     Examples: "100 mL/hr", "50 cc/h", "30 drops/min", "20 gtt/min".
const FLUID_RATE_RE = /\b\d+(?:\.\d+)?\s*(?:mL\s*\/\s*hr?|mL\s*\/\s*h|cc\s*\/\s*hr?|drops?\s*\/\s*min|gtt\s*\/\s*min)\b/gi;

export type SafetyRedactResult = {
  redacted: string;
  matches: Array<{ category: 'drug_dose' | 'fluid_volume' | 'fluid_rate'; matched: string }>;
};

export function applySafetyRedaction(text: string): SafetyRedactResult {
  const matches: SafetyRedactResult['matches'] = [];

  let out = text.replace(DRUG_DOSE_RE, (m) => {
    matches.push({ category: 'drug_dose', matched: m });
    return REDACTED_PLACEHOLDER;
  });
  out = out.replace(FLUID_VOLUME_RE, (m) => {
    matches.push({ category: 'fluid_volume', matched: m });
    return REDACTED_PLACEHOLDER;
  });
  out = out.replace(FLUID_RATE_RE, (m) => {
    matches.push({ category: 'fluid_rate', matched: m });
    return REDACTED_PLACEHOLDER;
  });

  return { redacted: out, matches };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test corpora (PRD §15.4(b)) — kept inline so the regex and its tests evolve together.
// These are exercised by lib/calculators/__tests__/safety-regex.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const POSITIVE_TEST_CASES: Array<{ input: string; expectMatches: number; category: string }> = [
  { input: 'Start metformin 500 mg twice daily.',                  expectMatches: 1, category: 'drug_dose' },
  { input: 'Give 1 mg of glucagon IM.',                            expectMatches: 1, category: 'drug_dose' },
  { input: 'Loading dose 500 mcg.',                                expectMatches: 1, category: 'drug_dose' },
  { input: 'Bolus 5 units of insulin.',                            expectMatches: 1, category: 'drug_dose' },
  { input: '0.5 g IV q6h.',                                        expectMatches: 1, category: 'drug_dose' },
  { input: 'Infuse 1000 mL bolus over 30 min.',                    expectMatches: 1, category: 'fluid_volume' },
  { input: '500 cc of normal saline.',                             expectMatches: 1, category: 'fluid_volume' },
  { input: 'Run at 100 mL/hr.',                                    expectMatches: 1, category: 'fluid_rate' },
  { input: 'Maintenance 50 cc/h.',                                 expectMatches: 1, category: 'fluid_rate' },
  { input: '30 drops/min via gravity.',                            expectMatches: 1, category: 'fluid_rate' },
];

export const NEGATIVE_TEST_CASES: Array<{ input: string; reason: string }> = [
  { input: 'Sodium 140 mEq/L is normal.',                          reason: 'lab unit per L' },
  { input: 'Creatinine 1.4 mg/dL.',                                reason: 'lab unit per dL' },
  { input: 'Lactate 4.2 mmol/L is the SSC threshold.',             reason: 'lab unit mmol/L' },
  { input: 'Albumin 3.5 g/dL.',                                    reason: 'lab unit g/dL' },
  { input: 'SSC recommends 30 mL/kg crystalloid in the first hour.', reason: 'protocol cite mL/kg, not a dose' },
  { input: 'HCO3 9 mEq/L on this gas.',                            reason: 'lab unit' },
  { input: 'eGFR 42 mL/min/1.73 m² is CKD G3b.',                   reason: 'eGFR unit' },
  { input: 'PaO2 80 mmHg.',                                        reason: 'mmHg not in dose set' },
  { input: 'BUN 28 mg/dL.',                                        reason: 'lab unit per dL' },
  { input: 'Glucose 580 mg/dL is severe hyperglycemia.',           reason: 'lab unit per dL' },
];

// Fluid TYPE words that must pass through unredacted (per PRD §3.11).
// Not used by the regex (these aren't matched anyway); included as documentation +
// future allowlist anchor.
export const ALLOWED_FLUID_TYPES = [
  'hypertonic saline', '3% NaCl', '3% saline',
  '0.9% NaCl', '0.9% saline', 'normal saline', 'isotonic saline', 'isotonic crystalloid',
  'lactated ringer', "ringer's lactate", 'LR', 'plasmalyte',
  'D5W', '5% dextrose',
] as const;
