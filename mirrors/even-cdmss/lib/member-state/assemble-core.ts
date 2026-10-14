// lib/member-state/assemble-core.ts — MemberState Stage 0 assembly: already-fetched db13 rows
// (individuals-prescriptions + joined labs) → immutable MemberEvidence. PURE (no db/llm/io);
// the db reads live in scripts/member-state-shadow.mjs. IDENTIFIER-FREE: copies ONLY clinical
// content + opaque refs (never name/mobile/dob). FAIL-SAFE: malformed/missing fields degrade to
// empty; never throws. Reuses prescriptionToAssertions from clinical-state (type-only + value).

import type { MemberEvidence, EncounterEvidence } from './schema';
import type { Provenance } from '../clinical-state/schema';
import { prescriptionToAssertions } from '../clinical-state/from-prescription';

function s(v: unknown): string { return typeof v === 'string' ? v : v == null ? '' : String(v); }
function orNull(v: unknown): string | null { const t = s(v).trim(); return t === '' ? null : s(v); }
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function sexOf(v: unknown): 'F' | 'M' | null {
  const t = s(v).trim(); if (!t) return null;
  return /^f/i.test(t) ? 'F' : /^m/i.test(t) ? 'M' : null;
}
function prov(sourceField: string, rawText: string, confidence = 0.9): Provenance {
  return { sourceField, rawText, extractionMethod: 'reported', confidence };
}

/** Parse a db13 diagnosis/impression icd field into {code,text} rows. Accepts a jsonb array of
 *  strings, an array of {code,name/description}, or a delimited string. Fail-safe → []. */
function parseIcdList(v: unknown): { code: string | null; text: string }[] {
  let arr: unknown[] = [];
  try {
    const parsed = typeof v === 'string' && v.trim().startsWith('[') ? JSON.parse(v) : v;
    if (Array.isArray(parsed)) arr = parsed;
    else if (typeof v === 'string' && v.trim()) arr = v.split(/[;,|]/);
  } catch {
    if (typeof v === 'string' && v.trim()) arr = v.split(/[;,|]/);
  }
  const out: { code: string | null; text: string }[] = [];
  for (const el of arr) {
    if (el == null) continue;
    // db13 diagnosis_icd_codes are jsonb arrays of BARE code strings and include empty-string
    // elements ([""]) — a problem is created ONLY for a non-empty (non-whitespace) code.
    if (typeof el === 'string') { const t = el.trim(); if (t) out.push({ code: t, text: t }); continue; }
    if (typeof el === 'object') {
      const o = el as Record<string, unknown>;
      const code = orNull(o.code ?? o.icd_code ?? o.icd);
      const text = orNull(o.name ?? o.description ?? o.display ?? o.text ?? code);
      if (code || text) out.push({ code: code ?? null, text: (text ?? code ?? '') as string });
    }
  }
  return out;
}

/** One db13 individuals-prescriptions row → an opd EncounterEvidence. Never throws. */
function prescriptionRowToEncounter(row: Record<string, unknown>): EncounterEvidence | null {
  try {
    const encounterRef = orNull(row.uid) ?? orNull(row.presc_uid);
    if (!encounterRef) return null;
    const date = (orNull(row.visit_date) ?? orNull(row.date) ?? s(row.timestamp).slice(0, 10)) || '';
    const { medicationAssertions, allergyAssertions } = prescriptionToAssertions(row.medications, s(row.patient_details__allergies) || null);

    const icd = [...parseIcdList(row.diagnosis_icd_codes), ...parseIcdList(row.impression_icd_codes)];
    const problems = (icd.length ? icd : parseIcdList(row.diagnosis).map((d) => ({ code: null, text: d.text })))
      .filter((d) => d.text || d.code)
      .map((d) => ({
        conceptRaw: (d.text || d.code || '') as string,
        icdCode: d.code,
        explicitStatus: null as 'active' | 'resolved' | null,   // db13 prescriptions carry no resolution
        provenance: prov('individuals-prescriptions.diagnosis_icd_codes', (d.code || d.text || '') as string, 0.9),
      }));

    const age = numOrNull(row.age);
    const sex = sexOf(row.gender ?? row.sex);
    return {
      encounterRef, date, kind: 'opd',
      problems,
      medicationAssertions,
      allergyAssertions,
      investigations: [],
      demographics: (age != null || sex != null) ? { age, sex } : undefined,
    };
  } catch {
    return null;
  }
}

/** Group already-fetched joined lab rows (test_values ⋈ test_digital_values) by booking → lab
 *  EncounterEvidence. Never throws. */
function labRowsToEncounters(labRows: Record<string, unknown>[]): EncounterEvidence[] {
  const byBooking = new Map<string, EncounterEvidence>();
  for (const row of labRows) {
    try {
      const booking = orNull(row.booking_id) ?? orNull(row.test_result_uid);
      if (!booking) continue;
      const date = (orNull(row.test_date) ?? '') || '';
      const analyteRaw = orNull(row.investigation_name);
      const value = orNull(row.value);
      if (!analyteRaw || value == null) continue;
      const point = {
        analyteRaw,
        value: value,
        unit: orNull(row.investigation_unit),
        abnormal: orNull(row.investigation_is_abnormal),
        provenance: prov('test_values_view', `${analyteRaw}: ${value}`, 0.9),
      };
      const enc = byBooking.get(booking) ?? { encounterRef: booking, date, kind: 'lab' as const, problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [] };
      enc.investigations.push(point);
      byBooking.set(booking, enc);
    } catch { /* skip malformed lab row */ }
  }
  return Array.from(byBooking.values());
}

export function assembleEvidence(input: {
  memberRef: string;
  generatedAt: string;
  sourceWatermarks: Record<string, string>;
  prescriptionRows: Record<string, unknown>[];
  labRows: Record<string, unknown>[];
}): MemberEvidence {
  const opd = (Array.isArray(input.prescriptionRows) ? input.prescriptionRows : [])
    .map(prescriptionRowToEncounter)
    .filter((e): e is EncounterEvidence => e !== null);
  const lab = labRowsToEncounters(Array.isArray(input.labRows) ? input.labRows : []);
  return {
    memberRef: s(input.memberRef),
    encounters: [...opd, ...lab],
    sourceWatermarks: input.sourceWatermarks || {},
    generatedAt: s(input.generatedAt),
  };
}
