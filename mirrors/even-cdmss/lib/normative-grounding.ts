/**
 * lib/normative-grounding.ts — the deterministic retrieval-backed matcher for post-hoc normative
 * grounding. Reads a stored low-value finding, does a RESTRICTED vector retrieve (skipExpand, no
 * reranker, no BM25 — vector cosine only, so the result is byte-stable run-to-run and NO LLM is on the
 * path), gates via normative-grounding-core, and returns the accepted citations. SOFT-FAILS to "no
 * citation" — never throws, never blocks. It reads stored findings; it is NOT on the audit-generation
 * path and it changes no verdict/score/lvc_category.
 */
import { retrieve, type RetrieveOptions } from './retrieve';
import type { Source } from './citations-core';
import {
  CW_SOURCE, GUIDELINE_SOURCES, EVEN_SOURCE, NORMATIVE_TAU,
  cwCandidateAccepted, guidelineCandidateAccepted, evenCandidateAccepted,
  hitToSource, mergeNormativeCitations,
  type NormativeHit, type EvenCategoryLookup,
} from './normative-grounding-core';

export type GroundingFinding = { subject?: string; rationale?: string | null; lvc_category?: string; verdict?: string; informational?: boolean };
export type GroundingResult = { cw: Source | null; guideline: Source | null; even: Source | null; citations: Source[] };
/** `evenCategoryLookup` (optional): the id→category map for ACTIVE/CONTESTED Even assertions. The
 *  even leg runs ONLY when it is supplied (so absent a live library the leg is fully inert — no
 *  retrieve, no citation — and default behaviour stays byte-identical). */
export type GroundingDeps = { retrieveFn?: typeof retrieve; evenCategoryLookup?: EvenCategoryLookup };
/** Selection controls (backfill/inspection ONLY — they never change the match/gate MATH):
 *  - legs: which leg(s) to run. `'both'` = cw+guideline (legacy); `'all'` = cw+guideline+even;
 *    DEFAULT (unset) = `'all'` (the even leg is inert unless an evenCategoryLookup is supplied AND
 *    active even-lvc chunks exist, so this is score-invariant until the first ratification).
 *  - categories: if set, ground ONLY findings whose lvc_category is in the list ([]/undefined = all).
 *  - tau: cosine threshold (default NORMATIVE_TAU).
 *  Defaults reproduce today's behaviour byte-identically. */
export type GroundingOptions = {
  legs?: 'cw' | 'guideline' | 'even' | 'both' | 'all';
  categories?: string[];
  tau?: number;
  /** Even-LVC grounding worker: a precomputed nomic query embedding for this finding (subject+rationale),
   *  passed straight to retrieve so the worker reuses its finding_embeddings cache instead of re-embedding.
   *  Omitted ⇒ retrieve embeds the query text as today (byte-identical). NO effect on gate math / τ. */
  queryEmbedding?: number[];
};

/** Deterministic retrieval config: vector cosine only — no expansion, no reranker, no BM25, no source
 *  weighting. So hits[0].similarity is the raw cosine the gate reads, and the match is reproducible. */
const CW_OPTS: RetrieveOptions = { source: CW_SOURCE, topK: 1, skipExpand: true, useReranker: false, useSourceWeights: false, hybrid: false };
const GUIDELINE_OPTS: RetrieveOptions = { restrictSources: [...GUIDELINE_SOURCES], topK: 1, skipExpand: true, useReranker: false, useSourceWeights: false, hybrid: false };
const EVEN_OPTS: RetrieveOptions = { source: EVEN_SOURCE, topK: 1, skipExpand: true, useReranker: false, useSourceWeights: false, hybrid: false };

/** Ground ONE finding against CW (category-gated) + the guideline sources (τ-gated). Returns the
 *  accepted citations (n=0 placeholder — the backfill assigns the real append index). Soft-fail.
 *  `options` selects legs/categories/tau for backfill/inspection; default = today's behaviour exactly
 *  (both legs, all categories, NORMATIVE_TAU) — the match/gate MATH is unchanged. */
export async function groundFinding(finding: GroundingFinding, deps: GroundingDeps = {}, options: GroundingOptions = {}): Promise<GroundingResult> {
  const retrieveFn = deps.retrieveFn ?? retrieve;
  const tau = options.tau ?? NORMATIVE_TAU;
  const legs = options.legs ?? 'all';
  const cats = options.categories;
  const empty: GroundingResult = { cw: null, guideline: null, even: null, citations: [] };

  const runCw = legs === 'cw' || legs === 'both' || legs === 'all';
  const runGuideline = legs === 'guideline' || legs === 'both' || legs === 'all';
  // The even leg runs ONLY when explicitly selected (or default/all) AND a lookup is supplied — so
  // without a live assertion library it is fully inert (no retrieve), keeping default byte-identical.
  const runEven = (legs === 'even' || legs === 'all') && !!deps.evenCategoryLookup;

  // Category selection (backfill only): if a list is given, ground ONLY those lvc_categories.
  if (cats && cats.length && !cats.includes(String(finding.lvc_category ?? ''))) return empty;

  const q = `${finding.subject ?? ''} ${finding.rationale ?? ''}`.trim();
  if (!q) return empty;

  // A precomputed embedding (grounding worker) is valid for every leg — it embeds THIS q. Omitted ⇒
  // retrieve embeds q as today. Spread per-leg so the default path stays byte-identical.
  const qEmb = options.queryEmbedding;

  let cw: Source | null = null;
  let guideline: Source | null = null;
  let even: Source | null = null;

  if (runCw) {
    try {
      const r = await retrieveFn(q, { ...CW_OPTS, queryEmbedding: qEmb });
      const top = r.hits?.[0] as NormativeHit | undefined;
      if (top && cwCandidateAccepted(finding.lvc_category, top, tau)) cw = hitToSource(top, 0);
    } catch (e) { console.warn('[normative-grounding] CW leg failed', (e as Error).message); }
  }

  if (runGuideline) {
    try {
      const r = await retrieveFn(q, { ...GUIDELINE_OPTS, queryEmbedding: qEmb });
      const top = r.hits?.[0] as NormativeHit | undefined;
      if (top && guidelineCandidateAccepted(top, tau)) guideline = hitToSource(top, 0);
    } catch (e) { console.warn('[normative-grounding] guideline leg failed', (e as Error).message); }
  }

  if (runEven) {
    try {
      const r = await retrieveFn(q, { ...EVEN_OPTS, queryEmbedding: qEmb });
      const top = r.hits?.[0] as NormativeHit | undefined;
      if (top && evenCandidateAccepted(finding.lvc_category, top, deps.evenCategoryLookup!, tau)) even = hitToSource(top, 0);
    } catch (e) { console.warn('[normative-grounding] even leg failed', (e as Error).message); }
  }

  return { cw, guideline, even, citations: mergeNormativeCitations([cw, guideline, even]) };
}
