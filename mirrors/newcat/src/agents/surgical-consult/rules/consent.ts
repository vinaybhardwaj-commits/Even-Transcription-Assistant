import { RULES_VERSION } from '../versions.js'
import { procedureGroup } from '../procedure-groups.js'
import { basis, type GatedFacts, type RuleOutcome } from './types.js'

export const CONSENT_ELEMENTS = ['risks', 'alternatives', 'no_surgery_option', 'recovery', 'cost', 'second_opinion_offered'] as const

const CLAIM: Record<(typeof CONSENT_ELEMENTS)[number], string> = {
  risks: 'The risks of the recommended procedure were not heard in the consult recording.',
  alternatives: 'Alternatives to the recommended procedure were not heard in the consult recording.',
  no_surgery_option: 'That not operating is an option was not heard in the consult recording.',
  recovery: 'Recovery from the recommended procedure was not heard in the consult recording.',
  cost: 'The cost of the recommended procedure was not heard in the consult recording.',
  second_opinion_offered: 'An offer of a second opinion was not heard in the consult recording.',
}

// One candidate per (recommendation, missing element). A consent fact counts for a recommendation when it links to it
// (rec_ref) or links to none (null: said about the consult as a whole). Absence is the finding here (spec section 4),
// allowed only when completeness passed: the F7 completeness hook abstains an incomplete window before any model call,
// so these rules never see one.
//
// The judge reads whole-segment context for these claims (rules/index.ts absenceRanges and the absence question set), so
// consent stated anywhere in the doctor and patient segments of the window is visible to it, not only the recommendation quote.
//
// `complete` is the pre-pass verdict. When false, absence is not evidence: the rule abstains (window_incomplete) instead.
export function consentRules(facts: GatedFacts, complete: boolean): RuleOutcome[] {
  const out: RuleOutcome[] = []
  const recs = facts.recommendation.filter((f) => f.role === 'doctor')
  if (recs.length > 0 && !complete) return [{ abstain: 'window_incomplete', rule_id: 'consent.all' }]
  const doctorConsent = facts.consent.filter((f) => f.role === 'doctor')
  const known = new Set(recs.map((r) => r.rec_id))
  for (const rec of recs) {
    // A rec_ref that matches no doctor recommendation is an extractor link error: treat it as null (about the whole
    // consult), the same fallback recommendationFor uses, so it can never create a false absence.
    const mine = doctorConsent.filter((c) => c.rec_ref === null || !known.has(c.rec_ref) || c.rec_ref === rec.rec_id)
    const group = procedureGroup(rec.procedure_text)
    for (const el of CONSENT_ELEMENTS) {
      if (mine.some((c) => c[el])) continue
      out.push({
        finding_type: 'consent_incomplete',
        procedure_group: group,
        rule_id: `consent.${el}`,
        rule_version: RULES_VERSION,
        claim: CLAIM[el],
        ...basis(rec),
        needs_judge: true,
        doctor_visible: false,
      })
    }
  }
  return out
}
