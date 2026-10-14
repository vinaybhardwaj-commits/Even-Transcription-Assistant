import { sql } from './db';
import { embedQuery, embedQueryV2, vectorLiteral, TOP_K, USE_EMBEDDING_V2 } from './llm';
import { expandQuery } from './expand';
import { rerank } from './rerank';
import { computeSourceQualityWeight } from './source-quality';
// F16 (decision 14): lab-ingested sources may not outrank the best curated source until a batch has
// passed an activation A/B. Pure clamp, shared with the Lab MCP so one rule governs both.
import { clampSourceWeight } from './lvc-proposal-core';
import { labLabel } from './lab-core';
import type { ChunkHit } from './db';

export type RetrieveOptions = {
  topK?: number;
  bookFilter?: string;
  chunkType?: 'narrative' | 'explanation';
  source?: string;
  minSimilarity?: number;
  skipExpand?: boolean;
  hybrid?: boolean;
  bm25Query?: string;

  /** v1.6: use embedding_v2 column (mxbai-embed-large, 1024-dim).
   *  Default = global USE_EMBEDDING_V2 env. */
  useEmbeddingV2?: boolean;

  /** Even-LVC grounding worker (CDMSS-EVEN-LVC-GROUNDING-WORKER §5): a PRECOMPUTED query embedding
   *  (nomic, same dim as `embedding`) to use INSTEAD of embedding the query text this call — the worker
   *  caches finding embeddings in finding_embeddings and reuses them across sweeps. Omitted ⇒ today's
   *  behaviour byte-identical (embed the (expanded) query text). Must be nomic-dim; only supplied on the
   *  skipExpand, non-v2 grounding path, so it never collides with expansion/v2. */
  queryEmbedding?: number[];

  /** v1.6: enable cross-encoder reranker on the candidate pool. */
  useReranker?: boolean;

  /** Lab measurement only: override the rerank backend for this call ('cohere' = deterministic
   *  OpenRouter Cohere rerank-v3.5 ruler, health-probed; 'judge' = LLM judge). Omitted ⇒ the env
   *  default (production stays 'judge'). Never set by a production caller. */
  rerankBackend?: 'judge' | 'cohere';

  /** R-11: opt-in NORMATIVE retrieval leg. When true, a third vector leg restricted to the
   *  normative sources (default ['choosing-wisely'], see normativeSources) joins the RRF union,
   *  so a terse normative statement competes for a pool seat instead of being outranked by dense
   *  literature. OFF by default ⇒ SQL + fusion byte-identical. Enabled only on NON-scoring surfaces
   *  (Stage 1); the audit citation path never sets it. */
  useNormativeLeg?: boolean;
  /** R-11: the source allowlist for the normative leg (default ['choosing-wisely']; never labq:% by
   *  default). Bound as an array param via the shipped restrictSources shape. */
  normativeSources?: string[];

  /** v1.6: multiply final score by source_quality_weight per chunk. */
  useSourceWeights?: boolean;

  /** Lab measurement only: include ONE named quarantined batch (label without the `labq:` prefix).
   *  Omitted ⇒ today's behaviour exactly. Never set by production callers. */
  includeQuarantined?: string;

  /** Lab measurement only: restrict BOTH legs to `source = ANY(these)` — a dedicated normative-source
   *  leg (e.g. ['choosing-wisely','labq:guidelines-lvc-22jul']). NAMED labq: sources are admitted
   *  through the quarantine guard; un-named ones stay excluded. Omitted/empty ⇒ today's behaviour,
   *  byte-identical. Never set by production callers. */
  restrictSources?: string[];

  /** Lab measurement only: force per-stage diagnostics (vector_rank/bm25_rank/rrf_score/final_rank)
   *  onto the returned hits even without includeQuarantined (R-5). Never set by production callers. */
  withDiagnostics?: boolean;

  /** Lab measurement only (R-2 Stage 1). When set, the BM25 leg keeps only lexemes whose corpus
   *  document frequency (planner estimate) is ≤ dfMax, OR-joins them, and caps the ranked scan.
   *  Omitted ⇒ today's plainto-AND behaviour, byte-identical. NEVER set by a production caller. */
  bm25Mode?: { strategy: 'discriminating'; dfMax: number };
};

export type ChunkHitWithMeta = ChunkHit & {
  source_quality_weight?: number;
  rerank_score?: number;
  rerank_backend?: 'judge' | 'cohere' | 'none';

  // Per-stage diagnostics — populated ONLY on the lab measurement path (includeQuarantined set),
  // so production result shapes are untouched. See §3.2 of the lab-retrieve-seam PRD.
  vector_rank?: number | null;   // rank in the vector leg, null if absent
  bm25_rank?: number | null;     // rank in the BM25 leg, null if absent
  normative_rank?: number | null;// rank in the normative leg (R-11), null if absent / leg off
  rrf_score?: number;            // fused RRF score
  final_rank?: number;           // 1-based position in the returned list
};

export type RetrieveResult = {
  hits: ChunkHitWithMeta[];
  expandedQuery: string;
  meta?: {
    vector_pool: number;
    bm25_pool: number;
    fused: number;
    bm25_query?: string;
    pool_size?: number;
    reranked?: boolean;
    source_weighted?: boolean;
    embedding_column?: 'embedding' | 'embedding_v2';

    // Lab-only BM25 discriminating-mode diagnostics (R-2 Stage 1) — present only when bm25Mode is set.
    bm25_mode?: 'discriminating';
    bm25_tsquery?: string;                                          // the OR-joined discriminating tsquery actually run
    bm25_terms?: { lexeme: string; df: number; kept: boolean }[];  // per-lexeme DF estimate + keep decision

    // R-11 normative leg — present only when useNormativeLeg is set.
    normative_pool?: number;         // rows the normative leg contributed to the union
    normative_sources?: string[];    // the source allowlist actually used
  };
};

// Reciprocal Rank Fusion. Exported so multi-query fusion reuses the SAME constant (do not redeclare).
export const RRF_K = 60;

// ── R-6 guard: USE_EMBEDDING_V2 latent failure ───────────────────────────────────
// USE_EMBEDDING_V2 is hardcoded false and no `embedding_v2` column exists. If that flag is ever
// flipped while the column is absent, the vector leg's SQL throws and is swallowed by the leg's
// `.catch(() => [])`, serving a SILENTLY-EMPTY vector leg. This guard makes that failure LOUD.
export class EmbeddingV2ColumnMissingError extends Error {
  constructor() {
    super('retrieve: USE_EMBEDDING_V2 is enabled but mksap_chunks.embedding_v2 is absent — refusing to query a silently-empty vector leg (R-6)');
    this.name = 'EmbeddingV2ColumnMissingError';
  }
}

/** Pure decision half of the R-6 guard (unit-testable). Throws iff v2 is requested but the column is absent. */
export function assertEmbeddingV2Available(useV2: boolean, columnExists: boolean): void {
  if (useV2 && !columnExists) throw new EmbeddingV2ColumnMissingError();
}

/** Column-existence probe for the R-6 guard. INFERRED SQL — reported verbatim for orchestrator validation. */
async function embeddingV2ColumnExists(): Promise<boolean> {
  const rows = await (sql as unknown as (q: string, p: unknown[]) => Promise<unknown[]>)(
    `SELECT 1 FROM information_schema.columns WHERE table_name = 'mksap_chunks' AND column_name = 'embedding_v2' LIMIT 1`,
    [],
  );
  return rows.length > 0;
}

// ── quarantine filter seam (pure, unit-testable) ─────────────────────────────────
// The three constant guards, plus the opt-in structural filters (book/chunk_type/source).
// Clauses carry `$FP_n` placeholders that each leg remaps to its own positional base.
export type FilterClauseOpts = {
  includeQuarantined?: string;   // lab-only: relax the quarantine guards for ONE named batch
  restrictSources?: string[];    // lab-only: restrict BOTH legs to source = ANY(these) — admits NAMED labq: sources
  bookFilter?: string;
  chunkType?: string;
  source?: string;
};

/**
 * Build the retrieval WHERE-filter clause array and its bound params, in order.
 *
 * INVARIANT (load-bearing): with `includeQuarantined` omitted/empty the returned clauses are
 * EXACTLY `['text IS NOT NULL', 'visible IS NOT FALSE', "source NOT LIKE 'labq:%'"]` (plus any
 * structural filters) and no quarantine param is added — so the SQL retrieve() emits is
 * byte-identical to production for every real caller.
 *
 * When set, BOTH quarantine guards relax for that ONE label via a BOUND parameter (`labq:<slug>`),
 * never interpolated. The label is slugged with the shared `labLabel` helper, so a hostile value
 * can never widen the filter beyond a single batch.
 */
export function buildFilterClauses(opts: FilterClauseOpts): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [`text IS NOT NULL`, `visible IS NOT FALSE`, `source NOT LIKE 'labq:%'`];
  const params: unknown[] = [];
  let fp = 0;

  // Fail-safe: only genuine non-blank string sources restrict. An empty/all-blank array ⇒ fall
  // through to today's behaviour (never an empty-everything filter).
  const restrict = Array.isArray(opts.restrictSources)
    ? opts.restrictSources.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
    : [];

  if (restrict.length) {
    // Lab-only multi-source restrict: BOTH legs match ONLY the named sources, via one BOUND array
    // param (never interpolated). A NAMED labq: source is admitted (source = ANY includes it, and the
    // visible guard is relaxed the same way includeQuarantined relaxes it); an UN-named labq: source
    // is not in the array, so `source = ANY(...)` excludes it — same "name it to include it" model.
    const idx = fp++;
    params.push(restrict);
    clauses[1] = `(visible IS NOT FALSE OR source = ANY($FP_${idx}))`;
    clauses[2] = `source = ANY($FP_${idx})`;
  } else {
    // Fail-safe (PRD §8.1): only a NON-blank label relaxes the guard. Empty/whitespace ⇒ fall through
    // to today's exact behaviour rather than let labLabel('   ') → 'default' silently widen the filter.
    const raw = (opts.includeQuarantined ?? '').trim();
    const label = raw ? labLabel(raw) : '';
    if (label) {
      const idx = fp++;                       // this batch's param slot ($FP_idx), reused in BOTH relaxed clauses
      params.push(`labq:${label}`);
      clauses[1] = `(visible IS NOT FALSE OR source = $FP_${idx})`;
      clauses[2] = `(source NOT LIKE 'labq:%' OR source = $FP_${idx})`;
    }
  }

  if (opts.bookFilter) { clauses.push(`book = $FP_${fp++}`); params.push(opts.bookFilter); }
  if (opts.chunkType)  { clauses.push(`chunk_type = $FP_${fp++}`); params.push(opts.chunkType); }
  // The single-source filter is redundant with (and would conflict with) a multi-source restrict.
  if (opts.source && !restrict.length) { clauses.push(`source = $FP_${fp++}`); params.push(opts.source); }

  return { clauses, params };
}

/** Remap `$FP_n` placeholders to real positional params for one leg. `base` = the position of the
 *  first filter param (vector leg = 3, BM25 leg = 2). Pure string transform. */
export function renderFilterSql(clauses: string[], base: number): string {
  return clauses.map((c) => c.replace(/\$FP_(\d+)/g, (_m, n) => `$${base + Number(n)}`)).join(' AND ');
}

/** Clamp a lab_retrieve topK request to [1, 20], defaulting to the served k (8). Pure. */
export function clampLabRetrieveTopK(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 8;
  return Math.min(20, n);
}

// ── BM25 leg builders (R-2 Stage 1 — lab measurement only) ───────────────────────
// The naive OR-of-all-terms scores millions of rows and takes >180s (measured). The discriminating
// leg keeps only low-DF (rare, discriminating) lexemes and caps the ranked candidate set. All the
// SQL here is INFERRED against the live corpus schema and reported verbatim for validation.

/** Cap on the ranked candidate set for the discriminating leg — ts_rank_cd never scores more than
 *  this many rows, so the leg cannot time out. Measured: OR-all-11-terms capped here = ~5s, vs >180s uncapped. */
export const BM25_DISCRIMINATING_CAP = 5000;

/** Default dfMax the lab tool uses when the caller gives none: the rare-term planner floor is ~11,204
 *  (0.5% default selectivity) and the lowest common stem measured is ~46,685, so 30,000 cleanly
 *  separates them. Stage 2 sweeps this (D2); it is not a tuned production constant. */
export const BM25_DEFAULT_DFMAX = 30000;

/** Lexemes that are safe to OR into a to_tsquery — alphanumeric stems only. Hyphenated/compound
 *  stems (e.g. `co-prescrib`) are dropped to avoid tsquery syntax errors; they decompose into
 *  common parts (`co`, `prescrib`) the DF cut drops anyway. */
const SAFE_LEXEME_RE = /^[a-z0-9]+$/i;

/** Parse a tsquery `::text` (e.g. `'antihistamin' & 'montelukast' & 'co-prescrib'`) into bare lexemes. Pure. */
export function parseTsqueryLexemes(tsqueryText: string): string[] {
  if (!tsqueryText) return [];
  return tsqueryText
    .split(/\s*[&|]\s*/)
    .map((t) => t.trim().replace(/^!+/, '').replace(/^\(+/, '').replace(/\)+$/, ''))
    .map((t) => t.replace(/^'(.*)'(?::[*\d]+)?$/, '$1'))   // strip quotes + any weight/prefix marker
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Keep the DISCRIMINATING lexemes: DF ≤ dfMax AND safe-to-OR (alphanumeric). Deduped, lowercased. Pure. */
export function selectDiscriminatingLexemes(terms: { lexeme: string; df: number }[], dfMax: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { lexeme, df } of terms) {
    if (!(df <= dfMax)) continue;                 // too common (or unknown df) — drop
    if (!SAFE_LEXEME_RE.test(lexeme)) continue;   // non-alphanumeric stem — drop (tsquery-syntax safety)
    const lx = lexeme.toLowerCase();
    if (seen.has(lx)) continue;
    seen.add(lx);
    out.push(lx);
  }
  return out;
}

/** OR-join lexemes into a to_tsquery input string (`'a | b'`). Empty ⇒ '' (⇒ no BM25 leg). Pure. */
export function orJoinLexemes(lexemes: string[]): string {
  return lexemes.join(' | ');
}

/** DEFAULT (production) BM25 SQL — byte-identical to today's inline template. Pure. */
export function defaultBm25Sql(bm25FilterSQL: string, pool: number): string {
  return `
    SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) DESC) AS rank
    FROM mksap_chunks
    WHERE text_tsv @@ plainto_tsquery('english', $1)
      AND ${bm25FilterSQL}
    ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) DESC
    LIMIT ${pool}
  `;
}

/** DISCRIMINATING BM25 SQL — caps the candidate set BEFORE ranking (LIMIT on a pre-ranked CTE) so
 *  ts_rank_cd cannot score more than `capN` rows. $1 = the OR-joined discriminating tsquery. Pure. */
export function discriminatingBm25Sql(bm25FilterSQL: string, pool: number, capN: number): string {
  return `
    WITH cand AS (
      SELECT id, text_tsv
      FROM mksap_chunks
      WHERE text_tsv @@ to_tsquery('english', $1)
        AND ${bm25FilterSQL}
      LIMIT ${capN}
    )
    SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(text_tsv, to_tsquery('english', $1)) DESC) AS rank
    FROM cand
    ORDER BY ts_rank_cd(text_tsv, to_tsquery('english', $1)) DESC
    LIMIT ${pool}
  `;
}

/** The plainto-lexeme extraction SQL — INFERRED, reported verbatim. $1 = the BM25 query text. */
export function plaintoLexemesSql(): string {
  return `SELECT plainto_tsquery('english', $1)::text AS q`;
}

/** The BOUNDED DF-estimate SQL (D6): the PLANNER'S row estimate via EXPLAIN — no execution, no scan,
 *  no COUNT over 2.2M rows. $1 = a single lexeme. INFERRED, reported verbatim. */
export function dfEstimateSql(): string {
  return `EXPLAIN (FORMAT JSON) SELECT 1 FROM mksap_chunks WHERE text_tsv @@ to_tsquery('english', $1)`;
}

// ── normative retrieval leg (R-11) ───────────────────────────────────────────────
/** Production-visible normative sources the leg reads by default. Quarantined labq:% is NEVER here. */
// The two guideline sources use their ACTIVATED (lab:) keys. While they remain quarantined (labq:…)
// these keys match ZERO rows, so the leg's `source = ANY(...)` returns exactly the choosing-wisely
// set — byte-identical to before. They go live only when V runs corpus_manage activate (labq:→lab:).
export const DEFAULT_NORMATIVE_SOURCES = ['choosing-wisely', 'lab:guidelines-even-protocols', 'lab:guidelines-icmr-amr-2019'];

/** Resolve the normative-leg source allowlist. An explicit list (lab measurement) is used as-is —
 *  that is the "name it to include it" affordance, and it may name an activated lab: (or, for the
 *  lab, a labq:) source. The DEFAULT is choosing-wisely plus any env-configured ACTIVATED lab:
 *  sources, with labq:% stripped so quarantined content is never served by default. Pure. */
export function resolveNormativeSources(explicit: string[] | undefined, env: string | undefined): string[] {
  const clean = (arr: string[]) => arr.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim());
  if (explicit && clean(explicit).length) return clean(explicit);
  const envSrcs = clean((env ?? '').split(',')).filter((s) => !s.startsWith('labq:'));   // never quarantined by default
  return [...DEFAULT_NORMATIVE_SOURCES, ...envSrcs];
}

/** N_norm — how many normative candidates the leg contributes. From env NORMATIVE_LEG_K, default 5. Pure. */
export function normativeLegK(rawEnv: string | undefined): number {
  const n = Number(rawEnv);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
}

/** The normative leg SQL — the SAME vector query as the main leg, filtered to the normative sources
 *  (via the shipped source = ANY($n) shape) and capped at N_norm. $1 = vlit, $2 = minSim, $3+ = the
 *  bound source array. INFERRED, reported verbatim for validation. Pure. */
export function normativeVectorSql(embCol: string, normFilterSQL: string, limit: number): string {
  return `
    SELECT id, ROW_NUMBER() OVER (ORDER BY ${embCol} <=> $1::vector) AS rank
    FROM mksap_chunks
    WHERE 1 - (${embCol} <=> $1::vector) > $2
      AND ${embCol} IS NOT NULL
      AND ${normFilterSQL}
    ORDER BY ${embCol} <=> $1::vector
    LIMIT ${limit}
  `;
}

export type Bm25DiscriminatingPlan = {
  tsquery: string;                                           // OR-joined kept lexemes ('' ⇒ no leg)
  terms: { lexeme: string; df: number; kept: boolean }[];    // per-lexeme DF estimate + keep decision
};

/**
 * Build the discriminating BM25 tsquery + per-term DF report for `bm25Query`. FAIL-SAFE: any error
 * (DB, parse, unexpected shape) ⇒ null, so the caller degrades to an EMPTY BM25 leg — never a
 * timeout, never wrong data. Uses the bounded planner-estimate DF (D6), one EXPLAIN per lexeme.
 */
async function buildDiscriminatingBm25(bm25Query: string, dfMax: number): Promise<Bm25DiscriminatingPlan | null> {
  try {
    const sqlText = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;
    const lexRows = await sqlText(plaintoLexemesSql(), [bm25Query]);
    const lexemes = parseTsqueryLexemes(String(lexRows?.[0]?.q ?? ''));
    if (!lexemes.length) return null;
    const dfs = await Promise.all(lexemes.map(async (lexeme) => {
      try {
        const r = await sqlText(dfEstimateSql(), [lexeme]);
        const plan = (r?.[0]?.['QUERY PLAN'] as { Plan?: { 'Plan Rows'?: number } }[] | undefined)?.[0]?.Plan;
        const est = Number(plan?.['Plan Rows']);
        return { lexeme, df: Number.isFinite(est) ? est : Number.POSITIVE_INFINITY };
      } catch {
        return { lexeme, df: Number.POSITIVE_INFINITY };   // unknown ⇒ treat as common ⇒ dropped
      }
    }));
    const kept = new Set(selectDiscriminatingLexemes(dfs, dfMax));
    const terms = dfs.map((d) => ({ lexeme: d.lexeme, df: d.df, kept: kept.has(d.lexeme.toLowerCase()) }));
    return { tsquery: orJoinLexemes([...kept]), terms };
  } catch {
    return null;
  }
}

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrieveResult> {
  const topK = opts.topK ?? TOP_K;
  const minSim = opts.minSimilarity ?? 0.3;
  const hybrid = opts.hybrid !== false;
  const useV2 = opts.useEmbeddingV2 ?? USE_EMBEDDING_V2;
  const useReranker = opts.useReranker === true;
  const useSourceWeights = opts.useSourceWeights === true;
  const embCol = useV2 ? 'embedding_v2' : 'embedding';

  // R-6 guard: fires ONLY if the hardcoded-false USE_EMBEDDING_V2 flag is ever flipped without the
  // column present — a loud named error instead of a silently-empty vector leg. No-op in production.
  if (useV2) assertEmbeddingV2Available(true, await embeddingV2ColumnExists());

  const expanded = opts.skipExpand ? query : await expandQuery(query);
  // A precomputed (cached) nomic embedding short-circuits the embed call (grounding worker); default =
  // embed the (expanded) query text exactly as before. Guarded to the non-v2 path (nomic dim).
  const vec = (opts.queryEmbedding && !useV2)
    ? opts.queryEmbedding
    : (useV2 ? await embedQueryV2(expanded) : await embedQuery(expanded));
  const vlit = vectorLiteral(vec);

  // When reranker is on, pull a deeper pool so the cross-encoder has more
  // to choose from. Otherwise stick with v1.5's POOL=max(40, K*5).
  const POOL = useReranker
    ? Math.max(30, topK * 4)   // smaller pool because rerank is the bottleneck
    : Math.max(40, topK * 5);

  // ---- filter clauses ----
  // QUARANTINE GUARD (lab MCP): lab-added corpus material is inert as source `labq:%` until
  // the user activates it (→ `lab:%`). Excluded from BOTH retrieval legs, always. The lab
  // measurement seam (opts.includeQuarantined, never set in production) relaxes both guards for
  // ONE named batch via a bound param — see buildFilterClauses. Omitted ⇒ byte-identical SQL.
  const { clauses: filterClauses, params: filterParams } = buildFilterClauses({
    includeQuarantined: opts.includeQuarantined,
    restrictSources: opts.restrictSources,
    bookFilter: opts.bookFilter,
    chunkType: opts.chunkType,
    source: opts.source,
  });

  // ---- Vector leg ----
  const vecFilterSQL = renderFilterSql(filterClauses, 3);
  const vecSQL = `
    SELECT id, ROW_NUMBER() OVER (ORDER BY ${embCol} <=> $1::vector) AS rank
    FROM mksap_chunks
    WHERE 1 - (${embCol} <=> $1::vector) > $2
      AND ${embCol} IS NOT NULL
      AND ${vecFilterSQL}
    ORDER BY ${embCol} <=> $1::vector
    LIMIT ${POOL}
  `;
  const vecParams = [vlit, minSim, ...filterParams];

  // ---- BM25 leg ----
  const bm25Query = (opts.bm25Query ?? query).trim();
  const bm25FilterSQL = renderFilterSql(filterClauses, 2);

  // DEFAULT (production): plainto-AND, byte-identical to today. LAB-ONLY discriminating mode swaps in
  // a DF-cut OR-of-rare-terms leg with a capped scan — never set by any production caller (§3).
  let bm25SQL: string;
  let bm25Params: unknown[];
  let bm25Enabled = true;
  let bm25Disc: Bm25DiscriminatingPlan | null = null;
  if (opts.bm25Mode?.strategy === 'discriminating') {
    bm25Disc = await buildDiscriminatingBm25(bm25Query, opts.bm25Mode.dfMax);
    if (bm25Disc && bm25Disc.tsquery) {
      bm25SQL = discriminatingBm25Sql(bm25FilterSQL, POOL, BM25_DISCRIMINATING_CAP);
      bm25Params = [bm25Disc.tsquery, ...filterParams];
    } else {
      // no discriminating terms survived the DF cut ⇒ EMPTY BM25 leg (never a timeout, never a throw).
      bm25SQL = '';
      bm25Params = [];
      bm25Enabled = false;
    }
  } else {
    bm25SQL = defaultBm25Sql(bm25FilterSQL, POOL);
    bm25Params = [bm25Query, ...filterParams];
  }

  // ---- Normative leg (R-11) — dormant, opt-in; the SAME vector query restricted to the normative
  // sources, LIMIT N_norm, unioned into the RRF pool. OFF ⇒ no query emitted, fusion byte-identical.
  const useNormativeLeg = opts.useNormativeLeg === true;
  let normSQL = '';
  let normParamsFull: unknown[] = [];
  let normativeSources: string[] = [];
  if (useNormativeLeg) {
    normativeSources = resolveNormativeSources(opts.normativeSources, process.env.NORMATIVE_LEG_SOURCES);
    const nNorm = normativeLegK(process.env.NORMATIVE_LEG_K);
    // Reuse the shipped restrictSources → source = ANY($n) filter (do NOT invent a new one).
    const { clauses: normClauses, params: normFilterParams } = buildFilterClauses({ restrictSources: normativeSources });
    normSQL = normativeVectorSql(embCol, renderFilterSql(normClauses, 3), nNorm);
    normParamsFull = [vlit, minSim, ...normFilterParams];
  }

  type RankRow = { id: number; rank: number };
  const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<RankRow[]>;
  const [vecRows, bm25Rows, normRows] = await Promise.all([
    sqlFn(vecSQL, vecParams).catch(() => [] as RankRow[]),
    (hybrid && bm25Enabled) ? sqlFn(bm25SQL, bm25Params).catch(() => [] as RankRow[]) : Promise.resolve([] as RankRow[]),
    // Fail-safe: a normative-leg error degrades to no added rows; it never throws and never blocks the others.
    useNormativeLeg ? sqlFn(normSQL, normParamsFull).catch(() => [] as RankRow[]) : Promise.resolve([] as RankRow[]),
  ]);

  // ---- RRF fusion ----
  const score: Map<number, number> = new Map();
  // Per-leg ranks — captured here so the lab path (§3.2) can expose them without a second pass.
  const vecRankById = new Map<number, number>();
  const bm25RankById = new Map<number, number>();
  const normRankById = new Map<number, number>();
  for (const r of vecRows) { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank))); vecRankById.set(r.id, Number(r.rank)); }
  for (const r of bm25Rows) { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank))); bm25RankById.set(r.id, Number(r.rank)); }
  // Normative leg unions into the SAME RRF pool. Empty when off ⇒ this loop is a no-op ⇒ byte-identical fusion.
  for (const r of normRows) { score.set(r.id, (score.get(r.id) ?? 0) + 1 / (RRF_K + Number(r.rank))); normRankById.set(r.id, Number(r.rank)); }

  // When reranker is on we hand it a wider pool (top K*3, capped at 30).
  // When off we trim to topK directly here.
  const poolSize = useReranker ? Math.min(30, topK * 3) : topK;
  const fusedIds = Array.from(score.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, poolSize)
    .map(([id]) => id);

  if (fusedIds.length === 0) {
    return { hits: [], expandedQuery: expanded, meta: {
      vector_pool: vecRows.length, bm25_pool: bm25Rows.length, fused: 0,
      bm25_query: bm25Query, pool_size: 0, reranked: false, source_weighted: false,
      embedding_column: embCol as 'embedding' | 'embedding_v2',
      ...(bm25Disc ? { bm25_mode: 'discriminating' as const, bm25_tsquery: bm25Disc.tsquery, bm25_terms: bm25Disc.terms } : {}),
      ...(useNormativeLeg ? { normative_pool: normRows.length, normative_sources: normativeSources } : {}),
    } };
  }

  // ---- Final hydrate ----
  // Pull source_quality_weight + similarity for the candidate pool
  const placeholders = fusedIds.map((_, i) => `$${i + 2}`).join(',');
  const finalSQL = `
    SELECT id, source, book, chapter, section, page_start, page_end, item_number, chunk_type, text, token_count,
           1 - (${embCol} <=> $1::vector) AS similarity,
           COALESCE(source_quality_weight, 1.0) AS source_quality_weight
    FROM mksap_chunks
    WHERE id IN (${placeholders})
  `;
  type HydratedRow = ChunkHit & { source_quality_weight: number };
  const rowsBy = await (sql as unknown as (q: string, p: unknown[]) => Promise<HydratedRow[]>)(finalSQL, [vlit, ...fusedIds]);
  const byId = new Map(rowsBy.map((r) => [r.id, r]));
  let hits: ChunkHitWithMeta[] = fusedIds
    .map((id) => byId.get(id))
    .filter((x): x is HydratedRow => !!x)
    .map((r) => ({ ...r }));

  // ---- Cross-encoder rerank ----
  if (useReranker && hits.length > 1) {
    const reranked = await rerank(query, hits.map((h) => ({
      id: h.id,
      text: h.text,
      __orig: h,
    })), opts.rerankBackend);
    hits = reranked.map((r) => {
      const orig = (r as unknown as { __orig: ChunkHitWithMeta }).__orig;
      return {
        ...orig,
        rerank_score: r.rerank_score,
        rerank_backend: r.rerank_backend,
      };
    });
  }

  // ---- Source-quality weighting ----
  // Multiplier applied to whichever score we sort by at this point.
  // After reranker: score = rerank_score * weight
  // No reranker:    score = similarity * weight
  if (useSourceWeights) {
    const sortKey = useReranker ? 'rerank_score' : 'similarity';
    hits = hits.map((h) => {
      const raw = (h[sortKey as keyof ChunkHitWithMeta] as number) ?? 0;
      // Compute the weight FRESH from the chunk's own fields rather than trusting
      // the precomputed mksap_chunks.source_quality_weight column. The Jun-2026 bulk
      // literature load (ingest_cdmss_keep.py) inserted ~2M PubMed/PMC rows WITHOUT
      // populating that column → they COALESCE to 1.0, which would rank raw abstracts
      // ABOVE weighted textbooks (StatPearls/UpToDate at 0.90). Computing here uses
      // the same formula a reindex would, so unknown journals get the 0.80 default and
      // tiny/fragment chunks get penalised — no 2M-row backfill needed. Overwrite the
      // field so telemetry shows the weight actually applied.
      const wRaw = computeSourceQualityWeight({ book: h.book, source: h.source, chunk_type: h.chunk_type, token_count: h.token_count });
      // F16 — EARNED weighting. A `lab:`/`labq:` chunk is clamped to 0.855 (the best curated
      // source's weight) until its batch has passed an activation A/B. Today an unactivated labq:
      // chunk computes to 0.9025, i.e. it outranks UpToDate and StatPearls purely by being new,
      // which is a ranking claim nothing has earned. Non-lab sources are returned untouched, so
      // production retrieval over the curated corpus is byte-identical.
      const w = clampSourceWeight(h.source, wRaw);
      return { ...h, source_quality_weight: w, [`${sortKey}_weighted`]: raw * w } as ChunkHitWithMeta & Record<string, number>;
    });
    const k = `${sortKey}_weighted`;
    hits.sort((a, b) => ((b as unknown as Record<string, number>)[k] ?? 0) - ((a as unknown as Record<string, number>)[k] ?? 0));
  }

  // Trim to final topK
  hits = hits.slice(0, topK);

  // ---- Per-stage diagnostics (lab measurement path ONLY) ----
  // Added when the lab explicitly asks (includeQuarantined OR withDiagnostics, R-5), so production
  // result shapes stay untouched — no production caller sets either flag.
  if (opts.includeQuarantined || opts.withDiagnostics) {
    hits = hits.map((h, i) => ({
      ...h,
      vector_rank: vecRankById.has(h.id) ? (vecRankById.get(h.id) as number) : null,
      bm25_rank: bm25RankById.has(h.id) ? (bm25RankById.get(h.id) as number) : null,
      normative_rank: normRankById.has(h.id) ? (normRankById.get(h.id) as number) : null,
      rrf_score: score.get(h.id) ?? 0,
      final_rank: i + 1,
    }));
  }

  return {
    hits,
    expandedQuery: expanded,
    meta: {
      vector_pool: vecRows.length,
      bm25_pool: bm25Rows.length,
      fused: hits.length,
      bm25_query: bm25Query,
      pool_size: poolSize,
      reranked: useReranker,
      source_weighted: useSourceWeights,
      embedding_column: embCol as 'embedding' | 'embedding_v2',
      ...(bm25Disc ? { bm25_mode: 'discriminating' as const, bm25_tsquery: bm25Disc.tsquery, bm25_terms: bm25Disc.terms } : {}),
      ...(useNormativeLeg ? { normative_pool: normRows.length, normative_sources: normativeSources } : {}),
    },
  };
}
