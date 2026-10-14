import type { Candidate, RuleSpec } from '../../../platform/agent/types.js'
import type { ExtractedFact } from '../facts.js'
import type { GatedFact } from '../facts.js'
import { buildTrailer } from '../governance/f7.js'
import { procedureGroup } from '../procedure-groups.js'
import { RULES_VERSION } from '../versions.js'
import { CONSENT_ELEMENTS, consentRules } from './consent.js'
import { ruleRunnable, type IndicationRule } from './indication.js'
import { anorectalRule } from './indication/anorectal.js'
import { circumcisionRule } from './indication/circumcision.js'
import { herniaRule } from './indication/hernia.js'
import { jointReplacementRule } from './indication/joint-replacement.js'
import { urologyEndoscopicRule } from './indication/urology-endoscopic.js'
import { patientConcernRules } from './patient-concern.js'
import { pressureRules } from './pressure.js'
import { saidVsWrittenRules, type Rx } from './said-vs-written.js'
import { groupFacts, isAbstain, isFinding, isNotDiscussed, type CandidateFinding, type GatedFacts, type RuleOutcome } from './types.js'

export const INDICATION_RULES: IndicationRule[] = [anorectalRule, jointReplacementRule, urologyEndoscopicRule, herniaRule, circumcisionRule]

export interface RulesResult {
  findings: CandidateFinding[]
  // Counted by reason, never deduped (I2 N2): two rules abstaining for one reason is two.
  abstention_counts: Record<string, number>
  not_discussed_counts: Record<string, number>
}

// FLAG F6: group-level fields come from the recommendation a fact links to (rec_ref), else the first doctor recommendation.
// Pure: gated facts in, candidate findings out. Disabled indication rules, rules without a verbatim-checked citation or a signed predicate, and rules whose
// procedure group was not recommended all count as not_discussed (spec section 11: unsigned rules report counts only).
// `complete` is the pre-pass verdict (the F7 hook already stops an incomplete window before any rule runs); `rx` is optional because the F7 rule shape has no per-run context (see said-vs-written.ts); pass it to run the svw rules directly.
export function runRules(facts: GatedFacts, rx: Rx | undefined, complete: boolean, indicationRules: IndicationRule[] = INDICATION_RULES): RulesResult {
  const outcomes: RuleOutcome[] = [...consentRules(facts, complete), ...pressureRules(facts), ...patientConcernRules(facts)]
  if (rx !== undefined) outcomes.push(...saidVsWrittenRules(facts, rx, complete))
  const groups = new Set(facts.recommendation.filter((f) => f.role === 'doctor').map((f) => procedureGroup(f.procedure_text)))
  for (const rule of indicationRules) {
    if (!ruleRunnable(rule) || !groups.has(rule.group as never)) outcomes.push({ not_discussed: rule.rule_id })
    else outcomes.push(rule.check(facts))
  }
  const result: RulesResult = { findings: [], abstention_counts: Object.create(null) as Record<string, number>, not_discussed_counts: Object.create(null) as Record<string, number> }
  // Duplicate facts (extractor repeats) must not cost extra judge calls: dedupe on (rule_id, procedure_group, evidence segments).
  // The group is part of the key (I2 N3): one quote can legitimately back the same rule for two procedures.
  const seen = new Set<string>()
  for (const o of outcomes) {
    if (isFinding(o)) {
      const key = dedupeKey(o)
      if (seen.has(key)) continue
      seen.add(key)
      result.findings.push(o)
    } else if (isAbstain(o)) result.abstention_counts[o.abstain] = (result.abstention_counts[o.abstain] ?? 0) + 1
    else if (isNotDiscussed(o)) result.not_discussed_counts[o.not_discussed] = (result.not_discussed_counts[o.not_discussed] ?? 0) + 1
  }
  return result
}

export const dedupeKey = (o: CandidateFinding): string => `${o.rule_id}|${o.procedure_group}|${o.fact_refs.join(',')}`

// FLAG: an InternalFinding has no procedure_group and its evidence has no segment id, so both travel in a summary trailer
// that the governance serializer reads back (governance/f7.ts).
export const summaryOf = (o: CandidateFinding): string =>
  o.claim +
  buildTrailer(
    o.procedure_group,
    o.evidence.map((e, i) => ({ fact_id: o.fact_refs[i] ?? '', segment_id: e.segment_id, role: e.role, t0: e.t0, t1: e.t1 })),
  )

// ---- F7 rule specs -------------------------------------------------------------------------------------------------
// Per-rule candidate caps keep the judge budget deterministic: jevCalls = 2 x MAX_CANDIDATES (primary + second per candidate).
// MAX_CANDIDATES sums the cap of EVERY spec that can be enabled (indication and svw included), so signing rules later
// cannot push a run over its budget. A run over a cap does not fail; the earliest candidates (by fact order) are judged
// and the rest are not reported.
export const RULE_CAPS = { consent: 2, pressure: 4, concern: 16, svw: 4, indication: 1 } as const

function candidatesFor(ruleId: string, flat: Array<GatedFact>, cap: number, rx?: Rx): Candidate[] {
  const facts = groupFacts(flat)
  const outcomes = [...consentRules(facts, true), ...pressureRules(facts), ...patientConcernRules(facts), ...(rx !== undefined ? saidVsWrittenRules(facts, rx, true) : [])]
  const seen = new Set<string>()
  const out: Candidate[] = []
  for (const o of outcomes) {
    if (!isFinding(o) || o.rule_id !== ruleId) continue
    const key = dedupeKey(o)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ factRefs: o.fact_refs, summary: summaryOf(o), key: `${o.procedure_group}|${o.fact_refs.join(',')}` })
  }
  return out.slice(0, cap)
}

type Spec = RuleSpec<ExtractedFact>
const capOf = new Map<string, number>()
const spec = (id: string, cap: number, enabled = true): Spec => (capOf.set(id, cap), {
  id,
  version: RULES_VERSION,
  severity: 'quality',
  enabled,
  evaluate: (flat) => candidatesFor(id, flat as Array<GatedFact>, cap),
})

export const CONSENT_RULE_IDS = CONSENT_ELEMENTS.map((el) => `consent.${el}`)
export const PRESSURE_RULE_IDS = ['pressure.decide_today', 'pressure.discount_or_package', 'pressure.fear_framing']
export const SVW_RULE_IDS = ['svw.group_differs', 'svw.rx_no_surgery_but_firm']

// Indication rules are registered so the platform counts them (rules_disabled) and so a signed rule runs when I4 flips it.
const indicationSpec = (rule: IndicationRule): Spec => (capOf.set(rule.rule_id, RULE_CAPS.indication), {
  id: rule.rule_id,
  version: RULES_VERSION,
  severity: 'quality',
  enabled: ruleRunnable(rule),
  evaluate: (flat) => {
    const o = rule.check(groupFacts(flat as Array<GatedFact>))
    return isFinding(o) ? [{ factRefs: o.fact_refs, summary: summaryOf(o), key: `${o.procedure_group}|${o.fact_refs.join(',')}` }] : []
  },
})

export const RULE_SPECS: Spec[] = [
  ...CONSENT_RULE_IDS.map((id) => spec(id, RULE_CAPS.consent)),
  ...PRESSURE_RULE_IDS.map((id) => spec(id, RULE_CAPS.pressure)),
  spec('concern.unaddressed', RULE_CAPS.concern),
  // svw.*: disabled, see said-vs-written.ts (the F7 rule shape cannot reach rx).
  ...SVW_RULE_IDS.map((id) => spec(id, RULE_CAPS.svw, false)),
  ...INDICATION_RULES.map(indicationSpec),
]

export const MAX_CANDIDATES = RULE_SPECS.reduce((sum, s) => sum + (capOf.get(s.id) ?? 0), 0)

export * from './types.js'
