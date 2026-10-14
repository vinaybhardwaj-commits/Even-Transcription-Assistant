/**
 * lib/lab-v2/sources/corpus.ts — read-only access to `mksap_chunks` (§17.2, decision 31).
 *
 * ⚠️ CORPUS SEARCH USES THE RETRIEVAL BM25 INDEX, NEVER `ILIKE`. Round A2 shipped
 * `text ILIKE '%…%'`, which is a full scan of the corpus and cannot use an index: on a five-word
 * query it ran past Vercel's 60 s box and returned 504 twice on 05 Sep 2026. The corpus already
 * has the right instrument — `mksap_chunks_tsv_idx`, a GIN index on `text_tsv`, which is what the
 * retrieval BM25 pool uses. This file now issues the SAME predicate through the SAME exported
 * builder, `defaultBm25Sql` from lib/retrieve.ts, so the lab searches the corpus the way
 * production searches it and the two cannot drift.
 *
 * ⚠️ "ACTIVE" IS NOT A COLUMN. `mksap_chunks` has no `active` field — confirmed live against
 * production Neon on 05 Sep 2026 (23 columns; the flag is `visible boolean`). Production's own
 * definition of a chunk retrieval may serve is the clause list at lib/retrieve.ts:167:
 *
 *     text IS NOT NULL · visible IS NOT FALSE · source NOT LIKE 'labq:%'
 *
 * Reproduced verbatim rather than re-invented, because the `labq:` prefix is the corpus quarantine
 * (lib/lab.ts CORPUS_QUARANTINE_INSERT_SQL inserts `visible false` AND a `labq:` source) and a lab
 * tool that reported a quarantined chunk as active would misdescribe the corpus the audits were
 * actually run against.
 *
 * Every statement here is INFERRED and listed verbatim in the build report. Column names and the
 * index name were confirmed live. Reads go through the v1 read-only guard and the 15 s deadline in
 * ./read.ts.
 */
import { defaultBm25Sql } from '../../retrieve';
import { LabError } from '../contracts';
import { boundedRead } from './read';

const SOURCE = 'mksap_chunks';

/** Production's active predicate, from lib/retrieve.ts:167. */
export const ACTIVE_PREDICATE = `text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'`;

/** The projection every corpus read shares. `preview` is a bounded excerpt, never a whole chunk. */
const CHUNK_COLUMNS =
  `id, book, chapter, source, ` +
  `(text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%') AS active, ` +
  `left(text, 400) AS preview`;

/** The same projection, qualified, for the join back from the ranked id set. */
const CHUNK_COLUMNS_C =
  `c.id, c.book, c.chapter, c.source, ` +
  `(c.text IS NOT NULL AND c.visible IS NOT FALSE AND c.source NOT LIKE 'labq:%') AS active, ` +
  `left(c.text, 400) AS preview`;

export interface ChunkRow {
  id: string | number; book: string | null; chapter: string | null; source: string | null;
  active: boolean; preview: string | null;
}

function litInts(ids: number[]): string {
  const clean = ids.map((n) => Math.trunc(Number(n))).filter((n) => Number.isFinite(n));
  if (!clean.length) throw new LabError('INVALID_INPUT', 'at least one citation id is required');
  return clean.join(', ');
}

export function buildChunksByIdSql(ids: number[]): string {
  return `SELECT ${CHUNK_COLUMNS} FROM mksap_chunks WHERE id IN (${litInts(ids)}) LIMIT 200`;
}

/** Resolve citation ids. Callers report ids that came back with no row as UNRESOLVED (§17.2). */
export async function chunksById(ids: number[]): Promise<ChunkRow[]> {
  if (!ids.length) return [];
  return boundedRead<ChunkRow>(SOURCE, buildChunksByIdSql(ids));
}

export interface CorpusSearchInput { text: string; book?: string; source?: string; active?: boolean; limit: number }

/**
 * The filter the BM25 leg is given, in `defaultBm25Sql`'s own `bm25FilterSQL` slot. Bind
 * parameters start at `$2` because `$1` is the query text, exactly as lib/retrieve.ts orders them
 * (`renderFilterSql(filterClauses, 2)`).
 *
 * The active filter is a PREDICATE here, not a post-filter: `active: true` narrows the indexed
 * scan, and `active: false` is the only way to see quarantined material at all. With `active`
 * omitted, both are searched — which is what a corpus tool should do by default.
 */
export function buildCorpusFilterSql(i: CorpusSearchInput): { filter: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (i.book) { params.push(i.book); clauses.push(`book = $${params.length + 1}`); }
  if (i.source) { params.push(i.source); clauses.push(`source = $${params.length + 1}`); }
  if (i.active === true) clauses.push(`(${ACTIVE_PREDICATE})`);
  if (i.active === false) clauses.push(`NOT (${ACTIVE_PREDICATE})`);
  return { filter: clauses.length ? clauses.join(' AND ') : 'TRUE', params };
}

/**
 * DECISION 31 — the lexical search, on the index.
 *
 * `defaultBm25Sql` is lib/retrieve.ts's own exported, pure BM25 template (line 271). It is
 * imported, not copied: the predicate `text_tsv @@ plainto_tsquery('english', $1)` is what hits
 * `mksap_chunks_tsv_idx`, and reusing the builder means a change to production's lexical stage
 * reaches this tool too. The ranked id set is joined back for the projection so the tool can
 * return the chunk fields §17.2 asks for while the ranking stays production's.
 */
export function buildCorpusSearchSql(i: CorpusSearchInput): string {
  const { filter } = buildCorpusFilterSql(i);
  const limit = Math.trunc(i.limit);
  return `WITH ranked AS (${defaultBm25Sql(filter, limit)}) ` +
    `SELECT ${CHUNK_COLUMNS_C} FROM mksap_chunks c JOIN ranked r ON r.id = c.id ` +
    `ORDER BY r.rank LIMIT ${limit}`;
}

export async function corpusSearch(i: CorpusSearchInput): Promise<ChunkRow[]> {
  if (!i.text.trim()) throw new LabError('INVALID_INPUT', 'text is required');
  const { params } = buildCorpusFilterSql(i);
  // $1 is the query text; the filter's own binds follow, exactly as the retrieval leg orders them.
  return boundedRead<ChunkRow>(SOURCE, buildCorpusSearchSql(i), [i.text, ...params]);
}

/** The quarantine prefix carried on a `labq:` source, or null. Display only. */
export function quarantinePrefix(source: string | null): string | null {
  return source && source.startsWith('labq:') ? 'labq:' : null;
}
