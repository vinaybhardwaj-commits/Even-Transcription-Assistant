// lib/member-state/schema.ts — MemberState Stage 0: the Plane-1 longitudinal clinical
// projection (member-state/1.0). PURE: no ./db, no ./llm, no I/O — zod for runtime validation
// only; loadable under `node --experimental-strip-types`. Mirrors clinical-state/schema.ts.
//
// CONSUMED BY NO LIVE ENGINE. Stage 0 is the pure aggregation/reconciliation core + a read-only
// shadow; there is no route, no UI, no flag. Managed-Care rendering (Stage 2) and OPD-Audit
// consumption (Stage 3) come later; open-loops (Plane 3) and trend/velocity (Stage 4+) are out.
//
// Reuses ConceptRef / Provenance / MedicationAssertion / AllergyAssertion / MedicationStatus /
// AllergyStatus from clinical-state (TYPE-ONLY imports — clinical-state is never modified).
//
// NORMALIZED-CONCEPT NOTE: the PRD types LongitudinalProblem/Medication/Investigation concept
// fields as `ConceptRef`, but §2.2 + invariant 3 ("every merge cites a normalizerVersion +
// relation") require the resolved concept to carry `relation` + `normalizerVersion`. ConceptRef
// has neither, so we reuse it as the base and extend it into `NormalizedConcept` (a superset —
// a NormalizedConcept IS a ConceptRef). Additive, faithful to "reuse ConceptRef".

import { z } from 'zod';
import type {
  ConceptRef, Provenance, MedicationAssertion, AllergyAssertion,
  MedicationStatus, AllergyStatus, StopReason, ComplaintStatusAssertion, FollowUpAssertion,
} from '../clinical-state/schema';
import { zFollowUpAssertion } from '../clinical-state/schema';

export const MEMBER_STATE_VERSION = 'member-state/1.1' as const;
export const NORMALIZATION_VERSION = 'member-norm/0.1' as const;
export const RECONCILIATION_VERSION = 'member-reconcile/0.2' as const;

// ── Normalized concept (superset of the reused ConceptRef; carries the merge decision) ──
export type NormalizationRelation = 'exact' | 'synonym' | 'broader' | 'narrower' | 'related' | 'unresolved';
export interface NormalizedConcept extends ConceptRef {
  relation: NormalizationRelation;   // Stage 0 emits only exact | synonym | unresolved (| related, flagged-not-merged)
  normalizerVersion: string;
}

// ── Immutable per-encounter evidence (the source of truth; projection is derived) ──
export interface EncounterEvidence {
  encounterRef: string;              // opaque (prescription uid / booking id / care-call id)
  date: string;                      // ISO date, as stated
  kind: 'opd' | 'lab' | 'care_call'; // 1.1: care_call = the patient-reported return channel (CCB)
  problems: { conceptRaw: string; icdCode?: string | null; explicitStatus?: 'active' | 'resolved' | null; provenance: Provenance }[];
  medicationAssertions: MedicationAssertion[];
  allergyAssertions: AllergyAssertion[];
  investigations: { analyteRaw: string; value: string; unit?: string | null; abnormal?: string | null; provenance: Provenance }[];
  demographics?: { age?: number | null; sex?: 'F' | 'M' | null };
  complaintStatuses?: ComplaintStatusAssertion[];   // 1.1 (optional) — patient-reported symptom outcome
  followUps?: FollowUpAssertion[];                   // 1.1 (optional) — carried onto the snapshot, no overlay
}

export interface MemberEvidence {
  memberRef: string;                 // opaque individual_uid; identifier-free downstream
  encounters: EncounterEvidence[];   // immutable
  sourceWatermarks: Record<string, string>;
  generatedAt: string;               // passed in
}

// ── Longitudinal primitives (Plane 1) ──
export type LongitudinalStatus = 'documented_active' | 'documented_resolved' | 'historical' | 'uncertain_current_status';
export type ProblemCourse = 'single_episode' | 'recurrent' | 'persistent' | 'uncertain';

export interface ProblemOccurrence { encounterRef: string; date: string; status: LongitudinalStatus; provenance: Provenance }
export interface LongitudinalProblem {
  normalizedConcept: NormalizedConcept;
  latestDocumentedStatus: LongitudinalStatus;   // fact (from the latest occurrence)
  latestStatusAt: string;
  firstDocumentedAt: string;
  lastDocumentedAt: string;
  course: ProblemCourse;                        // derived
  currentStatusConfidence: number;              // inference, not fact
  occurrences: ProblemOccurrence[];
}

export interface MedicationOccurrence { encounterRef: string; date: string; dose?: string | null; frequency?: string | null; route?: string | null; duration?: string | null; stopReason?: StopReason | null; provenance: Provenance }
export interface LongitudinalMedication {
  normalizedConcept: NormalizedConcept;
  status: MedicationStatus;          // mostly 'prescribed'; currentness left 'unknown'
  firstSeen: string;
  lastSeen: string;
  occurrences: MedicationOccurrence[];
}

export interface AllergyOccurrence { encounterRef: string; date: string; status: AllergyStatus; reaction?: string | null; provenance: Provenance }
export interface LongitudinalAllergy {
  substance: { raw: string; normalized?: string | null };
  status: AllergyStatus;             // reconciled; a conflict also emits a Discrepancy
  occurrences: AllergyOccurrence[];
}

export interface InvestigationPoint { encounterRef: string; date: string; value: string; unit?: string | null; abnormal?: string | null; provenance: Provenance }
export interface LongitudinalInvestigation {
  normalizedAnalyte: NormalizedConcept;
  unit?: string | null;              // the consistent unit, or null when mixed (+ a value_conflict Discrepancy)
  series: InvestigationPoint[];      // date-sorted; NO trend/velocity in Stage 0
}

// ── Conflicts (never resolved in Stage 0) ──
export interface EvidenceRef { encounterRef: string; date: string; detail: string }
export interface Discrepancy {
  id: string;
  domain: 'problem' | 'medication' | 'allergy' | 'investigation' | 'demographic';
  type: 'status_conflict' | 'value_conflict' | 'identity_conflict' | 'temporal_conflict' | 'source_conflict';
  assertions: EvidenceRef[];
  severity: 'informational' | 'review' | 'safety_critical';
  resolutionStatus: 'open';          // Stage 0 never resolves
}

export interface MemberStateSnapshot {
  version: typeof MEMBER_STATE_VERSION;
  normalizationVersion: string;
  reconciliationVersion: string;
  computedAt: string;                // passed in
  asOf: string;                      // = max encounter date
  sourceWatermarks: Record<string, string>;
  problems: LongitudinalProblem[];
  medications: LongitudinalMedication[];
  allergies: LongitudinalAllergy[];
  investigations: LongitudinalInvestigation[];
  conflicts: Discrepancy[];
  followUps: FollowUpAssertion[];    // 1.1 — carried (deduped by id), NO care-coordination overlay (Plane 3, later)
  sourceEncounterRefs: string[];
}

// ── zod (permissive where mirroring foreign clinical-state types) ──────────────────
const zProvenance = z.object({
  sourceField: z.string(),
  rawText: z.string(),
  extractionMethod: z.string(),
  confidence: z.number(),
}).passthrough();

const zNormalizedConcept = z.object({
  raw: z.string(),
  brand: z.string().optional(),
  generic: z.string().optional(),
  normalizedConceptId: z.string().nullable().optional(),
  relation: z.enum(['exact', 'synonym', 'broader', 'narrower', 'related', 'unresolved']),
  normalizerVersion: z.string(),
}).passthrough();

const zStatus = z.enum(['documented_active', 'documented_resolved', 'historical', 'uncertain_current_status']);
const zMedStatus = z.enum(['prescribed', 'reported_taking', 'administered', 'stopped', 'not_taking', 'unknown']);
const zAllergyStatus = z.enum(['reported_allergy', 'denied', 'historical', 'entered_in_error', 'unknown']);

const zLongitudinalProblem = z.object({
  normalizedConcept: zNormalizedConcept,
  latestDocumentedStatus: zStatus,
  latestStatusAt: z.string(),
  firstDocumentedAt: z.string(),
  lastDocumentedAt: z.string(),
  course: z.enum(['single_episode', 'recurrent', 'persistent', 'uncertain']),
  currentStatusConfidence: z.number(),
  occurrences: z.array(z.object({
    encounterRef: z.string(), date: z.string(), status: zStatus, provenance: zProvenance,
  }).passthrough()),
}).passthrough();

const zLongitudinalMedication = z.object({
  normalizedConcept: zNormalizedConcept,
  status: zMedStatus,
  firstSeen: z.string(),
  lastSeen: z.string(),
  occurrences: z.array(z.object({
    encounterRef: z.string(), date: z.string(),
    dose: z.string().nullable().optional(), frequency: z.string().nullable().optional(),
    route: z.string().nullable().optional(), duration: z.string().nullable().optional(),
    provenance: zProvenance,
  }).passthrough()),
}).passthrough();

const zLongitudinalAllergy = z.object({
  substance: z.object({ raw: z.string(), normalized: z.string().nullable().optional() }).passthrough(),
  status: zAllergyStatus,
  occurrences: z.array(z.object({
    encounterRef: z.string(), date: z.string(), status: zAllergyStatus,
    reaction: z.string().nullable().optional(), provenance: zProvenance,
  }).passthrough()),
}).passthrough();

const zLongitudinalInvestigation = z.object({
  normalizedAnalyte: zNormalizedConcept,
  unit: z.string().nullable().optional(),
  series: z.array(z.object({
    encounterRef: z.string(), date: z.string(), value: z.string(),
    unit: z.string().nullable().optional(), abnormal: z.string().nullable().optional(), provenance: zProvenance,
  }).passthrough()),
}).passthrough();

const zDiscrepancy = z.object({
  id: z.string().min(1),
  domain: z.enum(['problem', 'medication', 'allergy', 'investigation', 'demographic']),
  type: z.enum(['status_conflict', 'value_conflict', 'identity_conflict', 'temporal_conflict', 'source_conflict']),
  assertions: z.array(z.object({ encounterRef: z.string(), date: z.string(), detail: z.string() }).passthrough()),
  severity: z.enum(['informational', 'review', 'safety_critical']),
  resolutionStatus: z.literal('open'),
}).passthrough();

export const zMemberStateSnapshot = z.object({
  version: z.literal(MEMBER_STATE_VERSION),
  normalizationVersion: z.string(),
  reconciliationVersion: z.string(),
  computedAt: z.string(),
  asOf: z.string(),
  sourceWatermarks: z.record(z.string()),
  problems: z.array(zLongitudinalProblem),
  medications: z.array(zLongitudinalMedication),
  allergies: z.array(zLongitudinalAllergy),
  investigations: z.array(zLongitudinalInvestigation),
  conflicts: z.array(zDiscrepancy),
  followUps: z.array(zFollowUpAssertion),
  sourceEncounterRefs: z.array(z.string()),
}).strict();

/** Validate an unknown value as a MemberStateSnapshot (throws ZodError on mismatch). */
export function validateMemberStateSnapshot(x: unknown): MemberStateSnapshot {
  return zMemberStateSnapshot.parse(x) as MemberStateSnapshot;
}

/** An empty snapshot — computedAt + asOf are PASSED IN (no Date.now(); invariant 7). */
export function emptyMemberStateSnapshot(computedAt: string, asOf: string): MemberStateSnapshot {
  return {
    version: MEMBER_STATE_VERSION,
    normalizationVersion: NORMALIZATION_VERSION,
    reconciliationVersion: RECONCILIATION_VERSION,
    computedAt,
    asOf,
    sourceWatermarks: {},
    problems: [],
    medications: [],
    allergies: [],
    investigations: [],
    conflicts: [],
    followUps: [],
    sourceEncounterRefs: [],
  };
}
