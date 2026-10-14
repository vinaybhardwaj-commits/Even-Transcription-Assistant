/**
 * Pure core for the Right Care case-mix complexity composite (RIGHT-CARE-INDICATOR-PRD §3).
 * NO db / Next imports — recipe scoring + banding + as-of window math + db13-row parsers only.
 * The impure fetcher (lib/metabase.ts::fetchPatientHistoryBundle) runs the db13 queries and reduces
 * their rows with the parsers here; the orchestrator (lib/opd-note-audit.ts) bands the result.
 *
 * Recipe (§3), computed per (patient, index-encounter-date) from db13 history STRICTLY BEFORE the
 * index encounter (as-of discipline; index excluded):
 *   chronic_pts = 0|1|2  for 0 | 1–2 | 3+ distinct chronic ICD codes in prior 12m
 *   lab_pts     = 0|1     1 if ≥3 abnormal lab values in prior 12m
 *   util_pts    = 0|1     1 if ≥4 encounters in prior 12m
 *   band = NEW_TO_US if 0 encounters in prior 24m; else LOW (0) | MODERATE (1–2) | HIGH (3–4)
 * Circularity rule (§3): no input derivable from the doctor's own prescribing in the window
 * (chronic-only ICDs, index excluded, risk_category banned).
 */

export type ComplexityBand = 'NEW_TO_US' | 'LOW' | 'MODERATE' | 'HIGH';
export type ComplexityInputs = { chronic_codes: number; abnormal_labs: number; enc_12m: number; enc_24m: number; as_of: string };

export const ABNORMAL_LAB_THRESHOLD = 3;   // ≥3 abnormal labs → lab_pts 1
export const UTIL_ENC_THRESHOLD = 4;        // ≥4 encounters (12m) → util_pts 1

const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

// ── as-of window math ──────────────────────────────────────────────────────────
/** ISO timestamp of `asOf` minus `months` (UTC month arithmetic). Returns asOf unchanged if unparseable. */
export function windowStart(asOf: string, months: number): string {
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return asOf;
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() - months);
  return r.toISOString();
}

// ── recipe scoring (§3) ─────────────────────────────────────────────────────────
export function chronicPoints(distinctChronic: number): number {
  const c = num(distinctChronic);
  if (c >= 3) return 2;
  if (c >= 1) return 1;
  return 0;
}
export function labPoints(abnormalLabs: number): number { return num(abnormalLabs) >= ABNORMAL_LAB_THRESHOLD ? 1 : 0; }
export function utilPoints(enc12m: number): number { return num(enc12m) >= UTIL_ENC_THRESHOLD ? 1 : 0; }

export function complexityPoints(i: { chronic_codes: number; abnormal_labs: number; enc_12m: number }): number {
  return chronicPoints(i.chronic_codes) + labPoints(i.abnormal_labs) + utilPoints(i.enc_12m);
}

/** Band the composite. NEW_TO_US (zero encounters in prior 24m) takes precedence over the point bands. */
export function bandFor(i: { chronic_codes: number; abnormal_labs: number; enc_12m: number; enc_24m: number }): ComplexityBand {
  if (num(i.enc_24m) === 0) return 'NEW_TO_US';
  const points = complexityPoints(i);
  if (points === 0) return 'LOW';
  if (points <= 2) return 'MODERATE';
  return 'HIGH';
}

/** Assemble {band, inputs} from resolved counts. (Fetch failure → NULL band is handled by the caller.) */
export function buildComplexity(inputs: ComplexityInputs): { band: ComplexityBand; inputs: ComplexityInputs } {
  return { band: bandFor(inputs), inputs };
}

// ── db13-row parsers (pure) ──────────────────────────────────────────────────────
/** Distinct chronic ICD codes from `dpipe_prescription_pipeline__diagnosis` rows (already CHRONIC-filtered). */
export function countDistinctChronicIcds(rows: Array<Record<string, unknown>> | null | undefined, col = 'icd_code'): number {
  const set = new Set<string>();
  for (const r of rows || []) {
    const v = r?.[col];
    if (v != null && String(v).trim()) set.add(String(v).trim().toUpperCase());
  }
  return set.size;
}
/** Count of abnormal lab rows (already ABNORMAL-filtered in SQL). */
export function countAbnormalLabs(rows: Array<Record<string, unknown>> | null | undefined): number {
  return Array.isArray(rows) ? rows.length : 0;
}
/** Read a scalar count(*) from a single-row result under `col`. */
export function scalarCount(rows: Array<Record<string, unknown>> | null | undefined, col: string): number {
  return num(rows?.[0]?.[col]);
}
