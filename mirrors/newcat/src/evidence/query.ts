import { spellingAlts } from './spelling.js'

const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'not',
  'but',
  'its',
  'into',
  'about',
  'does',
  'what',
  'when',
  'which',
  'who',
  'how',
  'why',
  'can',
  'may',
  'any',
  'all',
  'per',
  'via',
  'than',
  'then',
  'also',
  'only',
  'over',
  'under',
  'between',
  'after',
  'before',
])

/**
 * OR of a few significant terms, plus the other British or Indian spelling.
 * plainto_tsquery ANDs every word of a question and returns no rows.
 */
export function bm25Query(question: string): string | null {
  const raw = question.toLowerCase().match(/[a-z]{3,}/g) ?? []
  const seeds: string[] = []
  const seen = new Set<string>()
  for (const term of raw) {
    if (STOP.has(term) || seen.has(term)) continue
    seen.add(term)
    seeds.push(term)
    if (seeds.length >= 8) break
  }
  const terms: string[] = []
  const have = new Set<string>()
  for (const term of seeds) {
    for (const form of [term, ...spellingAlts(term)]) {
      if (have.has(form)) continue
      have.add(form)
      terms.push(form)
      if (terms.length >= 12) return terms.join(' | ')
    }
  }
  if (terms.length === 0) return null
  return terms.join(' | ')
}

export function rrfScores(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of lists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return scores
}
