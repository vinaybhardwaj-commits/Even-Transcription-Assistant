// lib/right-care-state.ts — Right Care × ClinicalState (Slice 1): the shared construct-from-input
// adapter for the three Right Care submodules (Order check · Care pathway · Record audit), on the
// DDx Phase-1a model. CONSTRUCT + SURFACE + PERSIST only — the state feeds NOTHING back into any
// mode's reasoning (that is Slice 2, parked behind a golden A/B). Fail-open by contract: every
// entry point catches internally and returns null rather than throwing, so a construction failure
// can never change a mode's existing output.
//
// PURE except process.env flag reads: composes the pure extraction layer (deterministicExtract,
// normalizeWithLlm, extractedCaseToState) with an INJECTED ChatFn — no ./db, no ./llm here. All
// Neon I/O stays in lib/appropriateness-runs.ts / lib/record-audit-link-store.ts; the identity
// capture stays in the doc-audit route layer. No member identity enters this module or the state.

import { deterministicExtract, normalizeWithLlm, mergeLlmFindings, type ChatFn, type ExtractInput } from './clinical-state/extract';
import { extractedCaseToState } from './clinical-state/to-audit-family';
import { validateClinicalState, type ClinicalState } from './clinical-state/schema';
import { formatClinicalState } from './clinical-state/format';
import type { ExtractedCase } from './doc-audit-core';
import type { RunMode } from './appropriateness-runs';

/** Master gate for the whole feature (Part D). Default OFF → every touched route is unchanged. */
export function rightCareStateEnabled(): boolean {
  return process.env.RIGHT_CARE_CLINICAL_STATE === '1';
}

/** Slice 2 gate — ground the reasoning in the state. REQUIRES the master flag (the state must
 *  be built to inject it). Default OFF; ships OFF; flips per mode only after the golden A/B +
 *  V ratification. When off, build order and every prompt are unchanged from Slice 1. */
export function rightCareGroundingEnabled(): boolean {
  return rightCareStateEnabled() && process.env.RIGHT_CARE_CLINICAL_STATE_GROUND === '1';
}

/** The PATIENT PICTURE block injected into a mode's reasoning prompt (Slice 2). One composer
 *  so every mode ships the identical delimiters + rules: "Not mentioned" is genuinely unknown
 *  (never assume), and the model must not introduce a finding the picture doesn't state. */
export function patientPictureBlock(state: ClinicalState): string {
  return [
    'PATIENT PICTURE (structured, machine-extracted from the input above — authoritative for what is stated, negative, and not mentioned):',
    formatClinicalState(state),
    'Picture rules: treat every "Not mentioned" item as genuinely unknown — never assume it either way; do not introduce any finding this picture does not state.',
  ].join('\n');
}

export interface BuiltState { state: ClinicalState; rejectedSpans: number }

/** Build a ClinicalState from the mode's provided input, DDx-style. Stage 1 is deterministic;
 *  the stage-2 LLM normalisation runs only when CLINICAL_STATE_LLM=1 AND a chat fn is injected,
 *  and its failure falls back to the stage-1 state (never discards it). Returns null on any
 *  stage-1 error — the caller's output must be unchanged either way. */
export async function buildRightCareState(input: ExtractInput, chat?: ChatFn): Promise<BuiltState | null> {
  try {
    let state = deterministicExtract(input);
    let rejectedSpans = 0;
    if (process.env.CLINICAL_STATE_LLM === '1' && chat) {
      try {
        const llm = await normalizeWithLlm(input, chat);
        state = mergeLlmFindings(state, llm);
        rejectedSpans = llm.rejected.length;
      } catch {
        // LLM enrichment is additive — keep the deterministic state.
      }
    }
    return { state, rejectedSpans };
  } catch {
    return null;
  }
}

/** ExtractInput for the two typed-input modes (Part A). Order check carries the scenario plus the
 *  candidate orders; Care pathway carries the presentation. Surface is 'appropriateness' for both
 *  (the Surface union already declares it). */
export function rightCareExtractInput(
  mode: 'check' | 'pathway',
  args: { scenario: string; proposedActions?: string[]; age?: number | string; sex?: string },
): ExtractInput {
  return {
    surface: 'appropriateness',
    age: args.age,
    sex: args.sex,
    fields: mode === 'check'
      ? { scenario: args.scenario, proposedActions: args.proposedActions?.join('; ') }
      : { presentation: args.scenario },
  };
}

/** Server-side state reconstruction for persistence (Part C). save-run rebuilds the state from
 *  the run's OWN stored input through the same pure builders — it never trusts a client-supplied
 *  state blob. Deterministic stage only (the LLM pass is a per-request enrichment; DDx Phase-1a
 *  likewise persists via its trace). Returns a schema-validated state or null; never throws. */
export function stateForRun(mode: RunMode, input: unknown): ClinicalState | null {
  try {
    if (!input || typeof input !== 'object') return null;
    const o = input as Record<string, unknown>;
    let state: ClinicalState;
    if (mode === 'audit') {
      // The audit run's input IS the de-identified ExtractedCase the client analyzed.
      if (typeof o.courseSummary !== 'string' || !Array.isArray(o.investigations)) return null;
      state = extractedCaseToState(o as unknown as ExtractedCase);
    } else {
      const scenario = typeof o.scenario === 'string' ? o.scenario.trim() : '';
      if (!scenario) return null;
      const proposedActions = Array.isArray(o.proposedActions)
        ? (o.proposedActions as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim())
        : undefined;
      const p = (o.patient ?? {}) as { age?: unknown; sex?: unknown };
      state = deterministicExtract(rightCareExtractInput(mode, {
        scenario,
        proposedActions,
        age: typeof p.age === 'number' || typeof p.age === 'string' ? p.age : undefined,
        sex: typeof p.sex === 'string' ? p.sex : undefined,
      }));
    }
    return validateClinicalState(state);
  } catch {
    return null;
  }
}
