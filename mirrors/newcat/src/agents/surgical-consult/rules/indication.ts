import type { GatedFacts, RuleOutcome } from './types.js'

export interface CitationEntry {
  source: string
  section: string
  url: string
  quoted_passage: string
  // WebFetch returns a summary, so a passage is not proven verbatim. Signing sets this true; until then the rule counts as unsigned.
  verbatim_checked: boolean
}

// primary supports the indication itself; supporting entries back other claims the rule text makes (same url or another).
export interface Citation {
  primary: CitationEntry
  supporting: CitationEntry[]
}

// 'unwritten': no predicate exists yet. Predicates are clinical design, written and signed with the citation
// (fable, Fable 5.1 review, Jev claim-support), not invented in a build slice (I2c ruling).
export type PredicateStatus = 'unwritten' | 'signed'

// Spec sections 4 and 5. Every rule ships disabled until signed.
// ABSENCE RULE: a signed check() may return a finding ONLY when a stated fact contradicts the indication; otherwise
// {not_discussed}. check() must be pure (no `this`), so it works when detached.
export interface IndicationRule {
  rule_id: string
  group: string
  enabled: boolean
  predicate_status: PredicateStatus
  citation: Citation | null
  check(facts: GatedFacts): RuleOutcome
}

export const citationChecked = (c: Citation | null): boolean =>
  c !== null && c.primary.verbatim_checked && c.supporting.every((s) => s.verbatim_checked)

// A rule may run check() only when all three signing conditions hold.
export const ruleRunnable = (r: IndicationRule): boolean => r.enabled && citationChecked(r.citation) && r.predicate_status === 'signed'
