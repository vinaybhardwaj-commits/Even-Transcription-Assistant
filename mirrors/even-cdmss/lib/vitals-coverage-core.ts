/**
 * lib/vitals-coverage-core.ts — PURE, dependency-free core for the vitals-coverage panel
 * (U4-B C7, PRD v2.0, 2 Aug 2026). No imports, no I/O, no env: the page supplies "today" and runs
 * the SQL; everything decidable is decided here so it can be unit-tested.
 *
 * C7 IS A PANEL COUNT, NOT A FINDING. v1.0 specified an engine finding carrying
 * `domain: 'documentation'`; that does not typecheck — `OpdFindingDomain` has exactly two members
 * (appropriateness, prescribing_safety) and v1.0 confused it with the scorecard's `OpdDomain`.
 * V ruled on 2 Aug: no engine change at all. Nothing here reaches a score.
 */

/**
 * THE TRAP THIS MODULE EXISTS TO PREVENT (PRD §3.3, MEASURED).
 * `individuals-individual_vitals_records` holds 5,275 rows and the earliest is 2026-05-28 09:32 IST.
 * ANY window reaching before that date reports 100% missing — a data-availability artefact, not a
 * documentation gap. A panel that rendered it as a gap would be lying about doctors. Every window is
 * floored here, and the page says so when the clamp bites.
 */
export const VITALS_SOURCE_START = '2026-05-28';

/** Rolling window length, in days, inclusive of today. */
export const WINDOW_DAYS = 30;

/** The house day-shape guard (same regex as lib/metabase.ts / lib/ccb-detect.ts). */
export function isDay(d: unknown): d is string {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
}

/** Add `n` days to a YYYY-MM-DD string via UTC arithmetic. Returns '' on a malformed input. */
export function addDays(day: string, n: number): string {
  if (!isDay(day)) return '';
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return '';
  return new Date(t + n * 86_400_000).toISOString().slice(0, 10);
}

/** The IST calendar day containing `now`. Pure given its argument. */
export function istDay(now: Date): string {
  // en-CA renders ISO-shaped YYYY-MM-DD; the timeZone does the IST shift.
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export interface CoverageWindow {
  /** inclusive first IST day shown */
  start: string;
  /** EXCLUSIVE upper bound for the SQL range (= today + 1) */
  end: string;
  /** inclusive last IST day shown */
  lastDay: string;
  /** true when the requested window reached before the vitals source existed and was floored */
  clamped: boolean;
  /** how many days the window actually spans, after any clamp */
  days: number;
}

/**
 * The window to query: `days` back from `today` inclusive, FLOORED at VITALS_SOURCE_START.
 * `end` is exclusive (today + 1) so today's notes are included.
 */
export function coverageWindow(today: string, days = WINDOW_DAYS): CoverageWindow | null {
  if (!isDay(today) || !Number.isFinite(days) || days < 1) return null;
  const naiveStart = addDays(today, -(days - 1));
  if (!naiveStart) return null;
  const clamped = naiveStart < VITALS_SOURCE_START;
  const start = clamped ? VITALS_SOURCE_START : naiveStart;
  // A window entirely before the source has nothing honest to show.
  if (start > today) return null;
  const span = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return { start, end: addDays(today, 1), lastDay: today, clamped, days: span };
}

/**
 * The daily-coverage SQL, verbatim per PRD §3.2 / the kickoff.
 *
 * ⚠️ TWO MEASURED CONSTRAINTS, NOT PREFERENCES:
 *  1. A LEFT JOIN from individuals-prescriptions onto the whole vitals table returned HTTP 504 from
 *     Metabase. The bounded `NOT IN` form below returned in normal time. Do not "optimise" it back.
 *  2. The date range MUST be bounded — that bound is what makes the NOT IN affordable.
 *
 * ⚠️ metabaseQuery takes ONE SQL STRING WITH NO PARAMETER BINDING. Both dates are therefore
 * validated against ^\d{4}-\d{2}-\d{2}$ here and this function THROWS rather than interpolate
 * anything that fails. There is no path from a caller's string into the SQL except through isDay.
 *
 * ⚠️ THE THREE-WAY SPLIT, AND WHY `NOT IN` NEEDED GUARDING (measured on db13, 2 Aug 2026).
 * In SQL, `NULL NOT IN (…)` evaluates to NULL — not true — so a FILTER on it does not count the
 * row. A GP note with a null consult_uid therefore fell out of `no_vitals` and was silently
 * reported as COVERED: the page asserted vitals existed for a visit it could not look up. A note
 * with a BLANK-STRING consult_uid failed the opposite way — `'' NOT IN (…)` is true, so it counted
 * as no_vitals, asserting an absence it equally could not know. 33 of 2,771 GP notes (1.19%) in the
 * window carry no usable ID.
 *
 * Both are now their own category. The `NOT IN` subquery is UNCHANGED (a LEFT JOIN onto the whole
 * vitals table returns HTTP 504); it is only GUARDED, so it is asked exclusively about notes that
 * actually have an ID to ask about.
 *
 * TEMPLATE SCOPE (DEC-1): HOSPITAL_GP only. Teleconsults (GENERAL_PRACTITIONER), paediatrics and
 * the gynaecology templates are out of scope — each has its own vitals expectation and none was
 * measured. HOSPITAL_GP_INVESTIGATION_REFERRAL is excluded because it is DEAD: 3 notes since
 * 1 May 2026 (MEASURED 2 Aug 2026), so it needs no ruling, only this note so nobody re-opens it.
 */
export function buildVitalsCoverageSql(start: string, end: string): string {
  if (!isDay(start) || !isDay(end)) {
    throw new Error(`vitals-coverage: refusing to build SQL from a non-date bound (${String(start)}, ${String(end)})`);
  }
  return `SELECT (ip.uploaded_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
       COUNT(*) AS gp_notes,
       COUNT(*) FILTER (WHERE ip.consult_uid IS NULL OR btrim(ip.consult_uid) = '') AS no_consult_id,
       COUNT(*) FILTER (WHERE ip.consult_uid IS NOT NULL AND btrim(ip.consult_uid) <> ''
         AND ip.consult_uid NOT IN (
           SELECT consult_uid FROM "individuals-individual_vitals_records" WHERE consult_uid IS NOT NULL
         )) AS no_vitals
FROM "individuals-prescriptions" ip
WHERE ip.is_draft = false
  AND ip.type_of_prescription = 'HOSPITAL_GP'
  AND ip.uploaded_at >= '${start}' AND ip.uploaded_at < '${end}'
GROUP BY 1 ORDER BY 1 DESC`;
}

/**
 * One IST day. A GP visit is exactly one of three things, and the third is why this shape changed:
 *   · noConsultId — no consultation ID at all, so whether vitals exist is UNKNOWABLE from here
 *   · noVitals    — has an ID, and that ID is absent from the vitals table
 *   · covered     — has an ID and a vitals record (= gpNotes − noConsultId − noVitals)
 */
export interface CoverageDay {
  date: string;
  gpNotes: number;
  noConsultId: number;
  noVitals: number;
  /** noVitals ÷ (gpNotes − noConsultId): the share among visits we can actually answer for */
  pct: number;
}
export interface CoverageReport {
  days: CoverageDay[];
  totalGpNotes: number;
  totalNoConsultId: number;
  totalNoVitals: number;
  /** the headline denominator: GP visits we can answer for = totalGpNotes − totalNoConsultId */
  answerable: number;
  /** headline: noVitals ÷ answerable, 0–100, one decimal. Unknowable visits are in NEITHER side. */
  pct: number;
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? n : 0;
};
/** Metabase may hand a date back as 'YYYY-MM-DD' or a full ISO timestamp; keep the day part. */
const day = (v: unknown): string => {
  const s = String(v ?? '').slice(0, 10);
  return isDay(s) ? s : '';
};
const pctOf = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Shape raw Metabase rows into the panel's view model, newest day first.
 *
 * Rows outside [start, lastDay] are DROPPED. The SQL bounds `uploaded_at` in UTC while it groups by
 * the IST calendar date, so the boundary can admit a sliver of the day after `lastDay`; showing it
 * would render a few hours as if it were a day. Dropping is the honest choice.
 */
export function shapeCoverage(rows: unknown[], w: Pick<CoverageWindow, 'start' | 'lastDay'>): CoverageReport {
  const days: CoverageDay[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const d = day(r.d);
    if (!d || d < w.start || d > w.lastDay) continue;
    const gpNotes = num(r.gp_notes);
    // The three categories are disjoint and must stay so even on junk input: a subset can never
    // exceed its whole, and no-vitals can never exceed the visits we can actually answer for.
    const noConsultId = Math.min(num(r.no_consult_id), gpNotes);
    const answerable = gpNotes - noConsultId;
    const noVitals = Math.min(num(r.no_vitals), answerable);
    days.push({ date: d, gpNotes, noConsultId, noVitals, pct: pctOf(noVitals, answerable) });
  }
  days.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));   // newest first
  const totalGpNotes = days.reduce((s, x) => s + x.gpNotes, 0);
  const totalNoConsultId = days.reduce((s, x) => s + x.noConsultId, 0);
  const totalNoVitals = days.reduce((s, x) => s + x.noVitals, 0);
  // THE HEADLINE DENOMINATOR EXCLUDES WHAT WE CANNOT KNOW. A visit with no consultation ID is not
  // evidence of a gap and not evidence of coverage; folding it into either side would state
  // something the data cannot support. It is reported separately, in its own words, on the page.
  const answerable = totalGpNotes - totalNoConsultId;
  return { days, totalGpNotes, totalNoConsultId, totalNoVitals, answerable, pct: pctOf(totalNoVitals, answerable) };
}
