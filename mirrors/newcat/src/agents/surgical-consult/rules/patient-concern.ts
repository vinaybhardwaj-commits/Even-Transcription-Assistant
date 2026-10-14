import { RULES_VERSION } from '../versions.js'
import { procedureGroup } from '../procedure-groups.js'
import type { GatedFact } from '../facts.js'
import { basis, recommendationFor, type GatedFacts, type RuleOutcome } from './types.js'

export const DOCTOR_TURNS_TO_CHECK = 3

// CANDIDATE for every patient/attendant concern, question or hesitation (recall first, I2b ruling). The facts of the next
// 3 doctor segments (by t0, fewer if the consult ends) ride along as evidence so the judges can see whether the doctor
// replied. FLAG: rules see facts only, never the transcript, so a doctor reply that produced no fact is invisible to the judges.
export function patientConcernRules(facts: GatedFacts): RuleOutcome[] {
  const doctorFacts = ([...facts.recommendation, ...facts.indication, ...facts.consent, ...facts.pressure] as GatedFact[])
    .filter((f) => f.role === 'doctor')
    .sort((a, b) => a.t0 - b.t0 || a.start - b.start)
  const out: RuleOutcome[] = []
  for (const f of facts.patient_response) {
    if (f.role !== 'patient' && f.role !== 'attendant') continue
    if (!(f.question_asked || f.hesitation_stated || f.concern_stated)) continue
    const later = doctorFacts.filter((d) => d.t0 > f.t0 || (d.t0 === f.t0 && d.segment_id !== f.segment_id && d.start > f.start))
    const segments: string[] = []
    for (const d of later) if (!segments.includes(d.segment_id)) segments.push(d.segment_id)
    const keep = new Set(segments.slice(0, DOCTOR_TURNS_TO_CHECK))
    const replies = later.filter((d) => keep.has(d.segment_id))
    out.push({
      finding_type: 'concern_unaddressed',
      procedure_group: procedureGroup(recommendationFor(facts, f.rec_ref)?.procedure_text),
      rule_id: 'concern.unaddressed',
      rule_version: RULES_VERSION,
      claim: 'The doctor did not address this patient concern in the consult.',
      ...basis(f, ...replies),
      needs_judge: true,
      doctor_visible: false,
    })
  }
  return out
}
