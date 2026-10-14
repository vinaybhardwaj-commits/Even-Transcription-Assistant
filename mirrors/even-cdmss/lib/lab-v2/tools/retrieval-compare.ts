/**
 * lib/lab-v2/tools/retrieval-compare.ts — `retrieval_compare` (LAB-MCP-V2-PRD-v1.0 §17.6 item 5).
 *
 * Two candidate configurations, or two corpus snapshots, on the same queries: what each returned at
 * k, how much they overlap, how the ranks correlate, and how long each took.
 *
 * ⚠️ THE CANDIDATE STAGE IS PRODUCTION'S, ASSEMBLED FROM PRODUCTION'S OWN EXPORTS. Every piece of
 * SQL below comes from `lib/retrieve.ts` — `buildFilterClauses`, `renderFilterSql`,
 * `defaultBm25Sql` — and the fusion is `lib/retrieve.ts`'s RRF with its own `RRF_K`. Nothing here
 * re-implements retrieval semantics; if it did, the tool would measure the copy rather than the
 * engine. What this file adds, and the reason it cannot simply call `retrieve()`, is two things
 * `RetrieveOptions` has no switch for: turning the EMBEDDING leg off (it has `hybrid` for bm25 and
 * nothing for the vector side), and pinning a corpus SNAPSHOT by maximum chunk id.
 *
 * ⚠️ NO RERANKER, NO CHAT MODEL, AND ONE EMBEDDING AT MOST PER QUERY. Decision 27's shape:
 * `skipExpand` true, `useReranker` false. The query is embedded ONCE and the same vector is handed
 * to both configurations, which is both cheaper and fairer — a difference between two configs must
 * not be able to come from two embeddings of the same words. A config with `embedding: false` on
 * both sides embeds nothing at all.
 *
 * ⚠️ A SNAPSHOT IS `id <= n`, AND THAT IS AN APPROXIMATION THIS FILE STATES RATHER THAN HIDES.
 * `mksap_chunks.id` is a serial, so a larger id is a later insert — but a chunk edited in place, or
 * one whose `visible` flag was flipped after n, is NOT excluded by an id ceiling. So `id <= n`
 * answers "what the corpus looked like if nothing was edited", which is the honest claim, and it is
 * the claim the output makes.
 */
import { z } from 'zod';
import { LabError } from '../contracts';
import { boundedRead } from '../sources/read';
import { buildFilterClauses, defaultBm25Sql, renderFilterSql, RRF_K } from '../../retrieve';
import { embedQuery, vectorLiteral } from '../../llm';

export const RETRIEVAL_COMPARE_SCHEMAS = {
  retrieval_compare: {
    input: z.object({
      queries: z.array(z.string().min(3).max(2000)).min(1).max(20),
      k: z.number().int().min(1).max(50).default(10),
      a: z.object({
        label: z.string().max(60).optional(),
        bm25: z.boolean().default(true),
        embedding: z.boolean().default(true),
        /** Corpus snapshot: only chunks with `id <= max_chunk_id`. See the header's caveat. */
        max_chunk_id: z.number().int().positive().optional(),
      }),
      b: z.object({
        label: z.string().max(60).optional(),
        bm25: z.boolean().default(true),
        embedding: z.boolean().default(true),
        max_chunk_id: z.number().int().positive().optional(),
      }),
    }),
    output: z.object({
      k: z.number().int(),
      /** Zero, structurally: no chat model and no reranker is reachable from this tool. */
      model_calls: z.number().int(),
      /** How many times a query was embedded — 0 when neither config uses the vector leg. */
      embeddings: z.number().int(),
      snapshot_caveat: z.string(),
      config_a: z.record(z.unknown()),
      config_b: z.record(z.unknown()),
      totals: z.object({
        queries: z.number().int(),
        /**
         * DECISION 96 — TWO TOTALS, BECAUSE THERE WERE ALWAYS TWO UNITS.
         *
         * ⚠️ `mean_overlap_at_k` USED TO CARRY A PERCENT. Decision 76 reported it as an arithmetic
         * fault; decision 96 measured that it was a UNITS fault: the field was the mean of
         * `per_query.overlap_pct` under the name of a count. On the live three-query verification
         * that read 6.67 — a plausible-looking number that a reader would take as "0.67 of ten
         * results shared, roughly", when the per-query counts were 0, 0 and 2 and the mean count is
         * 0.67. The percent was never wrong; its name was.
         *
         * ⚠️ AND NOTHING IS RE-MEANED UNDER AN OLD NAME. `mean_overlap_pct` is the SAME computation
         * this field always performed, moved to the name that describes it. `mean_overlap_at_k` is a
         * new mean over `per_query.overlap_at_k`. A reader who had pinned the old field to a number
         * finds that number under `mean_overlap_pct`, unchanged.
         */
        mean_overlap_at_k: z.number().nullable(),
        mean_overlap_pct: z.number().nullable(),
        mean_rank_correlation: z.number().nullable(),
        ms_a: z.number().int(),
        ms_b: z.number().int(),
      }),
      per_query: z.array(z.object({
        query_hash: z.string(),
        ids_a: z.array(z.number().int()),
        ids_b: z.array(z.number().int()),
        overlap_at_k: z.number().int(),
        overlap_pct: z.number().nullable(),
        /** Spearman over the ids present in BOTH lists; null under two shared ids. */
        rank_correlation: z.number().nullable(),
        only_in_a: z.array(z.number().int()),
        only_in_b: z.array(z.number().int()),
        ms_a: z.number().int(),
        ms_b: z.number().int(),
      })),
    }),
  },
} as const;

export const SNAPSHOT_CAVEAT =
  'A corpus snapshot is `mksap_chunks.id <= max_chunk_id`. The id is a serial, so this excludes '
  + 'every chunk INSERTED after that point — it does not exclude a chunk edited in place, or one '
  + 'whose visibility changed afterwards. Read it as "the corpus at that size", not "the corpus as '
  + 'it was on that date".';

export interface CandidateConfig { label?: string; bm25: boolean; embedding: boolean; max_chunk_id?: number }

/** A hostile `max_chunk_id` can never reach a statement: it is an integer or it is refused. */
function snapshotClause(maxChunkId: number | undefined): string {
  if (maxChunkId == null) return '';
  // REFUSED, not floored. 1.5 is a caller's bug, and snapping it to 1 would silently compare
  // against a corpus of one chunk while the response reported a snapshot the caller recognises.
  if (!Number.isSafeInteger(maxChunkId) || maxChunkId <= 0) {
    throw new LabError('INVALID_INPUT', 'max_chunk_id must be a positive integer');
  }
  return ` AND id <= ${maxChunkId}`;
}

/**
 * The VECTOR leg, byte-identical to `lib/retrieve.ts`'s except for the snapshot clause. The filter
 * clauses come from production's own builder, so the quarantine guards cannot drift.
 */
export function vectorLegSql(pool: number, maxChunkId?: number): { sql: string; params: unknown[] } {
  const { clauses, params } = buildFilterClauses({});
  const filterSql = renderFilterSql(clauses, 3);
  return {
    sql: `SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $1::vector) AS rank
FROM mksap_chunks
WHERE 1 - (embedding <=> $1::vector) > $2
  AND embedding IS NOT NULL
  AND ${filterSql}${snapshotClause(maxChunkId)}
ORDER BY embedding <=> $1::vector
LIMIT ${Math.floor(pool)}`,
    params,
  };
}

/** The BM25 leg — `defaultBm25Sql` verbatim, with the snapshot clause appended to its filter. */
export function bm25LegSql(pool: number, maxChunkId?: number): { sql: string; params: unknown[] } {
  const { clauses, params } = buildFilterClauses({});
  const filterSql = `${renderFilterSql(clauses, 2)}${snapshotClause(maxChunkId)}`;
  return { sql: defaultBm25Sql(filterSql, Math.floor(pool)), params };
}

/** Reciprocal rank fusion, with production's own constant. */
export function fuse(legs: { id: number; rank: number }[][], k: number): number[] {
  const score = new Map<number, number>();
  for (const leg of legs) {
    for (const r of leg) score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank)));
  }
  return [...score.entries()]
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, k)
    .map(([id]) => id);
}

/**
 * Spearman's rank correlation over the ids present in BOTH lists.
 *
 * Null under three shared ids, because a correlation computed on two points is not a correlation —
 * and reporting 1.0 for "they both returned the same two chunks" would be the kind of number that
 * gets quoted.
 *
 * ⚠️ DECISION 98 — THE RANKS ARE THE SHARED IDS' RANKS AMONG THEMSELVES, AND THEY HAVE TO BE.
 *
 * As first written this took `ra` and `rb` from each id's position in the FULL top-k list, 0..k−1,
 * while `n` was the count of SHARED ids. Spearman's `1 − 6Σd²/(n(n²−1))` is derived on the
 * assumption that both rankings are permutations of the same 1..n; with k = 10 and n = 5 the
 * numerator ranges over positions up to 9 while the denominator is 120, and the formula simply
 * stops being bounded. Production returned **−3.35, −1.75 and −0.971, mean −2.02** on three prose
 * queries — numbers outside [−1, 1] that a reader would take as "strongly anticorrelated" when the
 * true values are 0, 0.4 and 0.429, i.e. mildly POSITIVE. The sign was wrong, not just the scale.
 *
 * So the shared ids are ranked 0..n−1 by their order in `a`, and again 0..n−1 by their order in
 * `b`, and the same formula is applied to those. Both rankings are then permutations of the same
 * n values, which is the condition the formula was always asking for.
 *
 * ⚠️ AND THE UNSHARED IDS ARE NOT PENALISED HERE, DELIBERATELY. How much the two lists overlap is
 * `overlap_at_k` and `overlap_pct`; this number answers a different question — of the chunks both
 * configurations found, do they agree on the ORDER. Folding disagreement about membership into a
 * correlation about ordering is exactly the conflation that produced −3.35.
 *
 * `fuse` returns each id once, so `a` and `b` carry no duplicates; the `seen` guard keeps that an
 * invariant of this function rather than an assumption about its caller.
 */
export function rankCorrelation(a: number[], b: number[]): number | null {
  const posB = new Map(b.map((id, i) => [id, i]));
  const seen = new Set<number>();
  const shared: number[] = [];
  for (const id of a) {
    if (posB.has(id) && !seen.has(id)) { seen.add(id); shared.push(id); }
  }
  const n = shared.length;
  if (n < 3) return null;
  // 0..n−1 by a's order, which `shared` is already in; then 0..n−1 by b's order.
  const rankInA = new Map(shared.map((id, i) => [id, i]));
  const rankInB = new Map([...shared]
    .sort((x, y) => (posB.get(x) as number) - (posB.get(y) as number))
    .map((id, i) => [id, i]));
  let d2 = 0;
  for (const id of shared) d2 += ((rankInA.get(id) as number) - (rankInB.get(id) as number)) ** 2;
  const rho = 1 - (6 * d2) / (n * (n * n - 1));
  return Math.round(rho * 1000) / 1000;
}

export interface RetrievalCompareDeps {
  /** Injection seam (repo idiom). Production passes nothing. */
  embed?: (text: string) => Promise<number[]>;
  read?: (source: string, statement: string, params: unknown[]) => Promise<{ id: unknown; rank: unknown }[]>;
}

/**
 * §17.6 DECISION 72 — COERCED AT THE READ BOUNDARY, and this is where it belongs.
 *
 * ⚠️ `ROW_NUMBER()` IS `bigint`, AND THE DRIVER HANDS BACK A STRING. Postgres returns bigint and
 * numeric as strings because they do not all fit in a double, and the node driver passes that
 * through faithfully. `retrieval_compare` then failed its OWN output schema with
 * "Expected number, received string" — the validator doing exactly its job, on a shape the tool
 * had never converted. Coercing here means every consumer downstream (the fusion, the overlap,
 * the correlation, the response) sees numbers, and only ONE place has to know that a column came
 * off the wire as text.
 */
export function coerceRankRows(rows: { id: unknown; rank: unknown }[]): { id: number; rank: number }[] {
  // ⚠️ `Number(null)` IS 0, AND `Number('')` IS 0. A null rank is not rank 0 — it is a row that
  // came back wrong — so absence is rejected BEFORE the conversion rather than converted into a
  // number that would sort first and win the fusion.
  const num = (v: unknown): number => (v == null || v === '' ? NaN : Number(v));
  return rows
    .map((r) => ({ id: num(r.id), rank: num(r.rank) }))
    // A row whose id or rank will not parse is dropped rather than carried as NaN: NaN sorts
    // unpredictably and would corrupt the fusion silently.
    .filter((r) => Number.isFinite(r.id) && Number.isFinite(r.rank));
}

const liveRead = async (source: string, statement: string, params: unknown[]) =>
  coerceRankRows(await boundedRead<{ id: unknown; rank: unknown }>(source, statement, params, 500));

export async function retrievalCompare(
  args: { queries: string[]; k?: number; a: CandidateConfig; b: CandidateConfig },
  deps: RetrievalCompareDeps = {},
) {
  const embed = deps.embed ?? embedQuery;
  const read = deps.read ?? liveRead;
  const k = Math.floor(args.k ?? 10);
  const configs = [args.a, args.b];
  for (const c of configs) {
    if (!c.bm25 && !c.embedding) {
      throw new LabError('INVALID_INPUT', 'a configuration with neither bm25 nor embedding retrieves nothing');
    }
  }
  // The same pool arithmetic production uses when the reranker is off.
  const pool = Math.max(40, k * 5);
  const needsVector = configs.some((c) => c.embedding);

  let embeddings = 0;
  const per_query: Record<string, unknown>[] = [];
  let msA = 0;
  let msB = 0;
  const overlaps: number[] = [];
  /** DECISION 96 — the counts, kept alongside the percents rather than derived from them. */
  const overlapCounts: number[] = [];
  const correlations: number[] = [];

  for (const query of args.queries) {
    // ONE embedding per query, shared by both configurations — see the header.
    let vlit: string | null = null;
    if (needsVector) {
      embeddings += 1;
      vlit = vectorLiteral(await embed(query));
    }

    const runConfig = async (c: CandidateConfig): Promise<{ ids: number[]; ms: number }> => {
      const started = Date.now();
      const legs: { id: number; rank: number }[][] = [];
      // ⚠️ COERCED AGAIN AROUND AN INJECTED READ. `deps.read` is a test seam, and a test that
      // supplies string-shaped rows — which is what production actually returns — must exercise
      // the same conversion the live path does, or the seam would hide the bug it exists to test.
      if (c.embedding && vlit) {
        const leg = vectorLegSql(pool, c.max_chunk_id);
        legs.push(coerceRankRows(await read('mksap_chunks', leg.sql, [vlit, 0.3, ...leg.params]).catch(() => [])));
      }
      if (c.bm25) {
        const leg = bm25LegSql(pool, c.max_chunk_id);
        legs.push(coerceRankRows(await read('mksap_chunks', leg.sql, [query, ...leg.params]).catch(() => [])));
      }
      return { ids: fuse(legs, k), ms: Date.now() - started };
    };

    const [ra, rb] = [await runConfig(args.a), await runConfig(args.b)];
    msA += ra.ms;
    msB += rb.ms;
    const setB = new Set(rb.ids);
    const shared = ra.ids.filter((id) => setB.has(id));
    const denom = Math.max(ra.ids.length, rb.ids.length);
    const overlapPct = denom > 0 ? Math.round((100 * shared.length) / denom) : null;
    const rho = rankCorrelation(ra.ids, rb.ids);
    // DECISION 96 — both accumulators are gated on the SAME condition, so the two totals are means
    // over the same set of queries. A query with no candidates on either side has no denominator and
    // therefore no overlap to report in either unit; counting a 0 for it in one total and not the
    // other would make the two numbers describe different things.
    if (overlapPct != null) { overlaps.push(overlapPct); overlapCounts.push(shared.length); }
    if (rho != null) correlations.push(rho);
    per_query.push({
      // The query TEXT is not returned: a caller supplied it and knows it, and a clinical query is
      // free text this platform does not need to echo into a stored report.
      query_hash: hashOf(query),
      ids_a: ra.ids,
      ids_b: rb.ids,
      overlap_at_k: shared.length,
      overlap_pct: overlapPct,
      rank_correlation: rho,
      only_in_a: ra.ids.filter((id) => !setB.has(id)),
      only_in_b: rb.ids.filter((id) => !new Set(ra.ids).has(id)),
      ms_a: Math.round(ra.ms),
      ms_b: Math.round(rb.ms),
    });
  }

  const mean = (xs: number[]): number | null => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

  return {
    k,
    // Structural, not observed: nothing in this module can reach `governedChat` or a reranker.
    model_calls: 0,
    embeddings,
    snapshot_caveat: SNAPSHOT_CAVEAT,
    config_a: { ...args.a } as Record<string, unknown>,
    config_b: { ...args.b } as Record<string, unknown>,
    totals: {
      queries: args.queries.length,
      // DECISION 96. `mean` already rounds to two decimals and returns null on an empty list, which
      // is exactly "null when no query produced a denominator".
      mean_overlap_at_k: mean(overlapCounts),
      mean_overlap_pct: mean(overlaps),
      mean_rank_correlation: mean(correlations),
      ms_a: Math.round(msA),
      ms_b: Math.round(msB),
    },
    per_query,
  };
}

function hashOf(v: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('crypto') as typeof import('crypto')).createHash('sha256').update(v).digest('hex');
}
