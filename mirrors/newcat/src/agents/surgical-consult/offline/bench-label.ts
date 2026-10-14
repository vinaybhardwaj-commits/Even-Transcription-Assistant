import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '../../../config.js'
import { isAllowedModelId } from '../../../llm/allowlist.js'
import { credentialProvider } from '../../../llm/aws.js'
import { sdkSender, type BedrockSender } from '../../../llm/bedrock.js'
import type { ModelTier } from '../../../llm/types.js'
import { prepass } from '../prepass.js'
import { segmentId } from '../segments.js'
import type { SampleLine } from './bench-sample.js'
import { readJsonl } from './bench-sample.js'
import { reportFailure } from './safe-error.js'
import { loadConsults, type LoadedConsult } from './input.js'
import { missingBedrockEnv, scrubbedEnv } from './run-batch.js'

/**
 * Blind two-labeler absence bench on Bedrock (S6-Rg, Fable R3 A1-A4). L1 and L2 label each sample item independently with
 * ABSENCE_RUBRIC verbatim; an adjudicator is asked only when they disagree. Plain text answers (no tool use): the first word
 * must be YES or NO, else the answer is unlabeled and never coerced. Labels carry ids and codes only and stay on t4.
 * The model-labelled bench is not clinician-labelled (A3).
 */

/** The ruling's ABSENCE_RUBRIC, exact wording (RULING-FABLE-ABSENCE-RUBRIC-14OCT.md). A test pins it. */
export const ABSENCE_RUBRIC = [
  'This claim says something did NOT happen in the consult. Answer YES only if both hold:',
  '(1) the transcript window covers the whole part of the consult where this topic would normally come up, with no gap in the recording or transcript over that part; and',
  "(2) no utterance in the window, in any language or translation, addresses the item even briefly, partially or indirectly, including references such as 'as we discussed', 'I explained earlier', a leaflet or form handed over, or a plan to discuss at the next visit.",
  'Answer NO if any utterance addresses the item at all. If you cannot tell whether the window is complete, answer NO.',
].join('\n')

export const ANSWER_FORMAT = 'Reply in plain text. The first word of your reply must be YES or NO, then one line giving the reason.'

export const DEFAULT_MODELS = {
  l1: 'global.anthropic.claude-opus-4-6-v1',
  l2: 'global.anthropic.claude-sonnet-5-5',
  adj: 'global.anthropic.claude-opus-5-5',
} as const
export type Role = keyof typeof DEFAULT_MODELS
export const ROLES: readonly Role[] = ['l1', 'l2', 'adj']
export const ROLE_ENV: Record<Role, string> = { l1: 'BENCH_L1_MODEL', l2: 'BENCH_L2_MODEL', adj: 'BENCH_ADJ_MODEL' }
const ROLE_TIER: Record<Role, ModelTier> = { l1: 'opus', l2: 'sonnet', adj: 'opus' }
export const MAX_TOKENS = 200

export type Answer = 'yes' | 'no'
export type Status = 'ok' | 'unparseable' | 'error' | 'not_asked'

export interface Models {
  l1: string
  l2: string
  adj: string
}

/** Model ids from the env names, with the settled ids as defaults. Names of invalid vars are returned, never the ids. */
export function modelsFromEnv(source: NodeJS.ProcessEnv): { models: Models; invalid: string[] } {
  const models = { ...DEFAULT_MODELS } as Models
  const invalid: string[] = []
  for (const role of ROLES) {
    const value = (source[ROLE_ENV[role]] ?? '').trim()
    if (value !== '') models[role] = value
    if (!isAllowedModelId(ROLE_TIER[role], models[role])) invalid.push(`${ROLE_ENV[role]} (not in allowlist)`)
  }
  return { models, invalid }
}

/** YES or NO as the first word, any case, else null. The reason is the rest of the first non-empty line after it. */
export function parseAnswer(text: string): { answer: Answer; reason: string } | null {
  const trimmed = text.trim()
  const m = /^(yes|no)(?![A-Za-z0-9_])/i.exec(trimmed)
  if (!m) return null
  const rest = trimmed.slice(m[0].length).replace(/^[\s.:;,\-–—*]+/, '')
  const reason = (rest.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 300)
  return { answer: m[1]!.toLowerCase() as Answer, reason }
}

const clock = (seconds: number): string => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

/** The labeler's input, rebuilt from the input turns: the claim, then the context segments with role, time and English text. */
export function buildWindow(consult: LoadedConsult, item: Pick<SampleLine, 'context'>): string | null {
  const turns = prepass(consult.input).turns
  const byId = new Map(turns.map((t, i) => [segmentId(i), t] as const))
  const lines: string[] = []
  for (const c of item.context) {
    const turn = byId.get(c.segment_id)
    if (!turn) return null
    lines.push(`[${c.segment_id} ${turn.role.toUpperCase()} ${clock(turn.t0)}] ${turn.text_en}`)
  }
  return lines.length > 0 ? lines.join('\n') : null
}

export function labelerPrompt(claim: string, window: string): { system: string; user: string } {
  return { system: `${ABSENCE_RUBRIC}\n\n${ANSWER_FORMAT}`, user: `Claim: ${claim}\n\nTranscript window:\n${window}` }
}

export function adjudicatorPrompt(claim: string, window: string, a: { answer: Answer; reason: string }, b: { answer: Answer; reason: string }): { system: string; user: string } {
  return {
    system: `${ABSENCE_RUBRIC}\n\nTwo labelers disagreed about this claim. Decide it yourself from the transcript window, using the rubric. ${ANSWER_FORMAT}`,
    user: `Claim: ${claim}\n\nTranscript window:\n${window}\n\nLabeler A: ${a.answer.toUpperCase()}. ${a.reason}\nLabeler B: ${b.answer.toUpperCase()}. ${b.reason}`,
  }
}

export interface LabelRecord {
  item_id: string
  /** The sampler run id copied from the sample item; the scorer refuses labels whose run differs from the key's. */
  run_id: string
  l1: Answer | null
  l2: Answer | null
  adj: Answer | null
  label: Answer | null
  status: { l1: Status; l2: Status; adj: Status }
  /** Why there is no label: a fixed code, else null. */
  unlabeled: 'input_missing' | 'labeler_unparseable' | 'labeler_error' | 'adjudicator_unparseable' | 'adjudicator_error' | null
  served: { l1: string | null; l2: string | null; adj: string | null }
  intended: Models
}

interface Asked {
  status: Status
  parsed: { answer: Answer; reason: string } | null
  served: string | null
}

async function ask(sender: BedrockSender, model: string, prompt: { system: string; user: string }): Promise<Asked> {
  try {
    const raw = await sender.send(model, { system: prompt.system, user: prompt.user, maxTokens: MAX_TOKENS })
    const parsed = parseAnswer(raw.text)
    return { status: parsed ? 'ok' : 'unparseable', parsed, served: raw.servedModelId ?? null }
  } catch {
    return { status: 'error', parsed: null, served: null }
  }
}

/** One item: L1 and L2 independently, the adjudicator only when both answered and differ. Nothing coerces a bad answer. */
export async function labelItem(sender: BedrockSender, models: Models, item: SampleLine, consult: LoadedConsult | undefined): Promise<LabelRecord> {
  const base: LabelRecord = {
    item_id: item.item_id,
    run_id: item.run_id,
    l1: null,
    l2: null,
    adj: null,
    label: null,
    status: { l1: 'not_asked', l2: 'not_asked', adj: 'not_asked' },
    unlabeled: null,
    served: { l1: null, l2: null, adj: null },
    intended: models,
  }
  const window = consult ? buildWindow(consult, item) : null
  if (window === null) return { ...base, unlabeled: 'input_missing' }
  const prompt = labelerPrompt(item.claim, window)
  const [a, b] = await Promise.all([ask(sender, models.l1, prompt), ask(sender, models.l2, prompt)])
  const rec: LabelRecord = {
    ...base,
    l1: a.parsed?.answer ?? null,
    l2: b.parsed?.answer ?? null,
    status: { l1: a.status, l2: b.status, adj: 'not_asked' },
    served: { l1: a.served, l2: b.served, adj: null },
  }
  if (!a.parsed || !b.parsed) return { ...rec, unlabeled: a.status === 'error' || b.status === 'error' ? 'labeler_error' : 'labeler_unparseable' }
  if (a.parsed.answer === b.parsed.answer) return { ...rec, label: a.parsed.answer }
  const c = await ask(sender, models.adj, adjudicatorPrompt(item.claim, window, a.parsed, b.parsed))
  const done: LabelRecord = { ...rec, adj: c.parsed?.answer ?? null, status: { ...rec.status, adj: c.status }, served: { ...rec.served, adj: c.served } }
  if (!c.parsed) return { ...done, unlabeled: c.status === 'error' ? 'adjudicator_error' : 'adjudicator_unparseable' }
  return { ...done, label: c.parsed.answer }
}

export interface Proof {
  role: Role
  intended: string
  served: string | null
  served_verified: boolean
  /** Set when the proof call failed: the error class, never a message. */
  error: boolean
}

/** A1: one tiny synthetic Converse call per distinct model. Ids only; the prompt is the word `ok`. */
export async function proveModels(sender: BedrockSender, models: Models): Promise<Proof[]> {
  const proofs: Proof[] = []
  const cache = new Map<string, { served: string | null; error: boolean }>()
  for (const role of ROLES) {
    const intended = models[role]
    let seen = cache.get(intended)
    if (!seen) {
      try {
        const raw = await sender.send(intended, { system: 'Reply with one word.', user: 'ok', maxTokens: 8 })
        seen = { served: raw.servedModelId ?? null, error: false }
      } catch {
        seen = { served: null, error: true }
      }
      cache.set(intended, seen)
    }
    proofs.push({ role, intended, served: seen.served, served_verified: seen.served !== null, error: seen.error })
  }
  return proofs
}

export interface LabelArgs {
  sample: string
  input: string
  out: string
  dryRun: boolean
}

export function parseArgs(argv: string[]): LabelArgs {
  const args: LabelArgs = { sample: '', input: '', out: '', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    switch (a) {
      case '--sample': args.sample = v ?? ''; i++; break
      case '--input': args.input = v ?? ''; i++; break
      case '--out': args.out = v ?? ''; i++; break
      case '--dry-run': args.dryRun = true; break
      default: throw new Error(`unknown argument ${String(a)}`)
    }
  }
  if (!args.sample || !args.input) throw new Error('--sample and --input are required')
  if (!args.dryRun && !args.out) throw new Error('--out is required')
  return args
}

export function consultsById(file: string): Map<string, LoadedConsult> {
  return new Map(loadConsults(file).consults.map((c) => [c.input.encounter_id, c] as const))
}

export async function main(argv: string[], source: NodeJS.ProcessEnv = process.env, sender?: BedrockSender): Promise<number> {
  const args = parseArgs(argv)
  const log = (line: string): void => void process.stdout.write(`${line}\n`)
  const items = readJsonl<SampleLine>(args.sample)
  const consults = consultsById(args.input)
  const { models, invalid } = modelsFromEnv(source)
  if (invalid.length > 0) {
    log(`model env not allowed: ${invalid.join(', ')}`)
    return 2
  }
  const rebuilt = items.filter((i) => {
    const c = consults.get(i.encounter_id)
    return c !== undefined && buildWindow(c, i) !== null
  }).length
  const calls = { probes: new Set(Object.values(models)).size, labeler_calls: 2 * rebuilt, adjudicator_calls_max: rebuilt }
  log(`items=${items.length} rebuildable=${rebuilt} not_rebuildable=${items.length - rebuilt}`)
  log(`models: l1=${models.l1} l2=${models.l2} adj=${models.adj}`)
  log(`call cap (hard): probes=${calls.probes} labeler_calls=${calls.labeler_calls} adjudicator_calls<=${calls.adjudicator_calls_max}`)
  if (args.dryRun) return 0
  const env = loadEnv(scrubbedEnv(source))
  if (!sender) {
    const missing = missingBedrockEnv(env, source)
    if (missing.length > 0) {
      log(`live run needs these env names set: ${missing.join(', ')}`)
      return 2
    }
  }
  if (existsSync(args.out)) throw new Error('out_path_exists')
  const bedrock = sender ?? sdkSender(env.BEDROCK_REGION!, credentialProvider(env))
  const proofs = await proveModels(bedrock, models)
  for (const p of proofs) log(`model=${p.role} intended=${p.intended} served=${p.served ?? 'unverified'} served_verified=${p.served_verified ? 'yes' : 'no'}${p.error ? ' proof_call=failed' : ''}`)
  if (proofs.some((p) => p.error)) {
    log('proof call failed: no labels written (check the Bedrock role and the model ids)')
    return 2
  }
  if (proofs.some((p) => !p.served_verified)) {
    log('WARNING: a served model id is unverified (the inference profile did not resolve). Labelling continues; the served-id proof waits on the bedrock:GetInferenceProfile grant.')
  }
  writeFileSync(args.out, '', { mode: 0o600, flag: 'wx' })
  const labels: LabelRecord[] = []
  for (const item of items) labels.push(await labelItem(bedrock, models, item, consults.get(item.encounter_id)))
  writeFileSync(args.out, labels.map((l) => `${JSON.stringify(l)}\n`).join(''), { mode: 0o600 })
  const count = (f: (l: LabelRecord) => boolean): number => labels.filter(f).length
  log(`labeled=${count((l) => l.label !== null)} unlabeled=${count((l) => l.label === null)} adjudicated=${count((l) => l.status.adj !== 'not_asked')} l1_l2_disagree=${count((l) => l.l1 !== null && l.l2 !== null && l.l1 !== l.l2)}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      reportFailure('bench-label', error)
      process.exit(1)
    },
  )
}
