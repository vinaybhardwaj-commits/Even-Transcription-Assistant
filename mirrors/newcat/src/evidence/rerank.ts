import type { ModelClient } from '../llm/types.js'
import type { EvidenceRef } from './hits.js'

export function parseRerankIds(text: string): string[] | null {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string' && item.length > 0)) return null
    return parsed
  } catch {
    return null
  }
}

export function applyRerank(hits: EvidenceRef[], ids: string[]): EvidenceRef[] {
  const byId = new Map(hits.map((hit) => [hit.chunk_id, hit]))
  const ordered: EvidenceRef[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const hit = byId.get(id)
    if (!hit || seen.has(id)) continue
    seen.add(id)
    ordered.push(hit)
  }
  for (const hit of hits) {
    if (!seen.has(hit.chunk_id)) ordered.push(hit)
  }
  return ordered
}

/** Haiku returns chunk ids only. A bad response keeps the fused order. */
export async function rerankHits(
  models: ModelClient,
  question: string,
  hits: EvidenceRef[],
  traceId: string,
): Promise<{ hits: EvidenceRef[]; rerank: 'ok' | 'unavailable' }> {
  if (hits.length < 2) return { hits, rerank: 'ok' }
  const listed = hits
    .map((hit) => `${hit.chunk_id}\t${hit.quote.slice(0, 400)}`)
    .join('\n')
  const completed = await models.complete({
    tier: 'haiku',
    system: 'Reorder evidence chunk ids. Reply with a JSON array of ids, best first, and no other text.',
    user: `Question: ${question}\n\n${listed}`,
    maxOutputTokens: 200,
    traceId,
    purpose: 'evidence.rerank',
  })
  if (completed.status !== 'ok') return { hits, rerank: 'unavailable' }
  const ids = parseRerankIds(completed.data.text)
  if (!ids || ids.length === 0) return { hits, rerank: 'unavailable' }
  return { hits: applyRerank(hits, ids), rerank: 'ok' }
}
