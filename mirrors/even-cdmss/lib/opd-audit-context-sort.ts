/**
 * 0.81.8 Part C — the frequent-flier sort for the /admin/opd-audit note list, kept as a PURE module so the
 * comparator is unit-testable (the table itself is a 'use client' component). ADVISORY only: it reads the
 * stored longitudinal block's counts and NEVER the scored band. Default list order is unchanged (worst-first);
 * this is one opt-in cycle state.
 */

/** The subset of a note row the comparator reads (mirrors AuditRow's context fields). */
export interface ContextSortRow {
  context?: string | null;       // established | thin | none | null (no longitudinal block)
  encounters?: number | null;    // prior encounters from contextMeta
  longFindings?: number | null;  // longitudinal findings on this note
  index: number;                 // note-quality index (worst-first tiebreak)
}

/**
 * Decision 12 tiering (most frequent-flier first):
 *   longitudinal-findings DESC → prior-encounters DESC → block-with-no-findings by encounters DESC
 *   → `none` (a block with 0 encounters) → no-block (null context) LAST.
 * Implemented as: any block before no-block; then findings DESC; then encounters DESC; then worst-first.
 */
export function frequentFlierCmp(a: ContextSortRow, b: ContextSortRow): number {
  const aBlock = a.context ? 0 : 1, bBlock = b.context ? 0 : 1;
  if (aBlock !== bBlock) return aBlock - bBlock;              // any longitudinal block before no-block
  const af = a.longFindings || 0, bf = b.longFindings || 0;
  if (af !== bf) return bf - af;                              // longitudinal findings DESC
  const ae = a.encounters || 0, be = b.encounters || 0;
  if (ae !== be) return be - ae;                             // prior encounters DESC
  return a.index - b.index;                                  // stable worst-first within the tier
}

export type SortMode = 'index' | 'time' | 'frequentFlier';
export const SORT_NEXT: Record<SortMode, SortMode> = { index: 'time', time: 'frequentFlier', frequentFlier: 'index' };
export const SORT_LABEL: Record<SortMode, string> = { index: 'worst first', time: 'newest', frequentFlier: 'frequent flier' };
