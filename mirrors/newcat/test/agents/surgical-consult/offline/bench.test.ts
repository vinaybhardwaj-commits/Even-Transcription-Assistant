import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeModelClient } from '../../../../src/llm/fake.js'
import { FakeJudgePort, type JudgePort } from '../../../../src/platform/agent/judge-port.js'
import type { SecondJudge } from '../../../../src/platform/judge/second.js'
import { appendBench, benchId, prepareBenchFile, type BenchLine } from '../../../../src/agents/surgical-consult/offline/bench.js'
import { allocate, groupOf, main as sampleMain, readBench, rng, sampleBench } from '../../../../src/agents/surgical-consult/offline/bench-sample.js'
import { parseConsultLines } from '../../../../src/agents/surgical-consult/offline/input.js'
import { main, parseArgs, runBatch, type BatchWiring } from '../../../../src/agents/surgical-consult/offline/run-batch.js'
import { prepass } from '../../../../src/agents/surgical-consult/prepass.js'
import { segmentId } from '../../../../src/agents/surgical-consult/segments.js'
import { scriptedExtractor } from '../helpers.js'
import { fixtureJsonl } from './helpers.js'

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 's6-bench-'))
const consults = () => parseConsultLines(fixtureJsonl()).consults
const mode = (file: string): number => statSync(file).mode & 0o777
afterEach(() => vi.restoreAllMocks())

interface State {
  rule: string
  claim: string
  evidence: Array<{ quote: string }>
  context_segments?: Array<{ segment_id: string; text: string }>
}

/** Fake judges that capture the exact state each is asked about; the second answers lower so outcomes vary. */
function capturing(primaryP: number, secondP: number) {
  const primary: State[] = []
  const second: State[] = []
  const wiring: BatchWiring = {
    models: (sql) => new FakeModelClient(sql, (request) => scriptedExtractor(request)),
    judge: () => {
      const port: JudgePort = new FakeJudgePort(() => primaryP)
      return { askValidity: (state, q, set) => (primary.push(state as State), port.askValidity(state, q, set)) }
    },
    second: () => ({ id: 'fake-second', askValidity: async (state) => (second.push(state as State), { p_yes: secondP, servedModelIds: ['fake-second'] }) }) as SecondJudge,
  }
  return { primary, second, wiring }
}

const inputs = new Map(consults().map((c) => [c.input.encounter_id, c.input]))

describe('bench export: what the judges received', () => {
  it('each line carries the exact claim, context and evidence both judges received, and rebuilds from the input turns', async () => {
    const cap = capturing(0.95, 0.95)
    const result = await runBatch(consults(), cap.wiring, { limit: 9, concurrency: 1, bench: true })
    const lines = result.entries.flatMap((e) => e.bench ?? [])
    expect(cap.primary.length).toBeGreaterThan(0)
    expect(lines).toHaveLength(cap.primary.length)
    expect(cap.second).toHaveLength(cap.primary.length)
    expect(lines.some((l) => l.polarity === 'absence')).toBe(true)
    expect(lines.some((l) => l.polarity === 'presence')).toBe(true)
    lines.forEach((line, i) => {
      const state = cap.primary[i]!
      expect(cap.second[i]).toEqual(state) // both judges got the same state
      expect(line.rule_id).toBe(state.rule)
      expect(line.claim).toBe(state.claim)
      expect(line.facts.map((f) => f.quote)).toEqual(state.evidence.map((e) => e.quote))
      expect(line.fact_refs).toEqual(line.facts.map((_, k) => `f${k + 1}`))
      expect(line.context.map((c) => c.segment_id)).toEqual((state.context_segments ?? []).map((c) => c.segment_id))
      // Rebuild the window from the input turns: same text, same times.
      const turns = prepass(inputs.get(line.encounter_id)!).turns
      for (const [k, seg] of (state.context_segments ?? []).entries()) {
        const idx = turns.findIndex((_, t) => segmentId(t) === seg.segment_id)
        expect(turns[idx]!.text_en).toBe(seg.text)
        expect(line.context[k]).toEqual({ segment_id: seg.segment_id, t0: turns[idx]!.t0, t1: turns[idx]!.t1 })
      }
      // Evidence segments exist in the input and the quote is verbatim inside it.
      for (const f of line.facts) {
        const idx = turns.findIndex((_, t) => segmentId(t) === f.segment_id)
        expect(turns[idx]!.text_en).toContain(f.quote)
        expect(turns[idx]!.role).toBe(f.role)
      }
      expect(line.primary_p).toBe(0.95)
      expect(line.second_p).toBe(0.95)
      expect(line.outcome).toBe('agree')
    })
  })

  it('records outcomes and p for disagreement and drops', async () => {
    const result = await runBatch(consults(), capturing(0.95, 0.1).wiring, { limit: 9, concurrency: 1, bench: true })
    const lines = result.entries.flatMap((e) => e.bench ?? [])
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.outcome === 'disagree' && l.primary_p === 0.95 && l.second_p === 0.1)).toBe(true)
    const dropped = await runBatch(consults(), capturing(0.1, 0.1).wiring, { limit: 9, concurrency: 1, bench: true })
    expect(dropped.entries.flatMap((e) => e.bench ?? []).every((l) => l.outcome === 'dropped')).toBe(true)
  })

  it('is off without the flag: no bench lines, runs unchanged', async () => {
    const off = await runBatch(consults(), capturing(0.95, 0.95).wiring, { limit: 9, concurrency: 1 })
    expect(off.entries.every((e) => e.bench === undefined)).toBe(true)
    const on = await runBatch(consults(), capturing(0.95, 0.95).wiring, { limit: 9, concurrency: 1, bench: true })
    expect(on.entries.map((e) => e.record.status)).toEqual(off.entries.map((e) => e.record.status))
    expect(on.entries.map((e) => e.record.judge_pairs)).toEqual(off.entries.map((e) => e.record.judge_pairs))
  })

  it('ids carry no run of 8 or more digits and the file is 0600', async () => {
    const result = await runBatch(consults(), capturing(0.95, 0.95).wiring, { limit: 9, concurrency: 1, bench: true })
    const file = path.join(tmp(), 'bench.jsonl')
    prepareBenchFile(file)
    expect(mode(file)).toBe(0o600)
    for (const e of result.entries) appendBench(file, e.bench ?? [])
    expect(mode(file)).toBe(0o600)
    const lines = readBench(file)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      for (const id of [l.bench_id, l.encounter_id, ...l.fact_refs, ...l.context.map((c) => c.segment_id), ...l.facts.map((f) => f.segment_id)]) expect(id).not.toMatch(/\d{8,}/)
    }
    expect(new Set(lines.map((l) => l.bench_id)).size).toBe(lines.length)
  })

  it('benchId never has 8+ digits in a row', () => {
    for (let i = 0; i < 2000; i++) expect(benchId()).not.toMatch(/\d{8,}/)
  })
})

describe('--bench-out on the CLI', () => {
  const setup = () => {
    const dir = tmp()
    const input = path.join(dir, 'in.jsonl')
    writeFileSync(input, fixtureJsonl())
    return { dir, input }
  }

  it('parses the flag; absent means no export', () => {
    expect(parseArgs(['--in', 'a', '--out', 'b']).benchOut).toBeUndefined()
    expect(parseArgs(['--in', 'a', '--out', 'b', '--bench-out', 'c']).benchOut).toBe('c')
    expect(() => parseArgs(['--in', 'a', '--out', 'b', '--bench-out', ''])).toThrow('--bench-out needs a path')
  })

  it('without the flag no bench file appears; with it the file is created 0600', async () => {
    const { dir, input } = setup()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['--in', input, '--out', path.join(dir, 'o1'), '--fake', '--limit', '9'], {})).toBe(0)
    expect(existsSync(path.join(dir, 'bench.jsonl'))).toBe(false)
    const bench = path.join(dir, 'bench.jsonl')
    expect(await main(['--in', input, '--out', path.join(dir, 'o2'), '--fake', '--limit', '9', '--bench-out', bench], {})).toBe(0)
    expect(mode(bench)).toBe(0o600)
  })

  it('refuses an existing bench path before running anything', async () => {
    const { dir, input } = setup()
    const bench = path.join(dir, 'bench.jsonl')
    writeFileSync(bench, 'keep\n')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await expect(main(['--in', input, '--out', path.join(dir, 'o'), '--fake', '--bench-out', bench], {})).rejects.toThrow('bench_path_exists')
    expect(readFileSync(bench, 'utf8')).toBe('keep\n')
    expect(existsSync(path.join(dir, 'o'))).toBe(false)
  })

  it('bench content stays out of runs.jsonl, report.json, report.md and stdout', async () => {
    const { dir } = setup()
    const out = path.join(dir, 'o')
    const bench = path.join(dir, 'bench.jsonl')
    // Scripted fake wiring through runBatch, then the same writers main uses.
    const cap = capturing(0.95, 0.95)
    const result = await runBatch(consults(), cap.wiring, { limit: 9, concurrency: 1, bench: true })
    expect(result.entries.flatMap((e) => e.bench ?? []).length).toBeGreaterThan(0)
    const { prepareOutDir, writeEntry } = await import('../../../../src/agents/surgical-consult/offline/run-batch.js')
    prepareOutDir(out)
    prepareBenchFile(bench)
    for (const e of result.entries) {
      writeEntry(out, e)
      appendBench(bench, e.bench ?? [])
    }
    const lines = readBench(bench)
    const runs = readFileSync(path.join(out, 'runs.jsonl'), 'utf8')
    for (const l of lines) {
      expect(runs).not.toContain(l.bench_id)
      expect(runs).not.toContain(l.claim)
    }
    expect(runs).not.toContain('bench_id')
    expect(runs).not.toContain('"claim"')
    expect(runs).not.toContain('"facts"')
  })
})

// ---- sampler ------------------------------------------------------------------------------------------------------------

let seq = 0
const line = (rule: string, outcome: BenchLine['outcome'], polarity: BenchLine['polarity'] = 'absence'): BenchLine => {
  seq += 1
  return {
    bench_id: `b-${String(seq).padStart(4, '0')}`,
    encounter_id: `enc-${seq}`,
    rule_id: rule,
    polarity,
    question_set: polarity === 'absence' ? 'consult-absence-claim' : 'consult-finding-validity',
    claim: 'A response to this patient concern was not heard in the consult recording.',
    context: [{ segment_id: 'seg-0001', t0: 1, t1: 2 }],
    fact_refs: ['f1'],
    facts: [{ segment_id: 'seg-0001', role: 'patient', t0: 1, t1: 2, quote: 'q' }],
    primary_p: 0.8,
    second_p: 0.2,
    outcome,
  }
}
const many = (rule: string, outcome: BenchLine['outcome'], n: number): BenchLine[] => Array.from({ length: n }, () => line(rule, outcome))

const built: BenchLine[] = [
  ...many('concern.unaddressed', 'dropped', 60),
  ...many('concern.unaddressed', 'disagree', 30),
  ...many('concern.unaddressed', 'agree', 10),
  ...many('consent.risks', 'dropped', 20),
  ...many('consent.risks', 'disagree', 5),
  ...many('consent.cost', 'agree', 2),
  ...many('consent.recovery', 'dropped', 1),
  ...many('consent.risks', 'agree', 3),
  ...many('consent.risks', 'unavailable', 7),
  ...Array.from({ length: 50 }, () => line('pressure.decide_today', 'agree', 'presence')), // presence: out
]
const corpus = (): BenchLine[] => built.map((l) => ({ ...l }))

describe('allocate', () => {
  it('hand-checked: proportional with a minimum of 1 per non-empty cell', () => {
    expect(allocate([60, 30, 9, 1], 10)).toEqual([5, 3, 1, 1])
    expect(allocate([50, 50], 10)).toEqual([5, 5])
    expect(allocate([0, 10, 0, 10], 4)).toEqual([0, 2, 0, 2])
    expect(allocate([3, 2], 10)).toEqual([3, 2]) // n above the total takes everything
  })
  it('refuses n below the number of non-empty cells', () => {
    expect(() => allocate([5, 5, 5], 2)).toThrow('n_below_cells')
  })
})

describe('bench sampler', () => {
  it('groups concern first, then each consent element', () => {
    expect(groupOf('concern.unaddressed')).toBe('concern')
    expect(groupOf('consent.risks')).toBe('consent.risks')
  })

  it('samples n absence lines, every non-empty cell at least once, proportionally, never presence or unavailable', () => {
    const r = sampleBench(corpus(), 30, 'seed-1')
    expect(r.sample).toHaveLength(30)
    expect(r.key).toHaveLength(30)
    expect(r.excluded_unavailable).toBe(7)
    expect(r.cells).toHaveLength(8) // concern x3, risks x3, cost agree, recovery dropped
    for (const c of r.cells) {
      expect(c.drawn).toBeGreaterThanOrEqual(1)
      expect(c.drawn).toBeLessThanOrEqual(c.available)
    }
    expect(r.cells.reduce((sum, c) => sum + c.drawn, 0)).toBe(30)
    const drawn = (g: string, o: string) => r.cells.find((c) => c.group === g && c.outcome === o)!.drawn
    expect(drawn('concern', 'dropped')).toBeGreaterThan(drawn('concern', 'disagree'))
    expect(drawn('concern', 'disagree')).toBeGreaterThan(drawn('concern', 'agree'))
    expect(drawn('consent.cost', 'agree')).toBeGreaterThanOrEqual(1)
    expect(drawn('consent.recovery', 'dropped')).toBe(1)
    // Key rows agree with the strata; no presence rule slipped in.
    expect(r.key.every((k) => !k.group.startsWith('pressure'))).toBe(true)
    expect(r.key.filter((k) => k.group === 'concern' && k.outcome === 'dropped')).toHaveLength(drawn('concern', 'dropped'))
  })

  it('blinding: the sample has no bench_id, p values or outcome; the key maps items to them', () => {
    const r = sampleBench(corpus(), 30, 'seed-1')
    for (const item of r.sample) {
      expect(Object.keys(item)).not.toEqual(expect.arrayContaining(['primary_p']))
      for (const banned of ['bench_id', 'primary_p', 'second_p', 'outcome']) expect(item).not.toHaveProperty(banned)
      expect(item.claim.length).toBeGreaterThan(0)
    }
    expect(JSON.stringify(r.sample)).not.toMatch(/b-\d{4}|dropped|disagree|"agree"/)
    // Exact allow-list: a new key (for example a judge field carrying p values) fails here, whatever its name.
    const ALLOWED = ['claim', 'context', 'encounter_id', 'fact_refs', 'facts', 'item_id', 'polarity', 'question_set', 'rule_id', 'run_id']
    for (const item of r.sample) expect(Object.keys(item).sort()).toEqual(ALLOWED)
    // The corpus judge p values (0.8 and 0.2) appear nowhere in the serialised sample, under any key.
    const serialised = JSON.stringify(r.sample)
    for (const p of ['0.8', '0.2']) expect(serialised).not.toContain(p)
    expect(JSON.stringify(r.key)).toContain('0.8')
    expect(new Set(r.key.map((k) => k.item_id)).size).toBe(30)
    expect(r.key.every((k) => /^b-\d{4}$/.test(k.bench_id) && ['dropped', 'disagree', 'agree'].includes(k.outcome))).toBe(true)
    expect(r.sample.map((i) => i.item_id)).toEqual(r.key.map((k) => k.item_id))
  })

  it('is deterministic for a seed (and independent of line order), and a different seed draws differently', () => {
    const a = sampleBench(corpus(), 30, 'seed-1')
    const reversed = sampleBench([...corpus()].reverse(), 30, 'seed-1')
    expect(reversed.key.map((k) => k.bench_id)).toEqual(a.key.map((k) => k.bench_id))
    const again = sampleBench(corpus(), 30, 'seed-1')
    expect(again).toEqual(a)
    const other = sampleBench(corpus(), 30, 'seed-2')
    expect(other.key.map((k) => k.bench_id)).not.toEqual(a.key.map((k) => k.bench_id))
    const r = rng('x')
    expect(r()).toBe(rng('x')())
  })

  it('does not order the sample by stratum', () => {
    const r = sampleBench(corpus(), 30, 'seed-1')
    const groups = r.key.map((k) => k.group)
    const sorted = [...groups].sort()
    expect(groups).not.toEqual(sorted)
  })

  it('CLI: writes the sample and key as 0600, refuses existing outputs', () => {
    const dir = tmp()
    const bench = path.join(dir, 'bench.jsonl')
    writeFileSync(bench, corpus().map((l) => `${JSON.stringify(l)}\n`).join(''))
    const out = path.join(dir, 'sample.jsonl')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(sampleMain(['--bench', bench, '--n', '30', '--seed', 's', '--out', out])).toBe(0)
    expect(mode(out)).toBe(0o600)
    expect(mode(`${out}.key`)).toBe(0o600)
    expect(readFileSync(out, 'utf8').trim().split('\n')).toHaveLength(30)
    expect(readFileSync(out, 'utf8')).not.toContain('primary_p')
    expect(() => sampleMain(['--bench', bench, '--n', '30', '--seed', 's', '--out', out])).toThrow('out_path_exists')
  })
})
