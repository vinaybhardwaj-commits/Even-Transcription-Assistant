/**
 * lib/pathway.ts — Pathway & Decision passes (PW.2), wired.
 *
 * Two-stage, per V's latency choice:
 *   traceSkeleton()  — Gemini-FLASH, fast: classify the input's stage + return the
 *                      ordered care-path spine (first paint in seconds).
 *   enrichPathway()  — Gemini-PRO: retrieve() guideline excerpts over the GENERAL
 *                      corpus, enrich each node (detail / decision-criteria / grounded
 *                      evidence vs labeled estimates / alternatives), then inject the
 *                      real EHRC tariff DETERMINISTICALLY for any orderable node.
 *
 * Both traced ('pathway' / 'pathway_enrich') and both soft-fail (skeleton → null,
 * enrich → null) so a slow/unavailable Vertex never breaks the /appropriateness
 * surface. No CW-seed dependency — works now. See CDMSS-PATHWAY-DECISION-PRD-v1.0.md.
 */

import { retrieve } from './retrieve';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { startTrace, logEvent, finishTrace, governedChat, withTrace } from './trace';
import { matchAnyTariffs } from './charge-master';
import { hitsToSources, buildCitedContext, type CiteHit, type Source } from './citations-core';
import { parseCritique } from './lvc-value-core';
import * as core from './pathway-core';
import type { PathwaySkeleton, PathwayEnrichment, SkeletonStage } from './pathway-core';

export interface PathwayInput {
  scenario: string;
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  /** Slice 2 (Right Care × ClinicalState): the pre-composed PATIENT PICTURE block, threaded
   *  into BOTH pathway prompts (skeleton + enrich). OPTIONAL — omitted (the default, and
   *  always when RIGHT_CARE_CLINICAL_STATE_GROUND is off) → prompts byte-identical to Slice 1. */
  clinicalStateText?: string;
  trace?: boolean;
  /** Lab probe: force the FREE local mini (no Gemini) for ₹0 pipeline testing. Default false. */
  forceOllama?: boolean;
}
export interface EnrichInput extends PathwayInput {
  stages: SkeletonStage[];
  workingDiagnosis?: string | null;
  /** Live progress callback for NDJSON streaming (stage, human message). */
  onProgress?: (stage: string, msg: string) => void;
}

export interface SkeletonResult { skeleton: PathwaySkeleton | null; traceId?: string }
export interface EnrichResult { enrichment: PathwayEnrichment | null; sources: Source[]; excerptCount: number; traceId?: string }

/** Injection seams for tests (defaults hit the real backend). promptRef (Stage 1) is the
 *  Stage-0 registry id of the system prompt — an additive envelope tag, never the prompt. */
export interface SkeletonDeps { generate: (system: string, user: string, traceId?: string) => Promise<string> }
export interface EnrichDeps {
  retrieveHits: (q: string) => Promise<CiteHit[]>;
  generate: (system: string, user: string, label: string, promptRef?: string) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string, promptRef?: string): Promise<any> {
  return governedChat(traceId, label, params, { gemini: geminiModel, promptRef });
}

// ─────────────────────────────────────────────────────────────────────────────
// SKELETON (Flash)
// ─────────────────────────────────────────────────────────────────────────────

async function defaultSkeletonGenerate(system: string, user: string, traceId?: string, forceOllama = false): Promise<string> {
  // Flash utility model (honours GEMINI_ALL / GEMINI_UTILITY); soft-falls to local Ollama.
  const geminiModel = forceOllama ? undefined : geminiUtilityModel();
  const r = await llmCall(traceId, 'pathway_skeleton', {
    model: 'llama3.1:8b',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 800,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel, 'pathway-core/SKELETON_SYSTEM');
  return r.choices?.[0]?.message?.content || '';
}

export async function traceSkeleton(input: PathwayInput, deps: Partial<SkeletonDeps> = {}): Promise<SkeletonResult> {
  const doTrace = input.trace !== false;

  // Stage 1 (guaranteed finalize): status-guarded withTrace closes any trace left 'running';
  // the explicit finishTrace calls below still set the real statuses first (behaviour unchanged).
  const run = async (traceId?: string): Promise<SkeletonResult> => {
  const generate = deps.generate ?? ((s: string, u: string) => defaultSkeletonGenerate(s, u, traceId, input.forceOllama === true));
  try {
    const user = core.buildSkeletonUser(input);
    const raw = await generate(core.SKELETON_SYSTEM, user, traceId);
    const skeleton = core.parseSkeleton(raw);
    if (traceId) {
      await logEvent(traceId, 'pathway_skeleton_result', null, {
        ok: !!skeleton,
        detectedStage: skeleton?.detectedStage,
        workingDiagnosis: skeleton?.workingDiagnosis ?? null,
        diagnosisCertainty: skeleton?.diagnosisCertainty,
        needsDdx: skeleton?.needsDdx,
        anchorNote: skeleton?.anchorNote ?? null,
        stages: skeleton?.stages.map((s) => ({ id: s.id, kind: s.kind, flag: s.flag })) ?? [],
      });
      await finishTrace(traceId, skeleton ? 'success' : 'partial');
    }
    return { skeleton, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[pathway] traceSkeleton failed', (e as Error).message);
    return { skeleton: null, traceId };
  }

  };

  if (!doTrace) return run(undefined);
  return withTrace('pathway', {
    scenario: input.scenario.slice(0, 500), proposedActions: input.proposedActions, patient: input.patient,
  }, run);
}

// ─────────────────────────────────────────────────────────────────────────────
// ENRICH (Pro)
// ─────────────────────────────────────────────────────────────────────────────

async function defaultRetrieveHits(q: string): Promise<CiteHit[]> {
  try {
    // Reranker ON (matches Ask/DDx) — stronger retrieval than the old no-rerank pass.
    const r = await retrieve(q, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[pathway] retrieve failed', (e as Error).message);
    return [];
  }
}

async function defaultEnrichGenerate(system: string, user: string, label: string, traceId: string | undefined, maxTokens: number, promptRef?: string): Promise<string> {
  // Pro reasoning for enrichment (honours GEMINI_ALL); soft-falls to local Ollama.
  const geminiModel = geminiModelFor('pathway') ?? geminiUtilityModel();
  const r = await llmCall(traceId, label, {
    model: TEXT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel, promptRef);
  return r.choices?.[0]?.message?.content || '';
}

export async function enrichPathway(input: EnrichInput, deps: Partial<EnrichDeps> = {}): Promise<EnrichResult> {
  const stages = (input.stages ?? []).slice(0, 8);
  if (stages.length === 0) return { enrichment: null, sources: [], excerptCount: 0 };

  const doTrace = input.trace !== false;
  const doAudit = process.env.PATHWAY_AUDIT !== '0';
  const traceId = doTrace
    ? await startTrace('pathway_enrich', {
        scenario: input.scenario.slice(0, 500), workingDiagnosis: input.workingDiagnosis,
        stageIds: stages.map((s) => s.id), patient: input.patient,
      })
    : undefined;

  const retrieveHits = deps.retrieveHits ?? defaultRetrieveHits;
  const generate = deps.generate
    ?? ((s: string, u: string, label: string, promptRef?: string) => defaultEnrichGenerate(s, u, label, traceId, label === 'pathway_enrich_critique' ? 800 : 2500, promptRef));

  const ids = stages.map((s) => s.id);
  const prog = input.onProgress ?? (() => {});

  try {
    prog('retrieving', 'Retrieving evidence from the corpus…');
    const query = [
      input.scenario,
      input.workingDiagnosis ?? '',
      ...stages.map((s) => `${s.title} ${s.action}`),
      'management workup treatment indications evidence guideline',
    ].filter(Boolean).join('. ');
    const hits = await retrieveHits(query);
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    prog('retrieving', `Retrieved ${sources.length} sources`);
    if (traceId) await logEvent(traceId, 'pathway_sources', null, { count: sources.length, ids: sources.map((s) => ({ n: s.n, book: s.book, url: s.url })) });

    const user = core.buildEnrichUser(
      { scenario: input.scenario, proposedActions: input.proposedActions, patient: input.patient, workingDiagnosis: input.workingDiagnosis, clinicalStateText: input.clinicalStateText },
      stages,
      citedContext,
    );
    prog('enriching', 'Enriching each step…');
    const draftRaw = await generate(core.ENRICH_SYSTEM, user, 'pathway_enrich', 'pathway-core/ENRICH_SYSTEM');
    let enrichment = core.parseEnrichment(draftRaw, ids, sources.length);

    // ── Citation self-critique + revise ──────────────────────────────────────
    if (doAudit && enrichment) {
      try {
        prog('reviewing', 'Auditing citations…');
        const critiqueRaw = await generate(core.ENRICH_CRITIQUE_SYSTEM, core.buildEnrichCritiqueUser(input.scenario, citedContext, draftRaw), 'pathway_enrich_critique', 'pathway-core/ENRICH_CRITIQUE_SYSTEM');
        const critique = parseCritique(critiqueRaw);
        if (traceId) await logEvent(traceId, 'pathway_enrich_critique', null, {
          severity: critique.severity, needs_revision: critique.needs_revision,
          issues: critique.unsupported_evidence.length + critique.wrong_or_missing_citations.length + critique.misfiled_estimates.length + critique.missing_caveats.length + critique.anchoring.length,
          anchoring: critique.anchoring.length,
        });
        if (critique.needs_revision) {
          prog('revising', 'Revising to fix citations…');
          const revRaw = await generate(core.ENRICH_REVISE_SYSTEM, core.buildEnrichReviseUser(input.scenario, citedContext, draftRaw, JSON.stringify(critique)), 'pathway_enrich', 'pathway-core/ENRICH_REVISE_SYSTEM');
          const revised = core.parseEnrichment(revRaw, ids, sources.length);
          if (revised) enrichment = revised;
        }
      } catch (e) {
        console.warn('[pathway] audit loop failed (keeping draft)', (e as Error).message);
      }
    }

    prog('finalizing', 'Finalizing…');

    // Deterministic EHRC tariff grounding: for each node naming a concrete order,
    // attach the real local price (never let the LLM produce the cost figure).
    if (enrichment) {
      for (const n of enrichment.nodes) {
        if (n.order) {
          const t = matchAnyTariffs([n.order]);
          if (t.length) n.tariffs = t;
        }
      }
      if (traceId) {
        await logEvent(traceId, 'pathway_tariffs', null, {
          matched: enrichment.nodes.filter((n) => n.tariffs?.length).map((n) => ({ id: n.id, order: n.order, codes: n.tariffs!.map((t) => t.code) })),
        });
      }
    }

    if (traceId) {
      await logEvent(traceId, 'pathway_enrich_result', null, {
        ok: !!enrichment,
        nodes: enrichment?.nodes.map((n) => ({ id: n.id, flag: n.flag, hasOrder: !!n.order, cites: n.citation_ids, tariffs: n.tariffs?.length ?? 0 })) ?? [],
      });
      await finishTrace(traceId, enrichment ? 'success' : 'partial');
    }
    return { enrichment, sources, excerptCount: hits.length, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[pathway] enrichPathway failed', (e as Error).message);
    return { enrichment: null, sources: [], excerptCount: 0, traceId };
  }
}

export type { Source } from './citations-core';

export type { PathwaySkeleton, PathwayEnrichment, SkeletonStage, EnrichedNode, MergedStage } from './pathway-core';
