// lib/episode-state/schema.ts — EpisodeState v0.1: the IPD analogue of the two shipped
// projections (ClinicalState per-encounter, MemberState longitudinal). EpisodeState brackets ONE
// admission as three phases — pre → intra → post — as a governed, versioned, DE-IDENTIFIED,
// FACTS-ONLY projection. PURE: no ./db, no ./llm, no I/O; zod for runtime validation only.
//
// SL1 populates INTRA ONLY (the reproducible in-hospital core assembled from the doc-audit extract
// + the kx envelope). `pre` and `post` are TYPED here and left EMPTY — SL4 fills them.
//
// FACTS-ONLY (the project's core principle — clinical facts stay separate from audit/prediction):
// no scored bands, no CVI, no prediction anywhere in this namespace. Every asserted fact carries
// Provenance {sourceField, rawText, extractionMethod, confidence}; the builder enforces the
// verbatim-substring no-fabrication discipline (rawText must occur in its cited source), exactly as
// ClinicalState does. DE-IDENTIFIED: link-back keys (episodeRef = ip_uid) + documented facts only —
// never a patient name, UHID, or URL. This namespace defines its OWN Provenance so it stays
// standalone; it does not import the frozen member-state/clinical-state cores.

import { z } from 'zod';

// 0.2 (SL4): pre/post phases are now populated from the OPD-linkage adapter. Forward-only — 0.2
// writes a new row keyed by (document_id, version); 0.1 rows are untouched.
export const EPISODE_STATE_VERSION = 'episode-state/0.2' as const;

/** How a fact reached the projection. The SL1 builder is PURE and runs no model, so every fact is
 *  either deterministically copied from the doc-audit extract ('deterministic') or read from the kx
 *  discharge/billing envelope ('reported'). 'llm' is reserved for a later phase that re-reads
 *  narrative — unused in SL1. */
export type ExtractionMethod = 'deterministic' | 'reported' | 'llm';

/** Every asserted fact knows where it came from — mirrors ClinicalState.Provenance (same shape,
 *  defined locally so episode-state imports no frozen core). */
export interface Provenance {
  sourceField: string;        // e.g. 'extract.courseSummary', 'kx.speciality'
  rawText: string;            // the literal source text this fact rests on (verbatim substring)
  startOffset?: number;
  endOffset?: number;
  extractionMethod: ExtractionMethod;
  confidence: number;         // 0..1
}

/** A single documented fact + its provenance. `value` is the de-identified fact as text (the fact
 *  IS its rawText — the builder copies verbatim, never paraphrases). */
export interface EpisodeFact {
  value: string;
  provenance: Provenance;
}

// ── phases ────────────────────────────────────────────────────────────────────────────────────

/** Admission-level administrative facts (documented, not scored). */
export interface AdmissionFacts {
  speciality: EpisodeFact | null;
  ward: EpisodeFact | null;
  admissionType: EpisodeFact | null;    // elective | emergency | … (as documented)
  careSetting: EpisodeFact | null;      // day_care | ward | icu | … (as documented)
  dischargeType: EpisodeFact | null;
  lengthOfStayDays: EpisodeFact | null;
  admitDate: EpisodeFact | null;
  dischargeDate: EpisodeFact | null;
}

/** SL1 core — the in-hospital course, facts only. */
export interface IntraAdmissionPhase {
  admission: AdmissionFacts;
  diagnosis: EpisodeFact | null;
  procedures: EpisodeFact[];            // OT / documented procedures
  medications: EpisodeFact[];           // administered / documented during stay
  investigations: EpisodeFact[];
  treatments: EpisodeFact[];
  courseSummary: EpisodeFact | null;    // the documented narrative (verbatim)
  billing: { netTotal: EpisodeFact | null };   // ₹ envelope from kx_billing_records
}

/** SL4 — pre-admission context (home meds, prior conditions, presenting complaints). Typed now,
 *  populated later; SL1 leaves every slot empty. */
export interface PreAdmissionPhase {
  presentingComplaints: EpisodeFact[];
  priorConditions: EpisodeFact[];
  homeMedications: EpisodeFact[];
}

/** SL4 — post-discharge plan (discharge meds, follow-up, warning signs). Typed now, populated
 *  later; SL1 leaves every slot empty. */
export interface PostDischargePhase {
  dischargeMedications: EpisodeFact[];
  followUpPlan: EpisodeFact[];
  warningSigns: EpisodeFact[];
}

export interface EpisodeDemographics {
  age?: number | null;
  sex?: 'F' | 'M' | null;
  sexRaw?: string | null;   // as documented ("male", "f", …) — never lose the source form
}

export interface EpisodeState {
  version: typeof EPISODE_STATE_VERSION;
  episodeRef: string;                   // link-back key (ip_uid) — de-identified, NEVER PHI
  demographics: EpisodeDemographics;
  pre: PreAdmissionPhase;               // SL1: empty
  intra: IntraAdmissionPhase;           // SL1: populated
  post: PostDischargePhase;             // SL1: empty
}

// ── zod validators ──────────────────────────────────────────────────────────────────────────────

const zProvenance = z.object({
  sourceField: z.string().min(1),
  rawText: z.string(),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
  extractionMethod: z.enum(['deterministic', 'reported', 'llm']),
  confidence: z.number().min(0).max(1),
}).strict();

const zFact = z.object({ value: z.string(), provenance: zProvenance }).strict();

const zAdmissionFacts = z.object({
  speciality: zFact.nullable(),
  ward: zFact.nullable(),
  admissionType: zFact.nullable(),
  careSetting: zFact.nullable(),
  dischargeType: zFact.nullable(),
  lengthOfStayDays: zFact.nullable(),
  admitDate: zFact.nullable(),
  dischargeDate: zFact.nullable(),
}).strict();

const zIntra = z.object({
  admission: zAdmissionFacts,
  diagnosis: zFact.nullable(),
  procedures: z.array(zFact),
  medications: z.array(zFact),
  investigations: z.array(zFact),
  treatments: z.array(zFact),
  courseSummary: zFact.nullable(),
  billing: z.object({ netTotal: zFact.nullable() }).strict(),
}).strict();

const zPre = z.object({
  presentingComplaints: z.array(zFact),
  priorConditions: z.array(zFact),
  homeMedications: z.array(zFact),
}).strict();

const zPost = z.object({
  dischargeMedications: z.array(zFact),
  followUpPlan: z.array(zFact),
  warningSigns: z.array(zFact),
}).strict();

export const zEpisodeState = z.object({
  version: z.literal(EPISODE_STATE_VERSION),
  episodeRef: z.string(),
  demographics: z.object({
    age: z.number().nullable().optional(),
    sex: z.enum(['F', 'M']).nullable().optional(),
    sexRaw: z.string().nullable().optional(),
  }).strict(),
  pre: zPre,
  intra: zIntra,
  post: zPost,
}).strict();

/** Validate an unknown value as an EpisodeState (throws ZodError on mismatch). */
export function validateEpisodeState(x: unknown): EpisodeState {
  return zEpisodeState.parse(x) as EpisodeState;
}

/** Empty phases — the builder starts here and fills intra only. */
export function emptyPre(): PreAdmissionPhase {
  return { presentingComplaints: [], priorConditions: [], homeMedications: [] };
}
export function emptyPost(): PostDischargePhase {
  return { dischargeMedications: [], followUpPlan: [], warningSigns: [] };
}
export function emptyIntra(): IntraAdmissionPhase {
  return {
    admission: {
      speciality: null, ward: null, admissionType: null, careSetting: null,
      dischargeType: null, lengthOfStayDays: null, admitDate: null, dischargeDate: null,
    },
    diagnosis: null, procedures: [], medications: [], investigations: [], treatments: [],
    courseSummary: null, billing: { netTotal: null },
  };
}

/** Fact counts for a trace/log line — never ship the arithmetic twice. */
export function episodeCounts(s: EpisodeState): Record<string, number> {
  const admissionFacts = Object.values(s.intra.admission).filter(Boolean).length;
  return {
    admissionFacts,
    diagnosis: s.intra.diagnosis ? 1 : 0,
    procedures: s.intra.procedures.length,
    medications: s.intra.medications.length,
    investigations: s.intra.investigations.length,
    treatments: s.intra.treatments.length,
    billing: s.intra.billing.netTotal ? 1 : 0,
    preFacts: s.pre.presentingComplaints.length + s.pre.priorConditions.length + s.pre.homeMedications.length,
    postFacts: s.post.dischargeMedications.length + s.post.followUpPlan.length + s.post.warningSigns.length,
  };
}
