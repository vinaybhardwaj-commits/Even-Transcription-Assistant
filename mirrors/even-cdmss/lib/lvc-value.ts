/**
 * lib/lvc-value.ts — Value Analysis pass (CW-VA), wired + GROUNDED.
 *
 * Reasons about the value of a proposed intervention for THIS patient, grounded by
 * retrieve() over the GENERAL corpus. As of the GC (grounding/citation) upgrade it:
 *   - retrieves WITH the cross-encoder reranker (matching Ask/DDx, not the weaker
 *     no-rerank pass it used before),
 *   - surfaces the retrieved chunks as first-class NUMBERED citations (Source[]) the
 *     clinician can see + click (PubMed link when the chunk is a journal article),
 *   - requires the model to attach citation_ids to each intervention (hybrid grounding:
 *     cite where supported, labelled estimate otherwise),
 *   - runs a citation self-critique + revise loop (like the Ask surface) so unsupported
 *     "evidence" is caught before the clinician sees it.
 *
 * Gemini-Pro reasoning; traced ('appropriateness_value'); soft-fails to null so it can
 * never break the parent /appropriateness response.
 * See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.2.md §14 + the GC grounding plan.
 */

import { retrieve } from './retrieve';
import { geminiModelFor, geminiUtilityModel, TEXT_MODEL } from './llm';
import { startTrace, logEvent, finishTrace, governedChat } from './trace';
import * as vcore from './lvc-value-core';
import type { ValueAnalysis } from './lvc-value-core';
import { matchAnyTariffs, formatTariffForPrompt } from './charge-master';
import { hitsToSources, buildCitedContext, type CiteHit, type Source } from './citations-core';

export interface ValueInput {
  scenario: string;
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  trace?: boolean;
  /** Citation self-critique + revise loop. Default on; env VALUE_AUDIT=0 disables. */
  audit?: boolean;
  /** Live progress callback for NDJSON streaming (stage, human message). */
  onProgress?: (stage: string, msg: string) => void;
  /** Lab probe: force the FREE local mini (no Gemini) for ₹0 pipeline testing. Default false. */
  forceOllama?: boolean;
}

export interface ValueResult {
  valueAnalysis: ValueAnalysis | null;
  sources: Source[];
  excerptCount: number;
  traceId?: string;
}

/** Injection seam for tests. promptRef (Stage 4) is the Stage-0 registry id of the system
 *  prompt — an additive envelope tag, never the prompt itself. */
export interface ValueDeps {
  retrieveHits: (q: string) => Promise<CiteHit[]>;
  generate: (system: string, user: string, label: string, promptRef?: string) => Promise<string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string, promptRef?: string): Promise<any> {
  return governedChat(traceId, label, params, { gemini: geminiModel, promptRef });
}

async function defaultRetrieveHits(q: string): Promise<CiteHit[]> {
  try {
    // NO useNormativeLeg here — this text enters the Value-Analysis JUDGE's prompt, and the
    // normative-source frame ("this care is guideline-concordant") reframes the very judgment we
    // want independent (CDMSS-WORKSPACE-FRAMING-PRINCIPLE §4 RightCare / §6 prompt boundary; R-11
    // measured ~90% signal loss). Vector+BM25+rerank grounding stays; do NOT re-add the leg.
    const r = await retrieve(q, { topK: 8, useReranker: true, useSourceWeights: true, hybrid: true });
    return r.hits.map((h) => ({
      id: h.id, source: h.source, book: h.book, chapter: h.chapter, section: h.section,
      page_start: h.page_start, page_end: h.page_end, item_number: h.item_number,
      chunk_type: h.chunk_type, similarity: h.similarity, text: h.text,
    }));
  } catch (e) {
    console.warn('[lvc-value] retrieve failed', (e as Error).message);
    return [];
  }
}

async function defaultGenerate(system: string, user: string, label: string, traceId: string | undefined, maxTokens: number, forceOllama = false, promptRef?: string): Promise<string> {
  const geminiModel = forceOllama ? undefined : (geminiModelFor('appropriateness') ?? geminiUtilityModel());
  const r = await llmCall(traceId, label, {
    model: TEXT_MODEL,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0.2,
    max_tokens: maxTokens,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  }, geminiModel, promptRef);
  return r.choices?.[0]?.message?.content || '';
}

export async function analyzeValue(input: ValueInput, deps: Partial<ValueDeps> = {}): Promise<ValueResult> {
  const doTrace = input.trace !== false;
  const doAudit = input.audit !== false && process.env.VALUE_AUDIT !== '0';
  const traceId = doTrace
    ? await startTrace('appropriateness_value', {
        scenario: input.scenario.slice(0, 500), proposedActions: input.proposedActions, patient: input.patient,
      })
    : undefined;

  const retrieveHits = deps.retrieveHits ?? defaultRetrieveHits;
  const generate = deps.generate
    ?? ((s: string, u: string, label: string, promptRef?: string) => defaultGenerate(s, u, label, traceId, label === 'lvc_value_critique' ? 700 : 1500, input.forceOllama === true, promptRef));
  const prog = input.onProgress ?? (() => {});

  try {
    prog('retrieving', 'Retrieving evidence from the corpus…');
    const query = [input.scenario, ...(input.proposedActions ?? []), 'benefits harms outcomes complications cost long-term care alternatives']
      .filter(Boolean).join('. ');
    const hits = await retrieveHits(query);
    const sources = hitsToSources(hits);
    const citedContext = buildCitedContext(hits);
    prog('retrieving', `Retrieved ${sources.length} sources`);
    if (traceId) await logEvent(traceId, 'lvc_value_sources', null, { count: sources.length, ids: sources.map((s) => ({ n: s.n, book: s.book, url: s.url })) });

    // Ground the upfront cost in the EHRC charge master (real local price, not an estimate).
    const tariffs = input.proposedActions?.length ? matchAnyTariffs(input.proposedActions) : [];
    if (traceId) await logEvent(traceId, 'lvc_value_tariffs', null, { matched: tariffs.map((t) => ({ code: t.code, item: t.item, general: t.general })) });

    let user = vcore.buildValueUser(input, citedContext);
    if (tariffs.length) {
      user += `\n\nEHRC TARIFF (authoritative local upfront cost — use this, do NOT estimate the upfront cost):\n${tariffs.map(formatTariffForPrompt).join('\n')}`;
    }

    prog('drafting', 'Analyzing value for this patient…');
    const draftRaw = await generate(vcore.VALUE_SYSTEM, user, 'lvc_value', 'lvc-value-core/VALUE_SYSTEM');
    let valueAnalysis = vcore.parseValueResponse(draftRaw, sources.length);

    // ── Citation self-critique + revise ──────────────────────────────────────
    if (doAudit && valueAnalysis) {
      try {
        prog('reviewing', 'Auditing citations…');
        const critiqueRaw = await generate(vcore.VALUE_CRITIQUE_SYSTEM, vcore.buildCritiqueUser(input.scenario, citedContext, draftRaw), 'lvc_value_critique', 'lvc-value-core/VALUE_CRITIQUE_SYSTEM');
        const critique = vcore.parseCritique(critiqueRaw);
        if (traceId) await logEvent(traceId, 'lvc_value_critique', null, {
          severity: critique.severity, needs_revision: critique.needs_revision,
          issues: critique.unsupported_evidence.length + critique.wrong_or_missing_citations.length + critique.misfiled_estimates.length + critique.missing_caveats.length,
        });
        if (critique.needs_revision) {
          prog('revising', 'Revising to fix citations…');
          const revRaw = await generate(vcore.VALUE_REVISE_SYSTEM, vcore.buildReviseUser(input.scenario, citedContext, draftRaw, JSON.stringify(critique)), 'lvc_value', 'lvc-value-core/VALUE_REVISE_SYSTEM');
          const revised = vcore.parseValueResponse(revRaw, sources.length);
          if (revised) valueAnalysis = revised;   // keep the draft if the revise pass didn't parse
        }
      } catch (e) {
        console.warn('[lvc-value] audit loop failed (keeping draft)', (e as Error).message);
      }
    }

    prog('finalizing', 'Finalizing…');
    if (valueAnalysis && tariffs.length) valueAnalysis.tariffs = tariffs;

    if (traceId) {
      await logEvent(traceId, 'lvc_value_result', null, {
        ok: !!valueAnalysis,
        interventions: valueAnalysis?.interventions.map((i) => ({ name: i.intervention, net_value: i.net_value, confidence: i.confidence, cites: i.citation_ids })) ?? [],
      });
      await finishTrace(traceId, 'success');
    }
    return { valueAnalysis, sources, excerptCount: hits.length, traceId };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    console.warn('[lvc-value] analyzeValue failed', (e as Error).message);
    return { valueAnalysis: null, sources: [], excerptCount: 0, traceId };
  }
}

export type { ValueAnalysis, ValueIntervention } from './lvc-value-core';
export type { Source } from './citations-core';
