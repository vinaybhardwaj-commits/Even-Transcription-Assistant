import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EmitRefusal, serialize } from '../../../audience/serialize.js'
import { jevConfig, jevReadiness, loadEnv, resolveBedrockAuth, type Env } from '../../../config.js'
import { migrate } from '../../../db/migrate.js'
import { openDatabase } from '../../../db/open.js'
import { asJson, type Sql } from '../../../db/sql.js'
import { FakeJevTransport } from '../../../decide/transport.js'
import { FakeModelClient } from '../../../llm/fake.js'
import type { ModelClient, ModelCompletion, ModelRequest } from '../../../llm/types.js'
import type { StageOutcome } from '../../../outcome.js'
import { JudgeUnavailable, type JudgeAnswer, type JudgePort, type JudgeQuestionSet } from '../../../platform/agent/judge-port.js'
import { runAgent } from '../../../platform/agent/run.js'
import { jevJudge } from '../../../platform/jev/judge.js'
import type { SecondJudge } from '../../../platform/judge/second.js'
import { buildJev, buildModelClient } from '../../../runtime.js'
import { ABSENCE_QUESTION_SET, CONSULT_AGENT_ID, surgicalConsult } from '../definition.js'
import { findingTypeOf } from '../governance/f7.js'
import { prepass } from '../prepass.js'
import { MAX_CANDIDATES, RULE_SPECS } from '../rules/index.js'
import { loadConsults, type LoadedConsult, type LoadResult } from './input.js'
import { geminiConfigOf, missingGeminiEnv, secondFactory, type SecondFactory } from './second.js'
import { appendBench, BenchRecorder, prepareBenchFile } from './bench.js'
import { buildReport, busSafeSummary, emptyExtraction, renderMarkdown, type Entry, type ExtractionRecord, type HeldDetail, type JudgePairRecord, type RunRecord } from './report.js'

/**
 * S6 offline runner: the platform's agent run path over a JSONL of consults, on an in-process pglite (never a DB URL),
 * with injected model, judge and second-judge wiring. Output stays under --out (quotes are allowed there, never on the bus).
 */

export const DEFAULT_LIMIT = 5
export const OUT_DIR_MODE = 0o700
export const OUT_FILE_MODE = 0o600

export interface BatchOptions {
  limit: number
  concurrency: number
  maxLlmCalls?: number | undefined
  maxJevCalls?: number | undefined
  /** Record each judged candidate's claim and window for the bench export (Entry.bench). Off by default. */
  bench?: boolean | undefined
}

export interface BatchWiring {
  models(sql: Sql): ModelClient
  judge(traceId: string, sql: Sql): JudgePort
  /** Per consult: the Gemini second judge bound to the run's db and trace, or null (findings hold). */
  second: SecondFactory
}

export interface CallCaps {
  /** Extraction (Bedrock) calls. */
  llm: number
  /** Primary-judge (Jev) asks. The second judge, when present, is held to the same number. */
  jev: number
}

/** The cap is the per-run budget times the consults to run (worst case), unless the caller lowers it. */
export function computeCaps(consultsToRun: number, options: Pick<BatchOptions, 'maxLlmCalls' | 'maxJevCalls'> = {}): CallCaps {
  return {
    llm: options.maxLlmCalls ?? consultsToRun * surgicalConsult.budget.llmCalls,
    jev: options.maxJevCalls ?? consultsToRun * MAX_CANDIDATES,
  }
}

// ---- metering ---------------------------------------------------------------------------------------------------------

export interface Meter {
  caps: CallCaps
  llm: number
  jev: number
  second: number
  /** Which cap stopped the batch, if any. */
  stopped: 'llm' | 'jev' | null
}

class MeteredModels implements ModelClient {
  constructor(private readonly inner: ModelClient, private readonly meter: Meter) {}
  async complete(request: ModelRequest): Promise<StageOutcome<ModelCompletion>> {
    if (this.meter.llm >= this.meter.caps.llm) {
      this.meter.stopped ??= 'llm'
      return { status: 'refused', error: { type: 'budget_exhausted', message: 'The offline call cap is reached.' } }
    }
    this.meter.llm += 1
    return this.inner.complete(request)
  }
}

/** The platform's cut for a rule: safety rules use the safety bar (run.ts: def.judge.thresholds). */
function thresholdFor(ruleId: string): number {
  const safety = RULE_SPECS.find((spec) => spec.id === ruleId)?.safety_class === true
  return safety ? surgicalConsult.judge.thresholds.safety : surgicalConsult.judge.thresholds.nonSafety
}

/** Counts the primary judge's asks, enforces the cap and records p per (state) for the Jev-Gemini pairs. */
export class MeteredJudge {
  readonly primary = new Map<string, number>()
  readonly secondary = new Map<string, number>()
  readonly rules = new Map<string, string>()
  /** One entry per judged candidate, in ask order (a consult's judge asks run one after another). */
  readonly judged: JudgePairRecord[] = []
  constructor(private readonly inner: JudgePort, private readonly second: SecondJudge | null, private readonly meter: Meter, private readonly bench: BenchRecorder | null = null) {}

  port(): JudgePort {
    return {
      askValidity: async (state, question, set) => {
        if (this.meter.jev >= this.meter.caps.jev) {
          this.meter.stopped ??= 'jev'
          throw new JudgeUnavailable('budget_exhausted')
        }
        this.meter.jev += 1
        const rule = String((state as { rule?: unknown }).rule ?? '')
        const entry: JudgePairRecord = { rule_id: rule, question_set: set.id, polarity: set.id === ABSENCE_QUESTION_SET.id ? 'absence' : 'presence', primary_p: null, second_p: null, primary_yes: null, second_yes: null, outcome: 'unavailable' }
        this.judged.push(entry)
        this.bench?.begin(state, set, entry.polarity, entry)
        const answer = await this.inner.askValidity(state, question, set)
        const key = JSON.stringify(state)
        this.primary.set(key, answer.p_yes)
        this.rules.set(key, rule)
        entry.primary_p = answer.p_yes
        entry.primary_yes = answer.p_yes >= thresholdFor(rule)
        return answer
      },
    }
  }

  secondPort(): SecondJudge | null {
    const second = this.second
    if (second === null) return null
    return {
      id: second.id,
      askValidity: async (state: unknown, question: string, set: JudgeQuestionSet): Promise<JudgeAnswer> => {
        if (this.meter.second >= this.meter.caps.jev) {
          this.meter.stopped ??= 'jev'
          throw new JudgeUnavailable('budget_exhausted')
        }
        this.meter.second += 1
        const answer = await second.askValidity(state, question, set)
        this.secondary.set(JSON.stringify(state), answer.p_yes)
        const entry = this.judged[this.judged.length - 1]
        if (entry && entry.primary_p !== null && entry.second_p === null) {
          entry.second_p = answer.p_yes
          entry.second_yes = answer.p_yes >= thresholdFor(entry.rule_id)
          entry.outcome = entry.primary_yes && entry.second_yes ? 'agree' : !entry.primary_yes && !entry.second_yes ? 'dropped' : 'disagree'
        }
        return answer
      },
    }
  }

  pairs(): RunRecord['pairs'] {
    const out: RunRecord['pairs'] = []
    for (const [key, jev_p] of this.primary) {
      const gemini_p = this.secondary.get(key)
      if (gemini_p !== undefined) out.push({ rule_id: this.rules.get(key) ?? '', jev_p, gemini_p })
    }
    return out
  }
}

// ---- one consult ------------------------------------------------------------------------------------------------------

const traceIdFor = (n: number): string => `s6-${String(n).padStart(4, '0')}`
const monthOf = (iso: string): string => iso.slice(0, 7)

interface Done {
  entry: Entry
}

async function runOne(sql: Sql, wiring: BatchWiring, models: ModelClient, meter: Meter, consult: LoadedConsult, n: number, benchOn: boolean): Promise<Done> {
  const traceId = traceIdFor(n)
  const input = consult.input
  const recorder = benchOn ? new BenchRecorder(input) : null
  const metered = new MeteredJudge(wiring.judge(traceId, sql), wiring.second(traceId, sql), meter, recorder)
  const base: Omit<RunRecord, 'status' | 'reason' | 'findings_kept' | 'held' | 'abstentions' | 'counts' | 'versions' | 'extraction' | 'judge_pairs' | 'pairs' | 'error'> = {
    n,
    encounter_id: input.encounter_id,
    doctor_uid: input.doctor_uid,
    month: monthOf(input.window.start),
    source: consult.source,
    match_confidence: consult.match_confidence,
    window_complete: consult.window_complete,
  }
  const failed = (error: RunRecord['error']): Done => ({
    entry: {
      record: { ...base, status: 'failed', reason: error, findings_kept: 0, held: [], abstentions: {}, counts: emptyCounts(), versions: {}, extraction: emptyExtraction(), judge_pairs: [], pairs: [], error },
      body: null,
      held: [],
    },
  })
  let audit
  try {
    audit = await runAgent(
      recorder ? recorder.wrap(surgicalConsult) : surgicalConsult,
      {
        sql,
        models,
        traceId,
        purpose: 's6-offline',
        audience: 'governance',
        judge: metered.port(),
        second: metered.secondPort(),
        idempotencyKey: traceId,
      },
      input,
    )
  } catch {
    return failed('run_threw')
  }
  let body: Record<string, unknown>
  try {
    body = serialize(audit, 'governance', { governance: surgicalConsult.serializers?.governance }) as Record<string, unknown>
  } catch (error) {
    return failed(error instanceof EmitRefusal ? 'governance_refused' : 'serialize_threw')
  }
  const held: HeldDetail[] = audit.findings
    .filter((f) => f.action === 'hold')
    .map((f) => ({
      finding_type: findingTypeOf(f.rule_id),
      procedure_group: String(f.meta?.procedure_group ?? 'other'),
      rule_id: f.rule_id,
      primary_p: f.judge?.primary_p ?? null,
      evidence: f.evidence.map((e) => ({ segment_id: e.segment_id ?? '', role: String(e.role ?? ''), t0: e.t0 ?? 0, t1: e.t1 ?? 0, quote: e.quote })),
    }))
  const counts = await countsFor(sql, traceId)
  const findings = Array.isArray(body.findings) ? body.findings : []
  const record: RunRecord = {
    ...base,
    status: audit.status,
    reason: typeof body.reason === 'string' ? body.reason : null,
    findings_kept: findings.length,
    held: held.map((h) => ({ finding_type: h.finding_type, procedure_group: h.procedure_group, rule_id: h.rule_id, primary_p: h.primary_p })),
    abstentions: (body.abstentions ?? {}) as Record<string, number>,
    counts,
    versions: stringVersions(body.versions),
    extraction: await extractionFor(sql, traceId),
    judge_pairs: metered.judged.map((p) => ({ ...p })),
    pairs: metered.pairs(),
    error: null,
  }
  return { entry: { record, body: body as unknown as Entry['body'], held, ...(recorder ? { bench: recorder.lines() } : {}) } }
}

/**
 * The run's extraction calls from the model_calls ledger (by trace id and the agent's extract purposes, so Gemini rows are out):
 * ids and codes only. served_verified is false when any call has no served id (the global inference profile does not resolve one).
 */
export async function extractionFor(sql: Sql, traceId: string): Promise<ExtractionRecord> {
  const rows = await sql.query<{ intended_model_id: string; served_model_id: string | null; status: string; error_type: string | null }>(
    `select intended_model_id, served_model_id, status, error_type from model_calls
     where trace_id = $1 and purpose like $2 and provider <> 'vertex' order by created_at, id`,
    [traceId, `${CONSULT_AGENT_ID}:extract%`],
  )
  if (rows.rows.length === 0) return emptyExtraction()
  const intended = [...new Set(rows.rows.map((r) => r.intended_model_id))]
  const served = [...new Set(rows.rows.flatMap((r) => (r.served_model_id === null ? [] : [r.served_model_id])))]
  const errors: Record<string, number> = {}
  for (const r of rows.rows) if (r.status !== 'ok') errors[r.error_type ?? r.status] = (errors[r.error_type ?? r.status] ?? 0) + 1
  const verified = rows.rows.every((r) => r.served_model_id !== null)
  return { intended: intended.join(','), served: verified ? served.join(',') : null, served_verified: verified, calls: rows.rows.length, errors_by_type: errors }
}

function emptyCounts(): RunRecord['counts'] {
  return { facts_total: 0, facts_kept: 0, facts_dropped: 0, drops: {}, llm_calls: 0, jev_calls: 0, candidates: 0, judge_agree: 0, judge_disagree: 0, judge_dropped: 0, judge_unavailable: 0 }
}

async function countsFor(sql: Sql, traceId: string): Promise<RunRecord['counts']> {
  const rows = await sql.query<{ counts: unknown }>('select counts from agent_runs where trace_id = $1', [traceId])
  const raw = rows.rows[0] ? asJson<Record<string, unknown>>(rows.rows[0].counts) : {}
  const num = (k: string): number => (typeof raw[k] === 'number' ? (raw[k] as number) : 0)
  const out = emptyCounts()
  for (const k of ['facts_total', 'facts_kept', 'facts_dropped', 'llm_calls', 'jev_calls', 'candidates', 'judge_agree', 'judge_disagree', 'judge_dropped', 'judge_unavailable'] as const) out[k] = num(k)
  const drops = raw.drops
  if (drops && typeof drops === 'object') {
    for (const [k, v] of Object.entries(drops)) if (typeof v === 'number') out.drops[k] = v
  }
  if (num('persist_failed') > 0) out.persist_failed = num('persist_failed')
  return out
}

function stringVersions(v: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) out[k] = typeof x === 'string' ? x : JSON.stringify(x)
  }
  return out
}

// ---- the batch --------------------------------------------------------------------------------------------------------

export interface BatchResult {
  entries: Entry[]
  meter: Meter
  /** Consults selected but not started because a cap was hit. */
  skipped_for_cap: number
}

export async function runBatch(consults: LoadedConsult[], wiring: BatchWiring, options: BatchOptions, sink?: (entry: Entry) => void, openSql?: () => Promise<Sql>): Promise<BatchResult> {
  const selected = consults.slice(0, options.limit)
  const meter: Meter = { caps: computeCaps(selected.length, options), llm: 0, jev: 0, second: 0, stopped: null }
  // Always the in-process pglite: openDatabase(undefined) never reads a URL. All migrations apply (0005 included).
  const sql = await (openSql ?? (() => openDatabase(undefined)))()
  try {
    await migrate(sql)
    const models = new MeteredModels(wiring.models(sql), meter)
    const entries: Entry[] = []
    let next = 0
    let skipped = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++
        if (i >= selected.length) return
        if (meter.stopped !== null) {
          skipped += 1
          continue
        }
        const { entry } = await runOne(sql, wiring, models, meter, selected[i]!, i + 1, options.bench === true)
        entries.push(entry)
        sink?.(entry)
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker))
    entries.sort((a, b) => a.record.n - b.record.n)
    return { entries, meter, skipped_for_cap: skipped }
  } finally {
    await sql.close()
  }
}

// ---- output -----------------------------------------------------------------------------------------------------------

export function prepareOutDir(out: string): void {
  // Any existing path is refused: a reused dir could hold stale files, and chmod would change a dir that is not ours.
  if (existsSync(out)) throw new Error('out_path_exists')
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  mkdirSync(out, { mode: OUT_DIR_MODE }) // the leaf, not recursive
  chmodSync(out, OUT_DIR_MODE) // the umask can only narrow the mode, never widen it; this pins it
  for (const dir of [path.join(out, 'governance'), path.join(out, 'held')]) mkdirSync(dir, { mode: OUT_DIR_MODE })
}

const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: OUT_FILE_MODE })

export function writeEntry(out: string, entry: Entry): void {
  const id = entry.record.encounter_id // opaque by the input check
  if (entry.body !== null) writeJson(path.join(out, 'governance', `${id}.json`), entry.body)
  if (entry.held.length > 0) writeJson(path.join(out, 'held', `${id}.json`), entry.held)
  appendFileSync(path.join(out, 'runs.jsonl'), `${JSON.stringify(entry.record)}\n`, { mode: OUT_FILE_MODE })
}

// ---- CLI --------------------------------------------------------------------------------------------------------------

export interface CliArgs {
  in: string
  out: string
  limit: number
  concurrency: number
  dryRun: boolean
  fake: boolean
  maxLlmCalls?: number
  maxJevCalls?: number
  benchOut?: string
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { in: '', out: '', limit: DEFAULT_LIMIT, concurrency: 1, dryRun: false, fake: false }
  const int = (name: string, v: string | undefined): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name} needs a positive integer`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = argv[i + 1]
    switch (a) {
      case '--in': args.in = value ?? ''; i++; break
      case '--out': args.out = value ?? ''; i++; break
      case '--limit': args.limit = int(a, value); i++; break
      case '--concurrency': args.concurrency = int(a, value); i++; break
      case '--max-llm-calls': args.maxLlmCalls = int(a, value); i++; break
      case '--max-jev-calls': args.maxJevCalls = int(a, value); i++; break
      case '--bench-out': args.benchOut = value ?? ''; i++; break
      case '--dry-run': args.dryRun = true; break
      case '--fake': args.fake = true; break
      default: throw new Error(`unknown argument ${String(a)}`)
    }
  }
  if (!args.in) throw new Error('--in is required')
  if (args.benchOut !== undefined && !args.benchOut) throw new Error('--bench-out needs a path')
  if (!args.dryRun && !args.out) throw new Error('--out is required')
  return args
}

/** The env with every database URL removed: the runner has no way to reach a database server. */
export function scrubbedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...source }
  delete copy.DATABASE_URL
  delete copy.CDMSS_DATABASE_URL_RO
  return copy
}

/** Env names (never values) a live run still needs, including the auth names for the Bedrock mode that resolves. */
export function missingLiveEnv(env: Env, source: NodeJS.ProcessEnv = process.env): string[] {
  const missing: string[] = []
  if (env.NEWCAT_LLM !== 'bedrock') missing.push('NEWCAT_LLM=bedrock')
  if (env.NEWCAT_JEV !== 'live') missing.push('NEWCAT_JEV=live')
  if (!env.BEDROCK_REGION) missing.push('BEDROCK_REGION')
  if (!env.BEDROCK_MODEL_SONNET) missing.push('BEDROCK_MODEL_SONNET')
  const auth = resolveBedrockAuth(env, { vercelOidcToken: source.VERCEL_OIDC_TOKEN })
  const has = (name: string): boolean => (source[name] ?? '').trim() !== ''
  if (auth === 'gcp-federation') {
    if (!env.GCP_SA_KEY_JSON) missing.push('GCP_SA_KEY_JSON')
    if (!env.AWS_ROLE_ARN) missing.push('AWS_ROLE_ARN')
  } else if (auth === 'vercel-oidc') {
    if (!env.AWS_ROLE_ARN) missing.push('AWS_ROLE_ARN')
    if (!has('VERCEL_OIDC_TOKEN')) missing.push('VERCEL_OIDC_TOKEN')
  } else if (!(has('AWS_ACCESS_KEY_ID') && has('AWS_SECRET_ACCESS_KEY')) && !has('AWS_PROFILE')) {
    // default-chain: the SDK would fail every call with no credentials, so stop before spending anything.
    missing.push('AWS_ACCESS_KEY_ID+AWS_SECRET_ACCESS_KEY or AWS_PROFILE (BEDROCK_AUTH=default-chain)')
  }
  if (jevReadiness(env) === 'unavailable') {
    const jev = jevConfig(env)
    if (!jev.baseUrl) missing.push('JEV_BASE_URL')
    if (!jev.apiKey) missing.push('JEV_API_KEY')
  }
  return missing
}

export function liveWiring(env: Env, second: SecondFactory): BatchWiring {
  return {
    models: (sql) => buildModelClient(sql, env),
    judge: (traceId, sql) => jevJudge({ transport: buildJev(sql, env), traceId, purpose: 's6-offline' }),
    second,
  }
}

export function fakeWiring(second: SecondFactory = () => null): BatchWiring {
  return {
    models: (sql) => new FakeModelClient(sql),
    judge: (traceId, sql) => jevJudge({ transport: new FakeJevTransport(sql), traceId, purpose: 's6-offline' }),
    second,
  }
}

/** Counts of what a run would do. No model call, no database, no text. */
export function dryRunSummary(load: LoadResult, options: BatchOptions): Record<string, unknown> {
  const selected = load.consults.slice(0, options.limit)
  const count = <K extends string>(key: (c: LoadedConsult) => K): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const c of selected) out[key(c)] = (out[key(c)] ?? 0) + 1
    return out
  }
  const wouldAbstain = selected.filter((c) => !prepass(c.input).complete).length
  const caps = computeCaps(selected.length, options)
  return {
    lines_read: load.lines,
    consults_valid: load.consults.length,
    rejects: load.rejects,
    would_run: selected.length,
    by_source: count((c) => c.source),
    by_match_confidence: count((c) => c.match_confidence),
    by_window_complete: count((c) => String(c.window_complete) as 'true' | 'false'),
    would_abstain_window_incomplete_no_model_call: wouldAbstain,
    would_call_model: selected.length - wouldAbstain,
    call_caps: { llm_calls: caps.llm, jev_asks: caps.jev, second_judge_asks: caps.jev },
  }
}

export async function main(argv: string[], source: NodeJS.ProcessEnv = process.env): Promise<number> {
  const args = parseArgs(argv)
  const options: BatchOptions = { limit: args.limit, concurrency: args.concurrency, maxLlmCalls: args.maxLlmCalls, maxJevCalls: args.maxJevCalls, bench: args.benchOut !== undefined }
  const load = loadConsults(args.in)
  const log = (line: string): void => void process.stdout.write(`${line}\n`)
  if (args.dryRun) {
    log(JSON.stringify(dryRunSummary(load, options), null, 2))
    return 0
  }
  const env = loadEnv(scrubbedEnv(source))
  if (!args.fake) {
    const missing = missingLiveEnv(env, source)
    if (missing.length > 0) {
      log(`live run needs these env names set: ${missing.join(', ')}`)
      return 2
    }
  }
  // --fake never reaches a network: no second judge. A live run uses Gemini only when NEWCAT_GEMINI=live and the config is complete.
  const gemini = args.fake ? null : geminiConfigOf(env)
  const second: SecondFactory = gemini ? secondFactory(env) : () => null
  const wiring = args.fake ? fakeWiring(second) : liveWiring(env, second)
  const caps = computeCaps(Math.min(load.consults.length, options.limit), options)
  log(`consults=${Math.min(load.consults.length, options.limit)} rejects=${JSON.stringify(load.rejects)}`)
  log(`call caps (hard stop): llm_calls=${caps.llm} jev_asks=${caps.jev} second_judge_asks=${gemini ? caps.jev : 0}; mode=${args.fake ? 'fake' : 'live'}; second_judge=${gemini ? 'gemini' : 'none (findings hold)'}`)
  if (!args.fake) {
    const notes = missingGeminiEnv(env)
    if (notes.length > 0) log(`second judge off: NEWCAT_GEMINI=live needs these env names set: ${notes.join(', ')}`)
    if (gemini && gemini.budgetMax < caps.jev) log(`warning: GEMINI_BUDGET_MAX is below the second-judge cap ${caps.jev}; asks past the budget hold (budget_exhausted)`)
  }
  if (args.benchOut !== undefined) prepareBenchFile(args.benchOut)
  prepareOutDir(args.out)
  let benchLines = 0
  const result = await runBatch(load.consults, wiring, options, (entry) => {
    writeEntry(args.out, entry)
    if (args.benchOut !== undefined && entry.bench) {
      appendBench(args.benchOut, entry.bench)
      benchLines += entry.bench.length
    }
  })
  const report = buildReport(result.entries, {
    lines_read: load.lines,
    rejects: load.rejects,
    skipped_for_cap: result.skipped_for_cap,
    stopped_by_cap: result.meter.stopped,
    caps: result.meter.caps,
    metered: { llm: result.meter.llm, jev: result.meter.jev, second: result.meter.second },
    mode: args.fake ? 'fake' : 'live',
  })
  writeJson(path.join(args.out, 'report.json'), report)
  writeFileSync(path.join(args.out, 'report.md'), renderMarkdown(report, result.entries), { mode: OUT_FILE_MODE })
  log(busSafeSummary(report, result.entries))
  if (args.benchOut !== undefined) log(`bench_lines=${benchLines}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      // The message is a code or a fixed string, never record text.
      process.stderr.write(`run-batch failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
      process.exit(1)
    },
  )
}
