import { describe, expect, it } from 'vitest'
import { serialize } from '../../../src/audience/serialize.js'
import { asJson } from '../../../src/db/sql.js'
import { FakeJudgePort } from '../../../src/platform/agent/judge-port.js'
import { FakeSecondJudge } from '../../../src/platform/judge/second.js'
import { CONVERSATION, GOOD_FACT, harness, reply, withJudge } from './harness.js'

describe('F7.3 G3: per-judge probabilities in the audit envelope', () => {
  it('fills finding.judge from the verdict and keeps it identical to agent_findings.judge', async () => {
    const second = new FakeSecondJudge(() => 0.9)
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => 0.95), second)
    const audit = await h.run(CONVERSATION, { second }, withJudge('gemini'))
    const judge = audit.findings[0]!.judge
    expect(judge).toEqual({
      primary_p: 0.95,
      second_p: 0.9,
      agree: true,
      served_model_ids: expect.arrayContaining(['fake.judge-1', 'fake-second-model']),
    })
    const row = (await h.sql.query<Record<string, unknown>>('select judge from agent_findings')).rows[0]!
    expect(asJson(row.judge)).toEqual(judge)
  })

  it('a held finding carries null probabilities', async () => {
    const h = await harness([reply([GOOD_FACT])], new FakeJudgePort(() => null))
    const audit = await h.run()
    expect(audit.findings[0]!.judge).toMatchObject({ primary_p: null, second_p: null, agree: null })
  })

  it('doctor, operator and internal bodies never carry judge', async () => {
    const h = await harness([reply([GOOD_FACT])])
    const audit = await h.run()
    expect(audit.findings[0]!.judge).toBeDefined()
    for (const audience of ['operator', 'internal'] as const) {
      expect(JSON.stringify(serialize(audit, audience))).not.toContain('primary_p')
    }
    expect(JSON.stringify(serialize(audit, 'doctor'))).not.toContain('primary_p')
  })
})
