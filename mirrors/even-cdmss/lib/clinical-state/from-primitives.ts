// lib/clinical-state/from-primitives.ts — populate ClinicalState from the primitives
// the codebase ALREADY has (wire, don't invent): parseInvestigations' output,
// concordance-core's unit inference / priors / cannot-miss floor, and the CCB
// timeline merge. Pure wiring — no ./llm, no ./db, no network.

import {
  type ClinicalState, type ClinicalFinding, mkFindingId,
} from './schema';
import { deterministicExtract, type ExtractInput } from './extract';
import type { ParsedInvestigations, InvestigationFinding } from '../investigations';
import {
  floorFor, type FloorRule,
  unitAnnotations, type UnitAnnotation,
  effectivePrior, coarseBand, type EffectivePrior,
} from '../concordance-core';
import { mergeTimeline, type TimelineItem } from '../ccb-dossier-core';

/** Fold parsed investigations into the state: the structured findings land in
 *  state.investigations verbatim; abnormal ones ALSO become positive findings with
 *  provenance (they are stated patient findings for reasoning surfaces). */
export function applyParsedInvestigations(state: ClinicalState, parsed: ParsedInvestigations | null): ClinicalState {
  if (!parsed) return state;
  const abnormalAsFindings: ClinicalFinding[] = parsed.findings
    .filter((f) => f.flag !== 'normal' && f.flag !== 'indeterminate')
    .map((f) => ({
      id: mkFindingId(f.note || f.test, 'investigations', 'present'),
      concept: f.note || f.test,
      status: 'present' as const,
      value: f.value || undefined,
      unit: f.unit ?? undefined,
      provenance: {
        sourceField: 'investigations',
        rawText: [f.test, f.value, f.unit].filter(Boolean).join(' '),
        extractionMethod: 'llm' as const, // parseInvestigations is an LLM normalisation of reported results
        confidence: parsed.structured ? 0.75 : 0.5,
      },
    }));
  return {
    ...state,
    investigations: [...state.investigations, ...parsed.findings],
    positives: [...state.positives, ...abnormalAsFindings],
  };
}

/** Cannot-miss floor rules applicable to this state's investigations (concordance-core). */
export function floorRulesFor(state: ClinicalState): FloorRule[] {
  const text = investigationsText(state);
  return text ? floorFor(text) : [];
}

/** Unit inference for investigation rows that lack units (concordance-core magnitudes). */
export function unitAnnotationsFor(state: ClinicalState): UnitAnnotation[] {
  const text = investigationsText(state);
  return text ? unitAnnotations(text) : [];
}

/** The sex×age-stratified population prior for an analyte, given this state's demographics. */
export function priorFor(state: ClinicalState, analyte: string): EffectivePrior | null {
  const age = state.demographics.age ?? null;
  return effectivePrior(analyte, state.demographics.sex ?? null, coarseBand(age));
}

/** Merge timeline slices into the state via the CCB house merge (newest-first, deduped). */
export function withTimeline(state: ClinicalState, ...slices: TimelineItem[][]): ClinicalState {
  return { ...state, timeline: mergeTimeline(state.timeline, ...slices) };
}

function investigationsText(state: ClinicalState): string {
  return state.investigations.map((f: InvestigationFinding) => [f.test, f.value, f.unit].filter(Boolean).join(' ')).join('; ');
}

/** The 1a DDx builder: deterministic stage-1 extraction over the request body fields,
 *  then the already-parsed investigations folded in. NO LLM call here — the stage-2
 *  normalisation (extract.normalizeWithLlm) is wired by the caller when flagged on. */
export function buildDdxClinicalState(
  body: { age?: number | string; sex?: string; cc?: string; history?: string; exam?: string; vitals?: string },
  investigations: ParsedInvestigations | null,
): ClinicalState {
  const input: ExtractInput = {
    surface: 'ddx',
    age: body.age,
    sex: body.sex,
    fields: { complaint: body.cc, history: body.history, exam: body.exam, vitals: body.vitals },
  };
  return applyParsedInvestigations(deterministicExtract(input), investigations);
}
