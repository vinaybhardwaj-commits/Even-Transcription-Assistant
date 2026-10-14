import { findQuote } from '../../facts/quote.js'
import { sha256 } from '../../hash.js'
import type { GatedFact, RawFact, Segment, Source } from './types.js'

export const DROP_REASONS = [
  'schema',
  'group_unknown',
  'segment_unknown',
  'segment_ambiguous',
  'quote_not_in_segment',
  'quote_in_other_segment',
  'role_not_allowed',
] as const
export type DropReason = (typeof DROP_REASONS)[number]

export interface GateResult<F> {
  kept: GatedFact<F>[]
  /** Counts only. Quotes and segment text are never logged or returned. */
  dropped: Record<DropReason, number>
  total: number
  droppedTotal: number
  dropRate: number
}

const ZERO_WIDTH = new Set(['​', '‌', '‍', '⁠', '﻿'])

/** Removes zero-width characters and keeps, for each kept character, its index in the original. */
export function stripZeroWidth(text: string): { text: string; origins: number[] } {
  let out = ''
  const origins: number[] = []
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    if (ZERO_WIDTH.has(char)) continue
    out += char
    origins.push(index)
  }
  return { text: out, origins }
}

export interface SegmentSpan {
  start: number
  end: number
}

/**
 * Finds `quote` in one segment: zero-width characters are stripped from both sides first,
 * then findQuote runs (exact, then folded). Offsets point into the ORIGINAL segment text.
 */
export function findInSegment(quote: string, segmentText: string, cursor = { at: 0 }): SegmentSpan | null {
  const needle = stripZeroWidth(quote)
  const haystack = stripZeroWidth(segmentText)
  if (needle.text.trim().length === 0) return null
  // The cursor is tracked in cleaned coordinates by findQuote; callers pass one per gate run.
  const span = findQuote(needle.text, haystack.text, cursor)
  if (!span) return null
  const first = haystack.origins[span.start]
  const last = haystack.origins[span.end - 1]
  if (first === undefined || last === undefined) return null
  return { start: first, end: last + 1 }
}

function emptyDrops(): Record<DropReason, number> {
  return Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])) as Record<DropReason, number>
}

function isRaw(value: unknown): value is RawFact {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.group === 'string' && typeof item.quote === 'string' && typeof item.segment_id === 'string'
}

/** Pairs each segment with the source it came from. */
function indexSegments(sources: Source[]): Map<string, { source: Source; segment: Segment } | 'ambiguous'> {
  const index = new Map<string, { source: Source; segment: Segment } | 'ambiguous'>()
  for (const source of sources) {
    for (const segment of source.segments) {
      index.set(segment.id, index.has(segment.id) ? 'ambiguous' : { source, segment })
    }
  }
  return index
}

/**
 * The quote gate. A fact is kept only when its quote is in the segment it names and the
 * segment's role is allowed for its group. Code computes offsets and stamps role, t0, t1.
 * `parseFields` validates the agent's own fields; a failure drops the fact as `schema`.
 */
export function gateFacts<F>(
  rawFacts: unknown[],
  sources: Source[],
  roleTable: Record<string, string[]>,
  parseFields: (raw: RawFact) => { ok: true; value: F } | { ok: false },
): GateResult<F> {
  const segments = indexSegments(sources)
  const dropped = emptyDrops()
  const kept: GatedFact<F>[] = []
  const cursors = new Map<string, { at: number }>()

  for (const raw of rawFacts) {
    if (!isRaw(raw)) {
      dropped.schema += 1
      continue
    }
    const parsed = parseFields(raw)
    if (!parsed.ok) {
      dropped.schema += 1
      continue
    }
    const allowed = roleTable[raw.group]
    if (!allowed) {
      dropped.group_unknown += 1
      continue
    }
    const entry = segments.get(raw.segment_id)
    if (entry === undefined) {
      dropped.segment_unknown += 1
      continue
    }
    if (entry === 'ambiguous') {
      dropped.segment_ambiguous += 1
      continue
    }
    const cursor = cursors.get(raw.segment_id) ?? { at: 0 }
    cursors.set(raw.segment_id, cursor)
    const span = findInSegment(raw.quote, entry.segment.text, cursor)
    if (!span) {
      const elsewhere = [...segments.values()].some(
        (other) => other !== 'ambiguous' && other.segment.id !== raw.segment_id && findInSegment(raw.quote, other.segment.text) !== null,
      )
      if (elsewhere) dropped.quote_in_other_segment += 1
      else dropped.quote_not_in_segment += 1
      continue
    }
    if (!allowed.includes(entry.segment.role)) {
      dropped.role_not_allowed += 1
      continue
    }
    const id = sha256(`${entry.source.id}|${entry.segment.id}|${raw.group}|${span.start}|${span.end}`).slice(0, 16)
    if (kept.some((fact) => fact.id === id)) continue
    kept.push({
      ...parsed.value,
      id,
      group: raw.group,
      quote: entry.segment.text.slice(span.start, span.end),
      source_id: entry.source.id,
      segment_id: entry.segment.id,
      role: entry.segment.role,
      t0: entry.segment.t0 ?? null,
      t1: entry.segment.t1 ?? null,
      start: span.start,
      end: span.end,
    } as GatedFact<F>)
  }

  const droppedTotal = Object.values(dropped).reduce((sum, n) => sum + n, 0)
  const total = rawFacts.length
  return { kept, dropped, total, droppedTotal, dropRate: total === 0 ? 0 : droppedTotal / total }
}
