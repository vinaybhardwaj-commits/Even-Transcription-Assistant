// lib/clinical-state/from-prescription.ts — ClinicalState 1.1: PURE mapper from db13's
// `individuals-prescriptions` prescription structure → typed MedicationAssertion /
// AllergyAssertion. No ./db, no ./llm, no I/O — type-only imports; loadable under
// `node --experimental-strip-types`. Mirrors from-primitives.ts / to-audit-family.ts.
//
// CONSUMED BY NO LIVE ENGINE IN 1.1. This locks the typed contract and proves it against
// the real prescription shape; Stage 0 (MemberState) wires it into the member-state builder
// and fills encounterRef + medicationConcept.normalizedConceptId. The /ddx extract path is
// deliberately NOT touched (no free-text med/allergy extraction here).
//
// Input shape (MEASURED from db13 individuals-prescriptions, 11 Jul 2026): each medication
// line carries brand_name, generic_name, dosage, strength, frequency ("1-0-1"), duration,
// route_of_administration, instruction_to_patient, default_opd_service_category, is_vital, uid
// (extra keys ignored; any may be empty strings). Allergies is a free-text string.
//
// FAIL-SAFE: every function degrades to empty/no-op on malformed input; never throws.

import type { MedicationAssertion, AllergyAssertion, ConceptRef, AllergyStatus } from './schema';

/** djb2 (the mkFindingId algorithm) over a key → stable hex, stable across runs. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** A field's string value if it carries non-whitespace content, else null (empty → null). */
function orNull(v: unknown): string | null {
  const raw = typeof v === 'string' ? v : v == null ? '' : String(v);
  return raw.trim() === '' ? null : raw;
}
function orUndef(v: unknown): string | undefined {
  const r = orNull(v);
  return r == null ? undefined : r;
}

/** Map one db13 medication line → a `prescribed` MedicationAssertion, or null to skip the
 *  line (both brand_name and generic_name empty). */
export function medicationLineToAssertion(line: Record<string, unknown>): MedicationAssertion | null {
  try {
    const brand = orUndef(line.brand_name);
    const generic = orUndef(line.generic_name);
    const raw = brand ?? generic;            // brand preferred for the display concept
    if (raw == null) return null;            // both empty → skip

    const medicationConcept: ConceptRef = { raw, brand, generic, normalizedConceptId: null };
    // id key prefers generic (the stable molecule) then brand — per spec.
    const idKey = `${generic ?? brand ?? ''}|prescribed`;
    const rawText = (brand ?? '') + (generic ? ` (${generic})` : '');

    return {
      id: `ma-${djb2(idKey)}`,
      medicationConcept,
      status: 'prescribed',
      dose: orNull(line.dosage),
      strength: orNull(line.strength),
      frequency: orNull(line.frequency),
      route: orNull(line.route_of_administration),
      duration: orNull(line.duration),
      instruction: orNull(line.instruction_to_patient),
      provenance: {
        sourceField: 'individuals-prescriptions.medications',
        rawText,
        extractionMethod: 'reported',
        confidence: 0.95,
      },
      encounterRef: null,
    };
  } catch {
    return null;
  }
}

// NKA / "no known allergy" notations (case/quote/space-insensitive) → a `denied` fact.
const NKA_NOTATIONS: ReadonlySet<string> = new Set([
  'no', 'nil', 'none', 'nka', 'nkda', 'nk',   // 'nk' = not-known (frequent db13 notation)
  'no known allergies', 'no known drug allergies', 'not known',
  'na', 'n/a', 'none known', 'nil known',
]);

/** Map free-text allergies → assertions. null/empty → [] (absence ≠ denied); an NKA notation
 *  → one `denied`; substantive text → one `reported_allergy` (raw preserved; splitting +
 *  reaction parsing deferred to a Stage-0/LLM pass). */
export function allergyTextToAssertions(text: string | null | undefined): AllergyAssertion[] {
  try {
    if (text == null) return [];
    const t = String(text);
    // btrim(lower(text), quotes+space) — quote/space-insensitive normalization for matching.
    const normalized = t.toLowerCase().replace(/^[\s"']+/, '').replace(/[\s"']+$/, '');
    if (normalized === '') return [];        // empty / whitespace / quotes-only → no assertion

    const status: AllergyStatus = NKA_NOTATIONS.has(normalized) ? 'denied' : 'reported_allergy';
    if (status === 'denied') {
      return [{
        id: `aa-${djb2(`${normalized}|denied`)}`,
        substance: { raw: t, normalized: 'no known allergy' },
        status: 'denied',
        provenance: {
          sourceField: 'individuals-prescriptions.patient_details__allergies',
          rawText: t, extractionMethod: 'reported', confidence: 0.9,
        },
        encounterRef: null,
      }];
    }
    return [{
      id: `aa-${djb2(`${normalized}|reported_allergy`)}`,
      substance: { raw: t, normalized: null },
      status: 'reported_allergy',
      reaction: null,
      provenance: {
        sourceField: 'individuals-prescriptions.patient_details__allergies',
        rawText: t, extractionMethod: 'reported', confidence: 0.6,
      },
      encounterRef: null,
    }];
  } catch {
    return [];
  }
}

/** Map a full prescription's medication jsonb (array or JSON string) + allergies free text →
 *  the two assertion arrays. Malformed medications → []; never throws. */
export function prescriptionToAssertions(
  medications: unknown,
  allergiesText?: string | null,
): { medicationAssertions: MedicationAssertion[]; allergyAssertions: AllergyAssertion[] } {
  let arr: unknown[] = [];
  try {
    const parsed = typeof medications === 'string' ? JSON.parse(medications) : medications;
    if (Array.isArray(parsed)) arr = parsed;
  } catch {
    arr = [];
  }
  const medicationAssertions = arr
    .map((line) => (line && typeof line === 'object' ? medicationLineToAssertion(line as Record<string, unknown>) : null))
    .filter((a): a is MedicationAssertion => a !== null);
  const allergyAssertions = allergyTextToAssertions(allergiesText ?? null);
  return { medicationAssertions, allergyAssertions };
}
