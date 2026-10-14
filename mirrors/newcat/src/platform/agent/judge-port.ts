/**
 * The judge the template talks to. F1 (Jev) is built in parallel: an adapter from
 * `JevTransport` to this port is a short follow-up once both slices merge.
 * The template never imports src/platform/jev.
 */

export interface JudgeQuestionSet {
  id: string
  sha: string
  question: string
}

export interface JudgeAnswer {
  /** Probability the claim is valid, 0..1. Forward and reversed orders already averaged. */
  p_yes: number
  servedModelIds: string[]
}

/** Rejects with JudgeUnavailable when the service is down or refuses (budget). */
export interface JudgePort {
  askValidity(state: unknown, question: string, set: JudgeQuestionSet): Promise<JudgeAnswer>
}

export interface JudgeEvidence {
  quote: string
  role?: string
  group?: string
}

export interface JudgeContextSegment {
  source_id: string
  segment_id: string
  role: string
  text: string
}

/**
 * The one place the state sent to a judge is shaped. run.ts and the planted-claim eval both use it.
 * `contextSegments` (whole segments, for absence claims) go under their own key, never into the evidence quotes.
 */
export function buildJudgeState(ruleId: string, claim: string, evidence: JudgeEvidence[], contextSegments: JudgeContextSegment[] = []) {
  return {
    rule: ruleId,
    claim,
    evidence: evidence.map((item) => ({
      ...(item.role !== undefined ? { role: item.role } : {}),
      ...(item.group !== undefined ? { group: item.group } : {}),
      quote: item.quote,
    })),
    ...(contextSegments.length > 0 ? { context_segments: contextSegments.map((segment) => ({ ...segment })) } : {}),
  }
}

export class JudgeUnavailable extends Error {
  constructor(readonly kind: string = 'judge_unavailable') {
    super('The judge did not answer.')
    this.name = 'JudgeUnavailable'
  }
}

/** Default until the F1 adapter is wired: every finding is held, never judged. */
export const unavailableJudge: JudgePort = {
  async askValidity() {
    throw new JudgeUnavailable()
  },
}

export interface FakeJudgeCall {
  state: unknown
  question: string
  set: JudgeQuestionSet
}

/** Scripted judge for tests. `respond` returns p_yes, or null for "unavailable". */
export class FakeJudgePort implements JudgePort {
  readonly calls: FakeJudgeCall[] = []
  constructor(
    private readonly respond: (call: FakeJudgeCall) => number | null = () => 0.99,
    private readonly modelId = 'fake.judge-1',
  ) {}

  async askValidity(state: unknown, question: string, set: JudgeQuestionSet): Promise<JudgeAnswer> {
    const call = { state, question, set }
    this.calls.push(call)
    const p = this.respond(call)
    if (p === null) throw new JudgeUnavailable()
    return { p_yes: p, servedModelIds: [this.modelId] }
  }
}
