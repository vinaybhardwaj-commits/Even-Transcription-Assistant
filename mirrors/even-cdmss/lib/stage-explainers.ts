/**
 * v1.7 Sprint G — per-stage explainer content (lock #27).
 * v2.0.2 — extended for surface-aware copy on /drugs.
 *
 * Each entry rendered in the pipeline-tracker explainer card while that
 * stage is active. Educational + contextual + tied to live state.
 */
export type StageExplainer = { title: string; body: string };

export const STAGE_EXPLAINERS: Record<string, StageExplainer> = {
  expanding: {
    title: 'Generating query variants',
    body: 'Your question is being rewritten into 3 angles — the original phrasing plus 2 variants that approach the topic from different directions (e.g. a diagnostic angle and a management angle). Running 3 searches in parallel catches relevant material that the original wording alone would miss.',
  },
  variants: {
    title: 'Query variants generated',
    body: 'Each variant will now independently search the database. The result sets are unioned, deduplicated, and the highest-scoring matches across all queries are kept.',
  },
  retrieving: {
    title: 'Hybrid retrieval',
    body: 'Running hybrid search across the database — vector similarity (semantic match via 1024-dim embeddings) plus BM25 keyword search, combined by Reciprocal Rank Fusion. The pool of ~190,000 indexed text chunks is narrowed to the most relevant 30.',
  },
  reranking: {
    title: 'Cross-encoder reranking',
    body: 'A second model is re-scoring the top results against your question. Vector search is fast at finding candidates but isn’t great at ranking them — the reranker takes 30 candidates, scores each (question, candidate) pair, and keeps the top 8. This is where retrieval quality often comes from.',
  },
  fusing: {
    title: 'Source-quality fusion',
    body: 'Each retained chunk is weighted by source quality — board-review textbooks weighted higher than secondary references, longer focused passages weighted higher than fragments. The final sort applies this weight before the answer-writing model sees them.',
  },
  drafting: {
    title: 'Drafting answer',
    body: 'The reasoning model is writing the first draft of your answer, citing every clinical claim against the source chunks shown above. This is the slowest single step — large model, long context window, careful generation.',
  },
  reviewing: {
    title: 'Auditing draft',
    body: 'The draft is being audited by a second model that looks for unsupported claims, missing caveats, clinical errors, and citation problems. If it finds issues, the draft will be revised. If the draft is clean, you see it as-is.',
  },
  revising: {
    title: 'Revising draft',
    body: 'The audit found issues. The audit model is now rewriting the draft to fix every flagged problem while preserving the parts that were correct. The revised answer replaces the draft that streamed earlier.',
  },
  generating: {
    title: 'Generating answer',
    body: 'The reasoning model is writing your answer in one pass, citing every clinical claim against the source chunks. (Self-critique is off — no audit step will follow.)',
  },
  finalizing: {
    title: 'Finalizing answer',
    body: 'Final formatting and persistence of the answer to your trace history.',
  },
  parsing: { title: 'Parsing response', body: 'Parsing the model’s structured response.' },
  persisting: { title: 'Saving trace', body: 'Persisting the full pipeline trace for forensic review.' },
  done: { title: 'Done', body: '' },
};

// v2.0.2 — /drugs/lookup runs a 3-phase pipeline (fast skeleton → pharmacology
// with self-critique → extras). The shared 'generating' / 'reviewing' / 'revising'
// stages mean something more specific here, and the /ask-style copy was confusing
// V (e.g. "Self-critique is off" appeared even though pharmacology DOES audit).
const DRUGS_EXPLAINERS: Record<string, StageExplainer> = {
  retrieving: {
    title: 'Pharmacology retrieval',
    body: 'Searching the indexed drug-information corpus for the most relevant pharmacology excerpts (mechanism, dosing, contraindications, AEs). In parallel, PubChem is queried for canonical identifiers, ATC codes, and pharmacological action classification.',
  },
  generating: {
    title: 'Three-phase generation',
    body: 'The drug card is built in three phases: (1) fast skeleton with the smaller model, (2) deep pharmacology with the reasoning model — this phase is audited and may be revised, (3) extras (formulations, interactions, special populations, pearls). Phase 2 is the longest single step (~2-4 min).',
  },
  reviewing: {
    title: 'Auditing pharmacology JSON',
    body: 'The fast model is auditing the pharmacology JSON the reasoning model just produced — checking each claim against the cited source excerpts and flagging unsupported claims, missing critical info, dosing errors, or missing safety signals. If it finds any, the reasoning model will revise.',
  },
  revising: {
    title: 'Revising pharmacology JSON',
    body: 'The audit flagged issues. The reasoning model is rewriting the pharmacology JSON to fix every problem the auditor identified while preserving the parts that were correct.',
  },
  expanding: {
    title: 'Resolving drug name',
    body: 'Normalizing the input to a canonical generic INN name. PubChem is tried first (instant, deterministic, cached) for brand-name shortcuts; falls back to the LLM normalizer for India-specific brands PubChem doesn’t carry.',
  },
};

const DRUGS_INTERACTIONS_EXPLAINERS: Record<string, StageExplainer> = {
  expanding: {
    title: 'Normalizing all drugs',
    body: 'Each drug name is being resolved to its canonical generic INN in parallel via PubChem (fast, deterministic) with LLM fallback. This catches Indian brand names like Glycomet → metformin before any retrieval runs.',
  },
  retrieving: {
    title: 'Pairwise excerpt retrieval + class-overlap check',
    body: 'For n drugs we check n(n-1)/2 pairs. PubChem ATC codes pre-flag any pair that shares a pharmacological class (e.g. two anticoagulants → class B01A overlap) so the LLM never misses a same-class duplication. In parallel, source excerpts are retrieved for each pair.',
  },
  generating: {
    title: 'Analyzing pairs',
    body: 'The reasoning model is analyzing each drug pair against the retrieved excerpts and class-overlap pre-flags, classifying severity (contraindicated / major / moderate / minor) and writing the mechanism + management for each interaction.',
  },
  parsing: {
    title: 'Deduplicating pairs',
    body: 'The model sometimes returns the same pair twice (e.g. warfarin↔apixaban and apixaban↔warfarin). Final pass deduplicates by canonical pair key and keeps the most severe classification.',
  },
};


// v2.0.3b — /ddx generates a structured differential diagnosis JSON, not free-text.
// The shared 'drafting'/'reviewing'/'revising' copy is /ask-flavored ("draft of your
// answer" implies a written response); /ddx-specific copy is clearer for clinicians.
const DDX_EXPLAINERS: Record<string, StageExplainer> = {
  expanding: {
    title: 'Expanding the clinical question',
    body: 'Compiling the chief complaint + history + exam + vitals into a structured query, and (if Multi-query is on) generating 3 reformulations from different diagnostic angles (e.g. "what could present with these vitals", "what are the cannot-miss causes of this CC"). All variants then run in parallel against the textbook + PLOS corpus.',
  },
  retrieving: {
    title: 'Pulling relevant evidence',
    body: 'Hybrid retrieval across MKSAP/Harrison\u2019s/Cecil/Kaplan textbook chunks plus PLOS ONE clinical case literature (last 5 years). Source quality + reranker run inline. The pool narrows to the most relevant excerpts for differential generation.',
  },
  drafting: {
    title: 'Drafting the differential',
    body: 'The reasoning model is enumerating likely diagnoses, ranking by clinical likelihood, identifying cannot-miss conditions, and proposing distinguishing features + next investigations for each. Slowest single step \u2014 expect 30-60s.',
  },
  reviewing: {
    title: 'Auditing the DDx',
    body: 'A second pass checks for missing cannot-miss diagnoses, likelihood errors (over- or under-weighting), unsupported clinical claims, and gaps in distinguishing features or investigations. If issues are found, the DDx will be revised.',
  },
  revising: {
    title: 'Revising the DDx',
    body: 'The audit flagged issues. The reasoning model is regenerating the differential to fix every problem the auditor identified \u2014 adding missing cannot-miss diagnoses, correcting likelihood weights, tightening distinguishing features.',
  },
  generating: {
    title: 'Reasoning through the case',
    body: 'Single-pass reasoning (self-critique is off). The reasoning model is generating the differential without an audit/revision step \u2014 faster but no second-opinion check.',
  },
  parsing: {
    title: 'Parsing the differential JSON',
    body: 'Converting the model output into the structured DDx schema (cannot-miss diagnoses, likelihood %, distinguishing features, next investigations, PLOS citation IDs).',
  },
};

/**
 * Get the explainer for a stage on a given surface. Falls back to the shared
 * STAGE_EXPLAINERS map when the surface doesn't have a custom override.
 * Callers that don't pass a surface get the original /ask-flavored copy.
 */
export function getStageExplainer(stage: string, surface?: string): StageExplainer | undefined {
  if (surface === 'drugs') return DRUGS_EXPLAINERS[stage] ?? STAGE_EXPLAINERS[stage];
  if (surface === 'drugs-interactions') return DRUGS_INTERACTIONS_EXPLAINERS[stage] ?? STAGE_EXPLAINERS[stage];
  if (surface === 'ddx') return DDX_EXPLAINERS[stage] ?? STAGE_EXPLAINERS[stage];
  return STAGE_EXPLAINERS[stage];
}
