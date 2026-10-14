// lib/proms/adhoc-review-core.ts — PROMs Tier-3 review-queue PURE logic (0.2b-2). Groups administered/
// generated adhoc sets by procedure, finds the dominant recurring selection, and classifies each
// procedure as a promotion candidate (dominant selection recurs ≥ PROMOTION_THRESHOLD) or still
// collecting. Deterministic: no Date.now, no randomness, no DB. Tested in isolation; the store feeds it
// rows and the admin route renders the result. Promotion PROPOSES a named set (V-ratified) → never a
// live hs-sets write.

/** A selection recurring at least this many times across the corpus → a promotion candidate (T5). */
export const PROMOTION_THRESHOLD = 5;

/** One adhoc set as the store sees it (only the fields the grouping needs). */
export interface AdhocSetRecord {
  id: string;
  procedureContext: string | null;
  itemIds: string[];
  generatedItemIds?: string[] | null;   // the original LLM selection (pre-trim) — for the edited count
  cmRef?: string | null;
  status?: string | null;               // 'draft' | 'frozen'
}

export interface ReviewCandidate {
  procedureKey: string;                 // normalized (lowercased/collapsed) — the grouping key
  procedureLabel: string;               // a verbatim procedure_context for display
  totalSets: number;                    // all adhoc sets seen for this procedure
  distinctCms: number;                  // how many care managers assembled one
  dominantSelection: string[];          // the most-common selection (sorted item ids)
  recurrenceCount: number;              // how many times the dominant selection recurred
  editedCount: number;                  // sets whose final selection differs from what was generated
  status: 'candidate' | 'collecting';
}

const norm = (s: string | null | undefined): string => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
/** Canonical key for a selection: deduped + sorted so order/dupes never split a recurring set. */
const selKey = (ids: string[]): string => Array.from(new Set((ids || []).map((x) => String(x)))).sort().join('|');

/**
 * Group adhoc sets by procedure → the dominant recurring selection + a candidate/collecting verdict.
 * Only frozen/administered sets should be fed for a promotion decision (drafts are still mutable), but
 * the function is agnostic — the caller filters. Deterministic ordering: candidates first (by recurrence
 * desc, then label), then collecting.
 */
export function groupAdhocForReview(records: AdhocSetRecord[], threshold: number = PROMOTION_THRESHOLD): ReviewCandidate[] {
  const byProc = new Map<string, AdhocSetRecord[]>();
  for (const r of records || []) {
    const k = norm(r.procedureContext);
    if (!k) continue;                                   // no procedure → cannot group
    const arr = byProc.get(k);
    if (arr) arr.push(r); else byProc.set(k, [r]);
  }

  const out: ReviewCandidate[] = [];
  for (const [key, recs] of byProc) {
    const counts = new Map<string, number>();
    for (const r of recs) { const sk = selKey(r.itemIds); counts.set(sk, (counts.get(sk) ?? 0) + 1); }
    let domKey = ''; let domCount = 0;
    for (const [sk, c] of counts) {
      if (c > domCount || (c === domCount && sk < domKey)) { domKey = sk; domCount = c; }   // deterministic tie-break
    }
    const distinctCms = new Set(recs.map((r) => r.cmRef).filter((x): x is string => !!x)).size;
    const editedCount = recs.filter((r) => r.generatedItemIds && selKey(r.itemIds) !== selKey(r.generatedItemIds)).length;
    const procedureLabel = (recs.find((r) => (r.procedureContext || '').trim())?.procedureContext || key).trim();
    out.push({
      procedureKey: key,
      procedureLabel,
      totalSets: recs.length,
      distinctCms,
      dominantSelection: domKey ? domKey.split('|') : [],
      recurrenceCount: domCount,
      editedCount,
      status: domCount >= threshold ? 'candidate' : 'collecting',
    });
  }

  return out.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'candidate' ? -1 : 1;
    if (b.recurrenceCount !== a.recurrenceCount) return b.recurrenceCount - a.recurrenceCount;
    return a.procedureLabel < b.procedureLabel ? -1 : a.procedureLabel > b.procedureLabel ? 1 : 0;
  });
}

/** Suggested house-set name for a promotion proposal (e.g. "Parotidectomy" → "hs-parotid"). Deterministic. */
export function suggestSetName(procedureLabel: string): string {
  const word = norm(procedureLabel).replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean)[0] || 'set';
  return `hs-${word.slice(0, 12)}`;
}
