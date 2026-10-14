/**
 * Pure core for the Learning-Loop flywheel strip (LEARNING-LOOP-V2 §2.1). No db / Next imports:
 * strip-types testable; the page/route fetches the counts and this assembles the view + the two
 * headline ratios. Zero-denominator → null (rendered as "—", never a fake 0%).
 */

/** Safe ratio: null when the denominator is 0 (so the UI shows "—", never 0/0). */
export function ratio(numer: number, denom: number): number | null {
  return denom > 0 ? numer / denom : null;
}
/** Whole-percent string, or "—" for a null ratio. */
export function pct(r: number | null): string {
  return r == null ? '—' : `${Math.round(r * 100)}%`;
}

export interface FlywheelCounts {
  // Audits (this week, IST Mon-start; excluded-filtered, engine family)
  auditsWeek: number; daysElapsed: number; engine: string;
  // Signals (this week)
  findingsWeek: number; labelsWeek: number;
  // Actions (this week)
  approvedByType: { type: string; n: number }[]; suppressionsWeek: number;
  // Better audits (current family, 90d) — the two ratios computed FOR REAL for the first time
  lvcTotal: number; lvcWithRef: number; llmTotal: number; llmGrounded: number;
}
export interface FlywheelView {
  audits: { count: number; perDay: number; engine: string };
  signals: { findings: number; labels: number };
  actions: { approved: { type: string; n: number }[]; suppressions: number };
  better: { attribution: number | null; grounded: number | null };
}

export function buildFlywheel(c: FlywheelCounts): FlywheelView {
  return {
    audits: { count: c.auditsWeek, perDay: Math.round(c.auditsWeek / Math.max(1, c.daysElapsed)), engine: c.engine },
    signals: { findings: c.findingsWeek, labels: c.labelsWeek },
    actions: { approved: (c.approvedByType || []).filter((x) => x.n > 0), suppressions: c.suppressionsWeek },
    better: { attribution: ratio(c.lvcWithRef, c.lvcTotal), grounded: ratio(c.llmGrounded, c.llmTotal) },
  };
}
