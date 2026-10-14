import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BedrockRaw, BedrockSender, BedrockTurn } from '../../../../src/llm/bedrock.js'
import { ABSENCE_RUBRIC, DEFAULT_MODELS, buildWindow, labelItem, main, modelsFromEnv, parseAnswer, proveModels, type LabelRecord, type Models } from '../../../../src/agents/surgical-consult/offline/bench-label.js'
import { LABELLING_LINE, busSafeBlock, score, main as scoreMain } from '../../../../src/agents/surgical-consult/offline/bench-score.js'
import type { KeyRow, SampleLine } from '../../../../src/agents/surgical-consult/offline/bench-sample.js'
import { parseConsultLines } from '../../../../src/agents/surgical-consult/offline/input.js'
import { prepass } from '../../../../src/agents/surgical-consult/prepass.js'
import { segmentId } from '../../../../src/agents/surgical-consult/segments.js'
import { fixtureJsonl } from './helpers.js'

afterEach(() => vi.restoreAllMocks())
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 's6-label-'))
const consults = () => parseConsultLines(fixtureJsonl()).consults
const consult = () => consults().find((c) => c.input.encounter_id.length > 0 && prepass(c.input).turns.length >= 3)!

const RULING_RUBRIC = `This claim says something did NOT happen in the consult. Answer YES only if both hold:
(1) the transcript window covers the whole part of the consult where this topic would normally come up, with no gap in the recording or transcript over that part; and
(2) no utterance in the window, in any language or translation, addresses the item even briefly, partially or indirectly, including references such as 'as we discussed', 'I explained earlier', a leaflet or form handed over, or a plan to discuss at the next visit.
Answer NO if any utterance addresses the item at all. If you cannot tell whether the window is complete, answer NO.`

const item = (id = 'item-001'): SampleLine => {
  const c = consult()
  const turns = prepass(c.input).turns
  return {
    item_id: id,
    run_id: 'run-test',
    encounter_id: c.input.encounter_id,
    rule_id: 'consent.risks',
    polarity: 'absence',
    question_set: 'consult-absence-claim',
    claim: 'The risks of the recommended procedure were not heard in the consult recording.',
    context: turns.slice(0, 3).map((t, i) => ({ segment_id: segmentId(i), t0: t.t0, t1: t.t1 })),
    fact_refs: ['f1'],
    facts: [],
  }
}

interface Call {
  model: string
  turn: BedrockTurn
}
type Reply = string | Error | { text: string; served: string | null }
function fakeSender(reply: (model: string, turn: BedrockTurn) => Reply): { sender: BedrockSender; calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    sender: {
      async send(model, turn): Promise<BedrockRaw> {
        calls.push({ model, turn })
        const r = reply(model, turn)
        if (r instanceof Error) throw r
        const text = typeof r === 'string' ? r : r.text
        const served = typeof r === 'string' ? `served-${model}` : r.served
        return { text, toolInput: null, stopReason: 'end_turn', inputTokens: null, outputTokens: null, latencyMs: null, servedModelId: served }
      },
    },
  }
}
const M: Models = { ...DEFAULT_MODELS }
const byModel = (answers: Partial<Record<keyof Models, string>>) => (model: string) => (model === M.l1 ? answers.l1 : model === M.l2 ? answers.l2 : answers.adj) ?? 'NO\nreason'

describe('rubric', () => {
  it('is the ruling text verbatim', () => {
    expect(ABSENCE_RUBRIC).toBe(RULING_RUBRIC)
    const ruling = path.join(os.homedir(), 'oc/consult-audit/RULING-FABLE-ABSENCE-RUBRIC-14OCT.md')
    if (existsSync(ruling)) {
      const text = readFileSync(ruling, 'utf8')
      const start = text.indexOf('"', text.indexOf('exact wording)')) + 1
      const end = text.indexOf('"\n', start)
      expect(text.slice(start, end)).toBe(ABSENCE_RUBRIC)
    }
  })
})

describe('parseAnswer', () => {
  it('needs YES or NO as the first word and never coerces', () => {
    expect(parseAnswer('YES\nBecause x')).toEqual({ answer: 'yes', reason: 'Because x' })
    expect(parseAnswer('  no. It was addressed.')).toEqual({ answer: 'no', reason: 'It was addressed.' })
    expect(parseAnswer('Yes - fine')?.answer).toBe('yes')
    for (const bad of ['', 'Maybe yes', 'NOT sure', 'YESTERDAY', 'The answer is NO', '**YES**', 'No_idea']) expect(parseAnswer(bad)).toBeNull()
  })
})

describe('labelItem', () => {
  it('blinding: no p, outcome, judge answer or other label in any prompt; L1 and L2 get the same prompt', async () => {
    const { sender, calls } = fakeSender(byModel({ l1: 'YES\nok', l2: 'NO\nok', adj: 'YES\nok' }))
    const rec = await labelItem(sender, M, item(), consult())
    expect(calls).toHaveLength(3)
    const [a, b, adj] = calls
    expect(a!.turn).toEqual(b!.turn)
    for (const c of calls) {
      const all = `${c.turn.system}\n${c.turn.user}`
      expect(all).not.toMatch(/primary_p|second_p|outcome|dropped|jev|gemini|bench_id|item-0|p_yes/i)
      expect(all).toContain(RULING_RUBRIC)
    }
    for (const c of [a!, b!]) expect(`${c.turn.system}\n${c.turn.user}`).not.toMatch(/Labeler|disagree/i)
    expect(adj!.turn.user).toMatch(/Labeler A: YES/)
    expect(adj!.turn.user).toMatch(/Labeler B: NO/)
    expect(rec).toMatchObject({ l1: 'yes', l2: 'no', adj: 'yes', label: 'yes', unlabeled: null, run_id: 'run-test' })
  })

  it('rebuilds the window from the input turns: claim, role, time and English text', async () => {
    const c = consult()
    const turns = prepass(c.input).turns
    const { sender, calls } = fakeSender(() => 'NO\nx')
    await labelItem(sender, M, item(), c)
    const user = calls[0]!.turn.user
    expect(user.startsWith('Claim: The risks of the recommended procedure were not heard in the consult recording.\n\nTranscript window:\n')).toBe(true)
    for (const [i, t] of turns.slice(0, 3).entries()) {
      expect(user).toContain(`[${segmentId(i)} ${t.role.toUpperCase()} `)
      expect(user).toContain(t.text_en)
    }
    expect(user).not.toContain(turns[3]?.text_en ?? '\u0000never')
    expect(buildWindow(c, { context: [{ segment_id: 'seg-9999', t0: 0, t1: 1 }] })).toBeNull()
  })

  it('the adjudicator is called only when L1 and L2 disagree', async () => {
    for (const [l1, l2, calls, label] of [['YES', 'YES', 2, 'yes'], ['NO', 'NO', 2, 'no'], ['YES', 'NO', 3, 'no'], ['NO', 'YES', 3, 'no']] as const) {
      const f = fakeSender(byModel({ l1, l2, adj: 'NO\nr' }))
      const rec = await labelItem(f.sender, M, item(), consult())
      expect(f.calls).toHaveLength(calls)
      expect(f.calls.filter((c) => c.model === M.adj)).toHaveLength(calls - 2)
      expect(rec.label).toBe(label)
    }
  })

  it('counts parse failures and errors as unlabeled, never coerced, and does not adjudicate them', async () => {
    const unparse = fakeSender(byModel({ l1: 'Probably yes', l2: 'YES\nr' }))
    expect(await labelItem(unparse.sender, M, item(), consult())).toMatchObject({ l1: null, l2: 'yes', label: null, unlabeled: 'labeler_unparseable', status: { l1: 'unparseable', l2: 'ok', adj: 'not_asked' } })
    expect(unparse.calls).toHaveLength(2)
    const err = fakeSender((m) => (m === M.l2 ? new Error('boom with text') : 'YES\nr'))
    const rec = await labelItem(err.sender, M, item(), consult())
    expect(rec).toMatchObject({ label: null, unlabeled: 'labeler_error', status: { l2: 'error' } })
    expect(JSON.stringify(rec)).not.toContain('boom')
    const badAdj = fakeSender(byModel({ l1: 'YES', l2: 'NO', adj: 'Hard to say' }))
    expect(await labelItem(badAdj.sender, M, item(), consult())).toMatchObject({ label: null, adj: null, unlabeled: 'adjudicator_unparseable' })
    const missing = fakeSender(() => 'YES')
    expect(await labelItem(missing.sender, M, item(), undefined)).toMatchObject({ label: null, unlabeled: 'input_missing' })
    expect(missing.calls).toHaveLength(0)
  })

  it('records intended and served ids per call and no text', async () => {
    const { sender } = fakeSender((m) => (m === M.l2 ? { text: 'NO\nreason text here', served: null } : 'YES\nreason text here'))
    const rec = await labelItem(sender, M, item(), consult())
    expect(rec.intended).toEqual(M)
    expect(rec.served).toEqual({ l1: `served-${M.l1}`, l2: null, adj: `served-${M.adj}` })
    expect(JSON.stringify(rec)).not.toContain('reason text here')
    expect(JSON.stringify(rec)).not.toContain('risks')
  })
})

describe('models and the A1 proof', () => {
  it('defaults are the settled ids; env names override; ids are checked against the allowlist by name only', () => {
    expect(modelsFromEnv({})).toEqual({ models: DEFAULT_MODELS, invalid: [] })
    expect(modelsFromEnv({ BENCH_L2_MODEL: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0' }).models.l2).toBe('global.anthropic.claude-sonnet-4-5-20250929-v1:0')
    const bad = modelsFromEnv({ BENCH_L1_MODEL: 'global.anthropic.claude-sonnet-5-5', BENCH_ADJ_MODEL: 'not-a-model' })
    expect(bad.invalid).toEqual(['BENCH_L1_MODEL (not in allowlist)', 'BENCH_ADJ_MODEL (not in allowlist)'])
    expect(bad.invalid.join()).not.toContain('not-a-model')
  })

  it('one tiny call per distinct model; served null means unverified', async () => {
    const { sender, calls } = fakeSender((m) => (m === M.l2 ? { text: 'ok', served: null } : 'ok'))
    const proofs = await proveModels(sender, M)
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.turn.user === 'ok' && c.turn.maxTokens <= 8)).toBe(true)
    expect(proofs.map((p) => [p.role, p.intended, p.served_verified])).toEqual([
      ['l1', M.l1, true],
      ['l2', M.l2, false],
      ['adj', M.adj, true],
    ])
    expect(proofs[1]!.served).toBeNull()
    // The same id twice is proved once.
    const same = fakeSender(() => 'ok')
    await proveModels(same.sender, { l1: M.l1, l2: M.l2, adj: M.l1 })
    expect(same.calls).toHaveLength(2)
  })
})

describe('main', () => {
  const setup = () => {
    const dir = tmp()
    const input = path.join(dir, 'in.jsonl')
    writeFileSync(input, fixtureJsonl())
    const sample = path.join(dir, 'sample.jsonl')
    writeFileSync(sample, [item('item-001'), item('item-002')].map((i) => `${JSON.stringify(i)}\n`).join(''))
    return { dir, input, sample }
  }
  const printed = () => vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

  it('dry run: counts and models, no call, no output file', async () => {
    const { dir, input, sample } = setup()
    const write = printed()
    const { sender, calls } = fakeSender(() => 'YES')
    expect(await main(['--sample', sample, '--input', input, '--dry-run'], {}, sender)).toBe(0)
    const out = write.mock.calls.map((c) => String(c[0])).join('')
    expect(out).toContain('items=2 rebuildable=2')
    expect(out).toContain('probes=3 labeler_calls=4 adjudicator_calls<=2')
    expect(calls).toHaveLength(0)
    expect(existsSync(path.join(dir, 'labels.jsonl'))).toBe(false)
  })

  it('proves the models first, prints served_verified per model, writes a 0600 file with ids and codes only', async () => {
    const { dir, input, sample } = setup()
    const write = printed()
    const out = path.join(dir, 'labels.jsonl')
    const { sender, calls } = fakeSender(byModel({ l1: 'YES\nsecret reason', l2: 'YES\nsecret reason' }))
    expect(await main(['--sample', sample, '--input', input, '--out', out], {}, sender)).toBe(0)
    expect(calls.slice(0, 3).every((c) => c.turn.user === 'ok')).toBe(true)
    const log = write.mock.calls.map((c) => String(c[0])).join('')
    expect(log).toMatch(/model=l1 intended=\S+ served=\S+ served_verified=yes/)
    expect(log).not.toContain('WARNING')
    expect(log).not.toContain('secret reason')
    expect(log).not.toContain('risks of the recommended')
    expect(statSync(out).mode & 0o777).toBe(0o600)
    const rows = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LabelRecord)
    expect(rows.map((r) => r.label)).toEqual(['yes', 'yes'])
    expect(readFileSync(out, 'utf8')).not.toContain('secret reason')
  })

  it('an unverified served id warns and still labels', async () => {
    const { dir, input, sample } = setup()
    const write = printed()
    const out = path.join(dir, 'labels.jsonl')
    const { sender } = fakeSender(() => ({ text: 'NO\nr', served: null }))
    expect(await main(['--sample', sample, '--input', input, '--out', out], {}, sender)).toBe(0)
    const log = write.mock.calls.map((c) => String(c[0])).join('')
    expect(log).toContain('served_verified=no')
    expect(log).toMatch(/WARNING: a served model id is unverified/)
    expect(log).toContain('GetInferenceProfile')
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('a failed proof call stops before any label is written', async () => {
    const { dir, input, sample } = setup()
    printed()
    const out = path.join(dir, 'labels.jsonl')
    const { sender, calls } = fakeSender(() => new Error('AccessDenied'))
    expect(await main(['--sample', sample, '--input', input, '--out', out], {}, sender)).toBe(2)
    expect(existsSync(out)).toBe(false)
    expect(calls).toHaveLength(3)
  })

  it('a model id outside the allowlist stops with the env name only; an existing out is refused; missing env names are listed', async () => {
    const { dir, input, sample } = setup()
    const write = printed()
    expect(await main(['--sample', sample, '--input', input, '--dry-run'], { BENCH_ADJ_MODEL: 'nope' })).toBe(2)
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('BENCH_ADJ_MODEL (not in allowlist)')
    const out = path.join(dir, 'labels.jsonl')
    writeFileSync(out, 'keep\n')
    await expect(main(['--sample', sample, '--input', input, '--out', out], {}, fakeSender(() => 'YES').sender)).rejects.toThrow('out_path_exists')
    expect(readFileSync(out, 'utf8')).toBe('keep\n')
    expect(await main(['--sample', sample, '--input', input, '--out', path.join(dir, 'x.jsonl')], {})).toBe(2)
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain('live run needs these env names set: BEDROCK_REGION')
  })
})

// ---- scoring ------------------------------------------------------------------------------------------------------------

const answer = (b: boolean) => (b ? ('yes' as const) : ('no' as const))
// Hand-checked set of 10 labeled items + 1 unlabeled:
//  label  : items 0-4 yes, 5-9 no
//  jev    : yes on 0-3 and 5          -> (Y,Y)=4 (Y,N)=1 (N,Y)=1 (N,N)=4: po 0.8, pe 0.5, kappa 0.6
//  gemini : yes on 0,1 and 5,6,7      -> (Y,Y)=2 (Y,N)=3 (N,Y)=3 (N,N)=2: po 0.4, pe 0.5, kappa -0.2
//  l1/l2  : both yes 0-2, l1 yes/l2 no on 3-4 (adjudicated yes), both no 5-9
//           po 0.8, pe 0.5*0.3 + 0.5*0.7 = 0.5, kappa 0.6
const yesItems = new Set([0, 1, 2, 3, 4])
const jevYes = new Set([0, 1, 2, 3, 5])
const gemYes = new Set([0, 1, 5, 6, 7])
const labelRows = (): LabelRecord[] => [
  ...Array.from({ length: 10 }, (_, i): LabelRecord => {
    const l2 = answer(i < 3)
    const disagree = i === 3 || i === 4
    return {
      item_id: `item-${String(i + 1).padStart(3, '0')}`,
      run_id: 'run-test',
      l1: i >= 5 ? 'no' : 'yes',
      l2,
      adj: disagree ? 'yes' : null,
      label: answer(yesItems.has(i)),
      status: { l1: 'ok', l2: 'ok', adj: disagree ? 'ok' : 'not_asked' },
      unlabeled: null,
      served: { l1: null, l2: null, adj: null },
      intended: M,
    }
  }),
  { item_id: 'item-011', run_id: 'run-test', l1: null, l2: 'yes', adj: null, label: null, status: { l1: 'unparseable', l2: 'ok', adj: 'not_asked' }, unlabeled: 'labeler_unparseable', served: { l1: null, l2: null, adj: null }, intended: M },
]
const keyRows = (): KeyRow[] =>
  Array.from({ length: 11 }, (_, i): KeyRow => ({
    item_id: `item-${String(i + 1).padStart(3, '0')}`,
    run_id: 'run-test',
    bench_id: `b-${i}`,
    group: i < 5 ? 'concern' : 'consent.risks',
    outcome: 'agree',
    primary_p: jevYes.has(i) ? 0.95 : 0.05,
    second_p: gemYes.has(i) ? 0.95 : 0.05,
  }))

describe('bench-score', () => {
  it('kappas against the labels are hand-checked: jev 0.6, gemini -0.2, labelers 0.6', () => {
    const s = score(labelRows(), keyRows())
    expect(s.items).toBe(11)
    expect(s.labeled).toBe(10)
    expect(s.unlabeled).toEqual({ labeler_unparseable: 1 })
    expect(s.adjudicated).toBe(2)
    expect(s.jev).toEqual({ n: 10, kappa: 0.6, yes_rate: 0.5, agreement: 0.8 })
    expect(s.gemini).toEqual({ n: 10, kappa: -0.2, yes_rate: 0.5, agreement: 0.4 })
    expect(s.l1_l2_pairs).toBe(10)
    expect(s.l1_l2_disagree).toBe(2)
    expect(s.kappa_l1_l2).toBe(0.6)
    expect(s.label_yes_rate).toBe(0.5)
    expect(s.both_kappa_ge_r3).toBe(false)
    expect(s.by_group).toEqual([
      { group: 'concern', items: 5, labeled: 5, label_yes: 5 },
      { group: 'consent.risks', items: 6, labeled: 5, label_yes: 0 },
    ])
    expect(s.unmatched).toEqual({ key_without_label: 0, label_without_key: 0 })
  })

  it('uses the per-rule cut: a p of 0.8 is yes for a non-safety rule', () => {
    const keys = keyRows().map((k) => ({ ...k, primary_p: 0.8, second_p: 0.8 }))
    const s = score(labelRows(), keys)
    expect(s.jev.yes_rate).toBe(1)
  })

  it('a kappa that is undefined is n/a and the R3 line is n/a', () => {
    const keys = keyRows().map((k) => ({ ...k, primary_p: 0.95 }))
    const s = score(labelRows(), keys)
    expect(s.jev.kappa).toBe(0) // judge always yes, labels half: pe = 0.5, po = 0.5
    const flat = labelRows().map((l) => ({ ...l, label: 'yes' as const }))
    const allYes = score(flat, keys)
    expect(allYes.jev.kappa).toBeNull()
    expect(busSafeBlock(allYes)).toContain('jev_vs_labels n=11 kappa=n/a')
  })

  it('the bus-safe block: counts and kappas only, the model-labelled line, no 8+ digit run, no ids or text', () => {
    const block = busSafeBlock(score(labelRows(), keyRows()))
    expect(block.split('\n')[0]).toBe(LABELLING_LINE)
    expect(block).toContain('jev_vs_labels n=10 kappa=0.6 agreement=0.8 yes_rate=0.5')
    expect(block).toContain('gemini_vs_labels n=10 kappa=-0.2')
    expect(block).toContain('labelers l1_l2_pairs=10 disagree=2 kappa=0.6')
    expect(block).toContain('group concern items=5 labeled=5 label_yes=5')
    expect(block).toContain('r3_both_kappa_ge_0.4=no')
    expect(block).not.toMatch(/\d{8,}/)
    expect(block).not.toMatch(/item-|b-\d|seg-|enc-|claim|quote|risks of/)
  })

  it('warns when the key and labels do not match', () => {
    const s = score(labelRows(), keyRows().slice(0, 6))
    expect(s.unmatched).toEqual({ key_without_label: 0, label_without_key: 5 })
    expect(busSafeBlock(s)).toContain('WARNING key/label mismatch')
  })

  it('refuses to join labels and a key from different sampler runs (or without a run id)', () => {
    const otherKey = keyRows().map((k) => ({ ...k, run_id: 'run-other' }))
    expect(() => score(labelRows(), otherKey)).toThrow('run_id_mismatch')
    const oneLabel = labelRows().map((l, i) => (i === 3 ? { ...l, run_id: 'run-other' } : l))
    expect(() => score(oneLabel, keyRows())).toThrow('run_id_mismatch')
    const noRun = labelRows().map(({ run_id: _drop, ...rest }) => rest as unknown as LabelRecord)
    expect(() => score(noRun, keyRows())).toThrow('run_id_missing')
    expect(() => score(labelRows(), keyRows())).not.toThrow()
  })

  it('CLI prints the block and writes --out as 0600', () => {
    const dir = tmp()
    const l = path.join(dir, 'labels.jsonl')
    const k = path.join(dir, 'key.jsonl')
    writeFileSync(l, labelRows().map((r) => `${JSON.stringify(r)}\n`).join(''))
    writeFileSync(k, keyRows().map((r) => `${JSON.stringify(r)}\n`).join(''))
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const out = path.join(dir, 'score.json')
    expect(scoreMain(['--labels', l, '--key', k, '--out', out])).toBe(0)
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toContain(LABELLING_LINE)
    expect(statSync(out).mode & 0o777).toBe(0o600)
    expect(() => scoreMain(['--labels', l, '--key', k, '--out', out])).toThrow()
  })
})
