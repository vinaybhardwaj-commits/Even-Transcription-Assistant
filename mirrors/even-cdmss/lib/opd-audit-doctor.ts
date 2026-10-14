/**
 * Per-doctor Neon aggregates for the OPD-audit by-doctor surface (Navigation & Export PRD §5).
 * Server-only (imports @/lib/db). Reads finished audits from opd_note_audits — no engine/scoring
 * dependency, no migration. Names/specialty are joined in the caller (db13 doctors + doctor_directory).
 *
 * ⚠️ Neon HTTP driver GROUP BY-alias gotcha: `GROUP BY <select-alias>` is rejected. Where a bucket
 * is a computed expression (the weekly trend), compute it in an inner subquery and GROUP BY the
 * column in the outer query (the nested-subquery pattern). Direct-column GROUP BYs (doctor_uid,
 * band) are fine and used as-is.
 */
import { sql } from '@/lib/db';
import { OPD_ENGINE_VERSIONS_CURRENT } from '@/lib/opd-note-audit-core';
import type { LvcCell } from '@/lib/opd-funnel-core';
import { displayedBandColumnExists } from '@/lib/opd-audit-store';
import { canonicalDistinctOnSql } from '@/lib/audit-canonical';

const APP = process.env.APP_SOURCE || 'standalone';
const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
async function rowsOf<T>(text: string, params: unknown[]): Promise<T[]> {
  try { return (await run(text, params)) as T[]; } catch { return []; }
}
const IST = "AT TIME ZONE 'Asia/Kolkata'";
// Decision 21: user-facing READ filters use the current-engine FAMILY (inlined ARRAY literal of code
// constants — same inline style as before, no param re-indexing). A 0.81.x metadata bump no longer
// orphans the historical corpus from these lists.
const ENG_FAMILY_SQL = `ANY(ARRAY[${OPD_ENGINE_VERSIONS_CURRENT.map((v) => `'${v}'`).join(', ')}])`;

/** Build the optional IST date-range clause + its params, starting at $startIdx. */
function rangeClause(from: string | null, to: string | null, startIdx: number): { clause: string; params: string[] } {
  const params: string[] = [];
  let clause = '';
  if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) { params.push(from); clause += ` AND (note_date ${IST})::date >= $${startIdx + params.length}`; }
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) { params.push(to); clause += ` AND (note_date ${IST})::date <= $${startIdx + params.length}`; }
  return { clause, params };
}

/**
 * CANONICAL BASIS (31 Jul 2026, addendum C). Every aggregate below now counts ONE ROW PER NOTE —
 * the canonical row per THE RULE in lib/audit-canonical.ts (highest engine version, ties by latest
 * audited_at). The PK is (uid, engine_version), so a note accumulates a row per engine bump: these
 * aggregates were counting most notes 2-3 times, inflating volume 40-68% per doctor. They are
 * ENFORCING a rule settled 27 Jul, not introducing one.
 *
 * The dedup is in SQL, not `canonicalByUid`, because these functions aggregate server-side and
 * never return rows for a TypeScript filter to reduce. `canonicalDistinctOnSql` is the twin of
 * that function and is pinned to it by test.
 *
 * The engine-family filter must stay INSIDE the subquery: it excludes `-mini` rows before ranking,
 * which is what makes the int[] cast in CANONICAL_RANK_SQL safe (see trap 2 there).
 */
function canonicalDoctorRows(cols: string, where: string): string {
  return canonicalDistinctOnSql({ table: 'opd_note_audits', identity: 'uid', cols, where });
}

export type DoctorIndexRow = {
  doctor_uid: string; nnotes: number; mean_index: number; low_value_rate: number; last_audited: string;
};
/** Every doctor with ≥1 audit (all-time): volume, mean index, low-value rate, last-audited date. */
export async function fetchDoctorIndex(): Promise<DoctorIndexRow[]> {
  return rowsOf<DoctorIndexRow>(
    `SELECT doctor_uid,
            count(*)::int nnotes,
            round(avg(note_quality_index))::int mean_index,
            round(100.0*avg((n_low_value>0)::int))::int low_value_rate,
            to_char(max((note_date ${IST})::date),'YYYY-MM-DD') last_audited
     FROM (${canonicalDoctorRows(
       'doctor_uid, note_quality_index, n_low_value, note_date',
       `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND doctor_uid IS NOT NULL AND excluded_reason IS NULL`,
     )}) canonical
     GROUP BY doctor_uid
     ORDER BY nnotes DESC, mean_index ASC`, [APP]);
}

export type DoctorStats = {
  nnotes: number; first_date: string | null; last_date: string | null;
  mean_index: number; low_value_rate: number;
  d_doc: number; d_nq: number; d_appr: number; d_presc: number; d_pc: number;
};
/** All-audit aggregate for one doctor over an optional date range (default all-time). */
export async function fetchDoctorStats(uid: string, from: string | null = null, to: string | null = null): Promise<DoctorStats | null> {
  const r = rangeClause(from, to, 2);
  const rows = await rowsOf<DoctorStats>(
    `SELECT count(*)::int nnotes,
            to_char(min((note_date ${IST})::date),'YYYY-MM-DD') first_date,
            to_char(max((note_date ${IST})::date),'YYYY-MM-DD') last_date,
            round(avg(note_quality_index))::int mean_index,
            round(100.0*avg((n_low_value>0)::int))::int low_value_rate,
            round(avg(score_documentation))::int d_doc, round(avg(score_note_quality))::int d_nq,
            round(avg(score_appropriateness))::int d_appr, round(avg(score_prescribing_safety))::int d_presc,
            round(avg(score_patient_centred))::int d_pc
     FROM (${canonicalDoctorRows(
       `note_quality_index, n_low_value, note_date, score_documentation, score_note_quality,
              score_appropriateness, score_prescribing_safety, score_patient_centred`,
       `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND doctor_uid = $2 AND excluded_reason IS NULL${r.clause}`,
     )}) canonical`,
    [APP, uid, ...r.params]);
  const row = rows[0];
  return row && Number(row.nnotes) > 0 ? row : null;
}

export type BandRow = { band: string; c: number };
/** Band A–E distribution for one doctor (direct-column GROUP BY — no gotcha). */
export async function fetchDoctorBandDist(uid: string, from: string | null = null, to: string | null = null): Promise<BandRow[]> {
  const r = rangeClause(from, to, 2);
  return rowsOf<BandRow>(
    `SELECT band, count(*)::int c
     FROM (${canonicalDoctorRows(
       'band, note_date',
       `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND doctor_uid = $2 AND excluded_reason IS NULL${r.clause}`,
     )}) canonical
     GROUP BY band`, [APP, uid, ...r.params]);
}

export type WeekRow = { wk: string; idx: number; c: number };
/** Weekly index trend for one doctor. NESTED-SUBQUERY pattern: the week bucket is computed in the
 *  inner query and grouped by the resulting column in the outer query (Neon GROUP BY-alias gotcha). */
export async function fetchDoctorWeeklyTrend(uid: string, from: string | null = null, to: string | null = null): Promise<WeekRow[]> {
  const r = rangeClause(from, to, 2);
  return rowsOf<WeekRow>(
    `SELECT wk, round(avg(idx))::int idx, count(*)::int c
     FROM (
       SELECT to_char(date_trunc('week', (note_date ${IST}))::date,'YYYY-MM-DD') wk,
              note_quality_index idx
       FROM (${canonicalDoctorRows(
         'note_quality_index, note_date',
         `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND doctor_uid = $2 AND excluded_reason IS NULL${r.clause}`,
       )}) canonical
     ) t
     GROUP BY wk
     ORDER BY wk`, [APP, uid, ...r.params]);
}

export type DoctorAuditRow = {
  id: string; uid: string; note_date: string; doctor_uid: string | null;
  consult_type: string | null; prescription_type: string | null;
  band: string; displayed_band?: string | null; note_quality_index: number; n_low_value: number; completeness_pct: number;
  score_documentation: number; score_note_quality: number; score_appropriateness: number;
  score_prescribing_safety: number; score_patient_centred: number;
  findings: unknown; suggestions: unknown; missing_fields: unknown; engine_version: string;
};
/** One doctor's audits newest-first (for the list + the bulk-PDF set). `limit` caps the set. */
export async function fetchDoctorAuditRows(uid: string, from: string | null = null, to: string | null = null, limit = 600): Promise<DoctorAuditRow[]> {
  const r = rangeClause(from, to, 2);
  const lim = Math.max(1, Math.min(2000, Math.floor(limit)));
  return rowsOf<DoctorAuditRow>(
    // §5 — the LIMIT must count CANONICAL rows, not duplicates. Deduplicating in TypeScript after
    // the fetch would silently shrink a 600-row request to ~350 and truncate the bulk-PDF set.
    `SELECT * FROM (${canonicalDoctorRows(
      `id, note_date, doctor_uid, consult_type, prescription_type,
            band${(await displayedBandColumnExists().catch(() => false)) ? ', displayed_band' : ''}, note_quality_index, n_low_value, completeness_pct,
            score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred,
            findings, suggestions, missing_fields, engine_version`,
      `app_source = $1 AND engine_version = ${ENG_FAMILY_SQL} AND doctor_uid = $2 AND excluded_reason IS NULL${r.clause}`,
    )}) canonical
     ORDER BY note_date DESC
     LIMIT ${lim}`, [APP, uid, ...r.params]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Right Care O/E + strata + day rate (RIGHT-CARE-INDICATOR-PRD §4 / Branch 2).
//
// Basis (§1, §2.2): the DISTINCT-uid latest audit at the current-engine FAMILY (0.81.3 ∪ 0.81.4 —
// the 0.81.4 metadata bump does NOT re-audit 0.81.3, so both are "current"; see opd-note-audit-core).
// This deliberately avoids fetchDoctorIndex's count(*) double-count. O numerator = notes with
// n_low_value > 0 (verdict tier is the authoritative LVC signal, §8; v1 gate suppresses nothing, so
// n_low_value>0 == "≥1 gated LVC finding"). All strings are INFERRED — fail-safe (error → []/zero).
// ─────────────────────────────────────────────────────────────────────────────
const ENGINES: string[] = [...OPD_ENGINE_VERSIONS_CURRENT];
/** Distinct-note (CANONICAL per uid) subquery over the current-engine family. `extra` adds WHERE terms.
 *
 *  ⚠️ RE-POINTED 31 Jul 2026 (addendum C §4). This previously ordered by `uid, note_date DESC,
 *  id DESC`. `note_date` is the CLINICAL note's date — identical across every re-audit of the same
 *  note — so it never broke a tie between duplicates, and the winner was decided by `id DESC` on a
 *  UUID: arbitrary with respect to both recency and engine version. MEASURED on the live table
 *  (current family, active rows, doctor_uid not null): 5,066 notes hold >1 row and the old and
 *  canonical orderings disagree on 2,774 of them — 55%. Right Care's O/E numerator reads
 *  `n_low_value` from the winning row, so on more than half the duplicated notes it was an older
 *  engine's low-value verdict. Now uses THE RULE. Callers are unchanged. */
function distinctNoteSubquery(cols: string, extra = ''): string {
  return canonicalDistinctOnSql({
    table: 'opd_note_audits',
    identity: 'uid',
    cols,
    where: `app_source = $1 AND engine_version = ANY($2) AND doctor_uid IS NOT NULL AND excluded_reason IS NULL${extra}`,
  });
}
const WIN90 = `(note_date ${IST})::date >= (now() ${IST})::date - 90`;

/** House-account / non-clinician exclusions (decision 15). app_settings JSON array; fail-safe → []. */
export async function readRightCareExclusions(): Promise<string[]> {
  const rows = await run(`SELECT value FROM app_settings WHERE key = 'right_care_doctor_exclusions'`, []).catch(() => []);
  const raw = rows[0]?.value;
  if (!raw) return [];
  try { const j = JSON.parse(String(raw)); return Array.isArray(j) ? j.map((x) => String(x)).filter(Boolean) : []; }
  catch { return []; }
}

/** Per-(doctor, band) LVC cells for the O/E + funnel cores. Banded only (unbanded excluded from O/E);
 *  latest-per-uid then drop nulls, so a later unbanded re-audit doesn't hide an older banded one. */
export async function fetchLvcCells(): Promise<LvcCell[]> {
  const rows = await rowsOf<{ doctor_uid: string; band: string; n: number; o: number }>(
    `SELECT doctor_uid, band, count(*)::int AS n, count(*) FILTER (WHERE nlv > 0)::int AS o
     FROM ( ${distinctNoteSubquery('doctor_uid, complexity_band AS band, n_low_value AS nlv')} ) latest
     WHERE band IS NOT NULL
     GROUP BY doctor_uid, band`, [APP, ENGINES]);
  return rows.map((r) => ({ doctor_uid: String(r.doctor_uid), band: r.band == null ? null : String(r.band), age_band: null, n: Number(r.n) || 0, o: Number(r.o) || 0 }));
}

/** Banded coverage over the distinct-note family basis: "banded n / m" (§8). Fail-safe → 0/0. */
export async function fetchRightCareCoverage(): Promise<{ banded: number; total: number }> {
  const rows = await rowsOf<{ banded: number; total: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE band IS NOT NULL)::int AS banded
     FROM ( ${distinctNoteSubquery('complexity_band AS band')} ) l`, [APP, ENGINES]);
  return { banded: Number(rows[0]?.banded || 0), total: Number(rows[0]?.total || 0) };
}

export type RightCareDayTrend = { day: string; rate: number; n: number };
export type RightCareCategory = { category: string; notes: number };
export interface RightCareDay {
  day: string; total: number; withLvc: number; rate: number;
  mean14: number; trend: RightCareDayTrend[]; categories: RightCareCategory[];
}
/** Overview tile (§7 + decision 24): headline day LVC-note rate, 14-day trend + mean, and the headline
 *  day's category split. `selectedDay` (YYYY-MM-DD, the page's chosen day) drives BOTH the rate and the
 *  category split; absent → the latest audited day. `day` is a clean ISO string (to_char) so the caption
 *  never renders a raw JS Date. Fail-safe → zeros. */
export async function fetchRightCareDay(selectedDay?: string | null): Promise<RightCareDay> {
  const sel = selectedDay && /^\d{4}-\d{2}-\d{2}$/.test(selectedDay) ? selectedDay : null;
  const empty: RightCareDay = { day: sel || '', total: 0, withLvc: 0, rate: 0, mean14: 0, trend: [], categories: [] };
  const trendRows = await rowsOf<{ day: string; n: number; with_lvc: number }>(
    `SELECT day, count(*)::int AS n, count(*) FILTER (WHERE nlv > 0)::int AS with_lvc
     FROM ( ${distinctNoteSubquery(
       `to_char((note_date ${IST})::date,'YYYY-MM-DD') AS day, n_low_value AS nlv`,
       ` AND (note_date ${IST})::date > COALESCE($3::date, (now() ${IST})::date) - 14 AND (note_date ${IST})::date <= COALESCE($3::date, (now() ${IST})::date)`)} ) l
     GROUP BY day ORDER BY day`, [APP, ENGINES, sel]);
  if (!trendRows.length) return empty;
  const trend: RightCareDayTrend[] = trendRows.map((r) => ({ day: String(r.day), n: Number(r.n) || 0, rate: Number(r.n) > 0 ? Number(r.with_lvc) / Number(r.n) : 0 }));
  // headline day = the selected day (rate + category split share it), else the latest day present.
  const headDay = sel || trend[trend.length - 1].day;
  const head = trend.find((t) => t.day === headDay) || { day: headDay, n: 0, rate: 0 };
  const mean14 = trend.reduce((a, t) => a + t.rate, 0) / trend.length;
  const catRows = await rowsOf<{ category: string; notes: number }>(
    `SELECT COALESCE(NULLIF(lower(f->>'lvc_category'), ''), 'other') AS category, count(DISTINCT l.uid)::int AS notes
     FROM ( ${distinctNoteSubquery(`findings`, ` AND (note_date ${IST})::date = $3::date`)} ) l,
          jsonb_array_elements(CASE WHEN jsonb_typeof(l.findings) = 'array' THEN l.findings ELSE '[]'::jsonb END) f
     WHERE f->>'verdict' = 'low-value' AND COALESCE((f->>'informational')::boolean, false) = false
     GROUP BY 1 ORDER BY notes DESC`, [APP, ENGINES, headDay]).catch(() => []);
  return {
    day: headDay, total: head.n, withLvc: Math.round(head.rate * head.n), rate: head.rate,
    mean14, trend, categories: catRows.map((r) => ({ category: String(r.category), notes: Number(r.notes) || 0 })),
  };
}

// ── Department (specialty) detail — §7c / decision 20 (90d window, Right Care basis) ──
const DEPT_JOIN = `LEFT JOIN doctor_directory dd ON dd.doctor_uid = l.doctor_uid`;
const DEPT_MATCH = `COALESCE(NULLIF(dd.speciality, ''), 'Unspecified') = $3`;

export interface DeptKpis { n: number; banded: number; avg_nqi: number; pct_low: number; sum_low: number }
export async function fetchDeptKpis(dept: string): Promise<DeptKpis> {
  const rows = await rowsOf<DeptKpis & { total: number }>(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE band IS NOT NULL)::int AS banded,
            round(avg(nqi))::int AS avg_nqi,
            round(100.0 * avg((nlv > 0)::int))::int AS pct_low,
            sum(nlv)::int AS sum_low
     FROM ( ${distinctNoteSubquery(`doctor_uid, complexity_band AS band, note_quality_index AS nqi, n_low_value AS nlv, note_date`, ` AND ${WIN90}`)} ) l
     ${DEPT_JOIN}
     WHERE ${DEPT_MATCH}`, [APP, ENGINES, dept]);
  const r = rows[0];
  return { n: Number(r?.n || 0), banded: Number(r?.banded || 0), avg_nqi: Number(r?.avg_nqi || 0), pct_low: Number(r?.pct_low || 0), sum_low: Number(r?.sum_low || 0) };
}

export type DeptWeek = { wk: string; nqi: number; lvc: number; n: number };
export async function fetchDeptWeeklyTrend(dept: string): Promise<DeptWeek[]> {
  return rowsOf<DeptWeek>(
    `SELECT wk, round(avg(nqi))::int AS nqi, round(100.0 * avg((nlv > 0)::int))::int AS lvc, count(*)::int AS n
     FROM (
       SELECT to_char(date_trunc('week', (l.note_date ${IST}))::date, 'YYYY-MM-DD') AS wk, l.nqi, l.nlv
       FROM ( ${distinctNoteSubquery(`doctor_uid, note_quality_index AS nqi, n_low_value AS nlv, note_date`, ` AND ${WIN90}`)} ) l
       ${DEPT_JOIN}
       WHERE ${DEPT_MATCH}
     ) t GROUP BY wk ORDER BY wk`, [APP, ENGINES, dept]);
}

export async function fetchDeptCategorySplit(dept: string): Promise<RightCareCategory[]> {
  const rows = await rowsOf<{ category: string; notes: number }>(
    `SELECT COALESCE(NULLIF(lower(f->>'lvc_category'), ''), 'other') AS category, count(DISTINCT l.uid)::int AS notes
     FROM ( ${distinctNoteSubquery(`doctor_uid, findings, note_date`, ` AND ${WIN90}`)} ) l
     ${DEPT_JOIN}
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.findings) = 'array' THEN l.findings ELSE '[]'::jsonb END) f
     WHERE ${DEPT_MATCH} AND f->>'verdict' = 'low-value' AND COALESCE((f->>'informational')::boolean, false) = false
     GROUP BY 1 ORDER BY notes DESC`, [APP, ENGINES, dept]);
  return rows.map((r) => ({ category: String(r.category), notes: Number(r.notes) || 0 }));
}

export type DeptFinding = { subject: string; signal_type: string; n: number };
export async function fetchDeptTopFindings(dept: string): Promise<DeptFinding[]> {
  return rowsOf<DeptFinding>(
    `SELECT f->>'subject' AS subject, COALESCE(f->>'signal_type', '') AS signal_type, count(*)::int AS n
     FROM ( ${distinctNoteSubquery(`doctor_uid, findings, note_date`, ` AND ${WIN90}`)} ) l
     ${DEPT_JOIN}
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.findings) = 'array' THEN l.findings ELSE '[]'::jsonb END) f
     WHERE ${DEPT_MATCH} AND COALESCE((f->>'informational')::boolean, false) = false AND COALESCE(f->>'subject', '') <> ''
     GROUP BY 1, 2 HAVING count(*) >= 3 ORDER BY n DESC LIMIT 10`, [APP, ENGINES, dept]);
}

// ── stewardship drill-through — the dept head's "which notes?" (NAVIGATOR-DRILL PRD §2.3) ──
// EXACT same basis as fetchDeptTopFindings (WIN90 + engine FAMILY + distinctNoteSubquery + DEPT_JOIN +
// DEPT_MATCH + non-informational) so the drill's finding count equals the stewardship ×n. Two reads
// off one basis: (A) totals (f findings across m notes, uncapped), (B) the note list (AllRow shape,
// newest-first, capped 600). INFERRED SQL — fully fail-safe (rowsOf → []; on error empty list + zero
// counts, never a 500). $4 = subject (exact), $5 = signal (COALESCE-folded like stewardship).
export interface DeptFindingNoteRow {
  id: string; uid: string; note_date: string; doctor_uid: string | null;
  consult_type: string | null; prescription_type: string | null; band: string;
  note_quality_index: number; n_low_value: number; completeness_pct: number;
  findings: unknown; missing_fields: unknown;
}
export interface DeptFindingNotesResult { rows: DeptFindingNoteRow[]; findings: number; notes: number; capped: boolean }

export async function fetchDeptFindingNotes(dept: string, subject: string, signal: string): Promise<DeptFindingNotesResult> {
  const params = [APP, ENGINES, dept, subject, signal];
  const matchWhere = `${DEPT_MATCH} AND COALESCE((f->>'informational')::boolean, false) = false
     AND f->>'subject' = $4 AND COALESCE(f->>'signal_type', '') = $5`;

  // (A) totals over the full matched set (finding count f, distinct-note count m)
  const totals = await rowsOf<{ f: number; m: number }>(
    `SELECT count(*)::int AS f, count(DISTINCT l.id)::int AS m
     FROM ( ${distinctNoteSubquery('id, doctor_uid, findings', ` AND ${WIN90}`)} ) l
     ${DEPT_JOIN}
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.findings) = 'array' THEN l.findings ELSE '[]'::jsonb END) f
     WHERE ${matchWhere}`, params);
  const findings = Number(totals[0]?.f || 0);
  const notes = Number(totals[0]?.m || 0);

  // (B) the note list (one row per matched note, newest-first, capped 600) in the AllRow column shape
  const rows = await rowsOf<DeptFindingNoteRow>(
    `SELECT id, uid, note_date, doctor_uid, consult_type, prescription_type, band,
            note_quality_index, n_low_value, completeness_pct, findings, missing_fields
     FROM (
       SELECT DISTINCT ON (l.id) l.id, l.uid, l.note_date, l.doctor_uid, l.consult_type, l.prescription_type,
              l.band, l.note_quality_index, l.n_low_value, l.completeness_pct, l.findings, l.missing_fields
       FROM ( ${distinctNoteSubquery(`id, doctor_uid, consult_type, prescription_type, band${(await displayedBandColumnExists().catch(() => false)) ? ', displayed_band' : ''}, note_quality_index, n_low_value, completeness_pct, findings, missing_fields, note_date`, ` AND ${WIN90}`)} ) l
       ${DEPT_JOIN}
       CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.findings) = 'array' THEN l.findings ELSE '[]'::jsonb END) f
       WHERE ${matchWhere}
       ORDER BY l.id
     ) t
     ORDER BY note_date DESC
     LIMIT 600`, params);

  return { rows, findings, notes, capped: notes > 600 };
}
