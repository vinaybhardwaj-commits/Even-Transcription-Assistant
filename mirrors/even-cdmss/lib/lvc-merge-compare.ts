/**
 * lib/lvc-merge-compare.ts — LVC RULEBOOK REPAIR PRD v1.1 §3.1 (D-12, D-19), 25 Aug 2026.
 *
 * THE BEFORE/AFTER EVIDENCE FOR ONE MERGE. Pure. Writes nothing, ever.
 *
 * WHAT IT ANSWERS. "If I accept this rule, what happens to findings that already exist?" It takes a
 * sample of stored low-value findings, runs the matcher TWICE — once against the live rulebook,
 * once against the rulebook as it would be if this record were accepted — and classifies each
 * finding's before/after pair.
 *
 * ⚠️ §6.7 IS THE WHOLE POINT: it calls the EXPORTED `matchLvcRule` from lib/opd-lvc-classify-core.
 * It does not reimplement matching, and it must never be allowed to. A private copy would drift
 * from the engine within one change and the evidence would be worthless — worse than worthless,
 * because it would look like evidence. lib/__tests__/lvc-rule-merge.test.ts asserts the call
 * against a stubbed module, so a reimplementation fails the build.
 *
 * ADVISORY, NOT A GATE (D-19). The panel that shows this is collapsed by default and a rule can be
 * accepted without opening it. This module therefore never blocks anything and has no write path.
 *
 * ⚠️ D-4 — HISTORY IS NOT REWRITTEN. Nothing here proposes changing a stored finding. The
 * comparison describes what the matcher WOULD say about the same text today; findings already
 * delivered to a doctor keep the rule_ref they were given.
 */

import { matchLvcRule, type LvcRuleLite, type ClassifiableFinding } from './opd-lvc-classify-core';
import type { MergedRule } from './lvc-rule-merge';

/** One stored finding, as read out of opd_note_audits.findings[]. */
export interface SampleFinding {
  /** opd_note_audits.uid — the note */
  note_id: string;
  subject: string;
  rationale: string | null;
  /** the rule_ref STORED on the finding, for transparency; not used to compute the classes */
  stored_rule_ref: string | null;
}

export type ChangeClass =
  | 'unchanged'
  | 'moved_to_survivor'
  | 'newly_matched'
  | 'lost_match'
  | 'changed_concept';

export interface ComparedFinding {
  note_id: string;
  subject: string;
  /** matchLvcRule against the LIVE rulebook */
  old_rule_ref: string | null;
  /** matchLvcRule against the PROPOSED rulebook */
  new_rule_ref: string | null;
  stored_rule_ref: string | null;
  change: ChangeClass;
}

export interface ComparisonSummary {
  sampled: number;
  counts: Record<ChangeClass, number>;
  /** a readable handful per class (§3.5) */
  examples: Record<ChangeClass, ComparedFinding[]>;
}

export const CHANGE_CLASSES: ChangeClass[] = [
  'unchanged', 'moved_to_survivor', 'newly_matched', 'lost_match', 'changed_concept',
];

export const CHANGE_CLASS_LABELS: Record<ChangeClass, string> = {
  unchanged: 'Unchanged',
  moved_to_survivor: 'Moved to survivor',
  newly_matched: 'Newly matched',
  lost_match: 'Lost match',
  changed_concept: 'Changed concept',
};

/**
 * The rulebook as it would be if `records` were accepted:
 *   · each survivor takes the record's keywords and category (that is what the matcher reads);
 *   · each absorbed rule LEAVES THE POOL, because it retires and getLvcRules selects status='active'.
 * Every other rule is passed through untouched, so a rule outside the merge is compared against
 * itself and lands in `unchanged` — which is the honest answer.
 */
export function buildProposedRules(live: LvcRuleLite[], records: MergedRule[]): LvcRuleLite[] {
  const bySurvivor = new Map(records.map((r) => [r.id, r]));
  const absorbed = new Set(records.flatMap((r) => r.absorbs));
  const out: LvcRuleLite[] = [];
  for (const rule of live) {
    if (absorbed.has(rule.id)) continue;                       // retires ⇒ no longer matchable
    const rec = bySurvivor.get(rule.id);
    out.push(rec ? { id: rule.id, keywords: [...rec.keywords], category: rec.category } : rule);
  }
  // A survivor absent from the live pool (already retired, or a Phase 2 rule that does not exist
  // yet) is still added, so the preview shows what it WOULD catch rather than silently nothing.
  for (const rec of records) {
    if (!out.some((r) => r.id === rec.id)) out.push({ id: rec.id, keywords: [...rec.keywords], category: rec.category });
  }
  return out;
}

/** Which survivor, if any, absorbs this rule id. */
function survivorOf(records: MergedRule[], ruleId: string | null): string | null {
  if (!ruleId) return null;
  for (const r of records) if (r.absorbs.includes(ruleId)) return r.id;
  return null;
}

export function classifyChange(oldRef: string | null, newRef: string | null, records: MergedRule[]): ChangeClass {
  if (oldRef === newRef) return 'unchanged';
  if (oldRef === null) return 'newly_matched';
  if (newRef === null) return 'lost_match';
  // Both non-null and different: a move is when the new ref is precisely the survivor the old ref
  // retires into. Anything else is a genuine change of clinical concept and is called that.
  return survivorOf(records, oldRef) === newRef ? 'moved_to_survivor' : 'changed_concept';
}

/**
 * Compare one sample under the live and proposed rulebooks. PURE — no I/O, no clock, no randomness.
 * The caller supplies the sample and the live rulebook; that is what makes this testable and what
 * keeps the fail-safe (an unreadable sample) in the route rather than in here.
 */
export function compareSample(
  sample: SampleFinding[],
  liveRules: LvcRuleLite[],
  records: MergedRule[],
): ComparedFinding[] {
  const proposed = buildProposedRules(liveRules, records);
  return sample.map((f) => {
    const finding: ClassifiableFinding = { subject: f.subject, rationale: f.rationale };
    const oldRef = matchLvcRule(finding, liveRules);
    const newRef = matchLvcRule(finding, proposed);
    return {
      note_id: f.note_id,
      subject: f.subject,
      old_rule_ref: oldRef,
      new_rule_ref: newRef,
      stored_rule_ref: f.stored_rule_ref,
      change: classifyChange(oldRef, newRef, records),
    };
  });
}

/** Roll a comparison up for the panel: a count per class and up to `perClass` readable examples. */
export function summarise(compared: ComparedFinding[], perClass = 5): ComparisonSummary {
  const counts = Object.fromEntries(CHANGE_CLASSES.map((c) => [c, 0])) as Record<ChangeClass, number>;
  const examples = Object.fromEntries(CHANGE_CLASSES.map((c) => [c, [] as ComparedFinding[]])) as Record<ChangeClass, ComparedFinding[]>;
  for (const c of compared) {
    counts[c.change] += 1;
    if (examples[c.change].length < perClass) examples[c.change].push(c);
  }
  return { sampled: compared.length, counts, examples };
}
