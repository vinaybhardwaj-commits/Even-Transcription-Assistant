import { describe, expect, it } from 'vitest'
import { ABSENCE_QUESTION, CONSULT_QUESTION } from '../../../src/agents/surgical-consult/definition.js'
import { isAbsenceRule } from '../../../src/agents/surgical-consult/rules/index.js'
import type { JevAnswer, JevCall, JevTransport } from '../../../src/decide/transport.js'
import { GEMINI_PINNED } from '../../../src/llm/allowlist.js'
import type { GeminiConfig, GeminiRequest, GeminiSender } from '../../../src/llm/gemini.js'
import { jevJudge } from '../../../src/platform/jev/judge.js'
import { geminiSecondJudge } from '../../../src/platform/judge/gemini-second.js'
import { load, rig } from './helpers.js'

/**
 * S6-Rd parity: what each judge receives for the same candidate, captured with fake senders (no network). The real Jev adapter
 * (platform/jev/judge.ts) and the real Gemini second judge (platform/judge/gemini-second.ts) run behind the real platform run path.
 */

const CONFIG: GeminiConfig = { project: 'proj-1', location: 'asia-northeast1', keyJson: '{}', model: GEMINI_PINNED[0]!, budgetMax: 1000 }

interface Captured {
  jev: JevCall[]
  gemini: GeminiRequest[]
}

async function capture(fixture: string, jevYes: number, geminiYes: number) {
  const r = await rig()
  const seen: Captured = { jev: [], gemini: [] }
  const transport: JevTransport = {
    async classify(call) {
      seen.jev.push(call)
      const answers: JevAnswer[] = call.questions.map((q) => ({ question_id: q.id, probabilities: { yes: jevYes, no: 1 - jevYes } }))
      return { status: 'ok', data: { servedModelId: 'jev-test', answers } }
    },
  }
  const sender: GeminiSender = async (request) => {
    seen.gemini.push(request)
    return {
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ p_yes: geminiYes }) }] } }],
      modelVersion: 'gemini-test',
    }
  }
  const audit = await r.run(load(fixture), {
    judge: jevJudge({ transport, traceId: 't-parity', purpose: 'agent_judge' }),
    second: geminiSecondJudge({ sql: r.sql, config: CONFIG, sender, traceId: 't-parity' }),
  })
  // Jev is asked in two option orders per candidate; Gemini once.
  const candidates = seen.gemini.map((g, i) => {
    const user = g.body.contents[0]!.parts[0]!.text
    const [question, state] = user.replace(/^Question:\n/, '').split('\n\nState:\n') as [string, string]
    return { question, state: JSON.parse(state) as { rule: string; claim: string; evidence: unknown[]; context_segments?: unknown[] }, forward: seen.jev[2 * i]!, reverse: seen.jev[2 * i + 1]!, request: g }
  })
  return { audit, seen, candidates }
}

describe('judge-input parity (Jev vs Gemini second judge)', () => {
  // hernia: concern.unaddressed (absence); knee without consent: consent.* (absence); decide-today-package: pressure.* (presence).
  const runs = [capture('hernia-full-consent', 0.9, 0.9), capture('knee-replacement-missing-consent', 0.9, 0.9), capture('decide-today-package', 0.9, 0.9)]

  it('both fixtures reach both judges for the same candidates, one Gemini ask and two Jev orders each', async () => {
    for (const run of runs) {
      const { seen, candidates } = await run
      expect(seen.gemini.length).toBeGreaterThan(0)
      expect(seen.jev.length).toBe(2 * seen.gemini.length)
      expect(candidates.every((c) => c.forward.optionOrder === 'forward' && c.reverse.optionOrder === 'reverse')).toBe(true)
    }
    const all = (await Promise.all(runs)).flatMap((r) => r.candidates)
    expect(all.some((c) => isAbsenceRule(c.state.rule))).toBe(true)
    expect(all.some((c) => !isAbsenceRule(c.state.rule))).toBe(true)
  })

  it('same state: same rule, claim, evidence quotes and context ranges, in the same order', async () => {
    for (const { candidates } of await Promise.all(runs)) {
      for (const c of candidates) {
        expect(c.forward.state).toEqual(c.state)
        expect(c.reverse.state).toEqual(c.state)
        expect(typeof c.state.claim).toBe('string')
        expect(c.state.claim.length).toBeGreaterThan(0)
        // Context: whole-consult segments for an absence rule, none for a presence rule, identical for both judges.
        if (isAbsenceRule(c.state.rule)) expect(c.state.context_segments?.length ?? 0).toBeGreaterThan(0)
        else expect(c.state.context_segments).toBeUndefined()
      }
    }
  })

  it('same polarity: the question text each judge is asked is the rule\'s question set, identical word for word', async () => {
    for (const { candidates } of await Promise.all(runs)) {
      for (const c of candidates) {
        const expected = isAbsenceRule(c.state.rule) ? ABSENCE_QUESTION : CONSULT_QUESTION
        expect(c.question).toBe(expected)
        // Jev's prompt is the question first, then its answer options.
        for (const call of [c.forward, c.reverse]) expect(call.questions[0]!.prompt.startsWith(`${expected}\nAnswer with exactly one of these options:`)).toBe(true)
      }
    }
  })

  it('p_yes maps the same direction: yes means the same thing to both and both reach the same cut', async () => {
    const { candidates } = await runs[0]!
    const c = candidates[0]!
    // Gemini is told p_yes is the probability that the answer is yes; Jev reads the probability of the option "yes".
    expect(c.request.body.systemInstruction.parts[0]!.text).toMatch(/p_yes is the probability, between 0 and 1, that the answer to the question is yes/)
    expect(c.forward.questions[0]!.options).toEqual(['yes', 'no'])
    expect(c.reverse.questions[0]!.options).toEqual(['no', 'yes'])
    // End to end: a 0.9 from each gives primary_p = second_p = 0.9 and agree; 0.1 from each drops the finding; a split abstains.
    const high = (await runs[0]!).audit
    expect(high.findings.length).toBeGreaterThan(0)
    expect(high.findings.every((f) => f.judge?.primary_p === 0.9 && f.judge?.second_p === 0.9 && f.judge?.agree === true)).toBe(true)
    const low = (await capture('hernia-full-consent', 0.1, 0.1)).audit
    expect(low.findings).toEqual([])
    const split = (await capture('hernia-full-consent', 0.9, 0.1)).audit
    expect(split.status).toBe('abstained')
    const flipped = (await capture('hernia-full-consent', 0.1, 0.9)).audit
    expect(flipped.status).toBe('abstained')
  })

  it('KNOWN DIVERGENCE (FLAG): Jev\'s prompt carries yes/no criteria text that the Gemini request does not', async () => {
    const { candidates } = await runs[1]!
    const absence = candidates.find((c) => isAbsenceRule(c.state.rule))!
    const jevPrompt = absence.forward.questions[0]!.prompt
    const geminiText = absence.request.body.contents[0]!.parts[0]!.text + absence.request.body.systemInstruction.parts[0]!.text
    // src/platform/jev/judge.ts:15 passes criteria: VALIDITY_RUBRIC (src/decide/questions.ts:35-38); Gemini's SYSTEM is src/platform/judge/gemini-second.ts:6-9.
    expect(jevPrompt).toContain('- yes: Yes. Every part of the factual question is directly supported by the quoted text and relevant typed facts.')
    expect(jevPrompt).toContain('- no: No. At least one part is missing, contradicted, or only inferred.')
    expect(geminiText).not.toContain('directly supported by the quoted text')
    expect(geminiText).not.toContain('only inferred')
    // Gemini also gets a system line telling it to use only the state; Jev does not.
    expect(absence.request.body.systemInstruction.parts[0]!.text).toContain('Use only the state.')
    expect(jevPrompt).not.toContain('Use only the state')
  })
})
