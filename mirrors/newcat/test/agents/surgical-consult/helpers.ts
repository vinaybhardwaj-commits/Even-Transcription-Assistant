import { readFileSync } from 'node:fs'
import { surgicalConsult } from '../../../src/agents/surgical-consult/definition.js'
import { ConsultAuditInput } from '../../../src/agents/surgical-consult/input.js'
import { FakeModelClient, type FakeReply } from '../../../src/llm/fake.js'
import type { ModelRequest } from '../../../src/llm/types.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { runAgent, type AgentDeps } from '../../../src/platform/agent/run.js'
import { FakeSecondJudge, type SecondJudge } from '../../../src/platform/judge/second.js'
import { testDb } from '../../helpers.js'

export const load = (name: string): ConsultAuditInput =>
  ConsultAuditInput.parse(JSON.parse(readFileSync(`fixtures/surgical-consult/${name}.json`, 'utf8')))

export const reply = (facts: unknown[]): FakeReply => ({ kind: 'text', text: '', toolInput: { facts } })

/** The segment lines the prompt shows the model: `[seg-NNNN ROLE mm:ss] text`. */
export function promptSegments(request: ModelRequest): Array<{ id: string; role: string; text: string }> {
  return request.user
    .split('\n')
    .map((line) => /^\[(seg-\d{4}) ([A-Z]+) \d\d:\d\d\] (.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ id: m[1]!, role: m[2]!.toLowerCase(), text: m[3]! }))
}

const NONE = { rec_ref: null }
const consent = (on: Record<string, boolean>) => ({
  ...NONE,
  risks: false,
  alternatives: false,
  no_surgery_option: false,
  recovery: false,
  cost: false,
  second_opinion_offered: false,
  ...on,
})

/**
 * A scripted "model" that reads the prompt, not the fixture: it extracts what a careful extractor would from the
 * hernia and knee fixtures by sentence. Deleting a sentence from the transcript removes its fact.
 */
export function scriptedExtractor(request: ModelRequest, blind = false): FakeReply {
  const facts: unknown[] = []
  for (const seg of promptSegments(request)) {
    const find = (re: RegExp) => re.exec(seg.text)?.[0]
    const add = (group: string, quote: string | undefined, fields: Record<string, unknown>) => {
      if (quote) facts.push({ group, quote, segment_id: seg.id, ...fields })
    }
    if (seg.role === 'doctor' || blind) {
      add('recommendation', find(/I recommend repairing it soon\./) ?? find(/You need a knee replacement on the right\./), {
        rec_id: 'r1',
        procedure_text: /knee/.test(seg.text) ? 'right knee replacement' : 'hernia repair',
        laterality: 'right',
        firmness: 'firm',
        urgency: 'elective',
      })
      add('consent', find(/The risks are infection, bleeding and the hernia coming back\./), consent({ risks: true }))
      add('consent', find(/The alternative is to wait and watch with a belt\./), consent({ alternatives: true }))
      add('consent', find(/Recovery is about two weeks off heavy work\./) ?? find(/Recovery takes about three months\./), consent({ recovery: true }))
      add('consent', find(/You can also take a second opinion/), consent({ second_opinion_offered: true }))
      add('consent', find(/doing nothing is an option\./), consent({ no_surgery_option: true }))
      add('consent', find(/The cost estimate is in the packet at the desk\./), consent({ cost: true }))
      add('pressure', find(/If you decide today I can give a package discount/), { ...NONE, decide_today: true, discount_or_package: true, fear_framing: false })
    }
    if (seg.role === 'patient' || blind) {
      add('patient_response', find(/How long has this been there, doctor\?/), { ...NONE, question_asked: true, hesitation_stated: false, agreement_stated: false, concern_stated: false })
    }
  }
  return reply(facts)
}

/** An extractor that ignores who spoke, so only the platform's role gate can stop a fact. */
export const roleBlindExtractor = (request: ModelRequest): FakeReply => scriptedExtractor(request, true)

export interface Rig {
  requests: ModelRequest[]
  judge: FakeJudgePort
  run(input: unknown, overrides?: Partial<AgentDeps>): ReturnType<typeof runAgent>
  sql: Awaited<ReturnType<typeof testDb>>
}

/** `respond` sees each model request. Both judges say yes (0.95) unless given. */
export async function rig(
  respond: (request: ModelRequest) => FakeReply = scriptedExtractor,
  judge = new FakeJudgePort(() => 0.95),
  second: SecondJudge | null = new FakeSecondJudge(() => 0.95),
): Promise<Rig> {
  const sql = await testDb()
  const requests: ModelRequest[] = []
  const models = new FakeModelClient(sql, (request) => {
    requests.push(request)
    return respond(request)
  })
  return {
    requests,
    judge,
    sql,
    run: (input, overrides = {}) =>
      runAgent(
        surgicalConsult,
        { sql, models, traceId: `trace-${Math.random().toString(16).slice(2)}`, purpose: 'test', audience: 'internal', judge, second, ...overrides },
        input,
      ),
  }
}
