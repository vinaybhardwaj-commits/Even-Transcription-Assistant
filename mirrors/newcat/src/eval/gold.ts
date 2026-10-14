import { sha256, stableStringify } from '../hash.js'

export interface GoldCase {
  id: string
  source: string
  source_uid: string
  source_timestamp: string
  body: string
  expected_safety_rule_ids: string[]
  expected_critical_rule_ids: string[]
}

export interface GoldFile {
  id: string
  synthetic: true
  description: string
  frozen_sha256: string
  baseline: { safety_recall: number; safety_precision: number }
  cases: GoldCase[]
}

export function goldContentHash(doc: GoldFile): string {
  const { frozen_sha256: _ignored, ...rest } = doc
  return sha256(stableStringify(rest))
}

export function assertGoldFrozen(doc: GoldFile): { ok: true } | { ok: false; reason: string } {
  if (doc.synthetic !== true) return { ok: false, reason: 'gold set is not marked synthetic' }
  const hash = goldContentHash(doc)
  if (hash !== doc.frozen_sha256) return { ok: false, reason: 'gold_hash_mismatch' }
  return { ok: true }
}
