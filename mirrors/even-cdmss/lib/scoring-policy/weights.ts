/**
 * lib/scoring-policy/weights.ts — NABH completeness weightage: tiers, normalisation, validation.
 *
 * PURE, dependency-free (no db / no json / no llm), unit-testable under
 * `node --experimental-strip-types`. This module and its three siblings are the ONLY place
 * weighted scoring exists. The scoring CORES (lib/opd-note-score-core.ts, lib/value-score-core.ts)
 * stay closed — weighting is a READ LAYER over stored per-field statuses and stored domain scores,
 * never a change to how a score is produced.
 *
 * See CDMSS-SCORING-POLICY-NABH-WEIGHTAGE-PRD-AND-KICKOFF-27-JUL-2026 §2.4, §2.8.
 */

/** Tier is the source of truth; the percentage is DERIVED (PRD §2.4). */
export type Tier = 'critical' | 'important' | 'standard' | 'minor';

export const TIERS: Tier[] = ['critical', 'important', 'standard', 'minor'];

/** PRD §2.4. Minimum is Minor — THERE IS NO ZERO. A field can be made to matter less; it can
 *  never be removed, because NABH mandatoriness is read-only (decision §1.9). */
export const TIER_POINTS: Record<Tier, number> = {
  critical: 8,
  important: 4,
  standard: 2,   // the default, and the tier v1 seeds every field at
  minor: 1,
};

export const TIER_LABEL: Record<Tier, string> = {
  critical: 'Critical', important: 'Important', standard: 'Standard', minor: 'Minor',
};

/** Ascending by weight — the order the four-segment tier control renders in (PRD §5.3). */
export const TIER_ORDER: Tier[] = ['minor', 'standard', 'important', 'critical'];

export const DEFAULT_TIER: Tier = 'standard';

/** A weight vector is field key → tier. Absent key ⇒ Standard (PRD §8.2). */
export type WeightVector = Record<string, Tier>;

export type NoteType = 'discharge_summary' | 'opd_rx';

/** Both note types Phase A ships (decision §1.4). `ot_note` renders locked and is NOT here. */
export const PHASE_A_NOTE_TYPES: NoteType[] = ['discharge_summary', 'opd_rx'];

export function isTier(v: unknown): v is Tier {
  return typeof v === 'string' && (TIERS as string[]).includes(v);
}

/** Coerce anything to a Tier. Unknown/garbage ⇒ Standard, never a throw and never a zero. */
export function asTier(v: unknown): Tier {
  return isTier(v) ? v : DEFAULT_TIER;
}

/** Points for a key under a vector. An unweighted key defaults to Standard (PRD §8.2) — it is
 *  never dropped and never zero-weighted, so a vector that has drifted from the rubric degrades
 *  to equal weighting for the fields it does not mention rather than distorting the score. */
export function pointsFor(vector: WeightVector | null | undefined, key: string): number {
  return TIER_POINTS[asTier(vector?.[key])];
}

/**
 * Derived display percentage per PRD §2.4:
 *
 *     wᵢ = 100 × ptsᵢ ÷ Σ(pts over ALL fields of that note type)
 *
 * NOTE — this normalisation is for DISPLAY AND AUDIT ONLY. The completeness formula (§2.3)
 * renormalises over the APPLICABLE subset per document, and because the same constant appears in
 * that formula's numerator and denominator it cancels exactly. Passing raw tier points to
 * weightedCompleteness() therefore gives an identical result; this function exists so the screen
 * can show a percentage, not because the arithmetic needs one.
 *
 * Returns {} for an empty key list rather than dividing by zero.
 */
export function normalisedWeights(vector: WeightVector | null | undefined, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (!keys.length) return out;
  const total = keys.reduce((s, k) => s + pointsFor(vector, k), 0);
  if (total <= 0) return out;      // unreachable while TIER_POINTS has no zero; defensive anyway
  for (const k of keys) out[k] = (100 * pointsFor(vector, k)) / total;
  return out;
}

/** Every field on Standard — v1, and the fallback whenever the policy layer cannot be read
 *  (PRD §8.1). This vector reproduces legacy unweighted scoring exactly (PRD §2.5). */
export function equalWeights(keys: string[]): WeightVector {
  const out: WeightVector = {};
  for (const k of keys) out[k] = DEFAULT_TIER;
  return out;
}

/** True when two vectors agree on every key in `keys` (absent ⇒ Standard on both sides). */
export function vectorsEqual(a: WeightVector | null | undefined, b: WeightVector | null | undefined, keys: string[]): boolean {
  return keys.every((k) => asTier(a?.[k]) === asTier(b?.[k]));
}

/** The changed fields between two vectors, for the publish diff (PRD §5.4 step 1). */
export function diffVectors(
  from: WeightVector | null | undefined,
  to: WeightVector | null | undefined,
  keys: string[],
): { key: string; from: Tier; to: Tier }[] {
  const out: { key: string; from: Tier; to: Tier }[] = [];
  for (const k of keys) {
    const f = asTier(from?.[k]), t = asTier(to?.[k]);
    if (f !== t) out.push({ key: k, from: f, to: t });
  }
  return out;
}

/**
 * Validate a candidate vector before it is persisted. Rejects nothing that could produce a wrong
 * score — unknown tiers coerce to Standard rather than failing — but DOES reject a non-object, so
 * a malformed publish body cannot overwrite a good vector with garbage.
 */
export function validateVector(v: unknown, keys: string[]): { ok: true; vector: WeightVector } | { ok: false; error: string } {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: 'weights must be an object of field key → tier' };
  const src = v as Record<string, unknown>;
  const vector: WeightVector = {};
  for (const k of keys) vector[k] = asTier(src[k]);
  const unknownKeys = Object.keys(src).filter((k) => !keys.includes(k));
  if (unknownKeys.length > 20) return { ok: false, error: 'weights contain too many unrecognised field keys' };
  return { ok: true, vector };
}

/** PRD §2.8 — `nabh-weights/<note_type>/<n>`. Monotonic per note type. engine_version is NOT
 *  touched by a weights change; the two version lines are deliberately independent (decision §1.8). */
export function weightsVersionString(noteType: string, version: number): string {
  return `nabh-weights/${noteType}/${version}`;
}

/** Deterministic canonical JSON for hashing a vector (keys sorted). The sha256 itself is computed
 *  in the store, which has node:crypto; this stays pure so the tests can assert the canonical form. */
export function canonicalVectorJson(vector: WeightVector, keys: string[]): string {
  const sorted = [...keys].sort();
  return JSON.stringify(sorted.map((k) => [k, asTier(vector[k])]));
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// FIELD CATALOGUES — the key space each note type's vector is defined over
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface FieldDef {
  key: string;
  label: string;
  section: string;
  /** false ⇒ the field is scored in the Continuity domain, not Documentation, and is therefore
   *  EXCLUDED from the completeness weight vector (kickoff normative list; companion spec §4.5). */
  weighted: boolean;
  /** Set when this entry is a near-duplicate of another key — see OPD_NEAR_DUPLICATES. */
  nearDuplicateOf?: string;
}

/**
 * The 21 `discharge_summary` fields. Keys, labels and sections are read VERBATIM from
 * data/nabh-rubric.json (which is on the UNTOUCHED list and was only read), and match PRD §2.9.
 * Order is the rubric's own order; the screen re-orders within a section by missing-count desc.
 */
export const DISCHARGE_SUMMARY_FIELDS: FieldDef[] = [
  { key: 'patient_name', label: 'Patient name', section: 'identifiers', weighted: true },
  { key: 'uhid', label: 'UHID', section: 'identifiers', weighted: true },
  { key: 'treating_doctor', label: 'Treating doctor', section: 'identifiers', weighted: true },
  { key: 'date_admission', label: 'Date of admission', section: 'identifiers', weighted: true },
  { key: 'date_discharge', label: 'Date of discharge', section: 'identifiers', weighted: true },
  { key: 'reason_admission', label: 'Reason for admission', section: 'clinical', weighted: true },
  { key: 'significant_findings', label: 'Significant findings', section: 'clinical', weighted: true },
  { key: 'diagnosis', label: 'Diagnosis', section: 'clinical', weighted: true },
  { key: 'condition_at_discharge', label: 'Condition at discharge', section: 'clinical', weighted: true },
  { key: 'investigations', label: 'Investigation results', section: 'course', weighted: true },
  { key: 'procedures_performed', label: 'Procedures performed', section: 'course', weighted: true },
  { key: 'medications_administered', label: 'Medications administered', section: 'course', weighted: true },
  { key: 'treatment_given', label: 'Other treatment given', section: 'course', weighted: true },
  { key: 'followup_advice', label: 'Follow-up advice', section: 'followup', weighted: true },
  { key: 'discharge_medication', label: 'Discharge medication (with dose/route/duration)', section: 'followup', weighted: true },
  { key: 'patient_instructions', label: 'Patient instructions (understandable language)', section: 'followup', weighted: true },
  { key: 'urgent_care_instructions', label: 'When & how to obtain urgent care', section: 'followup', weighted: true },
  { key: 'outcome', label: 'Discharge outcome (Discharged/LAMA/Referred/Death)', section: 'outcome', weighted: true },
  { key: 'cause_of_death', label: 'Cause of death', section: 'outcome', weighted: true },
  { key: 'doctor_signature', label: 'Doctor name & signature', section: 'signoff', weighted: true },
  { key: 'signed_datetime', label: 'Date & time of signature', section: 'signoff', weighted: true },
];

/** The six sections of §2.9, in render order. */
export const DISCHARGE_SUMMARY_SECTIONS = ['identifiers', 'clinical', 'course', 'followup', 'outcome', 'signoff'] as const;

export const SECTION_LABEL: Record<string, string> = {
  identifiers: 'Identifiers', clinical: 'Clinical', course: 'Course of care',
  followup: 'Follow-up', outcome: 'Outcome', signoff: 'Sign-off',
  documentation: 'Documentation', obstetric: 'Obstetric', continuity: 'Continuity',
};

/**
 * The `opd_rx` catalogue.
 *
 * ⚠️ TWO FLAGS, both reported.
 *
 * (1) THE PRD'S PREMISE IS PARTLY WRONG, IN OUR FAVOUR. §2.10 says "The OPD engine emits only
 *     display labels in `missing_fields`. It must begin emitting a structured array". It already
 *     emits KEYS: lib/opd-note-audit-core.ts `OpdCompletenessItem` is
 *     `{key, label, present, mandatory}`. What it lacks against IPD is a four-valued `status`
 *     (it has a boolean `present`), a `section`, and a `note`. This build ADDS those alongside the
 *     existing fields — it does not invent a key space, and the keys below are the engine's own.
 *
 * (2) NEAR-DUPLICATES ARE KEPT SEPARATE, AS INSTRUCTED — but note what the live engine does.
 *     `presenting_complaint` and `presenting_complaint_symptoms` are listed as two entries per the
 *     kickoff ("do NOT merge … emit both and flag them"). In the LIVE ENGINE, however, the GP path
 *     (label "Presenting complaint") and the obstetric path (label "Presenting complaint /
 *     symptoms") BOTH emit the single key `presenting_complaint`. The second entry therefore
 *     preserves the historical label distinction for reading old `missing_fields` strings, but no
 *     NEW audit will carry it. Merging them in the engine is a PRD decision, not a build one.
 *     `advice_given` / `advice_instructions` are genuinely two keys, and both are continuity.
 *
 * (3) `relevant_history` and `allergy_status` are HISTORICAL — the current engine removed them
 *     (they false-flagged ~100% of notes; see lib/opd-note-audit-core.ts). They stay in the
 *     catalogue so historical audits remain interpretable, and so the admin screen does not
 *     silently drop a field that older stored rows still carry.
 */
export const OPD_RX_FIELDS: FieldDef[] = [
  // ── Documentation — weighted ──
  { key: 'presenting_complaint', label: 'Presenting complaint', section: 'documentation', weighted: true },
  { key: 'presenting_complaint_symptoms', label: 'Presenting complaint / symptoms', section: 'documentation', weighted: true, nearDuplicateOf: 'presenting_complaint' },
  { key: 'relevant_history', label: 'Relevant history', section: 'documentation', weighted: true },
  { key: 'examination', label: 'Examination recorded', section: 'documentation', weighted: true },
  { key: 'vitals', label: 'Vitals for the presentation (e.g. temperature for fever)', section: 'documentation', weighted: true },
  { key: 'diagnosis', label: 'Diagnosis / impression', section: 'documentation', weighted: true },
  { key: 'allergy_status', label: 'Allergy status documented', section: 'documentation', weighted: true },
  { key: 'medication_dosing', label: 'Complete medication dosing', section: 'documentation', weighted: true },
  { key: 'investigations', label: 'Investigations ordered/reviewed or nil', section: 'documentation', weighted: true },
  // ── Documentation, obstetric-conditional — weighted ──
  { key: 'obstetric_vitals', label: 'Obstetric exam / vitals (weight + fetal SFH/FHR/presentation)', section: 'obstetric', weighted: true },
  { key: 'gravidity_parity', label: 'Gravidity & parity', section: 'obstetric', weighted: true },
  { key: 'lmp_edd', label: 'LMP and/or EDD', section: 'obstetric', weighted: true },
  { key: 'ga_pog', label: 'Gestational age / POG', section: 'obstetric', weighted: true },
  // ── Continuity — NOT weighted here (kickoff: EXCLUDE from the OPD weight vector) ──
  { key: 'advice_given', label: 'Advice / plan', section: 'continuity', weighted: false },
  { key: 'advice_instructions', label: 'Advice / instructions', section: 'continuity', weighted: false, nearDuplicateOf: 'advice_given' },
  { key: 'follow_up', label: 'Follow-up specified', section: 'continuity', weighted: false },
];

/** The two near-duplicate pairs, surfaced so the screen can badge them rather than hide them. */
export const OPD_NEAR_DUPLICATES: { keep: string; duplicate: string }[] = [
  { keep: 'presenting_complaint', duplicate: 'presenting_complaint_symptoms' },
  { keep: 'advice_given', duplicate: 'advice_instructions' },
];

/**
 * LABEL → KEY for the OPD engine's historical `missing_fields` (which stores display labels only).
 * Every label is VERBATIM from the companion spec §4.7's live-observed set, plus the engine's own
 * current label strings. Matching is exact-then-normalised (see labelToOpdKey).
 */
export const OPD_LABEL_TO_KEY: Record<string, string> = {
  'Presenting complaint': 'presenting_complaint',
  'Presenting complaint / symptoms': 'presenting_complaint_symptoms',
  'Relevant history': 'relevant_history',
  'Examination recorded': 'examination',
  'Vitals for the presentation (e.g. temperature for fever)': 'vitals',
  'Diagnosis / impression': 'diagnosis',
  'Allergy status documented': 'allergy_status',
  'Complete medication dosing': 'medication_dosing',
  'Investigations ordered/reviewed or nil': 'investigations',
  'Investigations ordered / reviewed or nil': 'investigations',
  'Gravidity & parity': 'gravidity_parity',
  'LMP and/or EDD': 'lmp_edd',
  'LMP and / or EDD': 'lmp_edd',
  'Gestational age / POG': 'ga_pog',
  'Advice / plan': 'advice_given',
  'Advice / instructions': 'advice_instructions',
  'Follow-up specified': 'follow_up',
};

/**
 * Resolve a stored label to a key. `obstetric_vitals` carries a DYNAMICALLY BUILT label —
 * lib/opd-note-audit-core.ts composes `Obstetric exam / vitals (weight[ + fetal …][ · BP recorded])`
 * from the trimester and whether BP appeared — so it is matched by prefix, not by table lookup.
 * Unknown labels return null rather than guessing (an unknown key defaults to Standard anyway).
 */
export function labelToOpdKey(label: string): string | null {
  const raw = String(label ?? '').trim();
  if (!raw) return null;
  if (OPD_LABEL_TO_KEY[raw]) return OPD_LABEL_TO_KEY[raw];
  if (/^Obstetric exam ?\/ ?vitals/i.test(raw)) return 'obstetric_vitals';
  const norm = raw.toLowerCase().replace(/\s+/g, ' ');
  for (const [k, v] of Object.entries(OPD_LABEL_TO_KEY)) {
    if (k.toLowerCase().replace(/\s+/g, ' ') === norm) return v;
  }
  return null;
}

export function fieldsFor(noteType: string): FieldDef[] {
  // `lab_packages` (Phase C) reuses this versioning table but has NO field catalogue — its stored
  // value is a package ARRAY, not a {fieldKey: tier} object. Returning [] rather than silently
  // handing back the discharge-summary catalogue keeps the two shapes from ever being conflated.
  if (noteType === 'lab_packages') return [];
  return noteType === 'opd_rx' ? OPD_RX_FIELDS : DISCHARGE_SUMMARY_FIELDS;
}

/** The keys a vector is defined over — the WEIGHTED subset only. Continuity fields are excluded
 *  from the vector entirely so they can never be given a completeness weight by accident. */
export function weightedKeysFor(noteType: string): string[] {
  return fieldsFor(noteType).filter((f) => f.weighted).map((f) => f.key);
}

export function labelFor(noteType: string, key: string): string {
  return fieldsFor(noteType).find((f) => f.key === key)?.label ?? key;
}
