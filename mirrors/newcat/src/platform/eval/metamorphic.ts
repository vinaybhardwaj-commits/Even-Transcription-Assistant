import type { InternalAudit } from '../../pipeline/types.js'
import type { Segment, Source } from '../agent/types.js'

/** Finding-type delta a transform is expected to cause. Types are rule ids. */
export interface MetamorphicExpect {
  added?: string[]
  removed?: string[]
  /** Statuses the variant may have. Defaults to any. */
  status?: InternalAudit['status'][]
}

export interface MetamorphicResult {
  pass: boolean
  base: string[]
  variant: string[]
  added: string[]
  removed: string[]
}

export type Runner<I> = (input: I) => Promise<InternalAudit>

function ruleTypes(audit: InternalAudit): string[] {
  return audit.findings.filter((finding) => finding.action === 'valid').map((finding) => finding.rule_id).sort()
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index])
}

/**
 * Runs the fixture and its transformed variant and compares the finding types.
 * `expect.added` / `expect.removed` must match the delta exactly.
 */
export async function metamorphic<I>(args: {
  run: Runner<I>
  fixture: I
  transform: (input: I) => I
  expect: MetamorphicExpect
}): Promise<MetamorphicResult> {
  const baseAudit = await args.run(args.fixture)
  const variantAudit = await args.run(args.transform(args.fixture))
  const base = ruleTypes(baseAudit)
  const variant = ruleTypes(variantAudit)
  const added = variant.filter((type) => !base.includes(type))
  const removed = base.filter((type) => !variant.includes(type))
  const statusOk = args.expect.status ? args.expect.status.includes(variantAudit.status) : true
  const pass = statusOk && sameSet(added, args.expect.added ?? []) && sameSet(removed, args.expect.removed ?? [])
  return { pass, base, variant, added, removed }
}

/** Source transforms. An agent maps them onto its own input with a small lens. */
export const transforms = {
  /** Deletes the first occurrence of `text` in the segment. */
  deleteText(sources: Source[], segmentId: string, text: string): Source[] {
    return mapSegment(sources, segmentId, (segment) => ({ ...segment, text: segment.text.replace(text, '') }))
  },
  /** Replaces `from` with `to` in the segment (a paraphrase supplied by the fixture author). */
  paraphrase(sources: Source[], segmentId: string, from: string, to: string): Source[] {
    return mapSegment(sources, segmentId, (segment) => ({ ...segment, text: segment.text.replace(from, to) }))
  },
  /** Swaps roles per the map, e.g. { clinician: 'patient', patient: 'clinician' }. */
  swapRoles(sources: Source[], map: Record<string, string>): Source[] {
    return sources.map((source) => ({
      ...source,
      segments: source.segments.map((segment) => ({ ...segment, role: map[segment.role] ?? segment.role })),
    }))
  },
  /** Appends a new segment to a source. */
  insertSegment(sources: Source[], sourceId: string, segment: Segment): Source[] {
    return sources.map((source) => (source.id === sourceId ? { ...source, segments: [...source.segments, segment] } : source))
  },
}

function mapSegment(sources: Source[], segmentId: string, fn: (segment: Segment) => Segment): Source[] {
  return sources.map((source) => ({
    ...source,
    segments: source.segments.map((segment) => (segment.id === segmentId ? fn(segment) : segment)),
  }))
}
