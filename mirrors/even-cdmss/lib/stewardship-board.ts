/**
 * lib/stewardship-board.ts — the internal MS board's reads: the named-clinician rows, the department
 * roll-up, and the danger queue (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, S2; spec §4).
 *
 * The aggregate SQL is the board page's own, moved here unchanged in meaning and composed from the
 * one fragment in lib/stewardship-canonical.ts — spec §12.1 asks that any extraction come from that
 * page and lib/opd-audit-doctor.ts, and this is that extraction. The page renders; this file reads.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ THE ONE THING WORTH ARGUING WITH, STATED PLAINLY: the escalation leg of the danger queue is
 * found by a SQL PREFILTER and decided by `tierFor`.
 *
 * Tier 1 is a regex over a finding's own text (lib/severity-tier-core.ts, the ratified table §3).
 * SQL cannot run it, and duplicating it in SQL would create the second severity authority this repo
 * has spent months removing everywhere else. So the query narrows and TypeScript decides:
 *
 *   · ESCALATION_PREFILTER below is a deliberate SUPERSET of the ratified escalation patterns —
 *     every phrase E-1 can match, plus the two lead words E-2 requires. It is allowed to return
 *     findings that are not tier 1. It is NOT allowed to miss one.
 *   · `tierFor` then decides every candidate. Nothing is promoted, demoted or counted on the
 *     strength of the ILIKE.
 *
 * THE RISK THIS CARRIES, and the tripwire against it: if a future E-3 entry is added to the ratified
 * table with vocabulary the prefilter does not cover, the queue would silently stop finding it.
 * lib/__tests__/stewardship-board.test.ts pins the set of escalation matchers declared in
 * severity-tier-core.ts, so adding one fails this branch's suite and forces the prefilter to be
 * revisited in the same change. Flagged in the S2 slice report.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ INFERRED SQL THROUGHOUT: this sandbox has no live Neon. Every query is exported verbatim in
 * BOARD_INFERRED_SQL and listed in the slice report. Every read is fail-safe — a fault degrades that
 * section to empty with a visible note on the page, never a 500 and never a guessed number.
 */
import { sql } from '@/lib/db';
import { dedupeTwins } from '@/lib/severity-tier-core';
import { fetchIpdDoctorHop, hopCoverage, type HopCoverage, type HopResult } from '@/lib/ipd-doctor-hop';
import {
  opdDangerVerdict, ipdDangerVerdict, sortBoardRows,
  DISPUTE_PILLS,
  type DangerPillState, type DangerVerdict,
} from '@/lib/stewardship-danger-core';
import {
  IPD_DEPT_UNASSIGNED, OPD_DEPT_LABEL_SQL, OPD_DEPT_UNSPECIFIED,
  STEWARDSHIP_APP, STEWARDSHIP_WINDOW_DAYS, ipdCanonParams, ipdCanonical90d,
  opdCanonParams, opdCanonical90d,
} from '@/lib/stewardship-canonical';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (v == null ? '' : String(v));

/**
 * How many rows one page load RENDERS. Not how many it counts.
 *
 * ⚠️ THE 29 AUG VALIDATION CAUGHT THIS AS A LIVE DEFECT and it is worth keeping the lesson at the
 * constant. The inpatient leg had 1,248 eligible findings, a 500 cap, and an `ORDER BY audit_id` —
 * so 748 dangerous findings were dropped, and which 748 was decided by row uuid. A contested
 * inpatient finding could sit outside the queue purely because of its primary key.
 *
 * Two things changed. The open COUNT is now computed over EVERY eligible row, uncapped, by a
 * grouped aggregate that returns a handful of rows however large the corpus is — a number on a board
 * must not be a function of a display limit. And every capped LIST is ordered newest-first with a
 * deterministic tiebreak, so a cap that bites drops the OLDEST rows and drops the same ones twice.
 */
const CANDIDATE_CAP = 4_000;
const QUEUE_CAP = 500;

// ── the aggregate rows (the board's existing 90-day recipe) ───────────────────────────────

const AGG_SELECT = `
  count(*)::int AS n_notes,
  round(avg(t.note_quality_index))::int AS avg_nqi,
  round(100.0 * avg(CASE WHEN t.band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
  round(avg(t.score_appropriateness))::int AS avg_appr,
  round(avg(t.score_prescribing_safety))::int AS avg_presc,
  round(avg(t.completeness_pct))::int AS avg_complete,
  round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
  sum(t.n_low_value)::int AS sum_low,
  sum(t.n_interaction_alerts)::int AS sum_interactions`;

const AGG_COLS = `doctor_uid, note_quality_index, band,
    score_appropriateness, score_prescribing_safety, score_documentation,
    completeness_pct, n_low_value, n_interaction_alerts`;

const DOCTOR_SQL = `
  SELECT t.doctor_uid AS doctor_uid,
         COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
         ${OPD_DEPT_LABEL_SQL} AS speciality, ${AGG_SELECT}
  FROM ( ${opdCanonical90d(AGG_COLS)} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY t.doctor_uid, dd.doctor_name, dd.speciality
  ORDER BY n_notes DESC, doctor_name
  LIMIT 400`;

const DEPT_SQL = `
  SELECT ${OPD_DEPT_LABEL_SQL} AS dept,
         count(DISTINCT t.doctor_uid)::int AS n_doctors, ${AGG_SELECT}
  FROM ( ${opdCanonical90d(AGG_COLS)} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  GROUP BY 1`;

/** The directory, for naming a clinician the inpatient hop resolved. One row per clinician; the
 *  board's own rows carry names already, but the danger queue is built before them and must not
 *  depend on which board grain the page happens to be rendering. */
const NAMES_SQL = `
  SELECT doctor_uid, COALESCE(NULLIF(doctor_name, ''), '(unknown)') AS doctor_name
    FROM doctor_directory`;

const TOTAL_SQL = `
  SELECT count(*)::int AS n_notes,
         round(avg(t.note_quality_index))::int AS avg_nqi,
         round(100.0 * avg(CASE WHEN t.band IN ('A','B') THEN 1 ELSE 0 END))::int AS pct_ab,
         round(100.0 * avg(CASE WHEN t.n_low_value > 0 THEN 1 ELSE 0 END))::int AS pct_low,
         sum(t.n_low_value)::int AS sum_low,
         sum(t.n_interaction_alerts)::int AS sum_interactions
  FROM ( ${opdCanonical90d('note_quality_index, band, n_low_value, n_interaction_alerts')} ) t`;

// ── the danger queue's three reads ────────────────────────────────────────────────────────

/**
 * A SUPERSET of the ratified escalation patterns (severity-tier-core §3). Read the file header
 * before changing a line of this array.
 *
 *   E-1 matches: acute coronary syndrome · ACS · unstable angina · myocardial infarction ·
 *                exertional chest pain / heaviness          → the first six patterns
 *   E-2 requires: "persistent" or "unexplained" somewhere in the text, before any of its other
 *                 conditions can hold                       → the last two patterns
 *
 * Every pattern is wider than the regex it stands in for. That is the direction the error must run.
 */
const ESCALATION_PREFILTER = [
  '%acute coronary%', '%acs%', '%unstable angina%', '%myocardial infarction%',
  '%chest pain%', '%chest heaviness%',
  '%persistent%', '%unexplained%',
];

const FINDING_LATERAL = (col: string) =>
  `jsonb_array_elements(CASE WHEN jsonb_typeof(${col}) = 'array' THEN ${col} ELSE '[]'::jsonb END)`;

const NOTE_DAY = `to_char((t.note_date AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD')`;

/**
 * D1 — the escalation candidates, with each finding's CURRENT pill. $1 app · $2 days · $3 prefilter
 * · $4 study (NULL = production rows only; §8's always-present predicate).
 *
 * ⚠️ THE PILL IS FOUND THROUGH THE NOTE, NOT THROUGH THE CANONICAL ROW. This lateral used to read
 * `v.audit_id = t.id`, which only sees pills left on the row the canonical rule happens to select.
 * The 29 Aug validation measured 29,255 rows over 22,404 distinct uids in the window — 23% of rows
 * are non-canonical — so a reviewer who pilled a finding on an earlier audit of the same note had
 * that pill silently ignored. Here that direction of the error INFLATES the open count: a finding
 * closed as `false` on a superseded row went on being counted open. The join now goes through the
 * note's `uid`, so any pill on any audit of that note is the pill.
 */
const DANGER_ESCALATION_SQL = `
  SELECT t.id AS audit_id, t.doctor_uid,
         COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
         ${OPD_DEPT_LABEL_SQL} AS dept,
         ${NOTE_DAY} AS note_day,
         f->>'subject' AS subject,
         COALESCE(f->>'signal_type', '') AS signal_type,
         COALESCE(f->>'rationale', '') AS rationale,
         COALESCE(f->>'verdict', '') AS verdict,
         COALESCE(f->>'domain', '') AS domain,
         COALESCE(f->>'finding_ref', '') AS finding_ref,
         COALESCE((f->>'informational')::boolean, false) AS informational,
         fb.verdict AS pill
  FROM ( ${opdCanonical90d('id, doctor_uid, note_date, findings')} ) t
  LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
  CROSS JOIN LATERAL ${FINDING_LATERAL('t.findings')} f
  LEFT JOIN LATERAL (
    SELECT v.verdict
      FROM opd_audit_feedback v
      JOIN opd_note_audits av ON av.id = v.audit_id
     WHERE av.uid = t.uid AND v.scope = 'finding' AND v.finding_ref = f->>'finding_ref'
       AND v.app_source = $1 AND v.study IS NOT DISTINCT FROM $4
     ORDER BY v.created_at DESC
     LIMIT 1
  ) fb ON true
  WHERE COALESCE(f->>'subject', '') <> ''
    AND (COALESCE(f->>'subject', '') || ' ' || COALESCE(f->>'rationale', '')) ILIKE ANY ($3::text[])
  ORDER BY t.note_date DESC, t.id, f->>'subject'
  LIMIT ${CANDIDATE_CAP}`;

/**
 * D2 — every finding whose CURRENT pill is an OPEN DISPUTE, whatever its tier. The inner query
 * settles "current"; the outer one keeps only the disputes, so a finding contested and then
 * confirmed does not appear. $1 app · $2 days · $3 study · $4 dispute pills.
 *
 * ⚠️ THREE THINGS THE 29 AUG VALIDATION CHANGED HERE, all the same defect wearing three hats.
 *
 * 1. The join is through the note's `uid`, not the canonical row's `id`. Feedback is keyed to an
 *    AUDIT ROW; the canonical basis keeps one row per NOTE. 23% of window rows are non-canonical, so
 *    a pill left on any of them vanished — and on this leg that means a contested finding simply not
 *    appearing in the queue at all. `a` is the row the reviewer was actually looking at; `t` is the
 *    canonical row that owns the note's identity, its clinician and its department.
 *
 * 2. "Current" is now settled per (note uid, finding_ref) rather than per (audit_id, finding_ref).
 *    Once pills from every row of a note count, two rows of one note can each carry a verdict on the
 *    same finding — and latest-wins has to mean latest across the note, or one note could contribute
 *    a `contested` and a `false` for the same finding at the same time.
 *
 * 3. The finding TEXT is read from `a.findings` — the row that was pilled — not from the canonical
 *    row. The reviewer adjudicated the words in front of them.
 *
 * The outer filter is `= ANY($4)` rather than `= 'contested'`: A5 opens on `needs_action` too, and
 * that list lives in one place (DISPUTE_PILLS) rather than in each WHERE clause.
 */
const DANGER_CONTESTED_SQL = `
  SELECT * FROM (
    SELECT DISTINCT ON (t.uid, fb.finding_ref)
           t.id AS audit_id, t.doctor_uid,
           COALESCE(NULLIF(dd.doctor_name, ''), '(unknown)') AS doctor_name,
           ${OPD_DEPT_LABEL_SQL} AS dept,
           ${NOTE_DAY} AS note_day,
           fb.finding_ref, fb.verdict AS pill,
           COALESCE(fj.f->>'subject', '') AS subject,
           COALESCE(fj.f->>'signal_type', '') AS signal_type,
           COALESCE(fj.f->>'rationale', '') AS rationale,
           COALESCE(fj.f->>'verdict', '') AS verdict,
           COALESCE(fj.f->>'domain', '') AS domain
    FROM opd_audit_feedback fb
    JOIN opd_note_audits a ON a.id = fb.audit_id
    JOIN ( ${opdCanonical90d('id, doctor_uid, note_date, findings')} ) t ON t.uid = a.uid
    LEFT JOIN doctor_directory dd ON dd.doctor_uid = t.doctor_uid
    LEFT JOIN LATERAL (
      SELECT x AS f FROM ${FINDING_LATERAL('a.findings')} x
       WHERE x->>'finding_ref' = fb.finding_ref
       LIMIT 1
    ) fj ON true
    WHERE fb.scope = 'finding' AND fb.finding_ref IS NOT NULL
      AND fb.app_source = $1 AND fb.study IS NOT DISTINCT FROM $3
    ORDER BY t.uid, fb.finding_ref, fb.created_at DESC
  ) q
  WHERE q.pill = ANY($4::text[])
  ORDER BY q.note_day DESC, q.audit_id, q.finding_ref
  LIMIT ${QUEUE_CAP}`;

/**
 * D3 — the inpatient leg: safety-domain findings and open disputes, on A6's canonical stays.
 * $1 engine · $2 app · $3 dispute pills. No clinician is attributed: the hop is S3's.
 *
 * ⚠️ SPLIT IN TWO ON 29 AUG, because one query was doing two jobs and doing one of them wrong. The
 * COUNT on the board must be the truth about the whole window; the LIST on the page is what fits on
 * a page. When they were the same query, the count inherited the list's cap and the board reported
 * 500 of 1,248 dangerous inpatient findings as though 500 were all of them.
 *
 * The shared body is `IPD_DANGER_BODY`, so the two can never disagree about what "eligible" means.
 */
const IPD_DANGER_BODY = `
    SELECT t.id AS audit_id, t.ip_uid, t.audited_at AS audited_at_raw,
           COALESCE(NULLIF(t.speciality, ''), '${IPD_DEPT_UNASSIGNED}') AS dept,
           f->>'subject' AS subject,
           COALESCE(f->>'domain', '') AS domain,
           COALESCE(f->>'verdict', '') AS verdict,
           fb.verdict AS pill
    FROM ( ${ipdCanonical90d('id, speciality, findings, audited_at')} ) t
    CROSS JOIN LATERAL ${FINDING_LATERAL('t.findings')} f
    LEFT JOIN LATERAL (
      SELECT v.verdict
        FROM ipd_audit_feedback v
       WHERE v.audit_id = t.id AND v.finding_ref = f->>'subject' AND v.app_source = $2
       ORDER BY v.created_at DESC
       LIMIT 1
    ) fb ON true
    WHERE COALESCE(f->>'subject', '') <> ''`;

/** The eligibility rule, written once and used by both the count and the list. */
const IPD_DANGER_ELIGIBLE = `q.domain = 'safety' OR q.pill = ANY($3::text[])`;

/**
 * D3a — THE COUNT, over every eligible row, uncapped. It groups rather than returning rows, so the
 * result stays a handful of rows however large the corpus grows, and the membership decision still
 * belongs to `ipdDangerVerdict` in TypeScript: the group key carries exactly the three fields that
 * function reads.
 */
const DANGER_IPD_COUNT_SQL = `
  SELECT q.dept, q.domain, q.verdict, q.pill, count(*)::int AS n
  FROM (${IPD_DANGER_BODY}
  ) q
  WHERE ${IPD_DANGER_ELIGIBLE}
  GROUP BY 1, 2, 3, 4`;

/** D3b — THE LIST. Newest audit first, with a deterministic tiebreak, so a cap that bites drops the
 *  oldest rows and drops the same ones on every load. */
const DANGER_IPD_SQL = `
  SELECT * FROM (${IPD_DANGER_BODY}
  ) q
  WHERE ${IPD_DANGER_ELIGIBLE}
  ORDER BY q.audited_at_raw DESC NULLS LAST, q.audit_id, q.subject
  LIMIT ${QUEUE_CAP}`;

/**
 * S3 — the canonical inpatient stays the board reads, on A6's recipe: one row per `ip_uid`, latest
 * `audited_at`, `ipd-discharge-audit/0.2` only, 90 IST days. `ipd-stay-audit/0.1` rows are drill
 * context on the case page and never enter this aggregate.
 *
 * The clinician is NOT in this query and cannot be: `ipd_discharge_audits` has no `doctor_uid`
 * column, the hop lives in db13, and A1 says read time. This returns stays; lib/ipd-doctor-hop.ts
 * says who was treating them; nothing joins the two in storage.
 *
 * $1 = engine version.
 */
const IPD_BOARD_STAYS_SQL = `
  SELECT t.ip_uid,
         COALESCE(NULLIF(t.speciality, ''), '${IPD_DEPT_UNASSIGNED}') AS dept,
         t.care_value_index, t.band
  FROM ( ${ipdCanonical90d('speciality, care_value_index, band, audited_at')} ) t
  ORDER BY t.audited_at DESC`;

// ── shapes ────────────────────────────────────────────────────────────────────────────────

export interface BoardMetrics {
  nNotes: number; avgNqi: number; pctAb: number;
  avgAppr: number; avgPresc: number; avgComplete: number;
  pctLow: number; sumLow: number; sumInteractions: number;
}
export interface BoardDoctorRow extends BoardMetrics {
  doctorUid: string; doctorName: string; speciality: string;
  openDangerous: number; confirmedDangerous: number;
  /** A1 — the mean CVI over the stays the practitioner-id hop RESOLVED to this clinician, or null
   *  when none resolved. Null is a refusal, never a zero: an unjoined clinician has no measured
   *  inpatient quality, which is a different statement from a poor one, and it sorts last. */
  ipdCvi: number | null; ipdStays: number;
}
export interface BoardDeptRow extends BoardMetrics {
  dept: string; nDoctors: number;
  openDangerous: number; confirmedDangerous: number;
  /** The department roll-up's inpatient cell stays NULL by decision, not by omission: this label is
   *  the OPD speciality vocabulary and the stays carry the inpatient one. Rolling resolved stays up
   *  through their clinician's OPD department would put an inpatient number under an OPD label and
   *  quietly perform the vocabulary merge F-10 forbids. The inpatient slice below shows that side in
   *  its OWN vocabulary instead. */
  ipdCvi: number | null; ipdStays: number;
}

/** One inpatient department, in the INPATIENT vocabulary, with what the hop could and could not
 *  attribute. This is A1's "IPD-only slice with the split banner for the unresolved remainder". */
export interface IpdSliceRow {
  dept: string;
  stays: number;
  joined: number;
  avgCvi: number | null;
  pctAb: number;
}

export interface IpdSlice {
  rows: IpdSliceRow[];
  coverage: HopCoverage;
  /** ip_uid -> who is treating, or a named refusal. Shared with the danger queue so the two agree. */
  byIpUid: Record<string, HopResult>;
  /** doctor_uid -> inpatient quality, for the board column. Only resolved stays are in here. */
  byDoctor: Record<string, { stays: number; avgCvi: number }>;
  ambiguousIds: string[];
  /** True when the Neon stay read failed (as distinct from the db13 hop failing). */
  unavailable: boolean;
}
export interface DangerRow {
  surface: 'opd' | 'ipd';
  auditId: string;
  subject: string;
  signalType: string;
  domain: string;
  doctorUid: string | null;
  doctorName: string;
  dept: string;
  day: string;
  occurrences: number;
  state: DangerPillState;
  open: boolean;
  leg: DangerVerdict['leg'];
  escalatedBy?: 'E-1' | 'E-2';
  reason: string;
  href: string;
}
export interface DangerQueue {
  /** The rows the surface RENDERS. The OPD legs are complete at today's volumes; the inpatient list
   *  is capped, newest-audit-first, and says so through `ipdEligible` vs `ipdShown`. */
  rows: DangerRow[];
  /** doctor_uid → counts, for the board column. Only the OPD leg can key a clinician today. */
  byDoctor: Record<string, { open: number; confirmed: number }>;
  /** department label → counts. The OPD and inpatient vocabularies are kept apart by surface. */
  byOpdDept: Record<string, { open: number; confirmed: number }>;
  /** inpatient department label → counts, from the UNCAPPED grouped count. Its own vocabulary. */
  byIpdDept: Record<string, { open: number; confirmed: number }>;
  /** ⚠️ COUNTED OVER EVERY ELIGIBLE ROW, not over `rows`. The board's headline number must not be a
   *  function of how many rows fit on a page — that was the 29 Aug defect. */
  openTotal: number;
  opdOpen: number;
  ipdOpen: number;
  /** How many inpatient findings were eligible in the whole window, and how many are rendered. */
  ipdEligible: number;
  ipdShown: number;
  /** True when a cap bit, so the surface can say the queue is partial rather than imply it is whole. */
  capped: boolean;
  /** True when a read failed: the section degrades to empty WITH a note (§6a). */
  unavailable: boolean;
}

const metricsOf = (r: Record<string, unknown>): BoardMetrics => ({
  nNotes: num(r.n_notes), avgNqi: num(r.avg_nqi), pctAb: num(r.pct_ab),
  avgAppr: num(r.avg_appr), avgPresc: num(r.avg_presc), avgComplete: num(r.avg_complete),
  pctLow: num(r.pct_low), sumLow: num(r.sum_low), sumInteractions: num(r.sum_interactions),
});

// ── the reads ─────────────────────────────────────────────────────────────────────────────

/**
 * THE DANGER QUEUE. Three reads, one merge, `tierFor` deciding the OPD severity leg and A5 deciding
 * every pill. Fail-safe: any read that throws contributes nothing and sets `unavailable`, and the
 * board then shows an empty queue with a visible note instead of a 500 or a false zero.
 */
export async function fetchDangerQueue(ipd0: IpdSlice): Promise<DangerQueue> {
  const p = opdCanonParams();
  const ipdP = ipdCanonParams();
  const disputes = [...DISPUTE_PILLS];
  let unavailable = false;
  const guard = async (text: string, params: unknown[]): Promise<Record<string, unknown>[]> => {
    try { return await run(text, params); } catch { unavailable = true; return []; }
  };

  const [escRows, conRows, ipdCountRows, ipdRows, nameRows] = await Promise.all([
    guard(DANGER_ESCALATION_SQL, [...p, ESCALATION_PREFILTER, null]),
    guard(DANGER_CONTESTED_SQL, [...p, null, disputes]),
    guard(DANGER_IPD_COUNT_SQL, [...ipdP, STEWARDSHIP_APP, disputes]),
    guard(DANGER_IPD_SQL, [...ipdP, STEWARDSHIP_APP, disputes]),
    guard(NAMES_SQL, []),
  ]);
  const nameOf = new Map(nameRows.map((r) => [str(r.doctor_uid), str(r.doctor_name)]));

  // ── OPD. The two legs can name the same finding (an escalated finding that was also disputed),
  // so they are merged on (audit_id, finding_ref | subject) before anything is counted.
  const opd = new Map<string, DangerRow & { _twinRef: string | null }>();
  const addOpd = (r: Record<string, unknown>) => {
    const subject = str(r.subject);
    if (!subject) return;
    const findingRef = str(r.finding_ref);
    const v = opdDangerVerdict({
      signal_type: str(r.signal_type), verdict: str(r.verdict), domain: str(r.domain),
      subject, rationale: str(r.rationale),
      informational: r.informational === true,
    }, r.pill);
    if (!v.included) return;
    const auditId = str(r.audit_id);
    const key = `${auditId}|${findingRef || subject}`;
    const prev = opd.get(key);
    if (prev) {
      // Both legs found it. Keep the richer reason and the strongest leg.
      prev.leg = prev.leg === v.leg ? prev.leg : 'both';
      return;
    }
    opd.set(key, {
      surface: 'opd', auditId, subject,
      signalType: str(r.signal_type), domain: str(r.domain),
      doctorUid: str(r.doctor_uid) || null, doctorName: str(r.doctor_name) || '(unknown)',
      dept: str(r.dept) || OPD_DEPT_UNSPECIFIED, day: str(r.note_day),
      occurrences: 1, state: v.state, open: v.open, leg: v.leg,
      ...(v.escalatedBy ? { escalatedBy: v.escalatedBy } : {}),
      reason: v.reason,
      href: `/admin/opd-audit/${auditId}`,
      _twinRef: findingRef || null,
    });
  };
  for (const r of escRows) addOpd(r);
  for (const r of conRows) addOpd(r);

  // §1.4 — TWINS: the same finding written for one clinician twice on one day is ONE decision, and
  // the queue is a list of decisions. `dedupeTwins` is the canonical helper for exactly this, and
  // this is the first surface to render cross-note finding rows; the reporting unit is stated on
  // the surface (DANGER_QUEUE_UNIT).
  const deduped = dedupeTwins([...opd.values()].map((f) => ({
    finding: f, findingRef: f._twinRef, doctorUid: f.doctorUid, noteDate: f.day,
  })));
  const opdRows: DangerRow[] = deduped.map(({ finding, occurrences }) => {
    const { _twinRef: _drop, ...row } = finding;
    return { ...row, occurrences };
  });

  // ── IPD, the COUNT: every eligible row in the window, grouped. The membership decision is still
  // `ipdDangerVerdict`'s — the group key carries exactly the three fields it reads.
  const byIpdDept: Record<string, { open: number; confirmed: number }> = {};
  let ipdOpen = 0;
  let ipdEligible = 0;
  for (const g of ipdCountRows) {
    const n = num(g.n);
    ipdEligible += n;
    const v = ipdDangerVerdict({ subject: 'x', domain: str(g.domain), verdict: str(g.verdict) }, g.pill);
    if (!v.included) continue;
    const dept = str(g.dept) || IPD_DEPT_UNASSIGNED;
    const cell = byIpdDept[dept] ?? (byIpdDept[dept] = { open: 0, confirmed: 0 });
    if (v.open) { ipdOpen += n; cell.open += n; } else if (v.state === 'confirmed') cell.confirmed += n;
  }

  // ── IPD, the LIST. No clinician key exists on this spine (A1), so these rows carry a department
  // and no person. They never enter the per-doctor column.
  const ipdRowsByStay = ipd0.byIpUid;
  const ipd: DangerRow[] = [];
  for (const r of ipdRows) {
    const subject = str(r.subject);
    if (!subject) continue;
    const v = ipdDangerVerdict({ subject, domain: str(r.domain), verdict: str(r.verdict) }, r.pill);
    if (!v.included) continue;
    const auditId = str(r.audit_id);
    // A1 — the clinician appears on this row ONLY when the practitioner-id hop resolved the stay.
    // Everything else stays unattributed and renders as the split banner, which is the difference
    // between "this stay is Dr X's" and "we do not know whose stay this is".
    const res = ipdRowsByStay[str(r.ip_uid)];
    const resolvedUid = res?.reason === 'resolved' ? res.doctorUid : null;
    ipd.push({
      surface: 'ipd', auditId, subject, signalType: '', domain: str(r.domain),
      doctorUid: resolvedUid,
      doctorName: resolvedUid ? (nameOf.get(resolvedUid) || '(unknown)') : '',
      dept: str(r.dept) || IPD_DEPT_UNASSIGNED,
      day: str(r.audited_at_raw).slice(0, 10),
      occurrences: 1, state: v.state, open: v.open, leg: v.leg, reason: v.reason,
      href: `/admin/ipd-audit/${auditId}`,
    });
  }

  // ⚠️ THE PER-CLINICIAN COUNT IS OPD-ONLY, DELIBERATELY, and this is the one S3 decision worth
  // arguing with. Resolved inpatient danger rows DO carry a clinician's name in the queue, so an MS
  // can see whose stay it is. They are NOT added to the board's open-dangerous column, because that
  // column is the leaderboard's primary SORT KEY and the hop resolves 41% of AUDITED stays (281 of
  // 685, round-2 validation F-1 — the 46% figure is the admissions-table basis): folding it in
  // would rank a clinician safer for having an ambiguous practitioner id. Two clinicians with the
  // same risk must not rank differently on join luck. Flagged for V in the S3 report; reversing it
  // is one `bump()` call.
  const byDoctor: Record<string, { open: number; confirmed: number }> = {};
  const byOpdDept: Record<string, { open: number; confirmed: number }> = {};
  let opdOpen = 0;
  for (const r of opdRows) {
    if (r.state === 'dropped') continue;
    if (r.open) opdOpen += r.occurrences;
    const bump = (m: Record<string, { open: number; confirmed: number }>, k: string) => {
      const cell = m[k] ?? (m[k] = { open: 0, confirmed: 0 });
      if (r.open) cell.open += r.occurrences; else if (r.state === 'confirmed') cell.confirmed += r.occurrences;
    };
    if (r.doctorUid) bump(byDoctor, r.doctorUid);
    bump(byOpdDept, r.dept);
  }

  // Open first, then the confirmed ones, then the rest; newest day first inside each group.
  const rank = (r: DangerRow) => (r.open ? 0 : r.state === 'confirmed' ? 1 : 2);
  const rows = [...opdRows, ...ipd].sort((a, b) =>
    rank(a) - rank(b) || b.day.localeCompare(a.day) || a.subject.localeCompare(b.subject));

  const capped = escRows.length >= CANDIDATE_CAP || conRows.length >= QUEUE_CAP || ipd.length < ipdEligible;

  return {
    rows, byDoctor, byOpdDept, byIpdDept,
    openTotal: opdOpen + ipdOpen, opdOpen, ipdOpen,
    ipdEligible, ipdShown: ipd.length,
    capped, unavailable,
  };
}

/**
 * S3 — the inpatient side: the canonical stays (Neon, A6), who was treating them (db13, A1), and
 * the honest counts for both. ONE db13 call for the whole window.
 *
 * TWO FAILURE MODES, KEPT APART ON PURPOSE. If the Neon stay read fails there are no stays to talk
 * about and `unavailable` says so. If the db13 HOP fails there are stays but no clinicians, and
 * `coverage.unavailable` says THAT — the slice still renders every stay, in its own vocabulary, all
 * unjoined. Collapsing the two would let "db13 is down" render as "this ward had no admissions".
 */
export async function fetchIpdSlice(): Promise<IpdSlice> {
  let stayRows: Record<string, unknown>[];
  try { stayRows = await run(IPD_BOARD_STAYS_SQL, ipdCanonParams()); }
  catch {
    return {
      rows: [], coverage: hopCoverage(0, {}), byIpUid: {}, byDoctor: {},
      ambiguousIds: [], unavailable: true,
    };
  }

  const stays = stayRows.map((r) => ({
    ipUid: str(r.ip_uid),
    dept: str(r.dept) || IPD_DEPT_UNASSIGNED,
    cvi: r.care_value_index == null ? null : num(r.care_value_index),
    band: str(r.band),
  })).filter((x) => x.ipUid);

  const hop = await fetchIpdDoctorHop(stays.map((x) => x.ipUid));

  // Per inpatient department, in the INPATIENT vocabulary. `joined` is what the hop resolved, and it
  // travels beside `stays` so the number is never read as a whole-department figure.
  const byDept = new Map<string, { stays: number; joined: number; sum: number; n: number; ab: number }>();
  const byDoctor: Record<string, { stays: number; sum: number }> = {};
  for (const st of stays) {
    const d = byDept.get(st.dept) ?? { stays: 0, joined: 0, sum: 0, n: 0, ab: 0 };
    d.stays += 1;
    if (st.cvi != null) { d.sum += st.cvi; d.n += 1; }
    if (st.band === 'A' || st.band === 'B') d.ab += 1;
    const res = hop.byIpUid[st.ipUid];
    if (res?.reason === 'resolved' && res.doctorUid) {
      d.joined += 1;
      if (st.cvi != null) {
        const cell = byDoctor[res.doctorUid] ?? (byDoctor[res.doctorUid] = { stays: 0, sum: 0 });
        cell.stays += 1; cell.sum += st.cvi;
      }
    }
    byDept.set(st.dept, d);
  }

  const rows: IpdSliceRow[] = [...byDept.entries()]
    .map(([dept, d]) => ({
      dept, stays: d.stays, joined: d.joined,
      avgCvi: d.n ? Math.round(d.sum / d.n) : null,
      pctAb: d.stays ? Math.round((100 * d.ab) / d.stays) : 0,
    }))
    .sort((a, b) => b.stays - a.stays || a.dept.localeCompare(b.dept));

  return {
    rows,
    coverage: hopCoverage(stays.length, hop.byIpUid, hop.coverage.unavailable),
    byIpUid: hop.byIpUid,
    byDoctor: Object.fromEntries(Object.entries(byDoctor).map(([uid, c]) => [uid, { stays: c.stays, avgCvi: Math.round(c.sum / c.stays) }])),
    ambiguousIds: hop.ambiguousIds,
    unavailable: false,
  };
}

/** The named-clinician board rows, already sorted by the D-no-composite rule. */
export async function fetchDoctorBoard(queue: DangerQueue, ipd: IpdSlice): Promise<BoardDoctorRow[]> {
  const rows = await run(DOCTOR_SQL, opdCanonParams()).catch(() => []);
  const built: BoardDoctorRow[] = rows.map((r) => {
    const uid = str(r.doctor_uid);
    const d = queue.byDoctor[uid] ?? { open: 0, confirmed: 0 };
    // A1 — the inpatient cell is populated ONLY from stays the practitioner-id hop resolved to this
    // clinician. A clinician with no resolved stay keeps `null`, which renders as the split banner's
    // cell and sorts last; it is not a zero and it must never be read as one.
    const ipdCell = ipd.byDoctor[uid];
    return {
      ...metricsOf(r),
      doctorUid: uid,
      doctorName: str(r.doctor_name) || '(unknown)',
      speciality: str(r.speciality) || OPD_DEPT_UNSPECIFIED,
      openDangerous: d.open, confirmedDangerous: d.confirmed,
      ipdCvi: ipdCell ? ipdCell.avgCvi : null,
      ipdStays: ipdCell ? ipdCell.stays : 0,
    };
  });
  return sortBoardRows(built.map((r) => ({ ...r, avgNqi: r.avgNqi, label: r.doctorName })))
    .map(({ label: _drop, ...r }) => r);
}

/** The department roll-up, same three columns, OPD vocabulary. */
export async function fetchDeptBoard(queue: DangerQueue): Promise<BoardDeptRow[]> {
  const rows = await run(DEPT_SQL, opdCanonParams()).catch(() => []);
  const built: BoardDeptRow[] = rows.map((r) => {
    const dept = str(r.dept) || OPD_DEPT_UNSPECIFIED;
    const d = queue.byOpdDept[dept] ?? { open: 0, confirmed: 0 };
    return {
      ...metricsOf(r), dept, nDoctors: num(r.n_doctors),
      openDangerous: d.open, confirmedDangerous: d.confirmed,
      ipdCvi: null, ipdStays: 0,
    };
  });
  return sortBoardRows(built.map((r) => ({ ...r, label: r.dept })))
    .map(({ label: _drop, ...r }) => r);
}

/** The window's totals, for the headline tiles. Fail-safe → zeros. */
export async function fetchBoardTotals(): Promise<BoardMetrics> {
  const rows = await run(TOTAL_SQL, opdCanonParams()).catch(() => []);
  return metricsOf(rows[0] ?? {});
}

/** Every INFERRED query this file runs, for the slice report and a live-validation pass. */
export const BOARD_INFERRED_SQL: Readonly<Record<string, string>> = Object.freeze({
  board_doctor: DOCTOR_SQL,
  board_dept: DEPT_SQL,
  board_totals: TOTAL_SQL,
  danger_escalation: DANGER_ESCALATION_SQL,
  danger_contested: DANGER_CONTESTED_SQL,
  danger_ipd_count: DANGER_IPD_COUNT_SQL,
  danger_ipd: DANGER_IPD_SQL,
  ipd_board_stays: IPD_BOARD_STAYS_SQL,
});

/** The prefilter, exported so the test can prove it is a superset of the ratified patterns. */
export const BOARD_ESCALATION_PREFILTER: readonly string[] = ESCALATION_PREFILTER;
export const BOARD_WINDOW_DAYS = STEWARDSHIP_WINDOW_DAYS;
