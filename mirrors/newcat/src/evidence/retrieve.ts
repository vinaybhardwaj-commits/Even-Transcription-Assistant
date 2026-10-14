import type { Audience } from '../facts/schema.js'
import type { Sql } from '../db/sql.js'
import type { ModelClient } from '../llm/types.js'
import type { Embedder } from './embed.js'
import { vectorLiteral } from './embed.js'
import type { EvidenceRef } from './hits.js'
import { RRF_K } from './hits.js'
import { bm25Query, rrfScores } from './query.js'
import { rerankHits } from './rerank.js'
import type { LicenceClass } from './approval.js'

const POOL = 40

interface ChunkRow {
  chunk_id: string
  text: string
  section_path: string
  source_id: string
  source_name: string
  licence_class: LicenceClass
  doctor_visible: boolean
  source_url: string | null
  document_url: string | null
}

export interface RetrieveOptions {
  question: string
  audience: Audience
  limit?: number | undefined
  traceId: string
  rerank?: 'off' | 'haiku' | undefined
  models?: ModelClient | undefined
}

export type RetrievalOutcome =
  | { status: 'ok'; data: EvidenceRef[]; rerank: 'off' | 'ok' | 'unavailable' }
  | { status: 'empty'; reason: string; rerank: 'off' | 'ok' | 'unavailable' }
  | { status: 'unavailable'; error: { type: string; message: string }; rerank: 'off' | 'ok' | 'unavailable' }

export async function retrieveEvidence(sql: Sql, embedder: Embedder, options: RetrieveOptions): Promise<RetrievalOutcome> {
  const limit = clampLimit(options.limit)
  const doctorOnly = options.audience === 'doctor'
  const lexical = bm25Query(options.question)
  let lexicalIds: string[] = []
  const byId = new Map<string, EvidenceRef>()
  try {
    if (lexical) {
      const rows = await sql.query<ChunkRow>(
        `select c.id as chunk_id, c.text, c.section_path, c.source_id, s.name as source_name,
                s.licence_class, s.doctor_visible, s.url as source_url, d.url as document_url
         from chunks c
         join sources s on s.id = c.source_id
         join documents d on d.id = c.document_id,
              to_tsquery('english', $1) query
         where c.tsv @@ query
           and ($2::boolean = false or s.doctor_visible = true)
         order by ts_rank_cd(c.tsv, query) desc
         limit $3`,
        [lexical, doctorOnly, POOL],
      )
      lexicalIds = rows.rows.map((row) => row.chunk_id)
      for (const row of rows.rows) byId.set(row.chunk_id, toRef(row))
    }
  } catch {
    return { status: 'unavailable', error: { type: 'retrieval_failed', message: 'The lexical search did not complete.' }, rerank: 'off' }
  }

  const embedded = await embedder.embed([options.question], 'query', options.traceId)
  if (embedded.status !== 'ok') {
    const error = 'error' in embedded ? embedded.error : { type: 'embedding_empty', message: 'The embedding response was empty.' }
    return { status: 'unavailable', error, rerank: 'off' }
  }
  const queryVector = embedded.data[0]
  if (!queryVector) {
    return { status: 'unavailable', error: { type: 'embedding_empty', message: 'The embedding response was empty.' }, rerank: 'off' }
  }

  let vectorIds: string[] = []
  try {
    const rows = await sql.query<ChunkRow>(
      `select c.id as chunk_id, c.text, c.section_path, c.source_id, s.name as source_name,
              s.licence_class, s.doctor_visible, s.url as source_url, d.url as document_url
       from chunks c
       join sources s on s.id = c.source_id
       join documents d on d.id = c.document_id
       where c.embedding is not null
         and ($2::boolean = false or s.doctor_visible = true)
       order by c.embedding <=> $1::vector
       limit $3`,
      [vectorLiteral(queryVector), doctorOnly, POOL],
    )
    vectorIds = rows.rows.map((row) => row.chunk_id)
    for (const row of rows.rows) byId.set(row.chunk_id, toRef(row))
  } catch {
    return { status: 'unavailable', error: { type: 'retrieval_failed', message: 'The vector search did not complete.' }, rerank: 'off' }
  }

  const scores = rrfScores([lexicalIds, vectorIds], RRF_K)
  const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  let hits = ranked.map(([id]) => byId.get(id)).filter((hit): hit is EvidenceRef => hit !== undefined).slice(0, limit)
  if (hits.length === 0) {
    return { status: 'empty', reason: 'no_matching_chunks', rerank: 'off' }
  }
  let rerank: 'off' | 'ok' | 'unavailable' = 'off'
  if (options.rerank === 'haiku' && options.models) {
    const reranked = await rerankHits(options.models, options.question, hits, options.traceId)
    hits = reranked.hits.slice(0, limit)
    rerank = reranked.rerank
  }
  if (options.audience !== 'internal') {
    hits = hits.map((hit) => stripQuote(hit, options.audience))
  }
  return { status: 'ok', data: hits, rerank }
}

function stripQuote(hit: EvidenceRef, audience: Audience): EvidenceRef {
  if (audience === 'internal') return hit
  if (hit.doctor_visible && hit.licence_class !== 'licensed_internal' && hit.licence_class !== 'commercial_db') return hit
  return { ...hit, quote: '' }
}

function toRef(row: ChunkRow): EvidenceRef {
  return {
    chunk_id: row.chunk_id,
    source_id: row.source_id,
    source_name: row.source_name,
    section_path: row.section_path,
    licence_class: row.licence_class,
    doctor_visible: row.doctor_visible,
    quote: row.text,
    url: row.document_url ?? row.source_url,
  }
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) return 8
  return Math.min(limit, 20)
}
