import type { ConsultAuditInput } from '../input.js'
import { procedureGroup } from '../procedure-groups.js'
import { RULES_VERSION } from '../versions.js'
import type { GatedFact } from '../facts.js'
import { basis, type CandidateFinding, type GatedFacts, type RuleOutcome } from './types.js'

// Copied verbatim from ~/oc/consult-audit/CDMSS-GENERIC-INDICATION-PATTERNS.md (CDMSS lib/ccb-brief-core.ts GENERIC_INDICATION_PATTERNS).
// Used ONLY to downgrade firmness to 'conditional'. Never a gate (spec section 4).
export const GENERIC_INDICATION_PATTERNS: RegExp[] = [
  /\bif\b/i,
  /\bshould\s+(be\s+considered|the\b)/i,
  /\bmay\s+(be\s+(considered|necessary|required|indicated|warranted)|necessitate|require|warrant)\b/i,
  /\b(can|might|could|would)\s+be\s+considered\b/i,
  /\bcan\s+be\s+an?\s+indication\b/i,
  /\b(in|for)\s+cases?\s+(of|where|involving|that)\b/i,
  /\bfor\s+(patients?|children|women|men|adults?|people|individuals?|those)\b/i,
  /\bpatients?\s+(with|who)\b.*\b(should|may|can|are\s+candidates)\b/i,
  /\b(is|are)\s+(often|usually|frequently|commonly|typically|generally)\s+(needed|required|reserved|considered|indicated|recommended|performed|warranted)\b/i,
  /\bis\s+reserved\s+for\b/i,
  /\bis\s+(a|an|the)\s+(definitive|potential|primary|key|common|first[-\s]line|gold[-\s]standard|appropriate|reasonable|mainstay|treatment\s+option|option|emergent|indication)\b/i,
  /\bis\s+the\s+most\s+common\b/i,
  /\brepresents?\s+a\b/i,
  /\bis\s+(defined|considered)\s+(as|an?|to\s+be)\b/i,
  /\bwhen\s+\w+\s+is\s+suspected\b/i,
  /\bwhen\s+conservative\b/i,
]

export type Firmness = 'firm' | 'conditional' | 'option_mentioned'

// Firmness can only move from 'firm' to 'conditional'; a conditional or option_mentioned fact is returned unchanged.
export function effectiveFirmness(f: Pick<GatedFact<'recommendation'>, 'firmness' | 'quote'>): Firmness {
  if (f.firmness === 'firm' && GENERIC_INDICATION_PATTERNS.some((re) => re.test(f.quote))) return 'conditional'
  return f.firmness
}

export type Rx = ConsultAuditInput['rx']

// procedureGroup runs on the extracted English procedure_text, never raw native text (I1 refute R4).
// Pure in (facts, rx). The svw.* RuleSpecs are enabled (rules/index.ts): the platform hands each rule the per-run context
// (ctx.rx is the written side). Completeness is not an argument: the F7 completeness hook abstains an incomplete window first.
export function saidVsWrittenRules(facts: GatedFacts, rx: Rx, complete = true): RuleOutcome[] {
  if (!rx) return [{ abstain: 'no_rx', rule_id: 'svw.all' }]
  const recs = facts.recommendation.filter((f) => f.role === 'doctor')
  const out: RuleOutcome[] = []
  const mk = (rule_id: string, group: string, claim: string, ev: CandidateFinding['evidence'], refs: string[]): CandidateFinding => ({
    finding_type: 'said_vs_written',
    procedure_group: group,
    rule_id,
    rule_version: RULES_VERSION,
    claim,
    evidence: ev,
    fact_refs: refs,
    needs_judge: true,
    doctor_visible: false,
  })

  if (rx.procedure_text !== null) {
    const rxGroup = procedureGroup(rx.procedure_text)
    for (const r of recs) {
      const said = procedureGroup(r.procedure_text)
      if (said !== rxGroup) {
        out.push(mk('svw.group_differs', said, 'The procedure group the doctor spoke differs from the procedure group written in the prescription.', basis(r).evidence, [r.id]))
      }
    }
  }
  if (rx.requires_surgery === false) {
    for (const r of recs) {
      if (effectiveFirmness(r) === 'firm') {
        out.push(mk('svw.rx_no_surgery_but_firm', procedureGroup(r.procedure_text), 'The doctor firmly recommended a procedure but the prescription records that surgery is not required.', basis(r).evidence, [r.id]))
      }
    }
  }
  // svw.rx_surgery_not_spoken (rx says surgery, none spoken) has no fact to cite, so the platform's evidence requirement
  // cannot be met: it stays a count-only outcome here.
  // Absence-based, so an incomplete window abstains instead.
  if (rx.requires_surgery === true && recs.length === 0) {
    out.push(complete ? { not_discussed: 'svw.rx_surgery_not_spoken' } : { abstain: 'window_incomplete', rule_id: 'svw.rx_surgery_not_spoken' })
  }
  return out
}
