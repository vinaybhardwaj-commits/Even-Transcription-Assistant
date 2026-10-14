import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixtureJsonl } from './helpers.js'

// S6-Rf verdict P2 (m29-m31): drive main with a model client that makes real judge asks, so --bench-out has bench lines, then check
// that no bench content reaches report.md, report.json, runs.jsonl or stdout. FakeModelClient is replaced here (this file only)
// by one that defaults to the scripted extractor; the judges stay the fake Jev transport.
const holder = vi.hoisted(() => ({ script: null as null | ((request: unknown) => unknown) }))
vi.mock('../../../../src/llm/fake.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../../src/llm/fake.js')>()
  class Scripted extends actual.FakeModelClient {
    constructor(sql: ConstructorParameters<typeof actual.FakeModelClient>[0], script?: ConstructorParameters<typeof actual.FakeModelClient>[1]) {
      super(sql, script ?? ((request) => holder.script!(request) as ReturnType<NonNullable<typeof script>>))
    }
  }
  return { ...actual, FakeModelClient: Scripted }
})

import { scriptedExtractor } from '../helpers.js'
holder.script = (request) => scriptedExtractor(request as Parameters<typeof scriptedExtractor>[0])
import { readBench } from '../../../../src/agents/surgical-consult/offline/bench-sample.js'
import { main } from '../../../../src/agents/surgical-consult/offline/run-batch.js'

afterEach(() => vi.restoreAllMocks())

describe('bench content stays out of every other output (main, fake wiring with judge asks)', () => {
  it('no bench_id, fact_refs key or bench claim in report.md, report.json, runs.jsonl or stdout', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 's6-leak-'))
    const input = path.join(dir, 'in.jsonl')
    writeFileSync(input, fixtureJsonl())
    const out = path.join(dir, 'out')
    const bench = path.join(dir, 'bench.jsonl')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['--in', input, '--out', out, '--fake', '--limit', '9', '--bench-out', bench], {})).toBe(0)
    const stdout = write.mock.calls.map((c) => String(c[0])).join('')
    const lines = readBench(bench)
    // The premise: the bench has lines of both polarities, with claims and quotes, and stdout reports only the count.
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.polarity === 'absence')).toBe(true)
    expect(lines.every((l) => l.claim.length > 0 && l.facts.length > 0)).toBe(true)
    expect(stdout).toContain(`bench_lines=${lines.length}`)
    const outputs: Record<string, string> = {
      stdout,
      'report.md': readFileSync(path.join(out, 'report.md'), 'utf8'),
      'report.json': readFileSync(path.join(out, 'report.json'), 'utf8'),
      'runs.jsonl': readFileSync(path.join(out, 'runs.jsonl'), 'utf8'),
    }
    for (const [name, text] of Object.entries(outputs)) {
      for (const l of lines) {
        expect(text.includes(l.bench_id), `${name}: bench_id`).toBe(false)
        expect(text.includes(l.claim), `${name}: claim`).toBe(false)
      }
      expect(text, `${name}: bench keys`).not.toMatch(/"bench_id"|"fact_refs"|"context":\s*\[\s*\{\s*"segment_id"/)
    }
    // Stdout never carries a quote either (report.md may: its examples carry quotes on t4 by design).
    for (const l of lines) for (const f of l.facts) expect(stdout.includes(f.quote), 'stdout: quote').toBe(false)
  })
})
