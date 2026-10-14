/**
 * v1.5 P2a: multi-query retrieval.
 *
 * Generates query reformulations (different clinical angles) and runs
 * retrieve() in parallel for each, with per-variant rerank/source-weighting OFF.
 * Fuses across variants by RRF (rank-based, so cross-variant-comparable), then
 * reranks ONCE over the fused pool against the original question and applies
 * source-quality weighting — mirroring retrieve()'s own structure.
 *
 * Latency: ~wall-clock-equal to a single retrieve() call (Promise.all),
 * plus one fast LLM call for variant generation (~500ms).
 *
 * Why this matters: most "/ask doesn't find X" failures aren't because
 * the content isn't there — they're wording-match failures. Reformulating
 * the query and unioning the candidate pools catches gold the original
 * phrasing missed.
 */
import { geminiUtilityModel } from './llm';
import { governedChat } from './trace';
import { retrieve, RRF_K, type RetrieveOptions, type RetrieveResult } from './retrieve';
import { rerank } from './rerank';
import { expandQuery, RETRIEVAL_LLM_SEED } from './expand';
import { computeSourceQualityWeight } from './source-quality';
import type { ChunkHit } from './db';

const VARIANT_MODEL = 'llama3.1:8b';
const VARIANT_COUNT = 2;  // 2 variants + the original = 3 retrievals fanned out (v1.6 hotfix: was 4, cut to keep latency under 300s on Mac Mini Ollama)

const SYSTEM_VARIANTS = `You are a clinical query reformulator. Given a clinician's question, output ${VARIANT_COUNT} alternative phrasings that approach the same underlying information need from different angles, in JSON.

Cover these angles (one per variant, in order):
1. Diagnostic workup / criteria angle
2. Management / treatment angle

Return ONLY a JSON array of strings, no prose:
["variant 1", "variant 2", "variant 3", "variant 4"]

Each variant should:
- Use precise clinical terminology
- Read like a focused query a physician would type
- Stay under 20 words
- NOT be a question form — make them noun-phrase queries (e.g. "pathophysiology of heart failure with reduced ejection fraction" not "what is the pathophysiology of HFrEF?")`;

export async function generateQueryVariants(question: string): Promise<string[]> {
  try {
    // Governed envelope (Stage 4). No promptRef: SYSTEM_VARIANTS is deliberately outside the
    // Stage-0 registry (query-variant scaffold, not a standing clinical prompt).
    const r = await governedChat(undefined, 'multi_query_variants', {
      model: VARIANT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_VARIANTS },
        { role: 'user', content: question },
      ],
      temperature: 0,  // deterministic variants (was 0.2 sampled) — removes run-to-run pool churn; seed belt-and-suspenders
      max_tokens: 300,
      ...({ options: { num_ctx: 8192, seed: RETRIEVAL_LLM_SEED }, keep_alive: '15m' } as Record<string, unknown>),
    }, { gemini: geminiUtilityModel() });
    let txt = r.choices?.[0]?.message?.content?.trim() || '';
    // Strip markdown fences if the model added them
    if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Find the JSON array boundaries
    const a = txt.indexOf('[');
    const b = txt.lastIndexOf(']');
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
    const arr = JSON.parse(txt);
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, VARIANT_COUNT);
  } catch (e) {
    console.warn('[multi-query] variant generation failed', (e as Error).message);
    return [];
  }
}

// Exported hit type adds ONLY the two genuinely-new fields, both optional. rerank_score /
// rerank_backend / source_quality_weight are ALSO present at runtime (set once at fusion) but are
// deliberately kept OFF this exported type: declaring them here would make the pre-existing
// `@ts-expect-error` directives in app/api/ask/route.ts and app/api/ddx/route.ts (which assume the
// multi-query hit is a bare ChunkHit lacking those fields) UNUSED, forcing edits to app/api — which
// §2.4 forbids. They stay on the internal FusionHit and are read via cast in the lab handler. FLAGGED.
export type MultiQueryHit = ChunkHit & {
  rrf_score?: number;                 // Σ over variants 1/(RRF_K + rank_in_that_variant)
  variant_ranks?: (number | null)[];  // 1-based rank per variant, index-aligned to `variants` (null if absent)
};

// Internal working type — the full per-hit diagnostic surface produced by fusion (§2.2). Kept off the
// exported MultiQueryHit (read via cast in the lab handler) for the same app/api reason as rerank_score.
type FusionHit = ChunkHit & {
  rrf_score: number;
  variant_ranks: (number | null)[];
  bm25_variant_ranks: (number | null)[];   // each variant's BM25-leg rank for this chunk, index-aligned to `variants` (null if it did not arrive via that variant's BM25 leg)
  bm25_rank: number | null;                 // convenience scalar: best (min) non-null across bm25_variant_ranks, null if never via BM25
  rerank_score?: number;
  rerank_backend?: 'judge' | 'cohere' | 'none';   // matches RerankResult exactly (type-only widening)
  source_quality_weight?: number;
};

export type MultiRetrieveResult = {
  hits: MultiQueryHit[];
  variants: string[];   // the queries we actually ran (index 0 = original arm's query, 1..N = variants)
  perVariantCounts: number[];
  expandedQuery: string;   // R-8: the text the ORIGINAL arm retrieved on (expanded, or the raw question if expansion is off)
};

/**
 * Run retrieve() for the original query + N variants in parallel, then FUSE by RRF across variants —
 * NOT by re-sorting raw cosine (the R-3 defect). Because RRF is rank-based it is immune to the fact
 * that each variant's `similarity` was computed against a DIFFERENT query vector and so is not
 * comparable across variants. The cross-encoder rerank and source-quality weighting then happen ONCE
 * over the fused pool, against the ORIGINAL question — the only place a cross-variant score is
 * meaningful. This mirrors retrieve.ts's own RRF → rerank → source-weight structure exactly.
 *
 * The per-variant retrieve() calls are made with useReranker/useSourceWeights OFF: those stages are
 * now applied once, at fusion. Passing them through would rerank three pools and discard the work.
 */
/** Collaborators, injectable for tests ONLY. Production callers pass nothing ⇒ the real functions. */
export type MultiQueryDeps = {
  retrieveFn?: typeof retrieve;
  rerankFn?: typeof rerank;
  variantsFn?: (question: string) => Promise<string[]>;
  expandFn?: typeof expandQuery;
};

export async function retrieveMultiQuery(
  question: string,
  opts: RetrieveOptions = {},
  deps: MultiQueryDeps = {},
): Promise<MultiRetrieveResult> {
  const retrieveFn = deps.retrieveFn ?? retrieve;
  const rerankFn = deps.rerankFn ?? rerank;
  const variantsFn = deps.variantsFn ?? generateQueryVariants;
  const expandFn = deps.expandFn ?? expandQuery;

  const topK = opts.topK ?? 8;
  // Fusion-level stage flags (mirror retrieve.ts). The per-variant calls force these OFF.
  const useReranker = opts.useReranker === true;
  const useSourceWeights = opts.useSourceWeights === true;

  // R-8: restore query expansion. Read `skipExpand` EXPLICITLY (D3) — NOT hardcoded — so a caller can
  // turn expansion off. Expand ONCE, on the ORIGINAL question; mirrors retrieve.ts:53-64's single-query
  // handling. expandQuery fails open (returns the original question on any error, never throws).
  const expandedQuery = opts.skipExpand ? question : await expandFn(question);

  // Per-variant pool — keep it moderate; we fuse and trim at the end.
  const perVariantK = Math.max(topK, 6);
  // Variants are generated from the ORIGINAL question, never the expanded paragraph (which is prose,
  // not a question — reformulating it would drift).
  const variants = await variantsFn(question);
  // index 0 = the ORIGINAL arm, retrieving on the EXPANDED text; 1..N = variants on raw variant text.
  const allQueries = [expandedQuery, ...variants];

  const results = await Promise.all(
    // Every arm hands retrieve() its FINAL text — the original arm's is already expanded, the variants
    // are deliberately raw — so the per-call skipExpand is true for all of them (no double-expansion).
    // The caller-facing expansion switch is handled ONCE above via `expandedQuery`, not here.
    // withDiagnostics: true makes each variant's retrieve() stamp per-hit bm25_rank (its own BM25-leg
    // rank) — provenance ONLY, it changes nothing retrieved or ranked. Fusion reads it below so a
    // chunk that arrived via a LATER variant's BM25 leg keeps its attribution.
    allQueries.map((q) =>
      retrieveFn(q, { ...opts, topK: perVariantK, skipExpand: true, useReranker: false, useSourceWeights: false, withDiagnostics: true })
        .catch((e) => {
          console.warn('[multi-query] variant retrieve failed', q.slice(0, 60), (e as Error).message);
          return { hits: [], expandedQuery: q } as RetrieveResult;
        }),
    ),
  );

  // ---- RRF across variants ----
  // Each variant's retrieve() returns hits in its own ranked order, so rank = index+1 within it.
  const nQ = allQueries.length;
  const byId = new Map<number | string, FusionHit>();
  for (let v = 0; v < results.length; v++) {
    const hits = results[v].hits;
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const rank = i + 1;
      let acc = byId.get(h.id);
      if (!acc) {
        acc = { ...(h as ChunkHit), rrf_score: 0, variant_ranks: new Array(nQ).fill(null), bm25_variant_ranks: new Array(nQ).fill(null), bm25_rank: null };
        byId.set(h.id, acc);
      }
      acc.variant_ranks[v] = rank;
      // Preserve THIS variant's BM25-leg provenance — the previous code kept only the first sighting.
      acc.bm25_variant_ranks[v] = h.bm25_rank ?? null;
      acc.rrf_score += 1 / (RRF_K + rank);
    }
  }
  // Convenience scalar: the best (min) BM25 rank across all variants — what Stage 2 attribution reads.
  for (const acc of byId.values()) {
    const seen = acc.bm25_variant_ranks.filter((x): x is number => x != null);
    acc.bm25_rank = seen.length ? Math.min(...seen) : null;
  }

  // Fused pool sorted by RRF descending, trimmed to the rerank pool (mirrors retrieve.ts:122).
  let fused: FusionHit[] = Array.from(byId.values()).sort((a, b) => b.rrf_score - a.rrf_score);
  const poolSize = useReranker ? Math.min(30, topK * 3) : topK;
  fused = fused.slice(0, poolSize);

  // ---- Single cross-encoder rerank over the fused pool, against the ORIGINAL question ----
  if (useReranker && fused.length > 1) {
    const reranked = await rerankFn(question, fused.map((h) => ({ id: h.id, text: h.text, __orig: h })), opts.rerankBackend);
    fused = reranked.map((r) => {
      const orig = (r as unknown as { __orig: FusionHit }).__orig;
      return { ...orig, rerank_score: r.rerank_score, rerank_backend: r.rerank_backend };
    });
  }

  // ---- Source-quality weighting (same seam retrieve.ts:187 uses) ----
  // Weight comes FRESH from the chunk's own fields, not the NULL-for-~2M-rows precomputed column.
  // Sort by rerank_score * weight, or rrf_score * weight when the reranker is off.
  if (useSourceWeights) {
    const sortKey: 'rerank_score' | 'rrf_score' = useReranker ? 'rerank_score' : 'rrf_score';
    const weighted = fused.map((h) => {
      const raw = (h[sortKey] as number | undefined) ?? 0;
      const w = computeSourceQualityWeight({ book: h.book, source: h.source, chunk_type: h.chunk_type, token_count: h.token_count });
      return { hit: { ...h, source_quality_weight: w } as FusionHit, weighted: raw * w };
    });
    weighted.sort((a, b) => b.weighted - a.weighted);
    fused = weighted.map((x) => x.hit);
  }

  return {
    hits: fused.slice(0, topK),
    variants: allQueries,
    perVariantCounts: results.map((r) => r.hits.length),
    expandedQuery,
  };
}
