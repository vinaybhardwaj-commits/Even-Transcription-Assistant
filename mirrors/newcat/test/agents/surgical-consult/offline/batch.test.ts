import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeModelClient } from '../../../../src/llm/fake.js'
import { FakeJudgePort } from '../../../../src/platform/agent/judge-port.js'
import { FakeSecondJudge, type SecondJudge } from '../../../../src/platform/judge/second.js'
import { parseConsultLines, type LoadedConsult } from '../../../../src/agents/surgical-consult/offline/input.js'
import { makeSecondJudge, missingGeminiEnv, secondFactory } from '../../../../src/agents/surgical-consult/offline/second.js'
import { RULE_SPECS } from '../../../../src/agents/surgical-consult/rules/index.js'
import { GEMINI_PINNED } from '../../../../src/llm/allowlist.js'
import type { GeminiSender } from '../../../../src/llm/gemini.js'
import { GeminiSecondJudge } from '../../../../src/platform/judge/gemini-second.js'
import { testDb, testEnv } from '../../../helpers.js'
import { recordModelCall } from '../../../../src/llm/ledger.js'
import {
  computeCaps,
  MeteredJudge,
  type Meter,
  dryRunSummary,
  main,
  extractionFor,
  missingLiveEnv,
  parseArgs,
  prepareOutDir,
  runBatch,
  scrubbedEnv,
  writeEntry,
  type BatchWiring,
} from '../../../../src/agents/surgical-consult/offline/run-batch.js'
import { buildReport, busSafeSummary, loadEntries, renderMarkdown } from '../../../../src/agents/surgical-consult/offline/report.js'
import { loadEnv } from '../../../../src/config.js'
import { scriptedExtractor } from '../helpers.js'
import { fixtureJsonl, FIXTURE_NAMES, loadFixture } from './helpers.js'

const all = (): LoadedConsult[] => parseConsultLines(fixtureJsonl()).consults

function wiring(second: SecondJudge | null, p = 0.95): BatchWiring {
  return {
    models: (sql) => new FakeModelClient(sql, (request) => scriptedExtractor(request)),
    judge: () => new FakeJudgePort(() => p),
    second: () => second,
  }
}
const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 's6-out-'))
const opts = { limit: 9, concurrency: 1 }

afterEach(() => vi.restoreAllMocks())

describe('dry run', () => {
  it('counts what would run and calls nothing', () => {
    const load = parseConsultLines(fixtureJsonl())
    const s = dryRunSummary(load, { limit: 9, concurrency: 1 })
    expect(s).toMatchObject({
      lines_read: 9,
      consults_valid: 9,
      would_run: 9,
      by_source: { cutter: 9 },
      by_match_confidence: { exact: 9 },
      by_window_complete: { true: 8, false: 1 },
    })
    expect(s.would_abstain_window_incomplete_no_model_call).toBe(3)
    expect(s.would_call_model).toBe(6)
    expect(s.call_caps).toEqual({ llm_calls: 18, jev_asks: 486, second_judge_asks: 486 })
    expect(JSON.stringify(s)).not.toContain('hernia')
  })

  it('the default limit is 5 and only a count of the first 5 is planned', () => {
    expect(parseArgs(['--in', 'a', '--out', 'b']).limit).toBe(5)
    expect(dryRunSummary(parseConsultLines(fixtureJsonl()), { limit: 5, concurrency: 1 }).would_run).toBe(5)
  })

  it('the CLI dry run needs no --out and writes nothing', async () => {
    const dir = tmp()
    const file = path.join(dir, 'in.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, fixtureJsonl())
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['--in', file, '--dry-run'], {})).toBe(0)
    expect(String(write.mock.calls[0]![0])).toContain('"would_run": 5')
    expect(readdirSync(dir)).toEqual(['in.jsonl'])
  })
})

describe('fake run over the 9 fixtures', () => {
  it('runs every fixture through the platform path with a second judge', async () => {
    const result = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.95)), opts)
    expect(result.entries).toHaveLength(9)
    const by = Object.fromEntries(result.entries.map((e) => [e.record.encounter_id, e.record]))
    expect(by[loadFixture('hernia-full-consent').encounter_id]).toMatchObject({ status: 'ok', error: null })
    expect(by[loadFixture('incomplete-window').encounter_id]).toMatchObject({ status: 'abstained', reason: 'window_incomplete' })
    expect(by[loadFixture('doctor-only').encounter_id]).toMatchObject({ status: 'abstained', reason: 'window_incomplete' })
    expect(by[loadFixture('no-surgery-recommended').encounter_id]).toMatchObject({ status: 'empty', reason: 'no_surgical_recommendation' })
    const hernia = result.entries.find((e) => e.record.encounter_id === loadFixture('hernia-full-consent').encounter_id)!
    expect(hernia.body!.findings.length).toBeGreaterThan(0)
    expect(hernia.record.pairs.length).toBeGreaterThan(0)
    expect(hernia.record.pairs.every((p) => p.jev_p === 0.95 && p.gemini_p === 0.95)).toBe(true)
    expect(result.entries.every((e) => e.record.error === null)).toBe(true)
    expect(result.meter.stopped).toBeNull()
    // The meter agrees with the platform's own per-run counts.
    expect(result.meter.llm).toBe(result.entries.reduce((s, e) => s + e.record.counts.llm_calls, 0))
    expect(result.meter.jev).toBeGreaterThan(0)
  })

  it('without a second judge every finding holds: no verdicts, held counted', async () => {
    const result = await runBatch(all(), wiring(null), opts)
    for (const e of result.entries) expect(e.body?.findings ?? []).toEqual([])
    const hernia = result.entries.find((e) => e.record.encounter_id === loadFixture('hernia-full-consent').encounter_id)!
    expect(hernia.record.status).toBe('unavailable')
    expect(hernia.record.held.length).toBeGreaterThan(0)
    expect(hernia.held).toHaveLength(hernia.record.held.length)
    expect(hernia.record.pairs).toEqual([])
    expect(hernia.record.abstentions.judge_unavailable).toBe(hernia.record.held.length)
    const report = buildReport(result.entries, { lines_read: 9, rejects: {}, skipped_for_cap: 0, stopped_by_cap: null, caps: result.meter.caps, metered: { llm: 0, jev: 0, second: 0 }, mode: 'fake' })
    expect(report.judge_agreement.label).toBe('n/a (no second judge)')
    expect(report.held.findings).toBeGreaterThan(0)
    expect(report.findings.kept).toBe(0)
  })

  it('concurrency 3 gives the same statuses as concurrency 1', async () => {
    const one = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.95)), opts)
    const three = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.95)), { ...opts, concurrency: 3 })
    const sig = (r: typeof one) => r.entries.map((e) => [e.record.encounter_id, e.record.status, e.record.findings_kept, e.record.held.length])
    expect(sig(three)).toEqual(sig(one))
  })

  it('--limit takes the first N', async () => {
    const result = await runBatch(all(), wiring(null), { limit: 2, concurrency: 1 })
    expect(result.entries.map((e) => e.record.n)).toEqual([1, 2])
  })

  it('writes the output set under --out with private modes, and nothing with text in runs.jsonl', async () => {
    const out = path.join(tmp(), 'out')
    prepareOutDir(out)
    const result = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.95)), opts, (e) => writeEntry(out, e))
    expect(statSync(out).mode & 0o777).toBe(0o700)
    expect(statSync(path.join(out, 'governance')).mode & 0o777).toBe(0o700)
    const files = readdirSync(path.join(out, 'governance'))
    expect(files).toContain(`${loadFixture('hernia-full-consent').encounter_id}.json`)
    for (const f of files) expect(statSync(path.join(out, 'governance', f)).mode & 0o777).toBe(0o600)
    const runs = readFileSync(path.join(out, 'runs.jsonl'), 'utf8')
    expect(runs.trim().split('\n')).toHaveLength(9)
    expect(statSync(path.join(out, 'runs.jsonl')).mode & 0o777).toBe(0o600)
    for (const name of FIXTURE_NAMES) for (const t of loadFixture(name).turns) expect(runs).not.toContain(t.text_en)
    for (const e of result.entries) for (const f of e.body?.findings ?? []) for (const ev of f.evidence) expect(runs).not.toContain(ev.quote)
    // The governance file is the platform body, quotes included (t4 only).
    const gov = JSON.parse(readFileSync(path.join(out, 'governance', `${loadFixture('hernia-full-consent').encounter_id}.json`), 'utf8')) as { findings: Array<{ evidence: Array<{ quote: string }> }>; capability: string }
    expect(gov.capability).toBe('audit.consult')
    expect(gov.findings[0]!.evidence[0]!.quote.length).toBeGreaterThan(0)
    // A second run into the same dir is refused.
    expect(() => prepareOutDir(out)).toThrow('out_path_exists')
    // The out dir rebuilds the same report.
    const rebuilt = loadEntries(out)
    expect(rebuilt.map((e) => e.record)).toEqual(result.entries.map((e) => e.record))
    expect(rebuilt.map((e) => e.body)).toEqual(result.entries.map((e) => e.body))
  })

  it('main --fake writes report.json and report.md that open with the bus-safe block', async () => {
    const dir = tmp()
    const file = path.join(dir, 'in.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, fixtureJsonl())
    const out = path.join(dir, 'out')
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['--in', file, '--out', out, '--fake', '--limit', '9', '--concurrency', '2'], {})).toBe(0)
    const printed = write.mock.calls.map((c) => String(c[0])).join('')
    expect(printed).toContain('call caps (hard stop): llm_calls=18 jev_asks=486')
    const md = readFileSync(path.join(out, 'report.md'), 'utf8')
    expect(md.startsWith('# audit.consult S6 offline report\n\n## Bus-safe summary')).toBe(true)
    expect(JSON.parse(readFileSync(path.join(out, 'report.json'), 'utf8')).consults.run).toBe(9)
  })
})

describe('F2: --out', () => {
  it('refuses any existing path, changes nothing, and creates the leaf as 0700', async () => {
    const { chmodSync, existsSync, writeFileSync } = await import('node:fs')
    const parent = tmp()
    chmodSync(parent, 0o755)
    writeFileSync(path.join(parent, 'input-128.jsonl'), 'x')
    expect(() => prepareOutDir(parent)).toThrow('out_path_exists')
    expect(statSync(parent).mode & 0o777).toBe(0o755) // not chmodded
    expect(readdirSync(parent)).toEqual(['input-128.jsonl']) // nothing written
    const file = path.join(parent, 'afile')
    writeFileSync(file, 'x')
    expect(() => prepareOutDir(file)).toThrow('out_path_exists')
    // an existing empty dir is refused too
    const empty = tmp()
    expect(() => prepareOutDir(empty)).toThrow('out_path_exists')
    const leaf = path.join(parent, 'fresh')
    prepareOutDir(leaf)
    expect(existsSync(path.join(leaf, 'governance'))).toBe(true)
    expect(statSync(leaf).mode & 0o777).toBe(0o700)
  })

  it('main refuses an existing --out before running anything', async () => {
    const dir = tmp()
    const file = path.join(dir, 'in.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, fixtureJsonl())
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await expect(main(['--in', file, '--out', dir, '--fake'], {})).rejects.toThrow('out_path_exists')
    expect(readdirSync(dir)).toEqual(['in.jsonl'])
  })
})

describe('cost guard', () => {
  it('F3: the second-judge guard stops on its own count', async () => {
    const meter: Meter = { caps: { llm: 9, jev: 2 }, llm: 0, jev: 0, second: 0, stopped: null }
    let inner = 0
    const counting: SecondJudge = {
      id: 'counting',
      askValidity: async () => {
        inner += 1
        return { p_yes: 0.9, servedModelIds: ['m'] }
      },
    }
    const second = new MeteredJudge(new FakeJudgePort(() => 0.9), counting, meter).secondPort()!
    const set = { id: 's', sha: 'x', question: 'q' }
    await second.askValidity({ n: 1 }, 'q', set)
    await second.askValidity({ n: 2 }, 'q', set)
    expect(meter.stopped).toBeNull()
    await expect(second.askValidity({ n: 3 }, 'q', set)).rejects.toThrow('The judge did not answer.')
    expect(inner).toBe(2)
    expect(meter.second).toBe(2)
    expect(meter.jev).toBe(0) // only the second passed the cap
    expect(meter.stopped).toBe('jev')
  })

  it('computes the cap from the per-run budget and the consults to run', () => {
    expect(computeCaps(5)).toEqual({ llm: 10, jev: 270 })
    expect(computeCaps(5, { maxLlmCalls: 3, maxJevCalls: 7 })).toEqual({ llm: 3, jev: 7 })
  })

  it('stops at the extraction cap: no more model calls, later consults are not started', async () => {
    let sent = 0
    const base = wiring(new FakeSecondJudge(() => 0.95))
    const counted: BatchWiring = { ...base, models: (sql) => new FakeModelClient(sql, (request) => (sent++, scriptedExtractor(request))) }
    const result = await runBatch(all(), counted, { ...opts, maxLlmCalls: 2 })
    expect(result.meter.stopped).toBe('llm')
    expect(result.meter.llm).toBe(2)
    expect(sent).toBe(2)
    expect(result.skipped_for_cap).toBeGreaterThan(0)
    expect(result.entries.length + result.skipped_for_cap).toBe(9)
  })

  it('stops at the judge cap: no asks past the cap, held instead', async () => {
    const second = new FakeSecondJudge(() => 0.95)
    const judge = new FakeJudgePort(() => 0.95)
    const result = await runBatch(all(), { ...wiring(second), judge: () => judge }, { ...opts, maxJevCalls: 3 })
    expect(result.meter.stopped).toBe('jev')
    expect(result.meter.jev).toBe(3)
    expect(judge.calls).toHaveLength(3)
    expect(second.calls.length).toBeLessThanOrEqual(3)
    expect(result.skipped_for_cap).toBeGreaterThan(0)
  })

  it('a cap of the exact worst case does not stop a normal batch', async () => {
    const result = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.95)), opts)
    expect(result.meter.stopped).toBeNull()
    expect(result.meter.llm).toBeLessThanOrEqual(result.meter.caps.llm)
  })
})

describe('the database', () => {
  it('never reads a DB URL from the env: an unreachable DATABASE_URL does not matter, and the env copy has none', async () => {
    const env = { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none', CDMSS_DATABASE_URL_RO: 'postgres://u:p@127.0.0.1:1/cdmss', BEDROCK_REGION: 'ap-south-1' }
    const clean = scrubbedEnv(env)
    expect(clean.DATABASE_URL).toBeUndefined()
    expect(clean.CDMSS_DATABASE_URL_RO).toBeUndefined()
    expect(loadEnv(clean).DATABASE_URL).toBeUndefined()
    const saved = { d: process.env.DATABASE_URL, c: process.env.CDMSS_DATABASE_URL_RO }
    process.env.DATABASE_URL = env.DATABASE_URL
    process.env.CDMSS_DATABASE_URL_RO = env.CDMSS_DATABASE_URL_RO
    try {
      const dir = tmp()
      const file = path.join(dir, 'in.jsonl')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(file, fixtureJsonl())
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
      expect(await main(['--in', file, '--out', path.join(dir, 'o'), '--fake', '--limit', '2'])).toBe(0)
    } finally {
      if (saved.d === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = saved.d
      if (saved.c === undefined) delete process.env.CDMSS_DATABASE_URL_RO
      else process.env.CDMSS_DATABASE_URL_RO = saved.c
    }
  })

  it('opens the in-process database with no URL and applies every migration, 0005 included', async () => {
    const seen: string[] = []
    await runBatch(all(), wiring(null), { limit: 1, concurrency: 1 }, undefined, async () => {
      const { openDatabase } = await import('../../../../src/db/open.js')
      const { appliedMigrations } = await import('../../../../src/db/migrate.js')
      const sql = await openDatabase(undefined)
      const close = sql.close.bind(sql)
      sql.close = async () => {
        seen.push(...(await appliedMigrations(sql)))
        await close()
      }
      return sql
    })
    expect(seen.some((m) => m.startsWith('0005_consult'))).toBe(true)
  })

  it('the offline sources never name a database URL variable except to delete it', () => {
    for (const f of readdirSync('src/agents/surgical-consult/offline')) {
      const text = readFileSync(path.join('src/agents/surgical-consult/offline', f), 'utf8')
      const uses = text.split('\n').filter((l) => /DATABASE_URL/.test(l) && !/^\s*delete copy\./.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l))
      expect(uses, f).toEqual([])
      expect(text).not.toMatch(/openDatabase\((?!undefined)[^)]/)
    }
  })
})

describe('live env', () => {
  it('names the missing env, never a value', () => {
    const missing = missingLiveEnv(loadEnv({ NEWCAT_LLM: 'fake' } as never), {})
    expect(missing).toEqual(expect.arrayContaining(['NEWCAT_LLM=bedrock', 'BEDROCK_REGION', 'BEDROCK_MODEL_SONNET', 'JEV_BASE_URL', 'JEV_API_KEY']))
    const base = { BEDROCK_REGION: 'r', BEDROCK_MODEL_SONNET: 'm', JEV_BASE_URL: 'https://x', JEV_API_KEY: 'secretvalue' }
    // default-chain (the dev default): exit 2 unless AWS credential names or a profile name are set
    const chain = loadEnv(base as never)
    expect(missingLiveEnv(chain, {})).toEqual(['AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_PROFILE (BEDROCK_AUTH=default-chain)'])
    expect(missingLiveEnv(chain, { AWS_PROFILE: 'p' })).toEqual([])
    expect(missingLiveEnv(chain, { AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' })).toEqual([])
    expect(missingLiveEnv(chain, { AWS_ACCESS_KEY_ID: 'a' })).toHaveLength(1)
    // gcp-federation (GCP_SA_KEY_JSON present, or BEDROCK_AUTH set): both names
    const gcp = loadEnv({ ...base, BEDROCK_AUTH: 'gcp-federation' } as never)
    expect(missingLiveEnv(gcp, { AWS_PROFILE: 'p' })).toEqual(['GCP_SA_KEY_JSON', 'AWS_ROLE_ARN'])
    expect(missingLiveEnv(loadEnv({ ...base, BEDROCK_AUTH: 'gcp-federation', GCP_SA_KEY_JSON: '{}', AWS_ROLE_ARN: 'arn' } as never), {})).toEqual([])
    const implied = loadEnv({ ...base, GCP_SA_KEY_JSON: '{"x":1}' } as never)
    expect(missingLiveEnv(implied, {})).toEqual(['AWS_ROLE_ARN'])
    expect(JSON.stringify(missingLiveEnv(implied, {}))).not.toContain('secretvalue')
  })

  it('a live run with missing env stops before any output', async () => {
    const dir = tmp()
    const file = path.join(dir, 'in.jsonl')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, fixtureJsonl())
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    expect(await main(['--in', file, '--out', path.join(dir, 'o')], {})).toBe(2)
    expect(String(write.mock.calls[0]![0])).toContain('BEDROCK_REGION')
    expect(readdirSync(dir)).toEqual(['in.jsonl'])
  })
})

describe('S6-Rd: judge_pairs in runs.jsonl', () => {
  it('records both judges per candidate with numbers, booleans and ids only', async () => {
    // Jev says yes (0.95), the second judge no (0.1): every judged candidate is a disagree.
    const result = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.1)), opts)
    const pairs = result.entries.flatMap((e) => e.record.judge_pairs ?? [])
    expect(pairs.length).toBeGreaterThan(0)
    expect(pairs.every((p) => p.primary_p === 0.95 && p.second_p === 0.1 && p.primary_yes === true && p.second_yes === false && p.outcome === 'disagree')).toBe(true)
    expect(new Set(pairs.map((p) => p.polarity))).toEqual(new Set(['presence', 'absence']))
    for (const p of pairs) {
      expect(p.polarity === 'absence').toBe(p.question_set === 'consult-absence-claim')
      expect(Object.keys(p).sort()).toEqual(['outcome', 'polarity', 'primary_p', 'primary_yes', 'question_set', 'rule_id', 'second_p', 'second_yes'])
      expect(p.rule_id).toMatch(/^[a-z][a-z0-9_.]*$/)
    }
    // No text anywhere: the serialized pairs hold none of the fixtures' words.
    const text = JSON.stringify(pairs)
    expect(text).not.toMatch(/recommend|hernia|knee|risk[s]? are|enc-|doc-/i)
    // Cross-check against the platform's own counts: one judge_disagree per judged candidate.
    expect(pairs.length).toBe(result.entries.reduce((s, e) => s + e.record.counts.judge_disagree, 0))
  })

  it('both yes is agree, both no is dropped, no second judge is unavailable (primary kept)', async () => {
    const yes = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.95)), opts)
    expect(new Set(yes.entries.flatMap((e) => e.record.judge_pairs ?? []).map((p) => p.outcome))).toEqual(new Set(['agree']))
    const no = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.1), 0.1), opts)
    expect(new Set(no.entries.flatMap((e) => e.record.judge_pairs ?? []).map((p) => p.outcome))).toEqual(new Set(['dropped']))
    const none = await runBatch(all(), wiring(null), opts)
    const held = none.entries.flatMap((e) => e.record.judge_pairs ?? [])
    expect(held.length).toBeGreaterThan(0)
    expect(held.every((p) => p.outcome === 'unavailable' && p.second_p === null && p.primary_p === 0.95)).toBe(true)
  })

  it('a rule on the safety bar uses 0.9, others 0.75', async () => {
    const mid = await runBatch(all(), wiring(new FakeSecondJudge(() => 0.8), 0.8), opts)
    const pairs = mid.entries.flatMap((e) => e.record.judge_pairs ?? [])
    const safety = new Set(RULE_SPECS.filter((s) => s.safety_class === true).map((s) => s.id))
    for (const p of pairs) expect(p.primary_yes, p.rule_id).toBe(!safety.has(p.rule_id))
  })
})

describe('S6-Rc: the extraction ledger rows reach runs.jsonl and the report', () => {
  it('extractionFor: a served row and a null row on the same trace give served_verified=false and served=null', async () => {
    const sql = await testDb()
    const row = (served: string | null, purpose: string, extra: Record<string, string | null> = {}) =>
      recordModelCall(sql, { traceId: 's6-0001', provider: 'bedrock', tier: 'sonnet', intendedModelId: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', servedModelId: served, inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, status: 'ok', stopReason: null, errorType: null, purpose, ...extra })
    await row('claude-sonnet-4-5-served', 'audit.consult:extract')
    await row(null, 'audit.consult:extract_escalation')
    // Rows that must not count: another trace, and a Gemini row on the same trace.
    await recordModelCall(sql, { traceId: 's6-0002', provider: 'bedrock', tier: 'sonnet', intendedModelId: 'x', servedModelId: null, inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, status: 'ok', stopReason: null, errorType: null, purpose: 'audit.consult:extract' })
    await recordModelCall(sql, { traceId: 's6-0001', provider: 'vertex', tier: 'second_judge', intendedModelId: 'gemini-2.5-pro', servedModelId: null, inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0, status: 'ok', stopReason: null, errorType: null, purpose: 'second_judge' })
    expect(await extractionFor(sql, 's6-0001')).toEqual({ intended: 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0', served: null, served_verified: false, calls: 2, errors_by_type: {} })
    // All served: verified, served ids listed.
    await sql.query(`update model_calls set served_model_id = 'claude-sonnet-4-5-served' where trace_id = 's6-0001' and provider = 'bedrock'`)
    expect(await extractionFor(sql, 's6-0001')).toMatchObject({ served: 'claude-sonnet-4-5-served', served_verified: true, calls: 2 })
  })

  const DATED = 'eu.anthropic.claude-sonnet-4-5-20250929-v1:0'
  // A fake client whose ledger rows carry a dated intended id and no served id, like the global profile on Bedrock.
  const nullServed = (sql: Parameters<BatchWiring['models']>[0]): FakeModelClient => {
    const inner = new FakeModelClient(sql, (request) => scriptedExtractor(request))
    const complete = inner.complete.bind(inner)
    inner.complete = async (request) => {
      const out = await complete(request)
      await sql.query(`update model_calls set intended_model_id = $2, served_model_id = null where trace_id = $1`, [request.traceId, DATED])
      return out
    }
    return inner
  }

  it('records intended, served_verified=false, calls and errors per consult; the report and the bus block say so', async () => {
    const w: BatchWiring = { ...wiring(new FakeSecondJudge(() => 0.95)), models: nullServed }
    const result = await runBatch(all(), w, opts)
    const ran = result.entries.filter((e) => e.record.counts.llm_calls > 0)
    expect(ran.length).toBeGreaterThan(0)
    for (const e of ran) {
      expect(e.record.extraction).toEqual({ intended: DATED, served: null, served_verified: false, calls: e.record.counts.llm_calls, errors_by_type: {} })
    }
    for (const e of result.entries.filter((x) => x.record.counts.llm_calls === 0)) expect(e.record.extraction).toMatchObject({ calls: 0, intended: null, served_verified: false })
    const report = buildReport(result.entries, { lines_read: 9, rejects: {}, skipped_for_cap: 0, stopped_by_cap: null, caps: result.meter.caps, metered: { llm: result.meter.llm, jev: 0, second: 0 }, mode: 'fake' })
    expect(report.models.extraction).toEqual([{ intended: DATED, served: null, served_verified: false, consults: ran.length, calls: result.meter.llm, errors_by_type: {} }])
    const block = busSafeSummary(report, result.entries)
    expect(block).toContain('extraction_model=claude-sonnet-4-5 served_verified=no')
    expect(/\d{8,}/.test(block)).toBe(false)
    expect(renderMarkdown(report, result.entries)).toContain('unverified: profile not resolved')
  })

  it('writes the extraction object (ids and codes only) into runs.jsonl', async () => {
    const dir = tmp()
    const file = path.join(dir, 'in.jsonl')
    writeFileSync(file, fixtureJsonl())
    const w: BatchWiring = { ...wiring(null), models: nullServed }
    const out = path.join(dir, 'o')
    prepareOutDir(out)
    await runBatch(all(), w, { ...opts, limit: 3 }, (entry) => writeEntry(out, entry))
    const rows = readFileSync(path.join(out, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { extraction: Record<string, unknown> })
    expect(rows.length).toBe(3)
    for (const row of rows) expect(Object.keys(row.extraction).sort()).toEqual(['calls', 'errors_by_type', 'intended', 'served', 'served_verified'])
  })

  it('a refused or failed call is counted by error type', async () => {
    const w: BatchWiring = { ...wiring(null), models: (sql) => new FakeModelClient(sql, () => ({ kind: 'truncated', text: 'x' })) }
    const result = await runBatch(all(), w, { ...opts, limit: 1 })
    const x = result.entries[0]!.record.extraction!
    expect(x.calls).toBeGreaterThan(0)
    expect(x.errors_by_type).toEqual({ truncated: x.calls })
  })
})

describe('S1PA-C3: the Gemini second judge in the offline runner', () => {
  const KEY = '{"private_key":"KEYMATERIAL-NEVER-PRINTED"}'
  const live = (over: Record<string, string | undefined> = {}) =>
    testEnv({ NEWCAT_GEMINI: 'live', GEMINI_MODEL: GEMINI_PINNED[0]!, VERTEX_PROJECT: 'proj-1', VERTEX_LOCATION: 'asia-northeast1', VERTEX_SA_KEY_JSON: KEY, ...over })
  const answer = (p: number) => ({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({ p_yes: p }) }] } }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1 },
    modelVersion: 'gemini-2.5-pro-test',
  })
  const never: GeminiSender = async () => {
    throw new Error('no network in tests')
  }

  it('is null unless NEWCAT_GEMINI=live and the config is complete: findings hold, never a substitute', async () => {
    const sql = await testDb()
    for (const env of [testEnv(), testEnv({ NEWCAT_GEMINI: 'off' }), live({ NEWCAT_GEMINI: 'off' }), live({ NEWCAT_GEMINI: undefined }), live({ VERTEX_SA_KEY_JSON: undefined }), live({ VERTEX_PROJECT: undefined }), live({ GEMINI_MODEL: 'not-on-the-allowlist' }), live({ VERTEX_LOCATION: 'global' })]) {
      expect(makeSecondJudge(env, sql, 't1', never)).toBeNull()
      expect(secondFactory(env, never)('t1', sql)).toBeNull()
    }
  })

  it('is the platform GeminiSecondJudge when live and complete (no network at construction)', async () => {
    const sql = await testDb()
    const second = makeSecondJudge(live(), sql, 't1', never)
    expect(second).toBeInstanceOf(GeminiSecondJudge)
    expect(second!.id).toBe('gemini')
    // No sender given: the real vertexSender is built lazily, so construction touches no network and no key.
    expect(makeSecondJudge(live(), sql, 't1')?.id).toBe('gemini')
  })

  it('missingGeminiEnv names variables only, never values', () => {
    expect(missingGeminiEnv(testEnv())).toEqual([])
    const names = missingGeminiEnv(live({ VERTEX_SA_KEY_JSON: undefined, VERTEX_PROJECT: undefined }))
    expect(names).toEqual(['VERTEX_PROJECT', 'VERTEX_SA_KEY_JSON'])
    expect(JSON.stringify(missingGeminiEnv(live({ GEMINI_MODEL: 'bad-model' })))).not.toContain('bad-model')
    expect(missingGeminiEnv(live())).toEqual([])
  })

  it('a batch with the Gemini judge (fake sender) gets verdicts, pairs, kappa inputs and the served model id', async () => {
    let calls = 0
    const sender: GeminiSender = async () => (calls++, answer(0.9))
    const w: BatchWiring = { ...wiring(null), second: secondFactory(live(), sender) }
    const result = await runBatch(all(), w, opts)
    expect(calls).toBeGreaterThan(0)
    expect(result.meter.second).toBe(calls)
    const hernia = result.entries.find((e) => e.record.encounter_id === loadFixture('hernia-full-consent').encounter_id)!
    expect(hernia.record.status).toBe('ok')
    expect(hernia.record.held).toEqual([])
    expect(hernia.record.pairs.length).toBeGreaterThan(0)
    expect(hernia.record.pairs.every((p) => p.jev_p === 0.95 && p.gemini_p === 0.9)).toBe(true)
    const report = buildReport(result.entries, { lines_read: 9, rejects: {}, skipped_for_cap: 0, stopped_by_cap: null, caps: result.meter.caps, metered: { llm: result.meter.llm, jev: result.meter.jev, second: result.meter.second }, mode: 'fake' })
    expect(report.judge_agreement.label).not.toBe('n/a (no second judge)')
    expect(report.judge_agreement.n_both).toBeGreaterThan(0)
    expect(report.judge_agreement.agreement).toBe(1)
    expect(Object.keys(report.models.served_by_consults)).toContain('gemini-2.5-pro-test')
    expect(report.held.findings).toBe(0)
    expect(report.findings.kept).toBeGreaterThan(0)
  })

  it('--fake under a complete live Vertex env never builds Gemini and never calls a sender', async () => {
    const file = path.join(tmp(), 'in.jsonl')
    writeFileSync(file, fixtureJsonl())
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (lines.push(String(chunk)), true))
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const source = { NEWCAT_GEMINI: 'live', GEMINI_MODEL: GEMINI_PINNED[0]!, VERTEX_PROJECT: 'proj-1', VERTEX_LOCATION: 'asia-northeast1', VERTEX_SA_KEY_JSON: KEY }
    const code = await main(['--in', file, '--out', path.join(path.dirname(file), 'o'), '--fake', '--limit', '2'], source)
    spy.mockRestore()
    expect(code).toBe(0)
    const text = lines.join('')
    expect(text).toContain('second_judge=none')
    expect(text).not.toContain('second_judge=gemini')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(text).not.toContain('KEYMATERIAL')
  })

  it('the second-judge cap still applies to the real judge class', async () => {
    const sender: GeminiSender = async () => answer(0.9)
    const w: BatchWiring = { ...wiring(null), second: secondFactory(live(), sender) }
    const result = await runBatch(all(), w, { ...opts, maxJevCalls: 3 })
    expect(result.meter.second).toBeLessThanOrEqual(3)
    expect(result.meter.stopped).toBe('jev')
  })
})
