import type { Role } from '../input.js'
import type { FactGroup, GatedFact } from '../facts.js'

export const FINDING_TYPES = [
  'indication_gap',
  'consent_incomplete',
  'pressure_signal',
  'said_vs_written',
  'patient_concern_unaddressed',
] as const
export type FindingType = (typeof FINDING_TYPES)[number]

export interface EvidenceQuote {
  segment_id: string
  role: Role
  t0: number
  t1: number
  quote: string
}

// Spec section 4. A candidate is never shown to a doctor: the judges must confirm it first (needs_judge), and
// doctor_visible stays false.
export interface CandidateFinding {
  finding_type: FindingType
  procedure_group: string
  rule_id: string
  rule_version: string
  claim: string
  evidence: EvidenceQuote[]
  // Ids of the gated facts the candidate rests on (the platform's factRefs). Evidence is built from the same facts.
  fact_refs: string[]
  needs_judge: true
  doctor_visible: false
}

export type RuleOutcome = CandidateFinding | { abstain: string; rule_id: string } | { not_discussed: string }

export type GatedFacts = { [G in FactGroup]: GatedFact<G>[] }

export const isFinding = (o: RuleOutcome): o is CandidateFinding => 'finding_type' in o
export const isAbstain = (o: RuleOutcome): o is { abstain: string; rule_id: string } => 'abstain' in o
export const isNotDiscussed = (o: RuleOutcome): o is { not_discussed: string } => 'not_discussed' in o

type Evidenced = { segment_id: string; role: Role; t0: number; t1: number; quote: string }

export function evidenceOf(f: Evidenced): EvidenceQuote {
  return { segment_id: f.segment_id, role: f.role, t0: f.t0, t1: f.t1, quote: f.quote }
}

/** Evidence quotes and fact refs for the same facts, in one call so they cannot drift apart. */
export function basis(...facts: Array<Evidenced & { id: string }>): Pick<CandidateFinding, 'evidence' | 'fact_refs'> {
  return { evidence: facts.map(evidenceOf), fact_refs: facts.map((f) => f.id) }
}

/** Flat gated facts (the platform's shape) -> facts by group. Order within a group is the platform's order. */
export function groupFacts(flat: Array<GatedFact>): GatedFacts {
  const out: GatedFacts = { recommendation: [], indication: [], consent: [], patient_response: [], pressure: [] }
  for (const fact of flat) (out[fact.group] as GatedFact[]).push(fact)
  return out
}

// FLAG F6 (multi-procedure): the procedure group of a non-recommendation fact comes from the recommendation it links to
// (rec_ref -> rec_id). A missing or dangling link falls back to the first doctor recommendation, then 'other'.
export function recommendationFor(facts: GatedFacts, ref: string | null): GatedFact<'recommendation'> | undefined {
  const recs = facts.recommendation.filter((f) => f.role === 'doctor')
  return (ref === null ? undefined : recs.find((r) => r.rec_id === ref)) ?? recs[0]
}
