import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { labelItem, DEFAULT_MODELS } from '../../../../src/agents/surgical-consult/offline/bench-label.js'
import { readJsonl, runIdOf, sampleBench, type SampleLine } from '../../../../src/agents/surgical-consult/offline/bench-sample.js'
import { score } from '../../../../src/agents/surgical-consult/offline/bench-score.js'
import { main } from '../../../../src/agents/surgical-consult/offline/run-batch.js'
import { CodedError, reportFailure, safeMessage } from '../../../../src/agents/surgical-consult/offline/safe-error.js'
import type { BenchLine } from '../../../../src/agents/surgical-consult/offline/bench.js'
import { parseConsultLines } from '../../../../src/agents/surgical-consult/offline/input.js'
import { fixtureJsonl } from './helpers.js'

afterEach(() => vi.restoreAllMocks())
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 's6-safe-'))
const MARKER = 'MARKER_QZX_SECRET_FRAGMENT'
const TSX = path.resolve('node_modules/.bin/tsx')
const OFFLINE = path.resolve('src/agents/surgical-consult/offline')

function cli(script: string, args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync(TSX, [path.join(OFFLINE, script), ...args], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir() } })
  return { status: r.status, out: r.stdout, err: r.stderr }
}

describe('safeMessage', () => {
  it('prints codes, errno names and our own fixed messages; everything else is unknown', () => {
    expect(safeMessage(new CodedError('bad_json line 7'))).toBe('bad_json line 7')
    expect(safeMessage(Object.assign(new Error(`ENOENT: no such file '/x/${MARKER}'`), { code: 'ENOENT' }))).toBe('fs_error ENOENT')
    for (const own of ['out_path_exists', 'bench_path_exists', 'run_id_mismatch', 'n_below_cells', '--in is required', '--bench-out needs a path', 'unknown argument --zap', 'usage: --bench <file> --n <int> --seed <s> --out <file> [--key-out <file>]']) {
      expect(safeMessage(new Error(own))).toBe(own)
    }
    let parse: unknown
    try {
      JSON.parse(`{"claim": ${MARKER}`)
    } catch (e) {
      parse = e
    }
    expect((parse as Error).message).toContain('MARKER') // the premise: node's message does echo a fragment
    expect(safeMessage(parse)).toBe('unknown')
    const zodErr = z.object({ a: z.string() }).safeParse({ a: MARKER }).error
    expect(safeMessage(zodErr)).toBe('unknown')
    expect(safeMessage(new Error(`something with ${MARKER}`))).toBe('unknown')
    expect(safeMessage('a string')).toBe('unknown')
  })
})

describe('failure reporting', () => {
  it('reportFailure never prints an uncoded error message', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    reportFailure('tool', new SyntaxError(`Unexpected token 'M', "${MARKER}" is not valid JSON`))
    reportFailure('tool', new CodedError('bad_json line 4'))
    expect(write.mock.calls.map((c) => String(c[0])).join('')).toBe('tool failed: unknown\ntool failed: bad_json line 4\n')
  })

  it('no tool writes an error message to stderr or stdout itself (source scan)', () => {
    for (const file of ['bench-sample.ts', 'bench-label.ts', 'bench-score.ts', 'run-batch.ts', 'bench.ts']) {
      const text = readFileSync(path.join(OFFLINE, file), 'utf8')
      expect(text, file).not.toMatch(/error(?:\s+instanceof\s+\w+)?\s*\?\s*error\.message|\.message\}/)
      expect(text, file).not.toMatch(/stderr\.write\(`[^`]*\$\{(?!.*reportFailure)/)
    }
  })
})

describe('no input fragment reaches stdout or stderr', () => {
  const lineWithMarker = `{"claim": ${MARKER}`
  const goodSample = (): string => {
    const sample = sampleBench(benchLines(), 4, 's').sample
    return sample.map((l) => JSON.stringify(l)).join('\n') + '\n'
  }

  it('readJsonl: a bad line is bad_json line N, an array or scalar is bad_shape line N', () => {
    const dir = tmp()
    const f = path.join(dir, 'a.jsonl')
    writeFileSync(f, `{"a":1}\n\n${lineWithMarker}\n`)
    expect(() => readJsonl(f)).toThrow(new CodedError('bad_json line 3'))
    writeFileSync(f, `{"a":1}\n[1,2]\n`)
    expect(() => readJsonl(f)).toThrow(new CodedError('bad_shape line 2'))
    writeFileSync(f, `"${MARKER}"\n`)
    expect(() => readJsonl(f)).toThrow(new CodedError('bad_shape line 1'))
  })

  it('bench-sample: marker line in the bench file', () => {
    const dir = tmp()
    const bench = path.join(dir, 'bench.jsonl')
    writeFileSync(bench, `${JSON.stringify(benchLines()[0])}\n${lineWithMarker}\n`)
    const r = cli('bench-sample.ts', ['--bench', bench, '--n', '3', '--seed', 's', '--out', path.join(dir, 's.jsonl')])
    expect(r.status).toBe(1)
    expect(r.err).toBe('bench-sample failed: bad_json line 2\n')
    expect(`${r.out}${r.err}`).not.toContain('MARKER')
    expect(existsSync(path.join(dir, 's.jsonl'))).toBe(false)
  })

  it('bench-label: marker line in the sample file (dry run, no network)', () => {
    const dir = tmp()
    const input = path.join(dir, 'in.jsonl')
    writeFileSync(input, fixtureJsonl())
    const sample = path.join(dir, 'sample.jsonl')
    writeFileSync(sample, `${lineWithMarker}\n`)
    const r = cli('bench-label.ts', ['--sample', sample, '--input', input, '--dry-run'])
    expect(r.status).toBe(1)
    expect(r.err).toBe('bench-label failed: bad_json line 1\n')
    expect(`${r.out}${r.err}`).not.toContain('MARKER')
  })

  it('bench-label: a missing file prints the errno name, not the path', () => {
    const dir = tmp()
    const gone = path.join(dir, `${MARKER}.jsonl`)
    const r = cli('bench-label.ts', ['--sample', gone, '--input', gone, '--dry-run'])
    expect(r.status).toBe(1)
    expect(r.err).toBe('bench-label failed: fs_error ENOENT\n')
    expect(`${r.out}${r.err}`).not.toContain('MARKER')
  })

  it('bench-score: marker line in the labels or the key file', () => {
    const dir = tmp()
    const good = path.join(dir, 'good.jsonl')
    writeFileSync(good, goodSample())
    const bad = path.join(dir, 'bad.jsonl')
    writeFileSync(bad, `{"item_id":"item-001"}\n${lineWithMarker}\n`)
    for (const [labels, key] of [[bad, good], [good, bad]] as const) {
      const r = cli('bench-score.ts', ['--labels', labels, '--key', key])
      expect(r.status).toBe(1)
      expect(r.err).toBe('bench-score failed: bad_json line 2\n')
      expect(`${r.out}${r.err}`).not.toContain('MARKER')
    }
  })

  it('run-batch --bench-out: marker lines in the input are counted, never echoed; the run output carries no fragment', () => {
    const dir = tmp()
    const input = path.join(dir, 'in.jsonl')
    writeFileSync(input, `${lineWithMarker}\n[\"${MARKER}\"]\n${fixtureJsonl()}`)
    const out = path.join(dir, 'out')
    const bench = path.join(dir, 'bench.jsonl')
    const r = cli('run-batch.ts', ['--in', input, '--out', out, '--fake', '--limit', '2', '--bench-out', bench])
    expect(r.status).toBe(0)
    expect(`${r.out}${r.err}`).not.toContain('MARKER')
    expect(r.out).toContain('bad_json')
    // A refusal path prints a code too: an existing bench path.
    const again = cli('run-batch.ts', ['--in', input, '--out', path.join(dir, 'out2'), '--fake', '--bench-out', bench])
    expect(again.status).toBe(1)
    expect(again.err).toBe('run-batch failed: bench_path_exists\n')
    expect(existsSync(path.join(dir, 'out2'))).toBe(false)
  })
})

describe('--bench-out ordering', () => {
  it('an existing --out leaves no bench file behind; a clean run creates both', async () => {
    const dir = tmp()
    const input = path.join(dir, 'in.jsonl')
    writeFileSync(input, fixtureJsonl())
    const out = path.join(dir, 'out')
    mkdirSync(out)
    const bench = path.join(dir, 'bench.jsonl')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await expect(main(['--in', input, '--out', out, '--fake', '--bench-out', bench], {})).rejects.toThrow('out_path_exists')
    expect(existsSync(bench)).toBe(false)
    // The same bench path now works with a fresh out dir (no stale file blocks the rerun).
    expect(await main(['--in', input, '--out', path.join(dir, 'out-new'), '--fake', '--limit', '1', '--bench-out', bench], {})).toBe(0)
    expect(existsSync(bench)).toBe(true)
  })
})

// ---- sampler run id -----------------------------------------------------------------------------------------------------

let seq = 0
function benchLines(): BenchLine[] {
  const make = (rule: string, outcome: BenchLine['outcome'], n: number): BenchLine[] =>
    Array.from({ length: n }, () => {
      seq += 1
      return {
        bench_id: `b-${String(seq).padStart(4, '0')}`,
        encounter_id: `enc-${seq}`,
        rule_id: rule,
        polarity: 'absence' as const,
        question_set: 'consult-absence-claim',
        claim: 'A response to this patient concern was not heard in the consult recording.',
        context: [{ segment_id: 'seg-0001', t0: 1, t1: 2 }],
        fact_refs: ['f1'],
        facts: [{ segment_id: 'seg-0001', role: 'patient', t0: 1, t1: 2, quote: 'q' }],
        primary_p: 0.8,
        second_p: 0.2,
        outcome,
      }
    })
  return cached ?? (cached = [...make('concern.unaddressed', 'dropped', 12), ...make('concern.unaddressed', 'agree', 8), ...make('consent.risks', 'disagree', 10)])
}
let cached: BenchLine[] | null = null

describe('sampler run id', () => {
  it('the same id is in every sample item and key row; deterministic; another seed or n gives another; letters and a dash only', () => {
    const a = sampleBench(benchLines(), 12, 'seed-a')
    const ids = new Set([...a.sample.map((s) => s.run_id), ...a.key.map((k) => k.run_id)])
    expect(ids.size).toBe(1)
    const id = [...ids][0]!
    expect(id).toMatch(/^run-[a-z]{12}$|^run-[a-f0-9g-p]{12}$/)
    expect(id).not.toMatch(/\d/)
    expect(sampleBench(benchLines(), 12, 'seed-a').sample[0]!.run_id).toBe(id)
    expect(sampleBench(benchLines(), 12, 'seed-b').sample[0]!.run_id).not.toBe(id)
    expect(sampleBench(benchLines(), 11, 'seed-a').sample[0]!.run_id).not.toBe(id)
    expect(runIdOf('s', 3, ['x', 'y'])).not.toBe(runIdOf('s', 3, ['y', 'x']))
  })

  it('labels carry the sample run id and score accepts them with the matching key', async () => {
    const consult = parseConsultLines(fixtureJsonl()).consults[0]!
    const a = sampleBench(benchLines(), 6, 'seed-a')
    const labelOf = async (item: SampleLine) => labelItem({ async send() { return { text: 'NO\nr', toolInput: null, stopReason: null, inputTokens: null, outputTokens: null, latencyMs: null, servedModelId: 'x' } } }, DEFAULT_MODELS, item, consult)
    const labels = await Promise.all(a.sample.map(labelOf))
    expect(labels.every((l) => l.run_id === a.sample[0]!.run_id)).toBe(true)
    expect(() => score(labels, a.key)).not.toThrow()
  })

  it('refuses labels from one sampler run against the key of another', async () => {
    const consult = parseConsultLines(fixtureJsonl()).consults[0]!
    const a = sampleBench(benchLines(), 6, 'seed-a')
    const b = sampleBench(benchLines(), 6, 'seed-b')
    // Same item ids (item-001...), different runs: without the run id this joined silently.
    expect(a.key.map((k) => k.item_id)).toEqual(b.key.map((k) => k.item_id))
    const labels = await Promise.all(a.sample.map((item) => labelItem({ async send() { return { text: 'YES\nr', toolInput: null, stopReason: null, inputTokens: null, outputTokens: null, latencyMs: null, servedModelId: 'x' } } }, DEFAULT_MODELS, item, consult)))
    expect(() => score(labels, b.key)).toThrow('run_id_mismatch')
  })
})
