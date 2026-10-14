// lib/member-state/lab-reference-ranges.ts — MemberState clinical-state redesign (member-present/0.2).
// PURE reference data + unit-aware banding. NO I/O, NO Date, NO LLM.
//
// Decision F: an analyte is banded ONLY when the stored unit MATCHES a range row's unit (mixed-unit
// rows render UNFLAGGED). Sex-specific rows where clinically relevant; adult ranges only (paeds OUT
// of scope — flagged). A "severity band" is low/borderline/high/critical vs a directional reference.
// Bands calibrated to the approved mockup (Vit D 8.0 → severe↓, B12 193 → low, LDL 129 → borderline,
// Total-chol 202 → borderline; HbA1c 5.1 / TSH 2.29 / Hb 12.5 / creat 0.6 / TG 105 / HDL 52 → in range).

export type Sex = 'F' | 'M' | null;
// 'abnormal' = source-flagged abnormal (test_values_view.investigation_is_abnormal) with NO mapped
// range row — surfaced honestly with no invented severity (patch: abnormal-lab completeness).
export type Band = 'critical' | 'high' | 'borderline' | 'low' | 'abnormal' | 'normal';

export interface RangeRow {
  analyte: string;                 // canonical analyte id
  unit: string;                    // the unit this row applies to (normalised, case-insensitive)
  sex?: 'F' | 'M';                 // omitted → applies to any sex (sex-neutral)
  /** ordered ascending cut-points → band for [prev, cut). Last band applies to >= last cut. */
  bands: { upTo: number | null; band: Band }[];
  refText: string;                 // human "ref …" string for the row (matches the mockup vocabulary)
  /** low-abnormal analytes read downward (deficiencies); high-abnormal read upward (lipids, sugar). */
  direction: 'low_is_abnormal' | 'high_is_abnormal';
}

/** Alias map: raw analyte name (lower-cased, trimmed) → canonical analyte id. Extend freely;
 *  an unmapped analyte simply never bands (rendered as a plain value). */
export const ANALYTE_ALIASES: Record<string, string> = {
  'vitamin d': 'vitamin_d_25oh',
  'vitamin d (25-oh)': 'vitamin_d_25oh',
  'vitamin d 25-oh': 'vitamin_d_25oh',
  'vitamin d (25 oh cholecalciferol)': 'vitamin_d_25oh',   // observed real db name
  '25-oh vitamin d': 'vitamin_d_25oh',
  '25 hydroxy vitamin d': 'vitamin_d_25oh',
  'vit d': 'vitamin_d_25oh',
  'non hdl cholesterol': 'non_hdl_cholesterol',             // observed; no range row → safety net surfaces
  'non-hdl cholesterol': 'non_hdl_cholesterol',
  'vitamin b12': 'vitamin_b12',
  'vitamin b-12': 'vitamin_b12',
  'vit b12': 'vitamin_b12',
  'b12': 'vitamin_b12',
  'ldl': 'ldl_cholesterol',
  'ldl cholesterol': 'ldl_cholesterol',
  'ldl-c': 'ldl_cholesterol',
  'total cholesterol': 'total_cholesterol',
  'cholesterol total': 'total_cholesterol',
  'cholesterol': 'total_cholesterol',
  'hdl': 'hdl_cholesterol',
  'hdl cholesterol': 'hdl_cholesterol',
  'triglycerides': 'triglycerides',
  'triglyceride': 'triglycerides',
  'tg': 'triglycerides',
  'hba1c': 'hba1c',
  'hb a1c': 'hba1c',
  'glycated haemoglobin': 'hba1c',
  'tsh': 'tsh',
  'thyroid stimulating hormone': 'tsh',
  'haemoglobin': 'haemoglobin',
  'hemoglobin': 'haemoglobin',
  'hb': 'haemoglobin',
  'creatinine': 'creatinine',
  'serum creatinine': 'creatinine',
  'fasting glucose': 'fasting_glucose',
  'fasting blood sugar': 'fasting_glucose',
  'fbs': 'fasting_glucose',
};

/** Normalise a unit for comparison (case-insensitive, µ↔u, common spellings). */
export function normalizeUnit(u: string | null | undefined): string {
  return String(u ?? '')
    .trim()
    .toLowerCase()
    .replace(/µ/g, 'u')
    .replace(/\s+/g, '');
}

/** Canonicalise a raw analyte name to its reference id, or '' if unknown. Tolerant: on an exact-lookup
 *  miss, strips ONE trailing parenthetical group and retries once — so "vitamin d (25 oh cholecalciferol)"
 *  → "vitamin d" → vitamin_d_25oh. Deterministic. */
export function canonicalAnalyte(raw: string | null | undefined): string {
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const key = norm(String(raw ?? ''));
  if (ANALYTE_ALIASES[key]) return ANALYTE_ALIASES[key];
  const stripped = norm(key.replace(/\s*\([^)]*\)\s*$/, ''));   // drop a trailing "(...)" qualifier
  if (stripped && stripped !== key && ANALYTE_ALIASES[stripped]) return ANALYTE_ALIASES[stripped];
  return '';
}

// Cut-points define bands for [previous, upTo). Order matters (ascending). Bands not in a row are 'normal'.
export const REFERENCE_RANGES: RangeRow[] = [
  {
    analyte: 'vitamin_d_25oh', unit: 'ng/ml', direction: 'low_is_abnormal', refText: 'ref ≥ 30',
    bands: [{ upTo: 10, band: 'critical' }, { upTo: 20, band: 'low' }, { upTo: 30, band: 'borderline' }, { upTo: null, band: 'normal' }],
  },
  {
    analyte: 'vitamin_b12', unit: 'pg/ml', direction: 'low_is_abnormal', refText: 'ref 200–900',
    bands: [{ upTo: 200, band: 'low' }, { upTo: 900, band: 'normal' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'ldl_cholesterol', unit: 'mg/dl', direction: 'high_is_abnormal', refText: 'optimal < 100',
    bands: [{ upTo: 100, band: 'normal' }, { upTo: 130, band: 'borderline' }, { upTo: 160, band: 'high' }, { upTo: null, band: 'critical' }],
  },
  {
    analyte: 'total_cholesterol', unit: 'mg/dl', direction: 'high_is_abnormal', refText: 'desirable < 200',
    bands: [{ upTo: 200, band: 'normal' }, { upTo: 240, band: 'borderline' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'hdl_cholesterol', unit: 'mg/dl', direction: 'low_is_abnormal', refText: 'ref ≥ 40',
    bands: [{ upTo: 40, band: 'low' }, { upTo: null, band: 'normal' }],
  },
  {
    analyte: 'triglycerides', unit: 'mg/dl', direction: 'high_is_abnormal', refText: 'ref < 150',
    bands: [{ upTo: 150, band: 'normal' }, { upTo: 200, band: 'borderline' }, { upTo: 500, band: 'high' }, { upTo: null, band: 'critical' }],
  },
  {
    analyte: 'hba1c', unit: '%', direction: 'high_is_abnormal', refText: 'ref < 5.7',
    bands: [{ upTo: 5.7, band: 'normal' }, { upTo: 6.5, band: 'borderline' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'tsh', unit: 'uiu/ml', direction: 'high_is_abnormal', refText: 'ref 0.4–4.5',
    bands: [{ upTo: 0.4, band: 'low' }, { upTo: 4.5, band: 'normal' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'fasting_glucose', unit: 'mg/dl', direction: 'high_is_abnormal', refText: 'ref 70–99',
    bands: [{ upTo: 70, band: 'low' }, { upTo: 100, band: 'normal' }, { upTo: 126, band: 'borderline' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'creatinine', unit: 'mg/dl', direction: 'high_is_abnormal', refText: 'ref 0.6–1.2',
    bands: [{ upTo: 0.6, band: 'low' }, { upTo: 1.2, band: 'normal' }, { upTo: null, band: 'high' }],
  },
  // Sex-specific: haemoglobin. Sex-neutral fallback (12–17) applied when sex is unknown.
  {
    analyte: 'haemoglobin', unit: 'g/dl', sex: 'F', direction: 'low_is_abnormal', refText: 'ref 12–15 (F)',
    bands: [{ upTo: 12, band: 'low' }, { upTo: 15.5, band: 'normal' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'haemoglobin', unit: 'g/dl', sex: 'M', direction: 'low_is_abnormal', refText: 'ref 13–17 (M)',
    bands: [{ upTo: 13, band: 'low' }, { upTo: 17.5, band: 'normal' }, { upTo: null, band: 'high' }],
  },
  {
    analyte: 'haemoglobin', unit: 'g/dl', direction: 'low_is_abnormal', refText: 'ref 12–17',
    bands: [{ upTo: 12, band: 'low' }, { upTo: 17.5, band: 'normal' }, { upTo: null, band: 'high' }],
  },
];

/** Select the range row for an analyte + unit + sex. Unit MUST match (Decision F). A sex-specific
 *  analyte prefers the sex row; falls back to the sex-neutral row when sex is unknown. null → no band. */
export function selectRange(analyteId: string, unit: string | null | undefined, sex: Sex): RangeRow | null {
  const u = normalizeUnit(unit);
  if (!analyteId || !u) return null;
  const rows = REFERENCE_RANGES.filter((r) => r.analyte === analyteId && normalizeUnit(r.unit) === u);
  if (!rows.length) return null;
  if (sex) { const sexed = rows.find((r) => r.sex === sex); if (sexed) return sexed; }
  const neutral = rows.find((r) => !r.sex);
  return neutral ?? null;   // sex-specific-only analyte with unknown sex → no band (honest)
}

export interface BandResult { band: Band; refText: string; direction: RangeRow['direction'] }

/** Band a numeric value against the selected row. null when no row matches the unit (Decision F). */
export function bandValue(analyteId: string, value: number, unit: string | null | undefined, sex: Sex): BandResult | null {
  const row = selectRange(analyteId, unit, sex);
  if (!row || !Number.isFinite(value)) return null;
  for (const b of row.bands) {
    if (b.upTo === null || value < b.upTo) return { band: b.band, refText: row.refText, direction: row.direction };
  }
  return { band: 'normal', refText: row.refText, direction: row.direction };
}
