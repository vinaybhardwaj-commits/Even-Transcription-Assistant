import type { Candidate, ContextRange, RuleOutput, RuleSpec } from '../../../platform/agent/types.js'
import type { ExtractedFact } from '../facts.js'
import type { GatedFact } from '../facts.js'
import { procedureGroup } from '../procedure-groups.js'
import { CONSULT_SOURCE_ID, type ConsultContext } from '../segments.js'
import { RULES_VERSION } from '../versions.js'
import { CONSENT_ELEMENTS, consentRules } from './consent.js'
import { ruleRunnable, type IndicationRule } from './indication.js'
import { anorectalRule } from './indication/anorectal.js'
import { circumcisionRule } from './indication/circumcision.js'
import { herniaRule } from './indication/hernia.js'
import { jointReplacementRule } from './indication/joint-replacement.js'
import { kneeArthroscopyRule } from './indication/knee-arthroscopy.js'
import { urologyEndoscopicRule } from './indication/urology-endoscopic.js'
import { patientConcernRules } from './patient-concern.js'
import { pressureRules } from './pressure.js'
import { saidVsWrittenRules, type Rx } from './said-vs-written.js'
import { groupFacts, isAbstain, isFinding, isNotDiscussed, type CandidateFinding, type GatedFacts, type RuleOutcome } from './types.js'

export const INDICATION_RULES: IndicationRule[] = [anorectalRule, jointReplacementRule, urologyEndoscopicRule, herniaRule, circumcisionRule, kneeArthroscopyRule]

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

// ---- F7 rule specs -------------------------------------------------------------------------------------------------
// Per-rule candidate caps keep the judge budget deterministic: jevCalls = 2 x MAX_CANDIDATES (primary + second per candidate).
// MAX_CANDIDATES sums the cap of EVERY spec that can be enabled (indication and svw included), so signing rules later
// cannot push a run over its budget. A run over a cap does not fail; the earliest candidates (by fact order) are judged
// and the rest are counted as over_cap.
export const RULE_CAPS = { consent: 2, pressure: 4, concern: 16, svw: 4, indication: 1 } as const

// Reasons a rule may count without a candidate (declared as the agent's countReasons). Plain snake_case words.
export const COUNT_REASONS = ['not_discussed', 'over_cap', 'abstain_no_rx', 'abstain_window_incomplete', 'abstain_needs_review', 'abstain_other'] as const
const ABSTAIN_COUNT = new Map<string, string>([
  ['no_rx', 'abstain_no_rx'],
  ['window_incomplete', 'abstain_window_incomplete'],
  ['needs_review', 'abstain_needs_review'],
])
const bump = (counts: Record<string, number>, key: string, n = 1): void => {
  if (n > 0) counts[key] = (counts[key] ?? 0) + n
}
// Counts are keyed by code constants only: an unknown abstention reason lands in abstain_other, never as a new key.
function countOutcome(counts: Record<string, number>, o: RuleOutcome): void {
  if (isAbstain(o)) bump(counts, ABSTAIN_COUNT.get(o.abstain) ?? 'abstain_other')
  else if (isNotDiscussed(o)) bump(counts, 'not_discussed')
}

// Summaries and meta values come from code constants and enum values only (claim text, procedure group): never from
// the context, a quote or any record text (F7.3 C4 / F7.4 C3).
const META_KEYS = ['procedure_group'] as const
export const CONSULT_META_KEYS: readonly string[] = META_KEYS
const metaOf = (o: CandidateFinding): Candidate['meta'] => ({ procedure_group: o.procedure_group })

// Absence findings (consent.*): the judge reads every doctor and patient segment of the consult window (G8, W1), so consent
// stated before the recommendation is visible too. One range per run of such segments, so no other role's text is shown;
// every range lies inside the window's segments, on both judges.
// consent.* and concern.unaddressed are absence claims: the judge reads the whole consult window.
export const isAbsenceRule = (ruleId: string): boolean => ruleId.startsWith('consent.') || ruleId === 'concern.unaddressed'
export const ABSENCE_ROLES: ReadonlySet<string> = new Set(['doctor', 'patient'])
export function absenceRanges(ctx: ConsultContext): ContextRange[] {
  const ranges: ContextRange[] = []
  let open: string | null = null
  let last = ''
  for (const s of ctx.segments) {
    if (ABSENCE_ROLES.has(s.role)) {
      open ??= s.id
      last = s.id
    } else if (open !== null) {
      ranges.push({ source_id: CONSULT_SOURCE_ID, segment_from: open, segment_to: last })
      open = null
    }
  }
  if (open !== null) ranges.push({ source_id: CONSULT_SOURCE_ID, segment_from: open, segment_to: last })
  return ranges
}

type Spec = RuleSpec<ExtractedFact, ConsultContext>
const capOf = new Map<string, number>()

// `complete` comes from the context: an incomplete window that reaches the rules abstains instead of emitting absence findings.
const outcomesFor = (ruleId: string, facts: GatedFacts, ctx: ConsultContext | undefined): RuleOutcome[] => {
  const complete = ctx?.complete ?? false
  if (ruleId.startsWith('consent.')) return consentRules(facts, complete)
  if (ruleId.startsWith('pressure.')) return pressureRules(facts)
  if (ruleId.startsWith('concern.')) return patientConcernRules(facts)
  return saidVsWrittenRules(facts, ctx?.rx ?? null, complete)
}

// One spec per family also carries the family's count-only outcomes (svw: no_rx, not spoken; consent: window_incomplete), so they are counted once.
const COUNTERS: ReadonlySet<string> = new Set(['svw.group_differs', 'consent.risks'])

function evaluateRule(ruleId: string, flat: Array<GatedFact>, cap: number, ctx: ConsultContext | undefined): RuleOutput {
  const facts = groupFacts(flat)
  const absence = isAbsenceRule(ruleId)
  if (absence && ctx === undefined) throw new Error('missing_rule_context')
  const counts: Record<string, number> = Object.create(null) as Record<string, number>
  const seen = new Set<string>()
  const all: Candidate[] = []
  for (const o of outcomesFor(ruleId, facts, ctx)) {
    if (!isFinding(o)) {
      if (COUNTERS.has(ruleId)) countOutcome(counts, o)
      continue
    }
    if (o.rule_id !== ruleId) continue
    const key = dedupeKey(o)
    if (seen.has(key)) continue
    seen.add(key)
    const candidate: Candidate = { factRefs: o.fact_refs, summary: o.claim, key: `${o.procedure_group}|${o.fact_refs.join(',')}`, meta: metaOf(o) }
    if (absence) {
      // A recommendation whose segment is not in the window cannot be judged in context: skip it.
      if (!ctx!.segments.some((seg) => seg.id === o.evidence[0]?.segment_id)) continue
      candidate.contextRanges = absenceRanges(ctx!)
    }
    all.push(candidate)
  }
  bump(counts, 'over_cap', Math.max(0, all.length - cap))
  const out: RuleOutput = { candidates: all.slice(0, cap), counts }
  // G5: no doctor recommendation survived, so there is nothing to audit; the first rule in order (consent.risks) names it.
  if (absence && !facts.recommendation.some((f) => f.role === 'doctor')) out.empty_reason = 'no_surgical_recommendation'
  return out
}

const spec = (id: string, cap: number): Spec => (capOf.set(id, cap), {
  id,
  version: RULES_VERSION,
  severity: 'quality',
  enabled: true,
  evaluate: (flat, ctx) => evaluateRule(id, flat as Array<GatedFact>, cap, ctx),
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
    const facts = groupFacts(flat as Array<GatedFact>)
    const counts: Record<string, number> = Object.create(null) as Record<string, number>
    const recommended = facts.recommendation.some((f) => f.role === 'doctor' && procedureGroup(f.procedure_text) === rule.group)
    const o: RuleOutcome = recommended ? rule.check(facts) : { not_discussed: rule.rule_id }
    if (!isFinding(o)) {
      countOutcome(counts, o)
      return { candidates: [], counts }
    }
    return { candidates: [{ factRefs: o.fact_refs, summary: o.claim, key: `${o.procedure_group}|${o.fact_refs.join(',')}`, meta: metaOf(o) }], counts }
  },
})

export const RULE_SPECS: Spec[] = [
  ...CONSENT_RULE_IDS.map((id) => spec(id, RULE_CAPS.consent)),
  ...PRESSURE_RULE_IDS.map((id) => spec(id, RULE_CAPS.pressure)),
  spec('concern.unaddressed', RULE_CAPS.concern),
  // svw.*: enabled through the rule context (F7.4): ctx.rx is the written side.
  ...SVW_RULE_IDS.map((id) => spec(id, RULE_CAPS.svw)),
  ...INDICATION_RULES.map(indicationSpec),
]

export const MAX_CANDIDATES = RULE_SPECS.reduce((sum, s) => sum + (capOf.get(s.id) ?? 0), 0)

export * from './types.js'
