// lib/member-state/normalize-core.ts — MemberState Stage 0 normalization. PURE, CONSERVATIVE,
// deterministic. A tiny hand-curated seed dictionary of high-confidence exact/synonym pairs
// ONLY — NOT a terminology service (SNOMED/RXNORM/ICD is a later Stage build). Broader/narrower
// are NEVER auto-merged (diabetes ≠ type-2-diabetes; CKD ≠ CKD-3; "rule out PE" ≠ PE). No
// dictionary hit → `unresolved` (first-class, non-failing). Two unresolved concepts merge ONLY
// when their normalized raw strings are identical (never fuzzily).
//
// The boundary-anchored matcher (ddx-eval/3) is a candidate-generation signal only and is
// deliberately NOT used here: Stage-0 acceptance is an EXACT normalized-key dictionary lookup,
// which can only ever UNDER-merge relative to a fuzzy candidate — the safe direction given the
// false-merge/false-split asymmetry. This keeps the merge authority conservative by construction.

import type { NormalizedConcept } from './schema';
import { NORMALIZATION_VERSION } from './schema';

export type NormalizeDomain = 'problem' | 'medication' | 'allergy' | 'investigation' | 'procedure';

/** Canonical surface form: lowercase, strip punctuation to spaces, collapse whitespace. */
export function normalizeRaw(raw: string): string {
  return (raw || '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

interface SeedEntry { canonicalId: string; relation: 'exact' | 'synonym'; generic?: string }

// ── Seed dictionaries — SMALL and obviously-safe. Stage-0 seed; replaced by the terminology
//    service later. Keys are already-normalized surface forms. Broader/narrower kept DISTINCT
//    (e.g. diabetes-mellitus and type-2-diabetes are SEPARATE canonicals — never merged). ──

const PROBLEM_SEED: Record<string, SeedEntry> = {
  'hypertension': { canonicalId: 'local:hypertension', relation: 'exact' },
  'htn': { canonicalId: 'local:hypertension', relation: 'synonym' },
  'high blood pressure': { canonicalId: 'local:hypertension', relation: 'synonym' },
  'essential hypertension': { canonicalId: 'local:hypertension', relation: 'synonym' },
  'diabetes mellitus': { canonicalId: 'local:diabetes-mellitus', relation: 'exact' },
  'diabetes': { canonicalId: 'local:diabetes-mellitus', relation: 'synonym' },
  'dm': { canonicalId: 'local:diabetes-mellitus', relation: 'synonym' },
  // type-2 is a SEPARATE canonical — a narrower concept, never merged with diabetes-mellitus:
  'type 2 diabetes mellitus': { canonicalId: 'local:type-2-diabetes', relation: 'exact' },
  'type 2 diabetes': { canonicalId: 'local:type-2-diabetes', relation: 'synonym' },
  't2dm': { canonicalId: 'local:type-2-diabetes', relation: 'synonym' },
  'chronic kidney disease': { canonicalId: 'local:ckd', relation: 'exact' },
  'ckd': { canonicalId: 'local:ckd', relation: 'synonym' },
  'pulmonary embolism': { canonicalId: 'local:pulmonary-embolism', relation: 'exact' },
  'pe': { canonicalId: 'local:pulmonary-embolism', relation: 'synonym' },
  'ischemic heart disease': { canonicalId: 'local:ihd', relation: 'exact' },
  'ihd': { canonicalId: 'local:ihd', relation: 'synonym' },
  'coronary artery disease': { canonicalId: 'local:ihd', relation: 'synonym' },
  'hypothyroidism': { canonicalId: 'local:hypothyroidism', relation: 'exact' },
  'bronchial asthma': { canonicalId: 'local:asthma', relation: 'exact' },
  'asthma': { canonicalId: 'local:asthma', relation: 'synonym' },
};

const MEDICATION_SEED: Record<string, SeedEntry> = {
  'paracetamol': { canonicalId: 'local:paracetamol', relation: 'exact', generic: 'paracetamol' },
  'acetaminophen': { canonicalId: 'local:paracetamol', relation: 'synonym', generic: 'paracetamol' },
  'diclofenac': { canonicalId: 'local:diclofenac', relation: 'exact', generic: 'diclofenac' },
  'metformin': { canonicalId: 'local:metformin', relation: 'exact', generic: 'metformin' },
  'amlodipine': { canonicalId: 'local:amlodipine', relation: 'exact', generic: 'amlodipine' },
  'atorvastatin': { canonicalId: 'local:atorvastatin', relation: 'exact', generic: 'atorvastatin' },
  'telmisartan': { canonicalId: 'local:telmisartan', relation: 'exact', generic: 'telmisartan' },
  'pantoprazole': { canonicalId: 'local:pantoprazole', relation: 'exact', generic: 'pantoprazole' },
  'amoxicillin': { canonicalId: 'local:amoxicillin', relation: 'exact', generic: 'amoxicillin' },
  'azithromycin': { canonicalId: 'local:azithromycin', relation: 'exact', generic: 'azithromycin' },
};

const INVESTIGATION_SEED: Record<string, SeedEntry> = {
  'hba1c': { canonicalId: 'local:hba1c', relation: 'exact' },
  'glycated hemoglobin': { canonicalId: 'local:hba1c', relation: 'synonym' },
  'glycosylated haemoglobin': { canonicalId: 'local:hba1c', relation: 'synonym' },
  'creatinine': { canonicalId: 'local:creatinine', relation: 'exact' },
  'serum creatinine': { canonicalId: 'local:creatinine', relation: 'synonym' },
  'hemoglobin': { canonicalId: 'local:hemoglobin', relation: 'exact' },
  'haemoglobin': { canonicalId: 'local:hemoglobin', relation: 'synonym' },
  'hb': { canonicalId: 'local:hemoglobin', relation: 'synonym' },
  'fasting blood sugar': { canonicalId: 'local:fbs', relation: 'exact' },
  'fbs': { canonicalId: 'local:fbs', relation: 'synonym' },
  'egfr': { canonicalId: 'local:egfr', relation: 'exact' },
  'tsh': { canonicalId: 'local:tsh', relation: 'exact' },
};

const ALLERGY_SEED: Record<string, SeedEntry> = {
  'penicillin': { canonicalId: 'local:penicillin', relation: 'exact' },
  'pcn': { canonicalId: 'local:penicillin', relation: 'synonym' },
  'sulfa': { canonicalId: 'local:sulfonamide', relation: 'synonym' },
  'sulphonamide': { canonicalId: 'local:sulfonamide', relation: 'exact' },
};

// ── Procedure seed (1.2, §6.1) — the same conservative posture as every seed above, and for a
//    sharper reason: a false procedure MERGE on the spine says a member had an operation they did
//    not have. So only obviously-identical surface forms of the SAME operation are paired, an
//    approach is never merged with another approach (open ≠ laparoscopic — they are different
//    operations with different risk), and a side is NEVER part of a canonical id (laterality is its
//    own field, from its own source column). Everything else stays `unresolved`, which merges only
//    on an identical normalized raw string.
const PROCEDURE_SEED: Record<string, SeedEntry> = {
  'cholecystectomy': { canonicalId: 'local:cholecystectomy', relation: 'exact' },
  'lap cholecystectomy': { canonicalId: 'local:laparoscopic-cholecystectomy', relation: 'synonym' },
  'laparoscopic cholecystectomy': { canonicalId: 'local:laparoscopic-cholecystectomy', relation: 'exact' },
  'open cholecystectomy': { canonicalId: 'local:open-cholecystectomy', relation: 'exact' },
  'appendicectomy': { canonicalId: 'local:appendicectomy', relation: 'exact' },
  'appendectomy': { canonicalId: 'local:appendicectomy', relation: 'synonym' },
  'laparoscopic appendicectomy': { canonicalId: 'local:laparoscopic-appendicectomy', relation: 'exact' },
  'inguinal hernia repair': { canonicalId: 'local:inguinal-hernia-repair', relation: 'exact' },
  'hernioplasty': { canonicalId: 'local:inguinal-hernia-repair', relation: 'synonym' },
  'lower segment caesarean section': { canonicalId: 'local:lscs', relation: 'exact' },
  'lscs': { canonicalId: 'local:lscs', relation: 'synonym' },
  'total knee replacement': { canonicalId: 'local:total-knee-replacement', relation: 'exact' },
  'tkr': { canonicalId: 'local:total-knee-replacement', relation: 'synonym' },
  'coronary angiography': { canonicalId: 'local:coronary-angiography', relation: 'exact' },
  'upper gi endoscopy': { canonicalId: 'local:upper-gi-endoscopy', relation: 'exact' },
  'ugi endoscopy': { canonicalId: 'local:upper-gi-endoscopy', relation: 'synonym' },
};

const SEEDS: Record<NormalizeDomain, Record<string, SeedEntry>> = {
  problem: PROBLEM_SEED,
  medication: MEDICATION_SEED,
  allergy: ALLERGY_SEED,
  investigation: INVESTIGATION_SEED,
  procedure: PROCEDURE_SEED,
};

/** Resolve a raw surface concept to a NormalizedConcept. EXACT normalized-key dictionary lookup
 *  only — a hit yields exact|synonym; a miss yields `unresolved` (never a fuzzy/broader merge). */
export function normalizeConcept(raw: string, domain: NormalizeDomain): NormalizedConcept {
  const normRaw = normalizeRaw(raw);
  const seed = normRaw ? SEEDS[domain][normRaw] : undefined;
  if (seed) {
    return {
      raw,
      normalizedConceptId: seed.canonicalId,
      relation: seed.relation,
      normalizerVersion: NORMALIZATION_VERSION,
      ...(seed.generic ? { generic: seed.generic } : {}),
    };
  }
  return { raw, normalizedConceptId: null, relation: 'unresolved', normalizerVersion: NORMALIZATION_VERSION };
}

/** Aggregation grouping key: the canonical id when resolved, else `unresolved:<normalized raw>`
 *  — so two unresolved concepts merge ONLY on identical normalized raw, never fuzzily. */
export function groupingKey(nc: NormalizedConcept): string {
  return nc.normalizedConceptId ?? `unresolved:${normalizeRaw(nc.raw)}`;
}
