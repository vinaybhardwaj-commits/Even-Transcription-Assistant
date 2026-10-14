import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BenchLine } from './bench.js'

/**
 * Stratified, blinded sample of absence bench lines for hand labelling (Fable R3).
 * Strata: rule group (concern, then each consent element) x outcome (dropped / disagree / agree), proportional allocation with
 * a minimum of 1 per non-empty cell. The sample file drops bench_id, primary_p, second_p and outcome; a separate 0600 key file
 * maps each sample item to its bench_id and outcome. Both files carry t4-only content (the sample has quotes): never post them.
 */

export const OUTCOMES = ['dropped', 'disagree', 'agree'] as const
export type SampledOutcome = (typeof OUTCOMES)[number]
const FILE_MODE = 0o600

export type SampleLine = Omit<BenchLine, 'bench_id' | 'primary_p' | 'second_p' | 'outcome'> & { item_id: string }
export interface KeyRow {
  item_id: string
  bench_id: string
  group: string
  outcome: SampledOutcome
  primary_p: number | null
  second_p: number | null
}
export interface SampleResult {
  sample: SampleLine[]
  key: KeyRow[]
  /** Candidates per cell (all absence lines with a sampled outcome) and how many were drawn. */
  cells: Array<{ group: string; outcome: SampledOutcome; available: number; drawn: number }>
  /** Absence lines left out because a judge was unavailable. */
  excluded_unavailable: number
}

/** concern for concern.*, else the rule id (consent.risks, ...). */
export const groupOf = (ruleId: string): string => (ruleId.startsWith('concern.') ? 'concern' : ruleId)
const groupRank = (g: string): string => (g === 'concern' ? `0${g}` : `1${g}`)

/** mulberry32 seeded from a string. */
export function rng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0)
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

/** Proportional allocation of n over cell sizes: min 1 per non-empty cell, never above the cell, total exactly min(n, all). */
export function allocate(sizes: number[], n: number): number[] {
  const total = sizes.reduce((s, x) => s + x, 0)
  if (n >= total) return [...sizes]
  const cells = sizes.filter((x) => x > 0).length
  if (n < cells) throw new Error('n_below_cells')
  const exact = sizes.map((x) => (x * n) / total)
  const alloc = sizes.map((x, i) => (x === 0 ? 0 : Math.min(x, Math.max(1, Math.floor(exact[i]!)))))
  let sum = alloc.reduce((s, x) => s + x, 0)
  // Add by largest remainder; remove from the cell most over its share (above 1). Ties break by cell order.
  while (sum < n) {
    let best = -1
    for (let i = 0; i < sizes.length; i++) if (alloc[i]! < sizes[i]! && (best < 0 || exact[i]! - alloc[i]! > exact[best]! - alloc[best]!)) best = i
    alloc[best]! += 1
    sum += 1
  }
  while (sum > n) {
    let worst = -1
    for (let i = 0; i < sizes.length; i++) if (alloc[i]! > 1 && (worst < 0 || alloc[i]! - exact[i]! > alloc[worst]! - exact[worst]!)) worst = i
    alloc[worst]! -= 1
    sum -= 1
  }
  return alloc
}

export function sampleBench(lines: BenchLine[], n: number, seed: string): SampleResult {
  const absence = lines.filter((l) => l.polarity === 'absence')
  const usable = absence.filter((l): l is BenchLine & { outcome: SampledOutcome } => (OUTCOMES as readonly string[]).includes(l.outcome))
  const groups = [...new Set(usable.map((l) => groupOf(l.rule_id)))].sort((a, b) => groupRank(a).localeCompare(groupRank(b)))
  const keys: Array<{ group: string; outcome: SampledOutcome }> = groups.flatMap((group) => OUTCOMES.map((outcome) => ({ group, outcome })))
  // Within a cell the order is by bench_id, so the draw depends on the file's content and the seed, not on line order.
  const members = keys.map((k) => usable.filter((l) => groupOf(l.rule_id) === k.group && l.outcome === k.outcome).sort((a, b) => a.bench_id.localeCompare(b.bench_id)))
  const alloc = allocate(members.map((m) => m.length), n)
  const rand = rng(seed)
  const drawn: Array<BenchLine & { outcome: SampledOutcome }> = []
  const cells = keys.map((k, i) => {
    const take = shuffle(members[i]!, rand).slice(0, alloc[i]!)
    drawn.push(...take)
    return { ...k, available: members[i]!.length, drawn: take.length }
  })
  const order = shuffle(drawn, rand)
  const sample: SampleLine[] = []
  const key: KeyRow[] = []
  order.forEach((line, i) => {
    const item_id = `item-${String(i + 1).padStart(3, '0')}`
    const { bench_id, primary_p, second_p, outcome, ...rest } = line
    sample.push({ item_id, ...rest })
    key.push({ item_id, bench_id, group: groupOf(line.rule_id), outcome, primary_p, second_p })
  })
  return { sample, key, cells: cells.filter((c) => c.available > 0), excluded_unavailable: absence.length - usable.length }
}

export function readBench(file: string): BenchLine[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as BenchLine)
}

export function main(argv: string[]): number {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const bench = get('--bench')
  const out = get('--out')
  const seed = get('--seed')
  const n = Number(get('--n'))
  if (!bench || !out || seed === undefined || !Number.isInteger(n) || n < 1) throw new Error('usage: --bench <file> --n <int> --seed <s> --out <file> [--key-out <file>]')
  const keyOut = get('--key-out') ?? `${out}.key`
  for (const f of [out, keyOut]) if (existsSync(f)) throw new Error('out_path_exists')
  const result = sampleBench(readBench(bench), n, seed)
  writeFileSync(out, result.sample.map((l) => `${JSON.stringify(l)}\n`).join(''), { mode: FILE_MODE, flag: 'wx' })
  writeFileSync(keyOut, result.key.map((k) => `${JSON.stringify(k)}\n`).join(''), { mode: FILE_MODE, flag: 'wx' })
  // Counts only.
  process.stdout.write(`sampled=${result.sample.length} cells=${result.cells.length} excluded_unavailable=${result.excluded_unavailable}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`bench-sample failed: ${error instanceof Error ? error.message : 'unknown'}\n`)
    process.exit(1)
  }
}
