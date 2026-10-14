/**
 * Stage 4 — v0 Adherence from document audits + surgical feedback.
 *
 * Lock (2026-09-22): Start Adherence scoring in Surgical ELO now from available
 * document audits and other surgical feedback. Honest empty when none — do not
 * defer to Stage 5.
 *
 * Pure shaping only. Callers pass counted inputs; this module invents no volumes.
 */

export type AdherenceState = "empty" | "live";

export interface AdherenceInputs {
  /** Document-audit findings counted toward adherence (any status). */
  auditFindingCount: number;
  /** Findings that closed remediated (positive adherence signal). */
  remediatedCount: number;
  /** Open / contested / escalated findings (negative pressure). */
  openPressureCount: number;
  /** Surgical feedback / case observations feeding adherence streams (when present). */
  surgicalFeedbackCount: number;
  /** Optional pre-computed percent from score_snapshots.adherence_score. */
  snapshotPercent: number | null;
}

export interface AdherencePresentation {
  state: AdherenceState;
  label: string;
  percent: number | null;
  /** Short honesty line for Surgical ELO chrome. */
  detail: string;
  sourceSummary: string;
}

export const ADHERENCE_EMPTY_LABEL = "None yet";

export function emptyAdherenceInputs(): AdherenceInputs {
  return {
    auditFindingCount: 0,
    remediatedCount: 0,
    openPressureCount: 0,
    surgicalFeedbackCount: 0,
    snapshotPercent: null,
  };
}

/**
 * v0 score:
 * - Prefer live score_snapshots.adherence_score when present.
 * - Else derive from document-audit remediated ratio + surgical feedback presence.
 * - Empty when no audits and no surgical feedback and no snapshot.
 */
export function computeAdherencePresentation(inputs: AdherenceInputs): AdherencePresentation {
  const hasAudits = inputs.auditFindingCount > 0;
  const hasSurgical = inputs.surgicalFeedbackCount > 0;
  const hasSnapshot =
    inputs.snapshotPercent !== null && Number.isFinite(inputs.snapshotPercent);

  if (!hasAudits && !hasSurgical && !hasSnapshot) {
    return {
      state: "empty",
      label: ADHERENCE_EMPTY_LABEL,
      percent: null,
      detail:
        "No document audits or surgical feedback yet. Adherence stays empty rather than inventing a score.",
      sourceSummary: "0 audits · 0 surgical feedback",
    };
  }

  if (hasSnapshot) {
    const pct = Math.max(0, Math.min(100, Math.round(inputs.snapshotPercent as number)));
    return {
      state: "live",
      label: `${pct}%`,
      percent: pct,
      detail: "From Surgical ELO score snapshots (live).",
      sourceSummary: sourceLine(inputs),
    };
  }

  // Document-audit derived v0: start at 70, + toward remediated, − open pressure.
  let score = 70;
  if (hasAudits) {
    const remRate = inputs.remediatedCount / Math.max(1, inputs.auditFindingCount);
    score = Math.round(40 + remRate * 50 - Math.min(30, inputs.openPressureCount * 4));
  }
  if (hasSurgical && !hasAudits) {
    // Surgical feedback alone without audits: mild positive presence, not a fake 100.
    score = 55;
  } else if (hasSurgical && hasAudits) {
    score = Math.min(100, score + 5);
  }
  score = Math.max(0, Math.min(100, score));

  return {
    state: "live",
    label: `${score}%`,
    percent: score,
    detail: hasAudits
      ? "v0 from document audits (Progress / OT / Discharge) and surgical feedback when present."
      : "v0 from surgical feedback signals — document audits still empty.",
    sourceSummary: sourceLine(inputs),
  };
}

function sourceLine(inputs: AdherenceInputs): string {
  return `${inputs.auditFindingCount} audit findings · ${inputs.surgicalFeedbackCount} surgical feedback`;
}
