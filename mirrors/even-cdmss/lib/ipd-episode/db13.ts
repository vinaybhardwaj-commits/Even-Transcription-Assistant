/**
 * lib/ipd-episode/db13.ts — the READ-ONLY database-13 layer for the IPD Episode Audit engine.
 * Every read goes through `metabaseQuery` (lib/metabase.ts), the repo's only path to db13. No new
 * credential, no direct Postgres connection.
 *
 * ⚠️ EVERY QUERY AND EVERY COLUMN NAME IN THIS FILE IS INFERRED. This module was written against
 * the measured schema references (EVEN-DB-REFERENCE-2026-09-01 + its 2026-09-02 addendum), not
 * against a live database — the build sandbox has none. So every reader here is FAIL-SAFE by
 * construction: a query that errors returns an empty result to the caller, and the caller records
 * a skip or proceeds with less. Nothing in this file throws a 500 and nothing returns a guessed
 * value. The orchestrator validates each SQL string against the live system before the feature is
 * shown to anyone; the build report lists them verbatim for exactly that purpose.
 *
 * THREE RULES THIS FILE MAKES STRUCTURAL:
 *
 * 1. IDS JOIN EXACTLY AND ARE NEVER REWRITTEN. `IPNO-1` and `IP-1` are different patients (585 of
 *    585 rewritten joins landed on a different uhid — addendum A2). `isEncounterId` REFUSES an id
 *    that does not match the shape; it never trims one into shape. There is no prefix
 *    substitution, no normalising and no `regexp_replace` anywhere below. A source-read test
 *    (PRD §13 item 12) asserts the file contains no `replace(` at all, which is why the one place
 *    that needs SQL literal escaping uses split/join.
 * 2. NO PHI COLUMN IS EVER SELECTED. Every SELECT below names columns from the §3.2.3 allow-list
 *    and nothing else. `patient_name`, `uhid`, `age`, `gender`, `mobile`, `address_details`, kin
 *    and contact columns are never named here. The repo's posture is OMISSION, not hashing: the
 *    identity a surface needs is joined at RENDER time by the existing `namesForIpUids` in
 *    lib/ipd-audit/db13.ts, and never stored. A source-read test (§13 item 13) enforces this.
 * 3. `_create_time` IS NOT CLINICAL TIME. It is the mirror's ingest time — every progress note in
 *    the mirror carries the same one. It appears in exactly ONE place below: the tiebreak that
 *    picks the latest of several discharge-summary rows for one `ipd_no` (8 of 2,457 ipd_no values
 *    repeat). Clinical ordering comes from `progressnote_date_time` inside `component_json`, then
 *    `g_creation_time` — never from `_create_time`, `_update_time` or `created_at`.
 */

import { metabaseQuery } from '../metabase';

// ── identifier discipline ────────────────────────────────────────────────────────────────────

/**
 * Encounter ids in this mirror run in four concurrent namespaces (`IPNO-`, `IP-`, `ERN-`, `ER-`)
 * plus their numeric tails. This is a SHAPE CHECK THAT REFUSES, never a normaliser: an id that
 * fails it makes the reader return nothing, so a malformed id can neither reach a query nor be
 * silently repaired into a different patient's id.
 */
export function isEncounterId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_-]{1,63}$/.test(v);
}

/**
 * SQL literal escaping for a value already shape-checked above. split/join rather than
 * `String.replace` because §13 item 12 makes "`replace(` never appears in this file" a
 * source-read assertion — see the header. Doubling a quote is not a rewrite of an id: an id
 * containing a quote fails `isEncounterId` and never reaches here.
 */
const lit = (s: string): string => `'${s.split("'").join("''")}'`;

/** Every reader returns [] on any fault. One place, so no caller can forget it. */
async function safeRows(label: string, query: string): Promise<Record<string, unknown>[]> {
  try {
    return await metabaseQuery(query);
  } catch (e) {
    console.warn(`[ipd-episode/db13] ${label} failed (degraded to empty): ${String((e as Error).message).slice(0, 300)}`);
    return [];
  }
}

// ── column allow-lists (PRD §3.2.3) ──────────────────────────────────────────────────────────
// Named as constants so the SELECTs below cannot drift from the list the PRD ratified, and so the
// source-read test has one place to check. NOT one of these lists names a PHI column.

const ADMISSION_COLS = [
  'encounter_id', 'uid', 'admission_date_time', 'admission_type', 'admit_source', 'ward',
  'ward_type_name', 'billing_category', 'admitting_doctor_speciality',
  'current_treating_doctor_speciality', 'treating_department_name', 'treating_sub_department_name',
  'facility_name', 'admitting_doctor_id', 'current_treating_doctor_id', 'remarks', 'member_id',
].join(', ');

const TEMPLATE_COLS = [
  '_doc_id', 'encounter_id', 'facility_id', 'template_name', 'status', 'finalized_by_username',
  'current_treating_doctor_id', 'ordering_doctor_id', 'g_creation_time', 'component_json',
].join(', ');

const OT_NOTE_COLS = `${TEMPLATE_COLS}, surgery_name, surgeon`;
const HANDOVER_COLS = `${TEMPLATE_COLS}, handed_over_by, received_by, handover_route`;

const BILLING_COLS = [
  '_doc_id', 'visit_id_admission_id', 'order_date_time', 'service_type', 'department',
  'service_item_name', 'ordered_item_name', 'ordered_qty', 'quantity', 'net_amt', 'status', 'order_no',
].join(', ');

const LAB_COLS = [
  '_doc_id', 'visit_id', 'order_no', 'service_name', 'sub_department', 'priority',
  'booking_date_time', 'sample_collection_date_time', 'report_date', 'icd_diagnosis',
].join(', ');

const TRANSFER_COLS = [
  '_doc_id', 'encounter_id', 'created_at', 'transfer_type', 'transfer_reason', 'ward',
  'vacant_ward_name', 'care_type', 'recommending_doctor_speciality',
].join(', ');

const DISCHARGE_COLS = [
  '_doc_id', 'ipd_no', 'discharge_date_time', 'discharge_type', 'admission_date_time',
  'treating_doctor_speciality', '_create_time',
].join(', ');

// ── row shapes (deliberately loose: these are inferred column names) ─────────────────────────

export type Db13Row = Record<string, unknown>;

export interface EpisodeCandidate {
  encounterId: string;
  admissionDateTime: string | null;
  dischargeDateTime: string | null;
}

// ── selection (PRD §3.1) ─────────────────────────────────────────────────────────────────────

/**
 * Closed episodes, oldest discharge first: `kx_ip_admissions` joined to the discharge-summary row
 * that closes it. Closure comes from `kx_discharge_summary_records` because `kx_ip_admissions` has
 * NO discharge column — all 1,348 rows read `status = 'Admitted'` (addendum A1). The join is exact
 * on `d.ipd_no = a.encounter_id`; the reference document's LATERAL/uhid recipe is void.
 *
 * DISTINCT ON takes the latest `_create_time` when one `ipd_no` carries several rows (8 of 2,457
 * do). That is the ONE legitimate use of `_create_time` in this engine and it is a tiebreak
 * between duplicate mirror rows, never a clinical ordering.
 *
 * ⚠️ SELECTION CONDITION 2 IS ENFORCED HERE, IN SQL, and that is a behaviour change worth naming.
 * The EXISTS clause drops episodes with no progress note, so they never become candidates at all.
 * Previously they were fetched, attempted, and skipped `no_notes` one at a time — 797 closed
 * episodes against 446 with notes means roughly 44% of every candidate page was destined to be
 * thrown away, and each one still consumed a slot in the worker's batch. They are now filtered by
 * the database, which is the only place that can do it cheaply.
 *
 * The join stays EXACT on `p.encounter_id = a.encounter_id`. Conditions 1 and 3 are still
 * re-checked per episode in run.ts, because the candidate query and the attempt can be minutes
 * apart and a skip must record what was true when the episode was actually tried.
 */
export async function fetchClosedEpisodes(limit = 2000): Promise<EpisodeCandidate[]> {
  const lim = Math.max(1, Math.min(5000, Math.floor(limit)));
  const rows = await safeRows('fetchClosedEpisodes', `
    SELECT a.encounter_id, a.admission_date_time, d.discharge_date_time
    FROM kx_ip_admissions a
    JOIN (
      SELECT DISTINCT ON (ipd_no) ipd_no, discharge_date_time, _create_time
      FROM kx_discharge_summary_records
      WHERE discharge_date_time IS NOT NULL
      ORDER BY ipd_no, _create_time DESC
    ) d ON d.ipd_no = a.encounter_id
    AND EXISTS (SELECT 1 FROM kx_clinical_template_progress_reports p
                WHERE p.encounter_id = a.encounter_id)
    ORDER BY d.discharge_date_time ASC
    LIMIT ${lim}`);
  return rows
    .filter((r) => isEncounterId(r.encounter_id))
    .map((r) => ({
      encounterId: String(r.encounter_id),
      admissionDateTime: r.admission_date_time == null ? null : String(r.admission_date_time),
      dischargeDateTime: r.discharge_date_time == null ? null : String(r.discharge_date_time),
    }));
}

/** The admission row for one encounter. Null when absent or unreadable. */
export async function fetchAdmission(encounterId: string): Promise<Db13Row | null> {
  if (!isEncounterId(encounterId)) return null;
  const rows = await safeRows('fetchAdmission', `
    SELECT ${ADMISSION_COLS}
    FROM kx_ip_admissions
    WHERE encounter_id = ${lit(encounterId)}
    LIMIT 1`);
  return rows[0] ?? null;
}

/**
 * The closing discharge-summary row. `_create_time` DESC picks the latest of several rows for the
 * same `ipd_no` — the duplicate tiebreak named in the header, not a clinical order.
 */
export async function fetchDischargeSummary(encounterId: string): Promise<Db13Row | null> {
  if (!isEncounterId(encounterId)) return null;
  const rows = await safeRows('fetchDischargeSummary', `
    SELECT ${DISCHARGE_COLS}
    FROM kx_discharge_summary_records
    WHERE ipd_no = ${lit(encounterId)} AND discharge_date_time IS NOT NULL
    ORDER BY _create_time DESC
    LIMIT 1`);
  return rows[0] ?? null;
}

// ── clinical templates ───────────────────────────────────────────────────────────────────────
// `component_json` is TEXT holding a JSON array of {name, valueString}. It is fetched WHOLE and
// parsed in the pure core (parseComponentJson) rather than picked apart in SQL, so one malformed
// note degrades to "no fields" instead of failing the query for a whole episode.

export async function fetchProgressNotes(encounterId: string, limit = 200): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(500, Math.floor(limit)));
  return safeRows('fetchProgressNotes', `
    SELECT ${TEMPLATE_COLS}
    FROM kx_clinical_template_progress_reports
    WHERE encounter_id = ${lit(encounterId)}
    LIMIT ${lim}`);
}

export async function fetchInitialAssessments(encounterId: string, limit = 20): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(100, Math.floor(limit)));
  return safeRows('fetchInitialAssessments', `
    SELECT ${TEMPLATE_COLS}
    FROM kx_clinical_template_initial_assessment_adults
    WHERE encounter_id = ${lit(encounterId)}
    LIMIT ${lim}`);
}

export async function fetchShiftHandovers(encounterId: string, limit = 200): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(500, Math.floor(limit)));
  return safeRows('fetchShiftHandovers', `
    SELECT ${HANDOVER_COLS}
    FROM kx_clinical_template_shift_handovers
    WHERE encounter_id = ${lit(encounterId)}
    LIMIT ${lim}`);
}

export async function fetchOtNotes(encounterId: string, limit = 50): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(200, Math.floor(limit)));
  return safeRows('fetchOtNotes', `
    SELECT ${OT_NOTE_COLS}
    FROM kx_clinical_template_ot_notes
    WHERE encounter_id = ${lit(encounterId)}
    LIMIT ${lim}`);
}

// ── orders, labs, transfers ──────────────────────────────────────────────────────────────────

/**
 * The order stream. Scoped to IP lines for THIS admission: `visit_id_admission_id = encounter_id
 * AND patient_type = 'IP'`. `patient_type` is a PREDICATE only — it is never selected, so no PHI
 * column enters the projection through it. IP billing runs to a mean of 88 rows and a max of 595
 * per episode, so the limit is generous but bounded; the per-day caps live in the pure core.
 */
export async function fetchBillingOrders(encounterId: string, limit = 1200): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(3000, Math.floor(limit)));
  return safeRows('fetchBillingOrders', `
    SELECT ${BILLING_COLS}
    FROM kx_billing_records
    WHERE visit_id_admission_id = ${lit(encounterId)} AND patient_type = 'IP'
    ORDER BY order_date_time ASC
    LIMIT ${lim}`);
}

/** Lab ORDER metadata. This table holds no result values (reference §1.6) — Tier C by definition. */
export async function fetchLabOrders(encounterId: string, limit = 300): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(1000, Math.floor(limit)));
  return safeRows('fetchLabOrders', `
    SELECT ${LAB_COLS}
    FROM kx_lab_reports
    WHERE visit_id = ${lit(encounterId)}
    LIMIT ${lim}`);
}

/**
 * Ward/care transfers. `created_at` is this table's ONLY timestamp and PRD §3.2.2 names it as the
 * clinical time for a transfer event — the "never order by created_at" rule is about the CLINICAL
 * TEMPLATE tables, where a clinician-stated time exists and `created_at` disagrees with it on 80%
 * of rows. It is selected here, and used, only for transfers.
 */
export async function fetchTransfers(encounterId: string, limit = 100): Promise<Db13Row[]> {
  if (!isEncounterId(encounterId)) return [];
  const lim = Math.max(1, Math.min(300, Math.floor(limit)));
  return safeRows('fetchTransfers', `
    SELECT ${TRANSFER_COLS}
    FROM kx_ip_transfers
    WHERE encounter_id = ${lit(encounterId)}
    LIMIT ${lim}`);
}
