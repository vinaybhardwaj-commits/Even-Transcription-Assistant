/**
 * lib/stewardship-canonical.ts — the ONE 90-day canonical basis the stewardship room reads.
 *
 * ⚠️ THIS IS AN EXTRACTION, NOT A NEW RECIPE. Every fragment below is lifted from
 * `app/admin/stewardship/page.tsx` (the live board's own SQL) and from `lib/opd-audit-doctor.ts` —
 * the two files the kickoff §5 names as the canonical 90-day source. The spec's §12.1 warning is
 * against MOVING the board's SQL into a guessed `lib/steward*` home; what it asks for, in the same
 * breath, is that any extraction come from those two files. It does. Flagged in the S1 report.
 *
 * WHY EXTRACT AT ALL. The stewardship Ask (S1) and the stewardship board (S2) must answer the same
 * question with the same number, and the room is about to grow a third reader (S3's IPD slice). The
 * repo has already paid for this twice: the board page's own comment records the day this basis was
 * one of THREE different rules over one table, and `lib/audit-canonical.ts` exists because two
 * counts sitting side by side were each computed their own way. One fragment, three readers.
 *
 * ⚠️ THE WINDOW IS THE IST CALENDAR DAY — V's ruling on flag F-2, 29 Aug 2026. The board page used
 * an INSTANT window (`note_date >= NOW() - 90 days`) while the dept helpers in
 * `lib/opd-audit-doctor.ts` used an IST CALENDAR-DAY one. The 29 Aug validation measured both at
 * 25,157 distinct uids — identical today, and that is exactly why it had to be settled rather than
 * left: a divergence with no visible effect is one that gets discovered at the edge of a day, in
 * production, by someone comparing two screens. One basis everywhere; this module carries the
 * calendar-day form the dept helpers already used.
 *
 * ⚠️ THE VERSION-SORT CAST IS GUARDED BY SHAPE, not by the engine list. `CANONICAL_RANK_SQL` orders
 * by `string_to_array(split_part(engine_version, '/', 2), '.')::int[]`, and Postgres RAISES on a
 * non-numeric component rather than mis-ranking. Today the explicit family list is what keeps the
 * cast safe — but `opd-note-audit/0.81.20-mini` already exists in the table with 236 rows, and one
 * append to `OPD_ENGINE_VERSIONS_CURRENT` would make every board query and every Ask-material query
 * throw at once. The tail-SHAPE test below excludes such a version by construction, the way
 * `lib/learning.ts` already does. It changes no number today (no family entry has a suffix) and it
 * removes a config edit's ability to take the room down.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live DB. Every string here is listed verbatim in the slice
 * report. Nothing in this file executes anything — it composes fragments; the callers run them.
 */
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import { IPD_ENGINE_VERSION, UNASSIGNED_SPECIALITY } from '@/lib/ipd-audit/store';

/** D-window — today's 90-day board window, unchanged. Live ceiling; never frozen to chase a number. */
export const STEWARDSHIP_WINDOW_DAYS = 90;

/** The app partition every Neon read on this surface carries. */
export const STEWARDSHIP_APP = process.env.APP_SOURCE || 'standalone';

// ── OPD: the board's canonical one-row-per-note basis, verbatim ────────────────────────────

/** Read-side engine FAMILY (decision 21) — also excludes `-mini` before ranking, which is what
 *  makes the int[] cast in CANONICAL_RANK_SQL safe. Verbatim from the board page. */
const OPD_ENG_FAMILY_SQL = `ANY(ARRAY[${OPD_ENGINE_VERSIONS_CURRENT.map((v) => `'${v}'`).join(', ')}])`;

/**
 * $1 = app_source, $2 = window days (as text — cast to int for the calendar-day subtraction).
 *
 * Four clauses, each load-bearing:
 *   · the app partition;
 *   · the engine FAMILY (decision 21) — which also excludes `-mini` before ranking;
 *   · the tail-SHAPE guard, so a suffixed family entry is excluded rather than crashing the cast;
 *   · the IST CALENDAR-DAY window (F-2, V's ruling), matching `lib/opd-audit-doctor.ts`;
 *   · `excluded_reason IS NULL`, which is how a marked row leaves every canonical surface.
 */
export const OPD_TAIL_SHAPE_SQL = String.raw`split_part(engine_version, '/', 2) ~ '^[0-9]+(\.[0-9]+)*$'`;

export const OPD_CANON_WHERE =
  `app_source = $1 AND engine_version = ${OPD_ENG_FAMILY_SQL} AND ${OPD_TAIL_SHAPE_SQL}`
  + ` AND excluded_reason IS NULL`
  + ` AND (note_date AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ($2)::int`;

/**
 * The canonical inner subquery: ONE row per note over the window, ranked by THE RULE
 * (lib/audit-canonical.ts). `cols` is the caller's projection; `uid` is always selected because it
 * is the identity. Wrap an aggregate around it — never aggregate the base table directly.
 */
export function opdCanonical90d(cols: string): string {
  return canonicalDistinctOnSql({ table: 'opd_note_audits', identity: 'uid', cols, where: OPD_CANON_WHERE });
}

/** The two bound values `OPD_CANON_WHERE` expects, in order. Further params start at $3. */
export function opdCanonParams(): [string, string] {
  return [STEWARDSHIP_APP, String(STEWARDSHIP_WINDOW_DAYS)];
}

/** The department label expression the board groups by — OPD vocabulary, parsed parens speciality. */
export const OPD_DEPT_LABEL_SQL = `COALESCE(NULLIF(dd.speciality, ''), 'Unspecified')`;
export const OPD_DEPT_UNSPECIFIED = 'Unspecified';

// ── IPD: kickoff A6's canonical recipe ────────────────────────────────────────────────────

/**
 * A6, verbatim: "Board CVI/band = `DISTINCT ON (ip_uid)` latest `audited_at`, engine
 * `ipd-discharge-audit/0.2` only, 90d IST. `ipd-stay-audit/0.1` rows are drill context and never
 * enter the board aggregate."
 *
 * ⚠️ DELIBERATELY NOT `canonicalDistinctOnSql`. That helper ranks by grader tier, then engine
 * version, then model tier, then time — the right rule when several ENGINE VERSIONS compete for one
 * identity. A6 settles the competition differently and more simply: only one engine version is
 * admitted at all, so the version and tier keys have nothing left to decide and `audited_at DESC` is
 * the whole tiebreak. Writing A6's rule as A6 states it is the point; dressing it in the other
 * helper would quietly re-admit `ipd-stay-audit/0.1` the day someone widened the filter.
 *
 * Identity is `ip_uid`, not `document_id`: A6 says one row per STAY, and one stay can carry several
 * discharge-summary documents.
 *
 * ⚠️ INFERRED: the 90-day column is `coalesce(discharged_at, audited_at)`, which is the pairing
 * `lib/ipd-audit/store.ts` already uses for every dated IPD read. A6 says "90d IST" and does not
 * name the column. Flagged for validation.
 *
 * $1 = the engine version.
 */
export const IPD_BOARD_ENGINE = IPD_ENGINE_VERSION;
export const IPD_DEPT_UNASSIGNED = UNASSIGNED_SPECIALITY;

export function ipdCanonical90d(cols: string): string {
  return `SELECT DISTINCT ON (ip_uid) ip_uid, ${cols}
            FROM ipd_discharge_audits
           WHERE engine_version = $1
             AND ip_uid IS NOT NULL
             AND (coalesce(discharged_at, audited_at) AT TIME ZONE 'Asia/Kolkata')::date
                 >= (now() AT TIME ZONE 'Asia/Kolkata')::date - ${STEWARDSHIP_WINDOW_DAYS}
           ORDER BY ip_uid, audited_at DESC`;
}

/** The one bound value `ipdCanonical90d` expects. Further params start at $2. */
export function ipdCanonParams(): [string] {
  return [IPD_BOARD_ENGINE];
}

/** The IPD department label expression — the raw stored speciality, `Unassigned` for null (no
 *  normalisation in v1, and none invented here: the two vocabularies stay two). */
export const IPD_DEPT_LABEL_SQL = `COALESCE(NULLIF(t.speciality, ''), '${UNASSIGNED_SPECIALITY}')`;
