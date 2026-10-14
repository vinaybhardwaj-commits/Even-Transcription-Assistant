/**
 * lib/metabase.ts — read db13 (`individuals-prescriptions`) THROUGH the Metabase API.
 *
 * Server-only. Uses METABASE_URL + METABASE_API_KEY (header `x-api-key`) against Metabase's
 * /api/dataset native-query endpoint — no `pg` driver, no new DB credential, no firewall
 * change. Powers the M2 OPD note-quality daily worker. Read-only by construction (we only
 * ever SELECT); identifiers stay in db13 and on the audit row, never in the LLM payload.
 */

import { windowStart, countDistinctChronicIcds, countAbnormalLabs, scalarCount, type ComplexityInputs } from './opd-complexity-core';

const DB13 = 13;
const SOURCE = '"individuals-prescriptions"';

// Consult types where the NABH OPD completeness checklist genuinely applies. Allied-health
// types (DIETARY / PHYSIO / nutrition) are deferred until their checklists are type-aware.
export const OPD_MEDICAL_TYPES = [
  'GENERAL_PRACTITIONER', 'HOSPITAL_GP', 'HOSPITAL_GYNAECOLOGY_ASSESSMENT',
  'HOSPITAL_PAEDIATRIC', 'HOSPITAL_GYNAECOLOGY_OBSTETRICS', 'HOSPITAL_GP_INVESTIGATION_REFERRAL',
];

// HYBRID SOURCE (29 Jun, per Ira): the reliable type-filter, link-back keys, and the RICH
// medications array (generic/brand/route) stay on the source `individuals-prescriptions` (ip).
// The clean clinical CONTENT — plain-text presenting_complaint + HOPI, readable diagnosis
// names, plan_of_management — comes from the flattened `dpipe_prescription_pipeline` joined 1:1
// on presc_uid (DISTINCT ON latest). The source's nested fields stay as a FALLBACK so we never
// regress the ~11% of notes the pipeline leaves empty. Driving off ip keeps doctor/keys/meds
// exactly as before (no schema or dashboard change).
const IP_COLS = [
  'uid', 'consult_uid', 'doctor_uid', 'kx_encounter_id', 'type_of_prescription', 'consult_type',
  'consult_types',   // 0.81.7 (Fix B) — db13 purpose markers (VISITING_HOSPITAL/EMERGENCY/CHAT) for the channel classifier
  'timestamp', '_create_time', 'prescription_url',
  'medications', 'diagnosis_icd_codes', 'impression_icd_codes', 'general_advice', 'further_investigation',
  'general_practitioner_prescription__presenting_complaints',  // fallback complaint (nested)
  'general_practitioner_prescription__plan_of_management',     // fallback advice (nested)
  'general_practitioner_prescription__examination',
  'followup__followup_type', 'followup__followup_date', 'follow_up_type', 'next_follow_up_date',
  'expected_resolution_date', 'reason_for_consultation', 'relevant_medical_history', 'comorbidities',
  'refer_to', 'num_referrals',   // 0.6 — disposition: a referral/handoff is not a definitive-treatment episode
];
// Obstetric-template adapter (CDMSS-OBGYN-TEMPLATE-EXTRACTION-FIX §9): the obstetric block lives in
// columns the GP projection never selected. Added to the projection ONLY when OBSTETRIC_EXTRACTION_ENABLED
// is on, so the default SELECT (and every GP/other fetch) is byte-identical — a wrong inferred column
// name cannot break the standard audit path; the orchestrator validates these live before enabling.
const OBSTETRIC_IP_COLS = [
  'visit_notes',
  'gynae_patient_history__menstrual_history__last_menstrual_period',
  'gynae_patient_history__obstetric_history__gravidity',
  'gynae_patient_history__obstetric_history__parity',
];
// U4-A1 vitals adapter (CDMSS-VITALS-SOURCE-AND-U4-RESCOPE §A.3/§A.5): weight/height + the nurse
// vitals join enter the projection ONLY when VITALS_EXTRACTION_ENABLED is on, for the same reason
// as the obstetric flag above — with the flag off every query string is byte-identical, so a wrong
// column name can never break the standard audit path; the orchestrator validates the live shapes
// (§A.4, read from db13 on 1 Aug) before enabling. Numbers only: no *_tag column is ever selected —
// the nurse chart tags a systolic of 149 NORMAL; a tag is a judgment, not a fact (R-11).
const VITALS_IP_COLS = [
  'patient_details__weight',
  'patient_details__height',
];
function vitalsExtractionOn(): boolean { return process.env.VITALS_EXTRACTION_ENABLED === '1'; }
function ipCols(): string[] {
  const cols = process.env.OBSTETRIC_EXTRACTION_ENABLED === '1' ? [...IP_COLS, ...OBSTETRIC_IP_COLS] : IP_COLS;
  return vitalsExtractionOn() ? [...cols, ...VITALS_IP_COLS] : cols;
}
// v.consult_uid doubles as the LEFT-JOIN row-exists marker (vitalsRecorded — a record with every
// measurement blank is still a record); v._update_time feeds the RELATIVE recordedAt offset (the
// wall clock never reaches the de-identified case). Neither is a measurement and neither is a tag.
const VITALS_PROJ = 'v.consult_uid AS vitals_consult_uid, v._update_time AS vitals_update_time, v.measurements__blood_pressure, v.measurements__pulse_rate, v.measurements__spo2_level, v.measurements__temperature, v.measurements__respiratory_value, v.measurements__early_warning_score';
function selectCols(): string {
  const base = ipCols().map((c) => `ip.${c}`).join(', ')
    + ', d.presenting_complaint AS dpipe_pc, d.diagnosis AS dpipe_dx, d.plan_of_management AS dpipe_pom, d.further_investigation AS dpipe_inv';
  return vitalsExtractionOn() ? `${base}, ${VITALS_PROJ}` : base;
}

const DPIPE_SELECT = 'presc_uid, presenting_complaint, diagnosis, plan_of_management, further_investigation';
// dpipeWhere bounds the pipeline scan (a date range for day-fetches, a presc_uid filter for
// uid-fetches) so we never seq-scan the whole 343k-row pipeline.
function joinDpipe(dpipeWhere: string): string {
  return `LEFT JOIN (SELECT DISTINCT ON (presc_uid) ${DPIPE_SELECT} FROM dpipe_prescription_pipeline WHERE ${dpipeWhere} ORDER BY presc_uid, _update_time DESC) d ON d.presc_uid = ip.uid`;
}

// U4-A1: the nurse-vitals join, in the joinDpipe shape. The table name REQUIRES the quotes (it
// contains a hyphen). LEFT JOIN — a note with no vitals must still audit; absence is the signal C7
// needs later. Dedupe = DISTINCT ON newest _update_time (a real timestamptz; created_at is TEXT and
// must not order anything). vitalsWhere bounds the vitals scan exactly as dpipeWhere bounds the
// pipeline scan (a date window for day-fetches, a consult_uid semi-join for uid-fetches) — never a
// seq-scan. Returns '' with the flag off so every query string stays byte-identical to today's.
const VITALS_TABLE = '"individuals-individual_vitals_records"';
const VITALS_SELECT = 'consult_uid, _update_time, measurements__blood_pressure, measurements__pulse_rate, measurements__spo2_level, measurements__temperature, measurements__respiratory_value, measurements__early_warning_score';
function joinVitals(vitalsWhere: string): string {
  if (!vitalsExtractionOn()) return '';
  return ` LEFT JOIN (SELECT DISTINCT ON (consult_uid) ${VITALS_SELECT} FROM ${VITALS_TABLE} WHERE ${vitalsWhere} ORDER BY consult_uid, _update_time DESC) v ON v.consult_uid = ip.consult_uid`;
}

function base(): string {
  const u = process.env.METABASE_URL;
  if (!u) throw new Error('METABASE_URL is not set');
  return u.replace(/\/+$/, '');
}
function apiKey(): string {
  const k = process.env.METABASE_API_KEY;
  if (!k) throw new Error('METABASE_API_KEY is not set');
  return k;
}

/** Run a native SQL query against db13 via Metabase /api/dataset. Returns rows as objects. */
export async function metabaseQuery(query: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${base()}/api/dataset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey() },
    body: JSON.stringify({ database: DB13, type: 'native', native: { query } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Metabase HTTP ${res.status}: ${text.slice(0, 400)}`);
  let j: { status?: string; error?: unknown; data?: { rows?: unknown[][]; cols?: { name: string }[] } };
  try { j = JSON.parse(text); } catch { throw new Error('Metabase: non-JSON response'); }
  if (j?.status === 'failed' || j?.error) throw new Error(`Metabase query failed: ${String(j.error ?? '').slice(0, 300)}`);
  const cols = (j?.data?.cols ?? []).map((c) => c.name);
  const rows = j?.data?.rows ?? [];
  return rows.map((r) => { const o: Record<string, unknown> = {}; cols.forEach((c, i) => { o[c] = r[i]; }); return o; });
}

const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u);
const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const quotedTypes = () => OPD_MEDICAL_TYPES.map((t) => `'${t}'`).join(', ');
// Encounters are timestamped in IST; a "day" is an Asia/Kolkata calendar day.
const dayPredicate = (day: string) => `(ip.timestamp AT TIME ZONE 'Asia/Kolkata')::date = '${day}'`;
const baseWhere = (day: string) =>
  `ip.is_draft = false AND ip.type_of_prescription IN (${quotedTypes()}) AND ${dayPredicate(day)}`;

/** Intake eligibility (Fix A) — exclude house-account doctor_uids + any db13 label whose name-part is
 *  exactly "Even Health" (so future house accounts are caught without a settings edit). NULL label passes. */
function intakeExcludeClause(excludeDoctorUids: string[]): string {
  const ex = Array.from(new Set((excludeDoctorUids || []).filter(isUid)));
  const notIn = ex.length ? ` AND ip.doctor_uid NOT IN (${ex.map((u) => `'${u}'`).join(', ')})` : '';
  const nameRule = ` AND (ip.doctor_name_with_speciality IS NULL OR ip.doctor_name_with_speciality NOT LIKE 'Even Health(%')`;
  return `${notIn}${nameRule}`;
}

/**
 * Count non-draft medical notes for an IST calendar day (eligible, house accounts excluded).
 *
 * SWEEP-1 (D1, 7 Aug 2026): count(DISTINCT ip.uid), NOT count(*). The db13 sync can write the
 * same note twice — MEASURED: `uprUJbQnetwvlFrmm2tb` landed in this table a second time on
 * 6 Aug 12:51 IST with the same _doc_id — and count(*) then reports 469 where 468 distinct
 * notes exist. Every consumer compares this number against a set of audited UIDS, so a
 * count that outruns the distinct uids makes a fully-audited day look permanently
 * incomplete: the fetch excludes all 468 and returns nothing, forever. The uid is the unit
 * of work, so the uid is the unit of counting.
 */
export async function countOpdNotesForDay(day: string, excludeDoctorUids: string[] = []): Promise<number> {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)');
  const rows = await metabaseQuery(`SELECT count(DISTINCT ip.uid)::int AS n FROM ${SOURCE} ip WHERE ${baseWhere(day)}${intakeExcludeClause(excludeDoctorUids)}`);
  return Number(rows[0]?.n ?? 0);
}

// U4-A1: the three note-fetch query strings are built by PURE exported builders so the gate test
// can pin flag-off byte-identity against today's literal string. The async fetchers below only run
// them; the strings they produce with the flag off are byte-identical to what the fetchers built
// inline before this change (proven in lib/__tests__/vitals-extraction.test.ts).

/**
 * Pure SQL for the day-fetch page (exported for the U4-A1 byte-identity gate).
 *
 * SWEEP-1 (D2, 7 Aug 2026): the page is DEDUPED by uid, newest ip._update_time winning —
 * the same DISTINCT ON shape the dpipe and vitals joins already use, and for the same
 * reason. Without it a duplicated source row is handed to the auditor twice in one page,
 * spending an LLM call on a note that is about to be written over by its own twin.
 *
 * The dedup has to be a SUBQUERY: DISTINCT ON requires its own ORDER BY to lead with the
 * uid, and the caller needs the page ordered oldest-encounter-first. So the inner select
 * picks the winner per uid and the outer one restores the encounter order and applies the
 * LIMIT. The LIMIT must stay OUTSIDE — inside, it would cap the rows before deduplication
 * and a page of duplicates would silently shrink the batch.
 *
 * `t."timestamp"` is the outer alias of `ip.timestamp`: selectCols() emits it unaliased, so
 * the subquery column is plainly `timestamp` (quoted here because it is also a type name).
 */
export function opdNotesForDaySql(day: string, excludeUids: string[], limit: number, excludeDoctorUids: string[] = []): string {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)');
  const ex = (excludeUids || []).filter(isUid);
  const notIn = ex.length ? ` AND ip.uid NOT IN (${ex.map((u) => `'${u}'`).join(', ')})` : '';
  const lim = Math.max(1, Math.min(50, Math.floor(limit)));
  const join = joinDpipe(`(timestamp AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '${day}'::date - 1 AND '${day}'::date + 1`);
  const vjoin = joinVitals(`(_update_time AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '${day}'::date - 1 AND '${day}'::date + 1`);
  return `SELECT * FROM (SELECT DISTINCT ON (ip.uid) ${selectCols()} FROM ${SOURCE} ip ${join}${vjoin} WHERE ${baseWhere(day)}${notIn}${intakeExcludeClause(excludeDoctorUids)} ORDER BY ip.uid, ip._update_time DESC) t ORDER BY t."timestamp" ASC LIMIT ${lim}`;
}

/** Next page of non-draft medical notes for the day, excluding already-audited uids + house accounts. */
export async function fetchOpdNotesForDay(day: string, excludeUids: string[], limit: number, excludeDoctorUids: string[] = []): Promise<Record<string, unknown>[]> {
  return metabaseQuery(opdNotesForDaySql(day, excludeUids, limit, excludeDoctorUids));
}

/** Pure SQL for the single-note fetch (exported for the U4-A1 byte-identity gate). */
export function opdNoteByUidSql(uid: string): string {
  if (!isUid(uid)) throw new Error('bad uid');
  const join = joinDpipe(`presc_uid = '${uid}'`);
  const vjoin = joinVitals(`consult_uid IN (SELECT consult_uid FROM ${SOURCE} WHERE uid = '${uid}')`);
  return `SELECT ${selectCols()} FROM ${SOURCE} ip ${join}${vjoin} WHERE ip.uid = '${uid}' LIMIT 1`;
}

/** Fetch a single note by uid (for spot-check / case-view note panel). */
export async function fetchOpdNoteByUid(uid: string): Promise<Record<string, unknown> | null> {
  const rows = await metabaseQuery(opdNoteByUidSql(uid));
  return rows[0] ?? null;
}

/** Pure SQL for the bulk uid fetch; null when no valid uids (exported for the U4-A1 gate). */
export function opdNotesByUidsSql(uids: string[]): string | null {
  const ex = Array.from(new Set((uids || []).filter(isUid)));
  if (!ex.length) return null;
  const inList = ex.map((u) => `'${u}'`).join(', ');
  const join = joinDpipe(`presc_uid IN (${inList})`);
  const vjoin = joinVitals(`consult_uid IN (SELECT consult_uid FROM ${SOURCE} WHERE uid IN (${inList}))`);
  return `SELECT ${selectCols()} FROM ${SOURCE} ip ${join}${vjoin} WHERE ip.uid IN (${inList})`;
}

/** Bulk fetch notes by uid (for the no-LLM completeness backfill). */
export async function fetchOpdNotesByUids(uids: string[]): Promise<Record<string, unknown>[]> {
  const sql = opdNotesByUidsSql(uids);
  if (!sql) return [];
  return metabaseQuery(sql);
}

/** Map doctor_uid → display name (db13 `doctors.name_with_prefix`). Names are staff data,
 *  not PHI; used to label the OPD Audit per-doctor view. Best-effort; missing uids omitted. */
export async function fetchDoctorNames(uids: string[]): Promise<Record<string, string>> {
  const ex = Array.from(new Set((uids || []).filter(isUid)));
  if (!ex.length) return {};
  const inList = ex.map((u) => `'${u}'`).join(', ');
  const rows = await metabaseQuery(
    `SELECT uid, name_with_prefix FROM doctors WHERE uid IN (${inList})`,
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    const u = String(r.uid || '');
    const nm = r.name_with_prefix ? String(r.name_with_prefix).trim() : '';
    if (u && nm) map[u] = nm;
  }
  return map;
}

/** Map note uid → prescription_url (db13 `individuals-prescriptions.prescription_url`, a GCS PDF).
 *  MEASURED 100% coverage for non-draft OPD notes since 1 Jun 2026 (Cowork, 9 Jul). Best-effort like
 *  fetchDoctorNames — the caller wraps with .catch so any error degrades to no-PDF (fallback pane).
 *  Slim two-column read on purpose (Review-Mode PDF-context §2.2); never reuse fetchOpdNotesByUids. */
export async function fetchPrescriptionUrls(uids: string[]): Promise<Record<string, string>> {
  const ex = Array.from(new Set((uids || []).filter(isUid)));
  if (!ex.length) return {};
  const inList = ex.map((u) => `'${u}'`).join(', ');
  const rows = await metabaseQuery(
    `SELECT uid, prescription_url FROM ${SOURCE} WHERE uid IN (${inList})`,
  );
  const map: Record<string, string> = {};
  for (const r of rows) {
    const u = String(r.uid || '');
    const url = r.prescription_url ? String(r.prescription_url).trim() : '';
    if (u && url) map[u] = url;
  }
  return map;
}

/** Map doctor_uid → { name, speciality }, parsed from db13 `individuals-prescriptions.
 *  doctor_name_with_speciality` ("Dr. Reshma(General Physician)"). The speciality lives in the
 *  trailing parentheses; we take the most-frequent label per doctor. Staff data, not PHI —
 *  used to give the stewardship view a real department dimension (the source consult_type is blank).
 *  Best-effort; uids with no parsed speciality are omitted. */
export async function fetchDoctorSpecialities(uids: string[]): Promise<Record<string, { name: string; speciality: string }>> {
  const ex = Array.from(new Set((uids || []).filter(isUid)));
  if (!ex.length) return {};
  const inList = ex.map((u) => `'${u}'`).join(', ');
  const rows = await metabaseQuery(
    `SELECT doctor_uid, doctor_name_with_speciality AS label, count(*)::int AS n
       FROM ${SOURCE}
      WHERE doctor_uid IN (${inList}) AND doctor_name_with_speciality IS NOT NULL
        AND timestamp >= now() - interval '90 days'
      GROUP BY doctor_uid, doctor_name_with_speciality`,
  );
  const best: Record<string, { label: string; n: number }> = {};
  for (const r of rows) {
    const u = String(r.doctor_uid || ''); if (!u) continue;
    const label = String(r.label || ''); const cnt = Number(r.n || 0);
    if (!best[u] || cnt > best[u].n) best[u] = { label, n: cnt };
  }
  const out: Record<string, { name: string; speciality: string }> = {};
  for (const [u, b] of Object.entries(best)) {
    const m = b.label.match(/\(([^)]*)\)\s*$/);
    const speciality = m ? m[1].trim() : '';
    const name = b.label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (speciality) out[u] = { name, speciality };
  }
  return out;
}

/** YYYY-MM-DD for the IST calendar day before `now` (the default daily-audit target). */
export function istYesterday(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
}
/** YYYY-MM-DD for the current IST calendar day. */
export function istToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

// ── Right Care case-mix complexity: patient history bundle (RIGHT-CARE-INDICATOR-PRD §3) ──────────
// Reads db13 history STRICTLY BEFORE the index encounter (as-of discipline; index excluded) for one
// patient and returns the raw counts the pure recipe (opd-complexity-core) bands. Circularity rule:
// chronic-ONLY ICDs, index encounter excluded, risk_category never touched.
//
// FAIL-SAFE (hard constraint): any query error or a 3s timeout on ANY leg → returns null, so the
// caller stores a NULL band ("unbanded") and never emits a partial/wrong band; the backfill retries.
// Empty results (a genuinely history-free patient) are NOT failures → enc_24m=0 → NEW_TO_US.
const HISTORY_TIMEOUT_MS = 3000;
function raceTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((res) => { setTimeout(() => res(fallback), ms); })]);
}

/**
 * Fetch the complexity history bundle for the note `noteUid` (as of `asOfHint`, the index encounter
 * timestamp — resolved from db13 if omitted). Returns {chronic_codes, abnormal_labs, enc_12m, enc_24m,
 * as_of} or null on any failure. LIVE-VALIDATED db13 shapes (Cowork, 8 Jul):
 *   - "individuals-prescriptions" has NO individual_uid; resolve the patient from dpipe_prescription_pipeline.
 *   - encounters/chronic come from dpipe_prescription_pipeline(+__diagnosis); labs from test_values_view.
 */
export async function fetchPatientHistoryBundle(noteUid: string, asOfHint?: string): Promise<ComplexityInputs | null> {
  if (!isUid(noteUid)) return null;

  // A leg resolves to null on error OR timeout (never rejects), so one bad column can't crash the audit.
  const leg = (query: string) => raceTimeout(metabaseQuery(query).catch(() => null), HISTORY_TIMEOUT_MS, null);

  // Resolve the patient (individual_uid) + index timestamp from the note uid — both uid and presc_uid
  // match on dpipe_prescription_pipeline (validated). No resolution → NULL band.
  const resolved = await leg(
    `SELECT individual_uid, timestamp FROM dpipe_prescription_pipeline WHERE uid = '${noteUid}' OR presc_uid = '${noteUid}' LIMIT 1`);
  if (resolved === null) return null;
  const iu = resolved[0]?.individual_uid ? String(resolved[0].individual_uid) : '';
  const idxTs = resolved[0]?.timestamp ? String(resolved[0].timestamp) : '';
  const asOfRaw = (asOfHint && !Number.isNaN(new Date(asOfHint).getTime())) ? asOfHint : idxTs;
  if (!iu || !isUid(iu) || !asOfRaw || Number.isNaN(new Date(asOfRaw).getTime())) return null;
  const asOf = new Date(asOfRaw).toISOString();
  const from12 = windowStart(asOf, 12);
  const from24 = windowStart(asOf, 24);

  // Encounters (12m/24m): dpipe_prescription_pipeline, non-draft, index excluded via `< asOf`.
  // presc_is_draft IS NOT TRUE — drafts-only QA accounts exist (one had 20 draft encounters/wk).
  const encSql = `SELECT
      count(*) FILTER (WHERE p.timestamp >= '${from12}'::timestamptz)::int AS enc12,
      count(*) FILTER (WHERE p.timestamp >= '${from24}'::timestamptz)::int AS enc24
    FROM dpipe_prescription_pipeline p
    WHERE p.individual_uid = '${iu}' AND p.presc_is_draft IS NOT TRUE AND p.timestamp < '${asOf}'::timestamptz`;
  // Chronic-ONLY ICDs (12m): diagnosis child joined dx._parent_id = p._id; index excluded by uid, not timestamp.
  const chronicSql = `SELECT DISTINCT dx.icd_code AS icd_code
    FROM dpipe_prescription_pipeline__diagnosis dx
    JOIN dpipe_prescription_pipeline p ON dx._parent_id = p._id
    WHERE p.individual_uid = '${iu}' AND dx.acute_chronic = 'CHRONIC'
      AND p.timestamp >= '${from12}'::timestamptz AND p.timestamp < '${asOf}'::timestamptz
      AND p.uid <> '${noteUid}'`;
  // Abnormal labs (12m): test_values_view has NO timestamp — use _create_time; exact _parent_path match.
  const labSql = `SELECT 1 AS one
    FROM test_values_view t
    WHERE t._parent_path = '/individuals/${iu}' AND t.investigation_is_abnormal = 'ABNORMAL'
      AND t._create_time >= '${from12}'::timestamptz AND t._create_time < '${asOf}'::timestamptz`;

  const [encRows, chronicRows, labRows] = await Promise.all([leg(encSql), leg(chronicSql), leg(labSql)]);
  if (encRows === null || chronicRows === null || labRows === null) return null; // any leg failed → NULL band

  return {
    chronic_codes: countDistinctChronicIcds(chronicRows),
    abnormal_labs: countAbnormalLabs(labRows),
    enc_12m: scalarCount(encRows, 'enc12'),
    enc_24m: scalarCount(encRows, 'enc24'),
    as_of: asOf.slice(0, 10),
  };
}
