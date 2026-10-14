import { sha256, stableStringify } from '../../hash.js'
import type { InternalAudit } from '../../pipeline/types.js'
import type { Runner } from './metamorphic.js'

export interface RegressionCase<I> {
  id: string
  input: I
  /** Frozen hash of the fixture input. A changed fixture fails until the hash is re-frozen by PR. */
  inputSha: string
  expected: NormalizedOutput
}

export interface NormalizedOutput {
  status: InternalAudit['status']
  reason?: string
  /** `rule_id:action`, sorted. */
  findings: string[]
}

export function fixtureSha(input: unknown): string {
  return sha256(stableStringify(input))
}

export function normalize(audit: InternalAudit): NormalizedOutput {
  return {
    status: audit.status,
    ...(audit.reason ? { reason: audit.reason } : {}),
    findings: audit.findings.map((finding) => `${finding.rule_id}:${finding.action}`).sort(),
  }
}

export interface RegressionFailure {
  id: string
  problem: 'fixture_changed' | 'output_changed'
}

export async function regression<I>(set: Array<RegressionCase<I>>, run: Runner<I>): Promise<RegressionFailure[]> {
  const failures: RegressionFailure[] = []
  for (const item of set) {
    if (fixtureSha(item.input) !== item.inputSha) {
      failures.push({ id: item.id, problem: 'fixture_changed' })
      continue
    }
    const actual = normalize(await run(item.input))
    if (stableStringify(actual) !== stableStringify(item.expected)) failures.push({ id: item.id, problem: 'output_changed' })
  }
  return failures
}
