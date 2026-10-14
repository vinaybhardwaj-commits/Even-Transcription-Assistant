// lib/clinical-state/schema.ts — ClinicalState v1.0: the canonical, universal CDMSS
// patient representation (shared core + per-surface extensions). PURE: no ./db, no
// ./llm, no I/O — zod for runtime validation only. Phase 1a builds and proves this
// schema (DDx trace + document-audit-family adapters); nothing consumes it live yet.
//
// Design rule: surfaces extend via `ext` (an open discriminated union) — they never
// fork the core. Cross-surface types (TimelineItem, InvestigationFinding, AdminFacts)
// are imported TYPE-ONLY from their owning modules; zod mirrors them permissively so
// this schema never breaks when an owning module adds a field.

import { z } from 'zod';
import type { TimelineItem } from '../ccb-dossier-core';
import type { InvestigationFinding } from '../investigations';
import type { AdminFacts } from '../doc-audit-core';

export const CLINICAL_STATE_VERSION = 'clinical-state/1.2' as const;

export type Surface = 'ddx' | 'note_audit' | 'doc_audit' | 'concordance' | 'appropriateness' | 'ask' | 'other';
export type FindingStatus = 'present' | 'absent' | 'unknown' | 'historical' | 'resolved';
export type ExtractionMethod = 'deterministic' | 'llm' | 'reported';

export interface Temporality {
  onset?: string;      // "2 hours ago", "since Tuesday" — as stated
  duration?: string;   // "for 2 hours", "x 3 days"
  sequence?: number;   // ordinal within the narrative when derivable
  course?: string;     // "worsening", "intermittent"
}

// ── Trust axis (1.2) — WHO said it + how trustworthy the channel is. Additive + OPTIONAL, so
//    every existing Provenance stays byte-compatible. The reconciliation engine weighs
//    patient_reported vs structured_db vs clinician_documented (e.g. patient "I stopped my statin"
//    overrides a stale prescription default). ──
export type Reporter = 'clinician' | 'patient_via_care_manager' | 'system' | 'unknown';
export type Trust = 'structured_db' | 'clinician_documented' | 'patient_reported' | 'inferred';

/** Every finding knows where it came from — the span, the method, the confidence, and (1.2) the
 *  reporter + trust channel. */
export interface Provenance {
  sourceField: string;              // e.g. 'history', 'exam', 'opd_note_audits.findings'
  rawText: string;                  // the literal source text this finding rests on
  startOffset?: number;
  endOffset?: number;
  extractionMethod: ExtractionMethod;
  confidence: number;               // 0..1
  reporter?: Reporter;              // NEW (optional) — who reported it
  trust?: Trust;                    // NEW (optional) — the trust weight of the channel
}

// ── Typed medication & allergy assertions (1.1) — additive; the typed representation
//    MemberState (Stage 0) reconciles across encounters. A prescription is not proof the
//    patient is taking it, so status is a first-class field; `medications: string[]` stays. ──

export type MedicationStatus = 'prescribed' | 'reported_taking' | 'administered' | 'stopped' | 'not_taking' | 'unknown';
export type AllergyStatus = 'reported_allergy' | 'denied' | 'historical' | 'entered_in_error' | 'unknown';

/** Lightweight concept reference — brand/generic as the source carries them.
 *  `normalizedConceptId` is reserved (null) for the Stage-0 NormalizedConcept service. */
export interface ConceptRef { raw: string; brand?: string; generic?: string; normalizedConceptId?: string | null }

export interface MedicationAssertion {
  id: string;
  medicationConcept: ConceptRef;
  status: MedicationStatus;
  dose?: string | null;
  strength?: string | null;
  frequency?: string | null;      // as stated, e.g. "1-0-1"
  route?: string | null;
  duration?: string | null;
  instruction?: string | null;
  stopReason?: StopReason | null;  // 1.2 — populated when a patient-reported 'stopped' carries a reason
  provenance: Provenance;
  encounterRef?: string | null;   // unset in 1.1 (single-encounter); Stage 0 populates it
}

// ── Patient-reported vocabulary (1.2) — canonical enums (verbatim from the Care-Call PRD §2 so
//    the CCB return channel IMPORTS these rather than duplicating them) + their assertion types.
//    These are assertion TYPES consumed at the member-state layer; emptyClinicalState is unaffected. ──
export type ComplaintStatus = 'resolved' | 'improving' | 'unchanged' | 'worse';
export type FollowUpAction = 'committed' | 'already_done_inhouse' | 'already_done_outside' | 'declined' | 'undecided';
export type StopReason = 'side_effect' | 'cost' | 'felt_better' | 'ran_out' | 'other';

export interface ComplaintStatusAssertion {
  id: string;
  concept: { raw: string; normalizedConceptId?: string | null };
  status: ComplaintStatus;
  provenance: Provenance;
  encounterRef?: string | null;
}

export interface FollowUpAssertion {
  id: string;
  subject: string;
  action: FollowUpAction;
  targetDate?: string | null;
  provenance: Provenance;
  encounterRef?: string | null;
}

export interface AllergyAssertion {
  id: string;
  substance: { raw: string; normalized?: string | null };
  status: AllergyStatus;
  reaction?: string | null;
  severity?: string | null;
  provenance: Provenance;
  encounterRef?: string | null;
}

/** Audit extension — carries BOTH audit engines' vocabularies verbatim (never collapsed):
 *  OPD note-audit uses verdict/domain/source/informational/signalType/findingRef;
 *  Case Audit (doc-audit) uses netValue (its `verdict: NetValue`) + its own domain.
 *  `extra` preserves any engine fields the typed slots don't model (lossless round-trip). */
export interface AuditExtension {
  kind: 'audit';
  verdict?: string;
  domain?: string;
  netValue?: string;
  signalType?: string;
  findingRef?: string;
  citationIds?: number[];
  source?: string;
  informational?: boolean;
  extra?: Record<string, unknown>;
}

/** Reserved: DDx uses the shared core only in 1a. */
export interface DdxExtension { kind: 'ddx' }

/** Open union — future surfaces add members ({kind:'concordance'…}), never fork the core. */
export type SurfaceExtension = AuditExtension | DdxExtension;

export interface ClinicalFinding {
  id: string;
  concept: string;
  normalizedConcept?: string;
  status: FindingStatus;
  value?: string;
  unit?: string | null;
  temporality?: Temporality;
  provenance: Provenance;
  ext?: SurfaceExtension;
  /**
   * The source span reads as a negation while the model labelled it 'present'. NOT A VERDICT —
   * "absent distal pulses" and "absent bowel sounds" are genuine positive signs that trip the same
   * cue, and both are cannot-miss findings in red-flag cases. Consumers must render a CAUTION and
   * must never suppress, filter or reorder on this field: an earlier build used the identical
   * detection to DROP these findings and lost exactly those two signs, which is why this is a mark
   * and not a gate. Absent ⇒ the cue did not fire, which is not evidence the polarity is right.
   */
  polaritySuspect?: true;
}

export interface Demographics {
  age?: number | null;
  ageBand?: string | null;   // coarse decade band, mirrors concordance-core extractDemographics
  sex?: 'F' | 'M' | null;
  sexRaw?: string | null;    // as stated ("male", "f", …) — never lose the source form
}

export interface Instability {
  unstable: boolean;                 // retained; === (assessment === 'unstable')
  reasons: string[];                 // e.g. "SBP 82 < 90"; unchanged semantics
  assessment: 'unstable' | 'no_instability_detected' | 'not_assessable';
  assessedInputs: string[];          // display channels present, e.g. ['BP','HR','SpO₂','RR','T']
  missingInputs: string[];           // display channels absent
}

export interface ClinicalState {
  version: typeof CLINICAL_STATE_VERSION;
  surface: Surface;
  demographics: Demographics;
  timeline: TimelineItem[];
  positives: ClinicalFinding[];
  negatives: ClinicalFinding[];
  unknowns: ClinicalFinding[];
  riskFactors: string[];
  exposures: string[];
  medications: string[];
  investigations: InvestigationFinding[];
  procedures?: string[];
  disposition?: string | null;
  instability: Instability;
  medicationAssertions: MedicationAssertion[];
  allergyAssertions: AllergyAssertion[];
  missingCriticalData: string[];
  adminFacts?: AdminFacts;
  /** Per-surface passthrough for narrative/administrative fields the clinical core
   *  deliberately doesn't model (e.g. doc-audit's courseSummary/completeness/aftercare).
   *  Exists so a discharge/OT case round-trips LOSSLESSLY without polluting the core. */
  surfaceExtras?: Record<string, unknown>;
}

// ── zod runtime validators (permissive where they mirror foreign types) ──

const zTemporality = z.object({
  onset: z.string().optional(),
  duration: z.string().optional(),
  sequence: z.number().optional(),
  course: z.string().optional(),
}).strict();

const zProvenance = z.object({
  sourceField: z.string().min(1),
  rawText: z.string(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  extractionMethod: z.enum(['deterministic', 'llm', 'reported']),
  confidence: z.number().min(0).max(1),
  reporter: z.enum(['clinician', 'patient_via_care_manager', 'system', 'unknown']).optional(),   // 1.2
  trust: z.enum(['structured_db', 'clinician_documented', 'patient_reported', 'inferred']).optional(), // 1.2
}).strict();

const zConceptRef = z.object({
  raw: z.string(),
  brand: z.string().optional(),
  generic: z.string().optional(),
  normalizedConceptId: z.string().nullable().optional(),
}).strict();

const zMedicationAssertion = z.object({
  id: z.string().min(1),
  medicationConcept: zConceptRef,
  status: z.enum(['prescribed', 'reported_taking', 'administered', 'stopped', 'not_taking', 'unknown']),
  dose: z.string().nullable().optional(),
  strength: z.string().nullable().optional(),
  frequency: z.string().nullable().optional(),
  route: z.string().nullable().optional(),
  duration: z.string().nullable().optional(),
  instruction: z.string().nullable().optional(),
  stopReason: z.enum(['side_effect', 'cost', 'felt_better', 'ran_out', 'other']).nullable().optional(),   // 1.2
  provenance: zProvenance,
  encounterRef: z.string().nullable().optional(),
}).strict();

const zAllergyAssertion = z.object({
  id: z.string().min(1),
  substance: z.object({ raw: z.string(), normalized: z.string().nullable().optional() }).strict(),
  status: z.enum(['reported_allergy', 'denied', 'historical', 'entered_in_error', 'unknown']),
  reaction: z.string().nullable().optional(),
  severity: z.string().nullable().optional(),
  provenance: zProvenance,
  encounterRef: z.string().nullable().optional(),
}).strict();

// ── Patient-reported assertion validators (1.2) — exported so member-state + the CCB thread reuse them. ──
export const zComplaintStatusAssertion = z.object({
  id: z.string().min(1),
  concept: z.object({ raw: z.string(), normalizedConceptId: z.string().nullable().optional() }).strict(),
  status: z.enum(['resolved', 'improving', 'unchanged', 'worse']),
  provenance: zProvenance,
  encounterRef: z.string().nullable().optional(),
}).strict();

export const zFollowUpAssertion = z.object({
  id: z.string().min(1),
  subject: z.string(),
  action: z.enum(['committed', 'already_done_inhouse', 'already_done_outside', 'declined', 'undecided']),
  targetDate: z.string().nullable().optional(),
  provenance: zProvenance,
  encounterRef: z.string().nullable().optional(),
}).strict();

const zAuditExt = z.object({
  kind: z.literal('audit'),
  verdict: z.string().optional(),
  domain: z.string().optional(),
  netValue: z.string().optional(),
  signalType: z.string().optional(),
  findingRef: z.string().optional(),
  citationIds: z.array(z.number().int()).optional(),
  source: z.string().optional(),
  informational: z.boolean().optional(),
  extra: z.record(z.unknown()).optional(),
}).strict();

const zDdxExt = z.object({ kind: z.literal('ddx') }).strict();

export const zSurfaceExtension = z.discriminatedUnion('kind', [zAuditExt, zDdxExt]);

export const zClinicalFinding = z.object({
  id: z.string().min(1),
  concept: z.string().min(1),
  normalizedConcept: z.string().optional(),
  status: z.enum(['present', 'absent', 'unknown', 'historical', 'resolved']),
  value: z.string().optional(),
  unit: z.string().nullable().optional(),
  temporality: zTemporality.optional(),
  provenance: zProvenance,
  ext: zSurfaceExtension.optional(),
  polaritySuspect: z.literal(true).optional(),
}).strict();

// Foreign shapes mirrored permissively (passthrough: owning modules may add fields).
const zTimelineItem = z.object({
  date: z.string().nullable(),
  kind: z.string(),
  title: z.string(),
  subtitle: z.string().nullable(),
  refUid: z.string().nullable(),
  docUrl: z.string().optional(),
}).passthrough();

const zInvestigationFinding = z.object({
  test: z.string(),
  value: z.string(),
  unit: z.string().nullable().optional(),
  flag: z.string(),
  category: z.string(),
  note: z.string().nullable().optional(),
}).passthrough();

const zAdminFacts = z.object({
  lengthOfStayDays: z.number().nullable(),
  admissionType: z.string().nullable(),
  careSetting: z.string().nullable(),
}).passthrough();

export const zClinicalState = z.object({
  version: z.literal(CLINICAL_STATE_VERSION),
  surface: z.enum(['ddx', 'note_audit', 'doc_audit', 'concordance', 'appropriateness', 'ask', 'other']),
  demographics: z.object({
    age: z.number().nullable().optional(),
    ageBand: z.string().nullable().optional(),
    sex: z.enum(['F', 'M']).nullable().optional(),
    sexRaw: z.string().nullable().optional(),
  }).strict(),
  timeline: z.array(zTimelineItem),
  positives: z.array(zClinicalFinding),
  negatives: z.array(zClinicalFinding),
  unknowns: z.array(zClinicalFinding),
  riskFactors: z.array(z.string()),
  exposures: z.array(z.string()),
  medications: z.array(z.string()),
  investigations: z.array(zInvestigationFinding),
  procedures: z.array(z.string()).optional(),
  disposition: z.string().nullable().optional(),
  instability: z.object({
    unstable: z.boolean(),
    reasons: z.array(z.string()),
    assessment: z.enum(['unstable', 'no_instability_detected', 'not_assessable']),
    assessedInputs: z.array(z.string()),
    missingInputs: z.array(z.string()),
  }).strict(),
  medicationAssertions: z.array(zMedicationAssertion),
  allergyAssertions: z.array(zAllergyAssertion),
  missingCriticalData: z.array(z.string()),
  adminFacts: zAdminFacts.optional(),
  surfaceExtras: z.record(z.unknown()).optional(),
}).strict();

/** Validate an unknown value as a ClinicalState (throws ZodError on mismatch). */
export function validateClinicalState(x: unknown): ClinicalState {
  return zClinicalState.parse(x) as ClinicalState;
}

/** An empty state for a surface — every builder starts here. */
export function emptyClinicalState(surface: Surface): ClinicalState {
  return {
    version: CLINICAL_STATE_VERSION,
    surface,
    demographics: {},
    timeline: [],
    positives: [],
    negatives: [],
    unknowns: [],
    riskFactors: [],
    exposures: [],
    medications: [],
    investigations: [],
    instability: { unstable: false, reasons: [], assessment: 'not_assessable', assessedInputs: [], missingInputs: ['BP', 'HR', 'SpO₂', 'RR', 'T'] },
    medicationAssertions: [],
    allergyAssertions: [],
    missingCriticalData: [],
  };
}

/** Deterministic finding id — djb2 over concept|sourceField|status (stable across runs). */
export function mkFindingId(concept: string, sourceField: string, status: FindingStatus): string {
  const s = `${concept.toLowerCase()}|${sourceField}|${status}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return `cf-${h.toString(16)}`;
}

/** Counts block for the trace event — never ship the arithmetic twice. */
export function stateCounts(s: ClinicalState): Record<string, number> {
  return {
    positives: s.positives.length,
    negatives: s.negatives.length,
    unknowns: s.unknowns.length,
    investigations: s.investigations.length,
    timeline: s.timeline.length,
    riskFactors: s.riskFactors.length,
    medications: s.medications.length,
    missingCriticalData: s.missingCriticalData.length,
  };
}
