import { RULES_VERSION } from '../versions.js'
import { procedureGroup } from '../procedure-groups.js'
import { basis, recommendationFor, type GatedFacts, type RuleOutcome } from './types.js'

const ELEMENTS = ['decide_today', 'discount_or_package', 'fear_framing'] as const
const CLAIM: Record<(typeof ELEMENTS)[number], string> = {
  decide_today: 'The doctor pressed the patient to decide today.',
  discount_or_package: 'The doctor tied a discount or package to deciding.',
  fear_framing: 'The doctor framed the decision with fear of harm.',
}

// One finding per pressure flag per doctor-role fact. The group comes from the linked recommendation (F6).
export function pressureRules(facts: GatedFacts): RuleOutcome[] {
  const out: RuleOutcome[] = []
  for (const f of facts.pressure) {
    if (f.role !== 'doctor') continue
    const group = procedureGroup(recommendationFor(facts, f.rec_ref)?.procedure_text)
    for (const el of ELEMENTS) {
      if (!f[el]) continue
      out.push({
        finding_type: 'pressure_signal',
        procedure_group: group,
        rule_id: `pressure.${el}`,
        rule_version: RULES_VERSION,
        claim: CLAIM[el],
        ...basis(f),
        needs_judge: true,
        doctor_visible: false,
      })
    }
  }
  return out
}
