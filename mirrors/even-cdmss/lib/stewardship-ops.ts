/**
 * lib/stewardship-ops.ts — the consult-ops pane's db13 reads
 * (CDMSS-STEWARDSHIP-MS-AGENT-KICKOFF-v2-29-AUG-2026, A4 / A7–A10; spec §4 D-ops-*).
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * CARD 8747 IS NEVER FETCHED. It is a dated extract with a hardcoded Jun 01 – Sep 01 2026 IST
 * window and a third literal date inside its TC block, last edited 2026-08-20. Polling it returns a
 * frozen quarter. Every metric below is rebuilt as live SQL against the same db13 tables, from the
 * dictionary in `handoff-docs/CDMSS-CONSULTS-OPS-DICTIONARY-8747-EVIDENCE-29-AUG-2026.md`, with the
 * card's own measured traps corrected rather than copied.
 *
 * WHAT THE DICTIONARY MEASURED AND THIS FILE DOES DIFFERENTLY, each with the reason:
 *
 *   · `is_no_show` is null on 92% of rows and TRUE on 3 CANCELED and 6 DOCTOR_NO_SHOW rows, so it
 *     conflates three outcomes. Patient no-show is `status = 'NO_SHOW'` (A9).
 *   · Doctor no-show is `status = 'DOCTOR_NO_SHOW'` — NEW WORK, not a reconstruction: card 8747
 *     computes no such thing, and the surface labels it as new.
 *   · The cancelling actor comes from the LAST `history` element, not from `cancelled_by`, which is
 *     populated on 561 of 2,689 cancelled rows.
 *   · TC identification is the resolved join URL, not the blank facility name (A4). The two disagree
 *     on 3 rows in 30d, and the URL keys on the actual Meet artefact.
 *   · CSAT averages RATED rows only. The card's `ELSE 0` maps 74% of latest-feedback rows — the
 *     unrated ones — to a score of zero, and zero is not a rating (A8).
 *   · `rating__submitted_at` is TEXT, so the card's recency ordering is a lexical string sort that
 *     works only while every row shares one format. It is cast here.
 *   · The TC on-time patient side drops its `LIKE '%gmail.com'` filter (A10), which silently
 *     discarded 496 distinct non-gmail patients and 688 measurable consults in 30d.
 *   · `chart_financial_reporting__services` is DEDUPED per `calendar_uid` before any join: 59
 *     calendar_uids carry 2–5 rows and the card multiplies on them.
 *
 * THE THREE DECK-BASIS REPLICAS (A7 / A8 / A10) are computed HERE, live, from the same tables, in
 * the same query as their primary. They exist for reconciliation with the existing slides and for
 * nothing else: they sort nothing, they feed no standing, and the type makes them a field of the
 * primary so neither can be rendered alone.
 *
 * WAIT is the 28 Aug method (`handoff-docs/OPD-REAL-WAIT-METHOD-28-AUG-2026.md`), not slot lead time
 * and not check-in-to-Rx: same-calendar-day token open → CONSULTATION `called_at`. Previous-day
 * stamps are DROPPED and counted, because Chart copies yesterday's booking onto today's check-in on
 * roughly a quarter of rows and those "waits" are 10–120 hours of lead time.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ INFERRED SQL THROUGHOUT — no live DB in this sandbox. Every string is exported verbatim in
 * `OPS_INFERRED_SQL`. `metabaseQuery` takes NO bind parameters, so the window is inlined as an
 * integer literal built from a code constant, never from user input. Every read is fail-safe: a
 * fault leaves that metric UNKNOWN (an em-dash), never zero.
 */
import { metabaseQuery } from './metabase';
import { sql } from './db';
import { STEWARDSHIP_APP, STEWARDSHIP_WINDOW_DAYS, opdCanonical90d, opdCanonParams } from './stewardship-canonical';
import {
  buildEmailMap, buildOpsRow, orderOpsRows,
  type EmailMap, type OpsInputs, type OpsRow,
} from './stewardship-ops-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const numOrNull = (v: unknown): number | null => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const str = (v: unknown): string => (v == null ? '' : String(v));
const lower = (v: unknown): string => str(v).trim().toLowerCase();

/** D-ops-live — the ops window is LABELLED, and it is the room's window so the pane and the board
 *  describe the same stretch of time. Inlined as an integer literal because Metabase takes no bind
 *  parameters; it comes from a code constant and never from a request. */
export const OPS_WINDOW_DAYS = STEWARDSHIP_WINDOW_DAYS;
const IST = `AT TIME ZONE 'Asia/Kolkata'`;
/** An IST calendar-day window that also excludes FUTURE slots — hundreds of them sit in the table
 *  and a booking that has not happened yet is not an ops fact about anybody. */
const EV_WINDOW = `(ce.start_time ${IST})::date >= (now() ${IST})::date - ${OPS_WINDOW_DAYS}
     AND (ce.start_time ${IST})::date <= (now() ${IST})::date`;
/** The four statuses that mean the consult did not happen as booked. */
const NOT_COMPLETED = `('CANCELED', 'NO_SHOW', 'DOCTOR_NO_SHOW', 'RESCHEDULED')`;
/** A4 — teleconsult is the resolved Meet URL, not the blank facility name. */
const IS_TC = `ce.consultation_conference__resolved_join_url IS NOT NULL AND trim(ce.consultation_conference__resolved_join_url) <> ''`;

// ── O0: the identity hop (D-ops-identity — unique e-mail or nothing) ───────────────────────

const EMAIL_MAP_SQL = `
SELECT lower(trim(email)) AS email, count(DISTINCT uid)::int AS n_uids, min(uid) AS uid
  FROM doctors
 WHERE email IS NOT NULL AND trim(email) <> ''
 GROUP BY 1`;

// ── O1: the calendar grain (booked / cancelled / no-shows / TC / Rx present) ───────────────

/**
 * `count(DISTINCT ce.event_uuid)` rather than `count(*)`: the dictionary's Caveat B records that
 * joining the Chart services table multiplies base rows on 59 calendar_uids. Nothing is joined here,
 * but counting the identity rather than the row is what makes that irrelevant instead of lucky.
 *
 * A7's two bases live side by side: `rx_present` is a prescription id on a COMPLETED consult, and
 * `rx_present_deck` is the card's dpipe-join replica. The dictionary measured the replica at 99.98%
 * of prescriptions that exist, which is why it is a reconciliation figure and not a metric.
 */
const CALENDAR_SQL = `
SELECT lower(trim(ce.employee_email)) AS email,
       count(DISTINCT ce.event_uuid)::int AS booked,
       count(DISTINCT ce.event_uuid) FILTER (WHERE ce.status = 'CANCELED')::int AS cancelled,
       count(DISTINCT ce.event_uuid) FILTER (WHERE ce.status = 'NO_SHOW')::int AS patient_no_show,
       count(DISTINCT ce.event_uuid) FILTER (WHERE ce.status = 'DOCTOR_NO_SHOW')::int AS doctor_no_show,
       count(DISTINCT ce.event_uuid) FILTER (WHERE ce.status = 'RESCHEDULED')::int AS rescheduled,
       count(DISTINCT ce.event_uuid) FILTER (WHERE ce.status NOT IN ${NOT_COMPLETED})::int AS completed,
       count(DISTINCT ce.event_uuid) FILTER (WHERE ${IS_TC})::int AS teleconsults,
       count(DISTINCT ce.event_uuid) FILTER (
         WHERE ce.status NOT IN ${NOT_COMPLETED}
           AND ce.prescription_uid IS NOT NULL AND trim(ce.prescription_uid) <> '')::int AS rx_present,
       count(DISTINCT ce.event_uuid) FILTER (
         WHERE ce.status NOT IN ${NOT_COMPLETED}
           AND ce.prescription_uid IN (SELECT d.presc_uid FROM dpipe_prescription_pipeline d))::int AS rx_present_deck
  FROM "accounts-members-calendar_events" ce
 WHERE ce.employee_email IS NOT NULL AND trim(ce.employee_email) <> ''
   AND ${EV_WINDOW}
 GROUP BY 1`;

/** O1b — who cancelled, from the LAST history element (A4). `cancelled_by` is sparse and is not
 *  read. The positional read assumes history is append-ordered, which the dictionary states and
 *  which SQL cannot verify; noted on the surface. */
const CANCEL_SOURCE_SQL = `
SELECT lower(trim(ce.employee_email)) AS email,
       COALESCE((ce.history -> (jsonb_array_length(ce.history) - 1)) ->> 'action_source', '(unrecorded)') AS action_source,
       count(DISTINCT ce.event_uuid)::int AS n
  FROM "accounts-members-calendar_events" ce
 WHERE ce.status = 'CANCELED'
   AND ce.employee_email IS NOT NULL AND trim(ce.employee_email) <> ''
   AND ${EV_WINDOW}
   AND jsonb_typeof(ce.history) = 'array' AND jsonb_array_length(ce.history) > 0
   AND (ce.history -> (jsonb_array_length(ce.history) - 1)) ->> 'status' = 'CANCELED'
 GROUP BY 1, 2`;

// ── O2: CSAT, two bases (A8) ──────────────────────────────────────────────────────────────

/**
 * The 1–5 map is the card's. What is NOT the card's is the average: `mean_rated` is over rows that
 * carry a rating, and `mean_deck` is the card's `ELSE 0` figure kept only for reconciliation. The
 * dictionary measured 3,716 of 5,016 latest rows unrated — three quarters — so the difference
 * between these two numbers is most of the metric.
 *
 * `rating__submitted_at` is cast to timestamptz before ordering: it is stored as TEXT and the card's
 * ordering is a lexical string sort that happens to work while every row shares one fixed-width
 * format.
 *
 * ⚠️ THE DENOMINATOR IS COMPLETED CONSULTS (round-2 validation, finding F-2). Without the status
 * filter a cancelled or no-showed event that happens to carry a `prescription_uid` entered `n_rx` —
 * 80 of 39,322 rx-bearing events in the window, 0.2%. Small, and wrong in a way that would have been
 * invisible: it deflates the response rate by counting consults that never happened as consults
 * nobody rated. It now matches the Rx-share denominator exactly, so the two rates on one row are
 * over one population.
 */
const CSAT_SCORE_CASE = `CASE f.rating__value
         WHEN 'HIGHLY_SATISFIED'   THEN 5
         WHEN 'SATISFIED'          THEN 4
         WHEN 'NEUTRAL'            THEN 3
         WHEN 'UNSATISFIED'        THEN 2
         WHEN 'HIGHLY_UNSATISFIED' THEN 1
       END`;

const CSAT_SQL = `
WITH ev AS (
  SELECT lower(trim(ce.employee_email)) AS email, ce.prescription_uid
    FROM "accounts-members-calendar_events" ce
   WHERE ce.employee_email IS NOT NULL AND trim(ce.employee_email) <> ''
     AND ce.prescription_uid IS NOT NULL AND trim(ce.prescription_uid) <> ''
     AND ce.status NOT IN ${NOT_COMPLETED}
     AND ${EV_WINDOW}
),
fb AS (
  SELECT DISTINCT ON (presc_uid) presc_uid, rating__value, score
    FROM (
      SELECT (f.feedback_metadata #>> array['teleconsultation_metadata','prescription_id']::text[]) AS presc_uid,
             f.rating__value,
             ${CSAT_SCORE_CASE} AS score,
             (f.rating__submitted_at)::timestamptz AS submitted_at
        FROM "individuals-feedbacks" f
       WHERE (f.feedback_metadata #>> array['teleconsultation_metadata','prescription_id']::text[]) IS NOT NULL
    ) x
   ORDER BY presc_uid, submitted_at DESC NULLS LAST
)
SELECT ev.email,
       count(*)::int AS n_rx,
       count(*) FILTER (WHERE fb.presc_uid IS NOT NULL)::int AS with_feedback_row,
       count(*) FILTER (WHERE fb.rating__value IS NOT NULL)::int AS n_rated,
       round(avg(fb.score) FILTER (WHERE fb.rating__value IS NOT NULL)::numeric, 2) AS mean_rated,
       round(avg(COALESCE(fb.score, 0)) FILTER (WHERE fb.presc_uid IS NOT NULL)::numeric, 2) AS mean_deck
  FROM ev
  LEFT JOIN fb ON fb.presc_uid = ev.prescription_uid
 GROUP BY 1`;

// ── O3: TC schedule adherence, two bases (A10) ────────────────────────────────────────────

/**
 * The card's overlap mechanic, with its patient filter removed (A10) and the replica kept beside it.
 * `any_gmail` and `doctor_start_gmail` carry the deck basis through the same aggregation, so the two
 * numbers come from one pass over one set of sessions rather than from two queries that could drift.
 *
 * The staff exclusion replaces the gmail assumption: a participant is a patient when their address
 * is not the doctor's and not an @even.in one.
 */
const TC_ADHERENCE_SQL = `
WITH ev AS (
  SELECT lower(trim(ce.employee_email)) AS email, ce.employee_email, ce.prescription_uid, ce.start_time,
         ce.consultation_conference__resolved_join_url AS murl
    FROM "accounts-members-calendar_events" ce
   WHERE ce.membership_id IS NOT NULL
     AND ce.employee_email IS NOT NULL AND trim(ce.employee_email) <> ''
     AND ce.prescription_uid IS NOT NULL AND trim(ce.prescription_uid) <> ''
     AND ${IS_TC}
     AND ${EV_WINDOW}
),
mm AS (
  SELECT ev.*, ca.meet_data__meet_key AS mkey, ca.participants
    FROM ev JOIN conference_activity ca ON ca.meet_data__meet_url = ev.murl
),
fl AS (
  SELECT mm.email, mm.employee_email, mm.prescription_uid, mm.start_time, mm.mkey,
         participant ->> 'email' AS p_email,
         (participant_session ->> 'start_time')::timestamptz AS p_start,
         (participant_session ->> 'end_time')::timestamptz   AS p_end
    FROM mm,
         LATERAL jsonb_array_elements(mm.participants)           AS participant,
         LATERAL jsonb_array_elements(participant -> 'sessions') AS participant_session
),
doc AS (SELECT * FROM fl WHERE lower(p_email) = lower(employee_email)),
pat AS (
  SELECT *, (lower(p_email) LIKE '%gmail.com') AS is_gmail
    FROM fl
   WHERE lower(p_email) <> lower(employee_email)
     AND lower(p_email) NOT LIKE '%@even.in'
),
dp AS (
  SELECT d.email, d.prescription_uid, d.start_time, d.p_start AS doctor_start, p.is_gmail
    FROM doc d
    JOIN pat p ON d.mkey = p.mkey AND d.p_end > p.p_start AND p.p_end > d.p_start
),
mp AS (
  SELECT email, prescription_uid,
         MIN(doctor_start) AS doctor_start,
         MAX(start_time)   AS start_time,
         bool_or(is_gmail) AS any_gmail,
         MIN(doctor_start) FILTER (WHERE is_gmail) AS doctor_start_gmail
    FROM dp
   GROUP BY 1, 2
)
SELECT email,
       count(*)::int AS measurable,
       count(*) FILTER (WHERE EXTRACT(EPOCH FROM (doctor_start - start_time)) <= 180)::int AS on_time,
       count(*) FILTER (WHERE any_gmail)::int AS measurable_deck,
       count(*) FILTER (WHERE any_gmail AND EXTRACT(EPOCH FROM (doctor_start_gmail - start_time)) <= 180)::int AS on_time_deck
  FROM mp
 GROUP BY 1`;

// ── O4: real wait (the 28 Aug method) ─────────────────────────────────────────────────────

/**
 * Same-calendar-day token open → CONSULTATION `called_at`. Both token hops are taken: the SCHEDULED
 * one (`queue_tokens.target_uid = services.uid`) and the WALK-IN one
 * (`queue_tokens.uid = dpipe_pqm_tokens.token_uid` and `service_request_uid = services.uid`). The
 * worked example in the method doc hopped all 30 consults through the walk-in path, so taking only
 * the scheduled one would measure nothing.
 *
 * A case enters only when Pulse was opened AND a prescription written — ACTIVE / NO_SHOW / CANCELED
 * have no finish clock. Previous-day stamps are excluded from the median and COUNTED, because they
 * are lead time wearing a check-in's clothes and dropping them silently would hide a data defect
 * that is a quarter of the rows.
 *
 * `queue_token_steps.called_at` is text and is cast. The slot's `start_time` / `end_time` are never
 * subtracted: they are 10/15/20-minute bookings and hundreds sit in the future.
 */
const WAIT_SQL = `
WITH s AS (
  SELECT DISTINCT ON (svc.uid) svc.uid, lower(trim(svc.doctor_email)) AS email
    FROM chart_financial_reporting__services svc
   WHERE svc.category = 'CONSULTATION'
     AND svc.doctor_email IS NOT NULL AND trim(svc.doctor_email) <> ''
     AND svc.prescription_start_time IS NOT NULL
     AND svc.prescription_upload_time IS NOT NULL
     AND (svc.prescription_upload_time ${IST})::date >= (now() ${IST})::date - ${OPS_WINDOW_DAYS}
     AND (svc.prescription_upload_time ${IST})::date <= (now() ${IST})::date
   ORDER BY svc.uid
),
tok AS (
  SELECT s.uid AS service_uid, t.uid AS token_uid, t.created_at AS token_open
    FROM s JOIN queue_tokens t ON t.target_uid = s.uid
  UNION ALL
  SELECT s.uid, t.uid, t.created_at
    FROM s
    JOIN dpipe_pqm_tokens d ON d.service_request_uid = s.uid
    JOIN queue_tokens t ON t.uid = d.token_uid
),
tok1 AS (
  SELECT DISTINCT ON (service_uid) service_uid, token_uid, token_open
    FROM tok ORDER BY service_uid, token_open
),
called AS (
  SELECT DISTINCT ON (st.token_uid) st.token_uid, (st.called_at)::timestamptz AS called_at
    FROM queue_token_steps st
   WHERE st.station = 'CONSULTATION' AND st.called_at IS NOT NULL AND trim(st.called_at) <> ''
   ORDER BY st.token_uid, (st.called_at)::timestamptz
),
w AS (
  SELECT s.email,
         (c.called_at IS NOT NULL AND k.token_open IS NOT NULL
          AND (k.token_open ${IST})::date = (c.called_at ${IST})::date) AS same_day,
         (c.called_at IS NOT NULL AND k.token_open IS NOT NULL
          AND (k.token_open ${IST})::date <> (c.called_at ${IST})::date) AS prev_day,
         CASE WHEN c.called_at IS NOT NULL AND k.token_open IS NOT NULL
                   AND (k.token_open ${IST})::date = (c.called_at ${IST})::date
              THEN EXTRACT(EPOCH FROM (c.called_at - k.token_open)) / 60.0 END AS wait_min
    FROM s
    LEFT JOIN tok1 k ON k.service_uid = s.uid
    LEFT JOIN called c ON c.token_uid = k.token_uid
)
SELECT email,
       count(*)::int AS chart_consults,
       count(*) FILTER (WHERE same_day)::int AS same_day_n,
       count(*) FILTER (WHERE prev_day)::int AS prev_day_stamps,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY wait_min))::int AS median_wait_min,
       count(*) FILTER (WHERE wait_min > 180)::int AS over_three_hours
  FROM w
 GROUP BY 1`;

// ── O5: grain 3 — the audited-note denominator, from Neon ──────────────────────────────────

/** The stewardship board's own denominator, per clinician. Read from Neon on the SAME canonical
 *  basis the board uses, so "audited notes" means one thing in this room. */
const AUDITED_NOTES_SQL = `
  SELECT t.doctor_uid, count(*)::int AS n
  FROM ( ${opdCanonical90d('doctor_uid')} ) t
  GROUP BY 1`;

// ── the read ──────────────────────────────────────────────────────────────────────────────

export interface OpsPane {
  rows: OpsRow[];
  /** Per-e-mail cancellation attribution, for the rows that have one. */
  cancelSources: Record<string, { source: string; n: number }[]>;
  /** Which of the five reads failed, by name. A failed read is an UNKNOWN column, never a zero. */
  failed: string[];
  /** E-mails that could not reach exactly one `doctors.uid` (D-ops-identity, fail closed). */
  unjoined: number;
  duplicateEmails: string[];
  windowDays: number;
}

/**
 * Read the whole pane. Six concurrent reads, five against db13 and one against Neon, each isolated:
 * a fault in one leaves that metric unknown and the rest of the pane intact.
 *
 * `only` scopes the pane to a set of `doctors.uid` — the department route passes its clinicians, so
 * the dept page shows ops for the clinicians the OPD directory puts in that department, and NEVER
 * for 8747's `mapped_speciality`, which is a calendar mode and not a department (D-ops-identity).
 */
export async function fetchOpsPane(only?: readonly string[]): Promise<OpsPane> {
  const failed: string[] = [];
  const db13 = async <T>(name: string, q: string): Promise<Record<string, unknown>[]> => {
    try { return await metabaseQuery(q); } catch { failed.push(name); return []; }
  };

  const [emailRows, calRows, cancelRows, csatRows, tcRows, waitRows, noteRows, nameRows] = await Promise.all([
    db13('identity', EMAIL_MAP_SQL),
    db13('calendar', CALENDAR_SQL),
    db13('cancellations', CANCEL_SOURCE_SQL),
    db13('csat', CSAT_SQL),
    db13('teleconsult adherence', TC_ADHERENCE_SQL),
    db13('wait', WAIT_SQL),
    run(AUDITED_NOTES_SQL, opdCanonParams()).catch(() => { failed.push('audited notes'); return []; }),
    run(`SELECT doctor_uid, COALESCE(NULLIF(doctor_name, ''), '') AS doctor_name FROM doctor_directory`, [])
      .catch(() => [] as Record<string, unknown>[]),
  ]);

  const map: EmailMap = buildEmailMap(emailRows.map((r) => ({
    email: str(r.email), nUids: num(r.n_uids), uid: r.uid == null ? null : str(r.uid),
  })));
  const nameOf = new Map(nameRows.map((r) => [str(r.doctor_uid), str(r.doctor_name)]));
  const notesByUid = new Map(noteRows.map((r) => [str(r.doctor_uid), num(r.n)]));

  const inputs = new Map<string, OpsInputs>();
  const at = (email: string): OpsInputs => {
    const k = lower(email);
    let v = inputs.get(k);
    if (!v) { v = {}; inputs.set(k, v); }
    return v;
  };

  for (const r of calRows) {
    at(str(r.email)).calendar = {
      booked: num(r.booked), cancelled: num(r.cancelled), patientNoShow: num(r.patient_no_show),
      doctorNoShow: num(r.doctor_no_show), rescheduled: num(r.rescheduled), completed: num(r.completed),
      teleconsults: num(r.teleconsults), rxPresent: num(r.rx_present), rxPresentDeck: num(r.rx_present_deck),
    };
  }
  for (const r of csatRows) {
    at(str(r.email)).csat = {
      nRx: num(r.n_rx), withFeedbackRow: num(r.with_feedback_row), nRated: num(r.n_rated),
      meanRated: numOrNull(r.mean_rated), meanDeck: numOrNull(r.mean_deck),
    };
  }
  for (const r of tcRows) {
    at(str(r.email)).tc = {
      measurable: num(r.measurable), onTime: num(r.on_time),
      measurableDeck: num(r.measurable_deck), onTimeDeck: num(r.on_time_deck),
    };
  }
  for (const r of waitRows) {
    at(str(r.email)).wait = {
      chartConsults: num(r.chart_consults), sameDay: num(r.same_day_n),
      previousDayStamps: num(r.prev_day_stamps), medianMin: numOrNull(r.median_wait_min),
      overThreeHours: num(r.over_three_hours),
    };
  }

  const cancelSources: Record<string, { source: string; n: number }[]> = {};
  for (const r of cancelRows) {
    const k = lower(r.email);
    (cancelSources[k] ??= []).push({ source: str(r.action_source) || '(unrecorded)', n: num(r.n) });
  }
  for (const list of Object.values(cancelSources)) list.sort((a, b) => b.n - a.n || a.source.localeCompare(b.source));

  const onlySet = only ? new Set(only) : null;
  const rows: OpsRow[] = [];
  for (const [email, input] of inputs) {
    const row = buildOpsRow(email, input, map, (uid) => nameOf.get(uid) || undefined);
    // Grain 3: the audited-note denominator, which only exists when the e-mail resolved to a uid.
    // A clinician with bookings and no audited notes appears with a denominator of zero, which is
    // the point of showing three grains (acceptance #14).
    row.auditedNotes = row.doctorUid ? (notesByUid.get(row.doctorUid) ?? 0) : 0;
    if (onlySet && !(row.doctorUid && onlySet.has(row.doctorUid))) continue;
    rows.push(row);
  }

  return {
    rows: orderOpsRows(rows),
    cancelSources,
    failed,
    unjoined: rows.filter((r) => !r.doctorUid).length,
    duplicateEmails: [...map.duplicate].sort(),
    windowDays: OPS_WINDOW_DAYS,
  };
}

/** Every INFERRED query this file runs, for the slice report and a live-validation pass. */
export const OPS_INFERRED_SQL: Readonly<Record<string, string>> = Object.freeze({
  ops_email_map: EMAIL_MAP_SQL,
  ops_calendar: CALENDAR_SQL,
  ops_cancel_source: CANCEL_SOURCE_SQL,
  ops_csat: CSAT_SQL,
  ops_tc_adherence: TC_ADHERENCE_SQL,
  ops_wait: WAIT_SQL,
  ops_audited_notes: AUDITED_NOTES_SQL,
});

export const OPS_APP = STEWARDSHIP_APP;
