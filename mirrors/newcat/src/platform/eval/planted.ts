import type { InternalFinding } from '../../pipeline/types.js'
import { buildJudgeState, type JudgePort, type JudgeQuestionSet } from '../agent/judge-port.js'
import type { SecondJudge } from '../judge/second.js'

export interface PlantedResult {
  pass: boolean
  /** p_yes per judge, in order: primary, then second when given. */
  p: number[]
}

/** Replaces every quote with text that cannot support the claim. Offsets are left as they were. */
export function alterEvidence(finding: InternalFinding, decoy = 'unrelated filler text'): InternalFinding {
  return { ...finding, evidence: finding.evidence.map((item) => ({ ...item, quote: decoy })) }
}

/**
 * Planted claim: alter the finding's evidence and ask the judges whether the claim still holds.
 * Every judge must say no (p_yes below the threshold). CI passes fake judges; a live run is
 * a separate script and is not part of the gate.
 */
export async function plantedClaim(args: {
  finding: InternalFinding
  set: JudgeQuestionSet
  threshold: number
  primary: JudgePort
  second?: SecondJudge | null
}): Promise<PlantedResult> {
  const altered = alterEvidence(args.finding)
  const state = buildJudgeState(
    altered.rule_id,
    altered.summary,
    altered.evidence.map((item) => ({ quote: item.quote })),
  )
  const p: number[] = []
  p.push((await args.primary.askValidity(state, args.set.question, args.set)).p_yes)
  if (args.second) p.push((await args.second.askValidity(state, args.set.question, args.set)).p_yes)
  return { pass: p.every((value) => value < args.threshold), p }
}
