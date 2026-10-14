/**
 * lib/cognition/join-core.ts — WM3: the join's arithmetic (cognition-join/0.1).
 *
 * PURE. No db, no LLM, no I/O. All SQL is in lib/cognition/join-store.ts and the db13 reads are in
 * lib/cognition/join-sweep.ts.
 *
 * The join answers one question per eligible note: what did the record hold BEFORE it (`O_before`),
 * what was the first result that became VISIBLE after it (`Y`), and what did the record hold once
 * that result had landed (`O_after`). This module owns the two decisions that are easy to get
 * quietly wrong:
 *
 * ── VISIBILITY IS NOT THE TEST DATE ─────────────────────────────────────────────────────────────
 *
 * A lab drawn on the 3rd and reported on the 5th was NOT knowable on the 3rd. The walk's own
 * honesty chip says this lag is not modelled there; here it IS, on Y only, by the ratified
 * `greatest_v1` rule: visibility is the later of the test date and the row's creation time. Before
 * 13 July 2023 db13 has no trustworthy `_create_time`, so the rule falls back to the test date and
 * SAYS SO in `y_visible_rule` — a row whose lag could not be modelled is labelled, never silently
 * treated as if it could.
 *
 * ── Y IS THE FIRST RESULT THE DOCTOR COULD HAVE SEEN, NOT THE FIRST ONE DRAWN ───────────────────
 *
 * `chooseY` orders candidates by VISIBILITY, not by test date, and excludes anything already
 * visible at the moment of the note. Ordering by test date would let a result that was reported a
 * week later count as the doctor's next piece of information.
 */
import { createHash } from 'crypto';

/** IST is UTC+5:30 and has no daylight saving, so a fixed offset is exact, not an approximation. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * db13 has no trustworthy `_create_time` before this instant, so the lag cannot be modelled for a
 * test dated earlier. Ratified cutoff (CAT Design, 8 Sep 2026, Q-rulings).
 */
export const CREATE_TIME_CUTOFF = new Date('2023-07-13T00:00:00Z');

export type YVisibleRule = 'greatest_v1' | 'test_date_only';
export type YStatus = 'pending' | 'present' | 'missing_within_horizon';
export type CutStatus = 'ok' | 'no_prior_history' | 'context_fetch_failed';
export type Provenance = 'captured' | 'reconstructed';
export type ResolveStatus = 'resolved' | 'unresolved';

/** One db13 lab row, as the Y query returns it. `investigation_name` may be null and still counts. */
export interface LabRow {
  booking_id: string;
  test_result_uid: string;
  test_date: Date;
  create_time: Date | null;
  investigation_name: string | null;
}

/** The IST calendar day of an instant, `YYYY-MM-DD`. */
export function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * When could this result first have been seen?
 *
 * After the cutoff, with a creation time present: the later of the two. A negative lag (a row
 * created BEFORE its own test date, which db13 does contain) therefore resolves to the test date,
 * not to a creation time that precedes the event it describes.
 *
 * Otherwise: the test date, labelled `test_date_only` so the readout can separate rows whose lag is
 * modelled from rows whose lag is merely unknown.
 */
export function visibleAtFor(testDate: Date, createTime: Date | null): { visibleAt: Date; rule: YVisibleRule } {
  if (testDate > CREATE_TIME_CUTOFF && createTime != null) {
    return { visibleAt: createTime > testDate ? createTime : testDate, rule: 'greatest_v1' };
  }
  return { visibleAt: testDate, rule: 'test_date_only' };
}

/**
 * The first result that became visible AFTER the note, within the horizon.
 *
 * Three exclusions, each for its own reason:
 *   · a test dated before the note's IST day belongs to the history the note already had;
 *   · a result already visible at `eventAt` was information the doctor had, not information they
 *     received — strictly `>`, so a result visible at the same instant is out;
 *   · a result beyond the horizon is not this note's follow-up.
 *
 * Ordered by VISIBILITY. The tie-break is `booking_id` then `test_result_uid` so two runs over the
 * same data pick the same row — an unstable Y would make the whole table unreproducible.
 */
export function chooseY(rows: LabRow[], eventAt: Date, noteDayIst: string, horizonDays: number): LabRow | null {
  const horizonEnd = new Date(eventAt.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  const candidates = rows
    .filter((r) => istDay(r.test_date) >= noteDayIst)
    .map((r) => ({ row: r, visibleAt: visibleAtFor(r.test_date, r.create_time).visibleAt }))
    .filter((c) => c.visibleAt > eventAt && c.visibleAt <= horizonEnd);
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    a.visibleAt.getTime() - b.visibleAt.getTime()
    || String(a.row.booking_id).localeCompare(String(b.row.booking_id))
    || String(a.row.test_result_uid).localeCompare(String(b.row.test_result_uid)));
  return candidates[0].row;
}

/**
 * The as-of day for `O_after`: the IST calendar day AFTER the result became visible.
 *
 * The day after, not the same day, because the spine's cut is strictly prior — an as-of of the
 * visibility day itself would reconstruct a state that does not yet contain Y, which is the one
 * thing O_after exists to contain.
 */
export function oAfterAsOf(visibleAt: Date): string {
  const [y, m, d] = istDay(visibleAt).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * Where this triple stands. `missing_within_horizon` is a CONCLUSION — we looked, the horizon has
 * passed, and nothing arrived — and `pending` is "not yet known". They are never collapsed.
 */
export function yStatusFor(hasY: boolean, now: Date, eventAt: Date, horizonDays: number): YStatus {
  if (hasY) return 'present';
  const horizonEnd = new Date(eventAt.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  return now > horizonEnd ? 'missing_within_horizon' : 'pending';
}

/** Stable serialisation: keys sorted at every depth, arrays left in order. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** sha256 of the canonical JSON. Two captures of the same state hash the same, whatever the key
 *  order the driver handed back. */
export function snapshotHash(json: unknown): string {
  return createHash('sha256').update(canonicalJson(json)).digest('hex');
}

/** A triple opened before the join first ran is RECONSTRUCTED — we are looking backwards at it.
 *  One opened from an event that arrived after the join was live is CAPTURED. */
export function provenanceFor(eventCreatedAt: Date, firstRunAt: Date | null): Provenance {
  return firstRunAt != null && eventCreatedAt > firstRunAt ? 'captured' : 'reconstructed';
}
