/**
 * lib/opd-audit/investigations-lookup.ts — "were investigations ordered on this note?", joined from
 * db13 at READ TIME (decision §1.11 — chosen over engine emission so the filter covers the full
 * 25,130-note history immediately).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * THE SCHEMA IS VALIDATED — DO NOT INFER (PRD §2.11).
 *
 *   "individuals-prescriptions"
 *     uid                 ← the join key, onto opd_note_audits.uid
 *     num_investigations  ← bigint. > 0 means investigations were ordered.
 *
 * ⚠️ THE TABLE NAME IS HYPHENATED AND MUST BE DOUBLE-QUOTED. Unquoted, Postgres parses
 * `individuals-prescriptions` as a subtraction between two identifiers.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ NULL MEANS UNKNOWN, NOT ZERO (§8.11). `num_investigations` is populated on 158,576 of 357,464
 * rows — roughly half are null. A null renders as "Unknown" and is matched by NEITHER "Investigations
 * ordered" NOR "None ordered". `None ordered` matches `= 0` EXPLICITLY: never `IS NOT TRUE`, never
 * `COALESCE(..., 0)`. Treating unknown as zero would silently assert that half the OPD corpus
 * ordered nothing, which is a claim the data does not make.
 *
 * FAIL-SOFT (§7.1, §8.8): on any error the filter DISABLES ITSELF with "Temporarily unavailable"
 * and the list renders unfiltered. Never a 500, never a wrong count.
 */

import { metabaseQuery } from '../metabase';

/** db13 note uids. Mirrors the shape lib/metabase.ts already validates. */
const isUid = (s: string) => /^[A-Za-z0-9_-]{6,64}$/.test(s);
const esc = (s: string) => s.replace(/'/g, "''");

/** The three states a note can be in. `unknown` is a first-class answer, not a missing value. */
export type InvestigationsState = 'ordered' | 'none' | 'unknown';

/** The filter options offered on the list (§7.1). */
export type InvestigationsFilter = 'all' | 'ordered' | 'none';

export const INVESTIGATIONS_UNAVAILABLE_NOTICE = 'Temporarily unavailable';

export interface InvestigationsLookupResult {
  /** uid → state. Only uids db13 returned appear; everything else is `unknown` by absence. */
  byUid: Record<string, InvestigationsState>;
  /** True when db13 could not be reached — the caller disables the filter and says so. */
  unavailable: boolean;
}

export const EMPTY_LOOKUP: InvestigationsLookupResult = { byUid: {}, unavailable: false };

/**
 * Classify one raw `num_investigations` value.
 *
 * null / undefined / '' / non-numeric ⇒ `unknown`. A negative value (which should not occur) is
 * also `unknown` rather than being folded into `none` — inventing a reading from a nonsensical one
 * is exactly the failure this module exists to avoid.
 */
export function classifyInvestigations(raw: unknown): InvestigationsState {
  if (raw == null || raw === '') return 'unknown';
  const n = Number(raw);
  if (!Number.isFinite(n)) return 'unknown';
  if (n > 0) return 'ordered';
  if (n === 0) return 'none';
  return 'unknown';
}

/** Does a note in `state` survive `filter`? `unknown` survives ONLY `all`. */
export function matchesInvestigationsFilter(state: InvestigationsState, filter: InvestigationsFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'ordered') return state === 'ordered';
  return state === 'none';   // 'none' matches num_investigations = 0 explicitly; unknown never does
}

export const INVESTIGATIONS_LABEL: Record<InvestigationsState, string> = {
  ordered: 'Investigations ordered',
  none: 'None ordered',
  unknown: 'Unknown',
};

/**
 * BATCHED — one Metabase call per page of results, NEVER one per row (§7.1).
 *
 * ⚠️ ADAPTATION, FLAGGED (same as the Phase B doctor lookup): the PRD writes the query as
 * `WHERE uid = ANY($1)`. `metabaseQuery` posts a NATIVE query string to /api/dataset and takes no
 * bound parameters, so `$1` cannot be supplied. It is an escaped `IN (…)` list instead. The table,
 * the join column and the selected columns are exactly §2.11's. Inputs pass `isUid` and
 * quote-escaping before interpolation.
 */
export async function fetchInvestigationsForUids(uids: (string | null | undefined)[]): Promise<InvestigationsLookupResult> {
  const ids = Array.from(new Set(
    (Array.isArray(uids) ? uids : []).map((u) => String(u ?? '').trim()).filter((u) => u && isUid(u)),
  ));
  if (!ids.length) return EMPTY_LOOKUP;

  let rows: Record<string, unknown>[];
  try {
    const list = ids.map((u) => `'${esc(u)}'`).join(', ');
    rows = await metabaseQuery(
      `SELECT uid, num_investigations
         FROM "individuals-prescriptions"
        WHERE uid IN (${list})`,
    );
  } catch {
    return { byUid: {}, unavailable: true };
  }

  const byUid: Record<string, InvestigationsState> = {};
  for (const r of rows) {
    const uid = String(r.uid ?? '').trim();
    if (!uid) continue;
    // Several prescription rows can share a uid; ORDERED wins over NONE, and any real reading wins
    // over UNKNOWN. Ordering the merge this way means an investigation that WAS ordered is never
    // lost to a sibling row that happens to read 0.
    const state = classifyInvestigations(r.num_investigations);
    const cur = byUid[uid];
    if (cur === 'ordered') continue;
    if (cur === 'none' && state !== 'ordered') continue;
    byUid[uid] = state;
  }
  return { byUid, unavailable: false };
}

/** The state for one uid, defaulting to `unknown` when db13 said nothing about it. */
export function stateFor(lookup: InvestigationsLookupResult, uid: string | null | undefined): InvestigationsState {
  return lookup.byUid[String(uid ?? '').trim()] ?? 'unknown';
}

/**
 * Apply the filter to a page of rows. When the lookup is unavailable the filter is INERT — every
 * row survives — so the list renders complete and unfiltered rather than mysteriously empty.
 */
export function applyInvestigationsFilter<T extends { uid?: unknown }>(
  rows: T[],
  lookup: InvestigationsLookupResult,
  filter: InvestigationsFilter,
): T[] {
  const list = Array.isArray(rows) ? rows : [];
  if (lookup.unavailable || filter === 'all') return list;
  return list.filter((r) => matchesInvestigationsFilter(stateFor(lookup, r?.uid as string), filter));
}
