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
import { createTelemetryCapture, evidenceFromCompletion, evidenceFromError, errorClassOf, type TelemetryCapture, type TransportEvidence } from './retrieval-capture';
import type { VariantStatus, VariantOutcome } from './retrieval-telemetry-core';
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

/** What variant generation actually did, alongside what it produced (D6). */
export type VariantGenerationResult = {
  status: VariantStatus;
  variants: string[];
  evidence: TransportEvidence | null;
  promptTokens: number | null;
  completionTokens: number | null;
};

/**
 * Variant generation, with its own outcome reported rather than collapsed into an empty array.
 *
 * ⚠️ SIX DISTINGUISHABLE OUTCOMES, FIVE CODE PATHS BEFORE THIS BUILD. A usable set, a valid empty
 * array, an array with no usable strings, and valid JSON that is not an array were each already
 * reachable separately — but a `JSON.parse` throw and a `governedChat` throw landed in the SAME
 * catch. They are different facts: a parse failure means a completion ARRIVED, cost tokens, and
 * kept its provider and model, which §4.6 prices and §4.4 says must be preserved. A failed-open
 * means no completion was produced at all. The inner `try` below is what separates them, and it is
 * the only reason this function exists as a sibling of the wrapper rather than as its body.
 *
 * BEHAVIOUR IS UNCHANGED. The same call, the same parameters, the same swallow, the same console
 * line. Only the return SHAPE is richer, and the wrapper below narrows it back.
 */
export async function generateQueryVariantsWithTelemetry(question: string): Promise<VariantGenerationResult> {
  const none = { evidence: null, promptTokens: null, completionTokens: null };
  let evidence: TransportEvidence | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
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
    evidence = evidenceFromCompletion(r);
    const usage = (r as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
    let txt = r.choices?.[0]?.message?.content?.trim() || '';
    // Strip markdown fences if the model added them
    if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Find the JSON array boundaries
    const a = txt.indexOf('[');
    const b = txt.lastIndexOf(']');
    if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
    let arr: unknown;
    try {
      arr = JSON.parse(txt);
    } catch (pe) {
      // A COMPLETION ARRIVED AND DID NOT PARSE. Provider, model, attempts and usage are all
      // PRESERVED (§4.4) — this stage is priced, and it is never `not_served`.
      console.warn('[multi-query] variant generation failed', (pe as Error).message);
      return { status: 'parse_failure', variants: [], evidence, promptTokens, completionTokens };
    }
    if (!Array.isArray(arr)) {
      return { status: 'not_an_array', variants: [], evidence, promptTokens, completionTokens };
    }
    const usable = arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, VARIANT_COUNT);
    const status: VariantStatus = arr.length === 0 ? 'parsed_empty' : usable.length === 0 ? 'all_invalid' : 'generated';
    return { status, variants: usable, evidence, promptTokens, completionTokens };
  } catch (e) {
    // The call itself never produced a completion. `not_served` only if the transport PROVED it.
    console.warn('[multi-query] variant generation failed', (e as Error).message);
    return { status: 'failed_open', variants: [], ...none, evidence: evidenceFromError(e) };
  }
}

/**
 * ⚠️ SIGNATURE AND BEHAVIOUR UNCHANGED. A thin wrapper, not a copy of the body — one call site, one
 * prompt, one set of parameters. Every existing injection of this function still works.
 *
 * ⚠️ THE EARLY EXIT BELOW MUST KEEP ITS LITERAL FORM, AND THIS COMMENT DELIBERATELY DOES NOT QUOTE
 * IT. lib/__tests__/retrieval-llm-determinism.test.ts greps this file for that statement as its
 * "fail-open preserved" assertion; a comment repeating the same characters would satisfy the grep
 * on its own, and the pin would keep passing over a file that no longer contained the statement.
 * A wrapper that handed back the variants unconditionally would fail that test, and rightly so:
 * every non-`generated` status really does fail open to an empty array here.
 */
export async function generateQueryVariants(question: string): Promise<string[]> {
  const result = await generateQueryVariantsWithTelemetry(question);
  if (result.status !== 'generated') return [];
  return result.variants;
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
  /** The telemetry-aware seam. Preferred when supplied; see the precedence note below. */
  variantsWithTelemetryFn?: (question: string) => Promise<VariantGenerationResult>;
  expandFn?: typeof expandQuery;
};

export async function retrieveMultiQuery(
  question: string,
  opts: RetrieveOptions = {},
  deps: MultiQueryDeps = {},
  capture?: TelemetryCapture,
): Promise<MultiRetrieveResult> {
  const retrieveFn = deps.retrieveFn ?? retrieve;
  const rerankFn = deps.rerankFn ?? rerank;
  const expandFn = deps.expandFn ?? expandQuery;

  /**
   * ⚠️ DEPENDENCY PRECEDENCE NEVER DEPENDS ON THE CAPTURE (D6). This resolution is identical with
   * and without one. If it were not, a telemetry-ON ranking-invariance test would reach the real
   * provider while the telemetry-OFF side ran a fake, and §6.1 would be comparing two different
   * experiments while reporting them as one.
   *
   * A legacy `deps.variantsFn` is therefore never bypassed — it is USED, and its inability to
   * report is recorded honestly rather than papered over.
   */
  const generateVariants: (q: string) => Promise<VariantGenerationResult> =
    deps.variantsWithTelemetryFn
      ? deps.variantsWithTelemetryFn
      : deps.variantsFn
        // A bare string array CANNOT distinguish `parsed_empty` from `failed_open` (A11). Inferring
        // either would put a fabricated fact in a provenance record, so the seam reports
        // `not_collected`: it means the collaborator cannot say, and it is never a defect.
        ? async (q: string) => ({
          status: 'not_collected' as VariantStatus,
          variants: await deps.variantsFn!(q),
          evidence: null, promptTokens: null, completionTokens: null,
        })
        : generateQueryVariantsWithTelemetry;

  const topK = opts.topK ?? 8;
  // Fusion-level stage flags (mirror retrieve.ts). The per-variant calls force these OFF.
  const useReranker = opts.useReranker === true;
  const useSourceWeights = opts.useSourceWeights === true;

  // R-8: restore query expansion. Read `skipExpand` EXPLICITLY (D3) — NOT hardcoded — so a caller can
  // turn expansion off. Expand ONCE, on the ORIGINAL question; mirrors retrieve.ts:53-64's single-query
  // handling. expandQuery fails open (returns the original question on any error, never throws).
  // D4: `expandFn` is `typeof expandQuery`, whose second parameter is `traceId` — hence the
  // explicit placeholder before the capture.
  const expandedQuery = opts.skipExpand ? question : await expandFn(question, undefined, capture);

  // Per-variant pool — keep it moderate; we fuse and trim at the end.
  const perVariantK = Math.max(topK, 6);
  // Variants are generated from the ORIGINAL question, never the expanded paragraph (which is prose,
  // not a question — reformulating it would drift).
  const generation = await generateVariants(question);
  const variants = generation.variants;
  if (capture) {
    capture.variantGeneration = {
      status: generation.status,
      evidence: generation.evidence,
      promptTokens: generation.promptTokens,
      completionTokens: generation.completionTokens,
      generatedCount: variants.length,
    };
  }
  // index 0 = the ORIGINAL arm, retrieving on the EXPANDED text; 1..N = variants on raw variant text.
  const allQueries = [expandedQuery, ...variants];

  const variantOutcomes: Array<{ index: number; outcome: VariantOutcome; candidateCount: number }> = [];
  /**
   * ⚠️ ONE CAPTURE PER ARM, AND THE PARENT IS NOT HANDED DOWN. `index_version` is written in exactly
   * one place in the tree — `lib/retrieve.ts`, before its first fallible statement — and the arms
   * were being called with two arguments, so a `lab_multi_query` row's `index_version` was whatever
   * `createTelemetryCapture` initialised it to, which is null. D17 does not permit null there, and
   * nothing rejects it at run time: `validateManifest` has no production caller and the column is
   * nullable with no CHECK, so the row would have been written and stored looking complete.
   *
   * The parent capture is NOT passed into the arms, because `retrieve()` also writes the candidate
   * id lists, the passage texts and the retrieval outcome — fusion-level facts that this function
   * computes for itself below. Six arms writing them in turn would leave the parent holding one
   * arbitrary arm's view of a pool it never had.
   */
  const armCaptures = capture ? allQueries.map(() => createTelemetryCapture(capture.role)) : undefined;
  const results = await Promise.all(
    // Every arm hands retrieve() its FINAL text — the original arm's is already expanded, the variants
    // are deliberately raw — so the per-call skipExpand is true for all of them (no double-expansion).
    // The caller-facing expansion switch is handled ONCE above via `expandedQuery`, not here.
    // withDiagnostics: true makes each variant's retrieve() stamp per-hit bm25_rank (its own BM25-leg
    // rank) — provenance ONLY, it changes nothing retrieved or ranked. Fusion reads it below so a
    // chunk that arrived via a LATER variant's BM25 leg keeps its attribution.
    allQueries.map((q, vi) =>
      retrieveFn(q, { ...opts, topK: perVariantK, skipExpand: true, useReranker: false, useSourceWeights: false, withDiagnostics: true }, armCaptures?.[vi])
        .then((r) => {
          // One of the four sites that swallow a retrieval exception into an empty hit list. The
          // three outcomes are DISCRIMINATED here (§4.3): a variant that found nothing and a
          // variant that threw both produce `hits: []`, and only one of them is a defect.
          variantOutcomes[vi] = { index: vi, outcome: r.hits.length > 0 ? 'success' : 'zero_hits', candidateCount: r.hits.length };
          return r;
        })
        .catch((e) => {
          console.warn('[multi-query] variant retrieve failed', q.slice(0, 60), (e as Error).message);
          variantOutcomes[vi] = { index: vi, outcome: 'retrieval_failure', candidateCount: 0 };
          if (capture) {
            capture.retrievalErrorClass = capture.retrievalErrorClass ?? errorClassOf(e);
          }
          return { hits: [], expandedQuery: q } as RetrieveResult;
        }),
    ),
  );
  if (capture) {
    // index 0 is the ORIGINAL expanded arm, so this array is always one longer than the generated
    // variant count — which is what the manifest's arity check asserts.
    capture.variants = allQueries.map((_, vi) => variantOutcomes[vi]
      ?? { index: vi, outcome: 'zero_hits' as VariantOutcome, candidateCount: 0 });
  }
  if (capture && armCaptures) {
    // `children` was declared in D5 and written by nothing. It is written here, and read by nothing
    // that serializes: the arms' captures are raw material, and raw material never leaves the
    // process (test 3). They are kept because the two fields lifted below are theirs.
    capture.children = armCaptures;
    // ⚠️ THE FIRST ARM THAT GOT AS FAR AS CHOOSING A COLUMN, NOT THE FIRST ARM. `index_version` is
    // stamped BEFORE `retrieve()`'s first fallible statement, so an arm that threw still has one —
    // which is what makes this the honest value even when every arm failed. It is null only if no
    // arm reached that line at all, which for an injected `retrieveFn` that ignores its capture is
    // a real absence and is recorded as one.
    capture.indexVersion = capture.indexVersion
      ?? armCaptures.find((c) => c.indexVersion !== null)?.indexVersion
      ?? null;
    // The arms all run the same configuration by construction — the per-call overrides above are
    // fixed — so any arm's config is the fusion's config.
    if (Object.keys(capture.retrievalConfig).length === 0) {
      const cfg = armCaptures.find((c) => Object.keys(c.retrievalConfig).length > 0);
      if (cfg) capture.retrievalConfig = { ...cfg.retrievalConfig };
    }
  }

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

  // The fused pool IS this role's candidate set: multi-query has no single hydrate step, so the
  // fused and hydrated counts are the same number by construction. Recorded as two values anyway,
  // because a reader must not have to know which role they are looking at to read the field.
  if (capture) {
    capture.fusedCandidateIds = fused.map((h) => Number(h.id));
    capture.hydratedCandidateIds = fused.map((h) => Number(h.id));
    capture.passageTexts = fused.map((h) => h.text ?? '');
  }

  // ---- Single cross-encoder rerank over the fused pool, against the ORIGINAL question ----
  if (useReranker && fused.length > 1) {
    // D4: `deps` is the fourth parameter of rerank(), so the capture needs its placeholder.
    const reranked = await rerankFn(question, fused.map((h) => ({ id: h.id, text: h.text, __orig: h })), opts.rerankBackend, undefined, capture);
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

  const hits = fused.slice(0, topK);
  if (capture) {
    capture.orderedFinalCandidateIds = hits.map((h) => Number(h.id));
    // A multi-query run whose every arm threw is a FAILURE, not an empty result. One arm throwing
    // and the rest returning nothing is `zero_hits`: the retrieval worked and found nothing.
    const everyArmFailed = capture.variants!.length > 0
      && capture.variants!.every((v) => v.outcome === 'retrieval_failure');
    capture.retrievalOutcome = everyArmFailed ? 'retrieval_failure'
      : hits.length > 0 ? 'success' : 'zero_hits';
    if (capture.retrievalOutcome !== 'retrieval_failure') capture.retrievalErrorClass = null;
  }

  return {
    hits,
    variants: allQueries,
    perVariantCounts: results.map((r) => r.hits.length),
    expandedQuery,
  };
}
