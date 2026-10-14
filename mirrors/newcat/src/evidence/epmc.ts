import type { Sql } from '../db/sql.js'
import type { Embedder } from './embed.js'
import { importCorpusLines, type CorpusLine, type ImportReport } from './import.js'

const EPMC_SEARCH = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search'

export function parseQueryList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/** CC BY and CC0 only. NC and ND stay out. A missing licence is not assumed open. */
export function epmcLicenceAllowed(licence: string | null | undefined, isOpenAccess: unknown): boolean {
  const open = isOpenAccess === true || isOpenAccess === 'Y' || isOpenAccess === 'y'
  if (!open) return false
  const value = (licence ?? '').toLowerCase().replace(/[_\s]+/g, '-')
  if (value === '') return false
  if (value.includes('nc') || value.includes('nd')) return false
  if (value.includes('cc0') || value.includes('cc-0')) return true
  if (value.includes('cc-by') || value.includes('ccby')) return true
  return false
}

export interface EpmcFetchOptions {
  fetchImpl?: typeof fetch | undefined
  pageSize?: number | undefined
  maxPages?: number | undefined
}

export async function fetchEpmcArticles(query: string, options: EpmcFetchOptions = {}): Promise<{ status: 'ok'; articles: CorpusLine[] } | { status: 'empty'; reason: string } | { status: 'unavailable'; error: { type: string; message: string } }> {
  const fetchImpl = options.fetchImpl ?? fetch
  const pageSize = options.pageSize ?? 25
  const maxPages = options.maxPages ?? 4
  const articles: CorpusLine[] = []
  let cursor = '*'
  const seen = new Set<string>()
  for (let page = 0; page < maxPages; page++) {
    if (seen.has(cursor)) break
    seen.add(cursor)
    const url = epmcUrl(query, pageSize, cursor)
    let response: Response
    try {
      response = await fetchImpl(url)
    } catch {
      return { status: 'unavailable', error: { type: 'epmc_unavailable', message: 'Europe PMC did not respond.' } }
    }
    if (!response.ok) {
      return { status: 'unavailable', error: { type: 'epmc_unavailable', message: 'Europe PMC did not respond.' } }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { status: 'unavailable', error: { type: 'epmc_unavailable', message: 'Europe PMC did not return JSON.' } }
    }
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const resultList = record.resultList && typeof record.resultList === 'object' ? (record.resultList as Record<string, unknown>).result : undefined
    const rows = asRecords(resultList)
    for (const row of rows) {
      const article = toArticle(row)
      if (article) articles.push(article)
    }
    const next = typeof record.nextCursorMark === 'string' ? record.nextCursorMark : ''
    if (next === '' || next === cursor || rows.length === 0) break
    cursor = next
  }
  if (articles.length === 0) return { status: 'empty', reason: 'no_open_access_abstracts' }
  return { status: 'ok', articles }
}

export async function importEpmcQueries(
  sql: Sql,
  embedder: Embedder,
  queries: string[],
  options: EpmcFetchOptions & { batchSize: number; concurrency?: number; now?: Date },
): Promise<ImportReport> {
  if (queries.length === 0) {
    return { status: 'empty', lines_read: 0, lines_imported: 0, lines_skipped: 0, chunks_written: 0, reason: 'no_queries' }
  }
  const lines: CorpusLine[] = []
  for (const query of queries) {
    const fetched = await fetchEpmcArticles(query, options)
    if (fetched.status === 'unavailable') {
      return {
        status: 'unavailable',
        lines_read: lines.length,
        lines_imported: 0,
        lines_skipped: 0,
        chunks_written: 0,
        error: fetched.error,
      }
    }
    if (fetched.status === 'ok') lines.push(...fetched.articles)
  }
  if (lines.length === 0) {
    return { status: 'empty', lines_read: 0, lines_imported: 0, lines_skipped: 0, chunks_written: 0, reason: 'no_open_access_abstracts' }
  }
  return importCorpusLines(sql, embedder, lines, {
    signer: 'none',
    batchSize: options.batchSize,
    concurrency: options.concurrency,
    now: options.now,
    traceId: 'europepmc',
  })
}

function epmcUrl(query: string, pageSize: number, cursor: string): string {
  const q = query.toUpperCase().includes('OPEN_ACCESS:') ? query : `${query} AND OPEN_ACCESS:Y`
  const params = new URLSearchParams({
    query: q,
    format: 'json',
    resultType: 'core',
    pageSize: String(pageSize),
    cursorMark: cursor,
  })
  return `${EPMC_SEARCH}?${params.toString()}`
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
  }
  if (value && typeof value === 'object') return [value as Record<string, unknown>]
  return []
}

function toArticle(row: Record<string, unknown>): CorpusLine | null {
  const licence = stringField(row, 'license') ?? stringField(row, 'licence')
  if (!epmcLicenceAllowed(licence, row.isOpenAccess)) return null
  const text = stringField(row, 'abstractText')
  if (!text) return null
  const id = stringField(row, 'pmcid') ?? stringField(row, 'pmid') ?? stringField(row, 'id') ?? ''
  if (id === '') return null
  const title = stringField(row, 'title') ?? 'Untitled'
  return {
    source: 'europepmc',
    title,
    section: 'Abstract',
    text,
    url: articleUrl(row, id),
    licence_class: 'open',
    external_id: id,
  }
}

function articleUrl(row: Record<string, unknown>, id: string): string {
  const pmcid = stringField(row, 'pmcid')
  if (pmcid) return `https://europepmc.org/article/PMC/${pmcid.replace(/^PMC/i, '')}`
  const pmid = stringField(row, 'pmid')
  if (pmid) return `https://europepmc.org/article/MED/${pmid}`
  return `https://europepmc.org/search?query=${encodeURIComponent(id)}`
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
