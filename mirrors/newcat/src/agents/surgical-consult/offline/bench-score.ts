import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cohenKappa } from '../governance/aggregate.js'
import { readJsonl, type KeyRow } from './bench-sample.js'
import type { LabelRecord } from './bench-label.js'
import { CodedError, reportFailure } from './safe-error.js'
import { thresholdFor } from './run-batch.js'

/**
 * Scores the judges against the model labels (S6-Rg). Joins the labels (by item_id) to the sampler's key file (p values and
 * group). Output is counts and kappas only: no ids, no text. The bench is model-labelled, not clinician-labelled (A3).
 */

export const R3_KAPPA = 0.4
export const LABELLING_LINE = 'bench=model-labelled (not clinician-labelled)'

export interface GroupCounts {
  group: string
  items: number
  labeled: number
  label_yes: number
}

export interface Score {
  items: number
  labeled: number
  unlabeled: Record<string, number>
  adjudicated: number
  l1_l2_pairs: number
  l1_l2_disagree: number
  kappa_l1_l2: number | null
  jev: { n: number; kappa: number | null; yes_rate: number | null; agreement: number | null }
  gemini: { n: number; kappa: number | null; yes_rate: number | null; agreement: number | null }
  label_yes_rate: number | null
  by_group: GroupCounts[]
  both_kappa_ge_r3: boolean | null
  /** Key rows without a label record, and label records without a key row (a mismatched pair of files). */
  unmatched: { key_without_label: number; label_without_key: number }
}

const round3 = (x: number | null): number | null => (x === null ? null : Math.round(x * 1000) / 1000)
const rate = (num: number, den: number): number | null => (den === 0 ? null : round3(num / den))
const ruleOf = (group: string): string => (group === 'concern' ? 'concern.unaddressed' : group)

function against(rows: Array<{ label: boolean; judge: boolean }>): { n: number; kappa: number | null; yes_rate: number | null; agreement: number | null } {
  return {
    n: rows.length,
    kappa: round3(cohenKappa(rows.map((r) => [r.judge, r.label]))),
    yes_rate: rate(rows.filter((r) => r.judge).length, rows.length),
    agreement: rate(rows.filter((r) => r.judge === r.label).length, rows.length),
  }
}

/** Labels and key must come from one sampler run: every record carries the same run_id. A mismatch is refused, never joined. */
export function checkRun(labels: LabelRecord[], key: KeyRow[]): void {
  const ids = new Set([...labels.map((l) => l.run_id), ...key.map((k) => k.run_id)])
  if ([...ids].some((id) => typeof id !== 'string' || id === '')) throw new CodedError('run_id_missing')
  if (ids.size > 1) throw new CodedError('run_id_mismatch')
}

export function score(labels: LabelRecord[], key: KeyRow[]): Score {
  checkRun(labels, key)
  const keyById = new Map(key.map((k) => [k.item_id, k] as const))
  const labelIds = new Set(labels.map((l) => l.item_id))
  const unlabeled: Record<string, number> = {}
  for (const l of labels) if (l.label === null) unlabeled[l.unlabeled ?? 'unknown'] = (unlabeled[l.unlabeled ?? 'unknown'] ?? 0) + 1
  const labeled = labels.filter((l) => l.label !== null)
  const joined = labeled.flatMap((l) => {
    const k = keyById.get(l.item_id)
    return k ? [{ l, k }] : []
  })
  const jev = against(joined.flatMap(({ l, k }) => (k.primary_p === null ? [] : [{ label: l.label === 'yes', judge: k.primary_p >= thresholdFor(ruleOf(k.group)) }])))
  const gemini = against(joined.flatMap(({ l, k }) => (k.second_p === null ? [] : [{ label: l.label === 'yes', judge: k.second_p >= thresholdFor(ruleOf(k.group)) }])))
  const both = labels.filter((l) => l.l1 !== null && l.l2 !== null)
  const groups = new Map<string, GroupCounts>()
  for (const l of labels) {
    const group = keyById.get(l.item_id)?.group ?? 'unknown'
    const g = groups.get(group) ?? { group, items: 0, labeled: 0, label_yes: 0 }
    g.items += 1
    if (l.label !== null) g.labeled += 1
    if (l.label === 'yes') g.label_yes += 1
    groups.set(group, g)
  }
  const order = (g: string): string => (g === 'concern' ? `0${g}` : `1${g}`)
  return {
    items: labels.length,
    labeled: labeled.length,
    unlabeled,
    adjudicated: labels.filter((l) => l.status.adj !== 'not_asked').length,
    l1_l2_pairs: both.length,
    l1_l2_disagree: both.filter((l) => l.l1 !== l.l2).length,
    kappa_l1_l2: round3(cohenKappa(both.map((l) => [l.l1 === 'yes', l.l2 === 'yes']))),
    jev,
    gemini,
    label_yes_rate: rate(labeled.filter((l) => l.label === 'yes').length, labeled.length),
    by_group: [...groups.values()].sort((a, b) => order(a.group).localeCompare(order(b.group))),
    both_kappa_ge_r3: jev.kappa === null || gemini.kappa === null ? null : jev.kappa >= R3_KAPPA && gemini.kappa >= R3_KAPPA,
    unmatched: { key_without_label: key.filter((k) => !labelIds.has(k.item_id)).length, label_without_key: labels.filter((l) => !keyById.has(l.item_id)).length },
  }
}

const f = (x: number | null): string => (x === null ? 'n/a' : String(x))

/** Counts and kappas only. */
export function busSafeBlock(s: Score): string {
  const un = Object.entries(s.unlabeled).sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => `${k}=${n}`).join(' ')
  return [
    LABELLING_LINE,
    `items=${s.items} labeled=${s.labeled} unlabeled=${s.items - s.labeled}${un ? ` (${un})` : ''} adjudicated=${s.adjudicated}`,
    `labelers l1_l2_pairs=${s.l1_l2_pairs} disagree=${s.l1_l2_disagree} kappa=${f(s.kappa_l1_l2)} (before adjudication)`,
    `label_yes_rate=${f(s.label_yes_rate)}`,
    `jev_vs_labels n=${s.jev.n} kappa=${f(s.jev.kappa)} agreement=${f(s.jev.agreement)} yes_rate=${f(s.jev.yes_rate)}`,
    `gemini_vs_labels n=${s.gemini.n} kappa=${f(s.gemini.kappa)} agreement=${f(s.gemini.agreement)} yes_rate=${f(s.gemini.yes_rate)}`,
    `r3_both_kappa_ge_${R3_KAPPA}=${s.both_kappa_ge_r3 === null ? 'n/a' : s.both_kappa_ge_r3 ? 'yes' : 'no'}`,
    ...s.by_group.map((g) => `group ${g.group} items=${g.items} labeled=${g.labeled} label_yes=${g.label_yes}`),
    ...(s.unmatched.key_without_label + s.unmatched.label_without_key > 0 ? [`WARNING key/label mismatch: key_without_label=${s.unmatched.key_without_label} label_without_key=${s.unmatched.label_without_key}`] : []),
  ].join('\n')
}

export function main(argv: string[]): number {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const labels = get('--labels')
  const keyFile = get('--key')
  if (!labels || !keyFile) throw new Error('usage: --labels <file> --key <file> [--out <file>]')
  const result = score(readJsonl<LabelRecord>(labels), readJsonl<KeyRow>(keyFile))
  const out = get('--out')
  if (out) writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  process.stdout.write(`${busSafeBlock(result)}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    reportFailure('bench-score', error)
    process.exit(1)
  }
}
