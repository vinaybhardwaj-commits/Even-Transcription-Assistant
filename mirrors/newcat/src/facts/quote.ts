import type { Span } from './schema.js'

export interface Cursor {
  at: number
}

function fold(text: string): { folded: string; origins: number[] } {
  let folded = ''
  const origins: number[] = []
  let pending = -1
  let started = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? ''
    if (/\s/.test(char)) {
      if (started) pending = pending < 0 ? index : pending
      continue
    }
    if (pending >= 0) {
      folded += ' '
      origins.push(pending)
      pending = -1
    }
    folded += char.toLowerCase()
    origins.push(index)
    started = true
  }
  return { folded, origins }
}

/** Next occurrence at or after the cursor. Otherwise the closest earlier one. */
function nearest(starts: number[], cursor: number): number {
  const upcoming = starts.filter((start) => start >= cursor)
  if (upcoming.length > 0) return Math.min(...upcoming)
  return Math.max(...starts)
}

function exactStarts(body: string, quote: string): number[] {
  const starts: number[] = []
  let from = 0
  while (from < body.length) {
    const found = body.indexOf(quote, from)
    if (found < 0) break
    starts.push(found)
    from = found + Math.max(1, quote.length)
  }
  return starts
}

function foldedStarts(body: string, quote: string): { start: number; end: number }[] {
  const haystack = fold(body)
  const needle = fold(quote)
  if (needle.folded.length === 0) return []
  const found: { start: number; end: number }[] = []
  let from = 0
  while (from < haystack.folded.length) {
    const at = haystack.folded.indexOf(needle.folded, from)
    if (at < 0) break
    const start = haystack.origins[at]
    const last = haystack.origins[at + needle.folded.length - 1]
    if (start !== undefined && last !== undefined) found.push({ start, end: last + 1 })
    from = at + Math.max(1, needle.folded.length)
  }
  return found
}

/** Exact quote first. Otherwise whitespace- and case-folded, nearest the cursor. */
export function findQuote(quote: string, body: string, cursor: Cursor): Span | null {
  const exact = exactStarts(body, quote)
  if (exact.length > 0) {
    const start = nearest(exact, cursor.at)
    const span = { start, end: start + quote.length, quote: body.slice(start, start + quote.length) }
    cursor.at = span.end
    return span
  }
  const folded = foldedStarts(body, quote)
  if (folded.length === 0) return null
  const start = nearest(
    folded.map((item) => item.start),
    cursor.at,
  )
  const match = folded.find((item) => item.start === start) ?? folded[0]
  if (!match) return null
  const span = { start: match.start, end: match.end, quote: body.slice(match.start, match.end) }
  cursor.at = span.end
  return span
}
