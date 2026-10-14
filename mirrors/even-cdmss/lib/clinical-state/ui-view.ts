// lib/clinical-state/ui-view.ts — Build 1c. Trims the already-computed ClinicalState into
// the clinician-facing view returned on the /api/ddx response, and gates it behind the
// CLINICAL_STATE_UI flag. PURE: no db/llm/IO. The gate is the neutrality contract — when
// disabled, clinicalStateResultField returns {} so the result payload is byte-identical to
// today (spreading {} adds nothing). The panel is a pure consumer of this additive field.

import { stateCounts, type ClinicalState, type ClinicalFinding, type Demographics, type Instability } from './schema';
import type { InvestigationFinding } from '../investigations';
import type { TimelineItem } from '../ccb-dossier-core';

/** The trimmed, client-facing projection of ClinicalState: exactly what the /ddx panel
 *  renders (findings by status, instability, investigations, temporality, provenance, counts,
 *  rejected-span count). Omits surfaceExtras and the audit-only slots. */
export interface ClinicalStateUiView {
  version: string;
  demographics: Demographics;
  instability: Instability;
  positives: ClinicalFinding[];
  negatives: ClinicalFinding[];
  unknowns: ClinicalFinding[];
  investigations: InvestigationFinding[];
  timeline: TimelineItem[];
  counts: Record<string, number>;
  rejectedSpans: number;   // count of LLM findings rejected for a non-matching span (0 when stage-2 off)
}

export function toClinicalStateUiView(state: ClinicalState, rejectedSpans = 0): ClinicalStateUiView {
  return {
    version: state.version,
    demographics: state.demographics,
    instability: state.instability,
    positives: state.positives,
    negatives: state.negatives,
    unknowns: state.unknowns,
    investigations: state.investigations,
    timeline: state.timeline,
    counts: stateCounts(state),
    rejectedSpans,
  };
}

/** The additive `clinicalState` field for the /api/ddx result — or `{}` when the flag is off
 *  or no state was built. Spread into the result data object: `{ ...data, ...field }`. When
 *  off it contributes nothing, so the response is byte-identical to today (the 1c neutrality
 *  contract). `enabled` is passed by the route (process.env.CLINICAL_STATE_UI === '1'). */
export function clinicalStateResultField(
  state: ClinicalState | null | undefined,
  rejectedSpans: number,
  enabled: boolean,
): { clinicalState?: ClinicalStateUiView } {
  if (!enabled || !state) return {};
  return { clinicalState: toClinicalStateUiView(state, rejectedSpans) };
}
