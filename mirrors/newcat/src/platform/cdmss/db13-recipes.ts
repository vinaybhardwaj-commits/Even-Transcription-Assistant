/**
 * Pure SQL builders for the db13 read recipes (Pulse source data via Metabase). Ported from the CDMSS
 * reference copy (cdmss-ref/lib/...); every builder cites its source file:line. ALL SQL here is
 * INFERRED until gating-lead validates it live against db13. Feature-flagged projections in the
 * source (OBSTETRIC_EXTRACTION_ENABLED, VITALS_EXTRACTION_ENABLED) are NOT ported: this is the
 * flag-off default string. No function in this file does I/O.
 */

export const OPD_MEDICAL_TYPES = [
  'GENERAL_PRACTITIONER',
  'HOSPITAL_GP',
  'HOSPITAL_GYNAECOLOGY_ASSESSMENT',
  'HOSPITAL_PAEDIATRIC',
  'HOSPITAL_GYNAECOLOGY_OBSTETRICS',
  'HOSPITAL_GP_INVESTIGATION_REFERRAL',
] as const // cdmss-ref/lib/metabase.ts:20-23

const SOURCE = '"individuals-prescriptions"' // metabase.ts:16

// metabase.ts:32-43
const IP_COLS = [
  'uid', 'consult_uid', 'doctor_uid', 'kx_encounter_id', 'type_of_prescription', 'consult_type',
  'consult_types',
  'timestamp', '_create_time', 'prescription_url',
  'medications', 'diagnosis_icd_codes', 'impression_icd_codes', 'general_advice', 'further_investigation',
  'general_practitioner_prescription__presenting_complaints',
  'general_practitioner_prescription__plan_of_management',
  'general_practitioner_prescription__examination',
  'followup__followup_type', 'followup__followup_date', 'follow_up_type', 'next_follow_up_date',
  'expected_resolution_date', 'reason_for_consultation', 'relevant_medical_history', 'comorbidities',
  'refer_to', 'num_referrals',
]

// metabase.ts:73-77 (flags off)
const SELECT_COLS = `${IP_COLS.map((c) => `ip.${c}`).join(', ')}, d.presenting_complaint AS dpipe_pc, d.diagnosis AS dpipe_dx, d.plan_of_management AS dpipe_pom, d.further_investigation AS dpipe_inv`

const DPIPE_SELECT = 'presc_uid, presenting_complaint, diagnosis, plan_of_management, further_investigation' // metabase.ts:79

// metabase.ts:82-84
function joinDpipe(dpipeWhere: string): string {
  return `LEFT JOIN (SELECT DISTINCT ON (presc_uid) ${DPIPE_SELECT} FROM dpipe_prescription_pipeline WHERE ${dpipeWhere} ORDER BY presc_uid, _update_time DESC) d ON d.presc_uid = ip.uid`
}

const esc = (s: string) => s.replace(/'/g, "''") // cdmss-ref/lib/preop/db13.ts:35
export const isUid = (u: string) => /^[A-Za-z0-9_-]{6,64}$/.test(u) // metabase.ts:131
export const isUhid = (u: string) => /^[A-Za-z0-9/_-]{2,40}$/.test(u) // preop/db13.ts:37
export const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) // metabase.ts:132

/** Typed refusal for a numeric argument that is not a finite whole number >= 1. Never carries the value. */
export class Db13ArgError extends Error {
  constructor(readonly arg: 'limit' | 'days') {
    super(`bad ${arg}`)
    this.name = 'Db13ArgError'
  }
}

/** Rejects NaN, Infinity, fractions and anything below 1; values above `max` clamp to it (existing behaviour). */
function intArg(value: number, arg: 'limit' | 'days', max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Db13ArgError(arg)
  return Math.min(max, value)
}

/** Valid uids only, de-duplicated, capped like inList so a caller cannot build an unbounded IN list. */
const uidList = (uids: string[], cap = 400): string[] =>
  Array.from(new Set((uids || []).filter(isUid))).slice(0, cap)

const quotedTypes = () => OPD_MEDICAL_TYPES.map((t) => `'${t}'`).join(', ') // metabase.ts:133
const dayPredicate = (day: string) => `(ip.timestamp AT TIME ZONE 'Asia/Kolkata')::date = '${day}'` // metabase.ts:135
const baseWhere = (day: string) =>
  `ip.is_draft = false AND ip.type_of_prescription IN (${quotedTypes()}) AND ${dayPredicate(day)}` // metabase.ts:136-137

// metabase.ts:141-146
function intakeExcludeClause(excludeDoctorUids: string[]): string {
  const ex = Array.from(new Set((excludeDoctorUids || []).filter(isUid)))
  const notIn = ex.length ? ` AND ip.doctor_uid NOT IN (${ex.map((u) => `'${u}'`).join(', ')})` : ''
  const nameRule = ` AND (ip.doctor_name_with_speciality IS NULL OR ip.doctor_name_with_speciality NOT LIKE 'Even Health(%')`
  return `${notIn}${nameRule}`
}

/** metabase.ts:161 */
export function countOpdNotesForDaySql(day: string, excludeDoctorUids: string[] = []): string {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)')
  return `SELECT count(DISTINCT ip.uid)::int AS n FROM ${SOURCE} ip WHERE ${baseWhere(day)}${intakeExcludeClause(excludeDoctorUids)}`
}

/** metabase.ts:187-195 */
export function opdNotesForDaySql(day: string, excludeUids: string[], limit: number, excludeDoctorUids: string[] = []): string {
  if (!isDay(day)) throw new Error('bad day (YYYY-MM-DD)')
  const ex = (excludeUids || []).filter(isUid)
  const notIn = ex.length ? ` AND ip.uid NOT IN (${ex.map((u) => `'${u}'`).join(', ')})` : ''
  const lim = intArg(limit, 'limit', 50)
  const join = joinDpipe(`(timestamp AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '${day}'::date - 1 AND '${day}'::date + 1`)
  return `SELECT * FROM (SELECT DISTINCT ON (ip.uid) ${SELECT_COLS} FROM ${SOURCE} ip ${join} WHERE ${baseWhere(day)}${notIn}${intakeExcludeClause(excludeDoctorUids)} ORDER BY ip.uid, ip._update_time DESC) t ORDER BY t."timestamp" ASC LIMIT ${lim}`
}

/** metabase.ts:203-208 */
export function opdNoteByUidSql(uid: string): string {
  if (!isUid(uid)) throw new Error('bad uid')
  const join = joinDpipe(`presc_uid = '${uid}'`)
  return `SELECT ${SELECT_COLS} FROM ${SOURCE} ip ${join} WHERE ip.uid = '${uid}' LIMIT 1`
}

/** metabase.ts:217-224; null when no valid uids */
export function opdNotesByUidsSql(uids: string[]): string | null {
  const ex = uidList(uids)
  if (!ex.length) return null
  const inList = ex.map((u) => `'${u}'`).join(', ')
  const join = joinDpipe(`presc_uid IN (${inList})`)
  return `SELECT ${SELECT_COLS} FROM ${SOURCE} ip ${join} WHERE ip.uid IN (${inList})`
}

/** metabase.ts:239-241 */
export function doctorNamesSql(uids: string[]): string | null {
  const ex = uidList(uids)
  if (!ex.length) return null
  return `SELECT uid, name_with_prefix FROM doctors WHERE uid IN (${ex.map((u) => `'${u}'`).join(', ')})`
}

/** metabase.ts:280-285 */
export function doctorSpecialitiesSql(uids: string[]): string | null {
  const ex = uidList(uids)
  if (!ex.length) return null
  const inList = ex.map((u) => `'${u}'`).join(', ')
  return `SELECT doctor_uid, doctor_name_with_speciality AS label, count(*)::int AS n
       FROM ${SOURCE}
      WHERE doctor_uid IN (${inList}) AND doctor_name_with_speciality IS NOT NULL
        AND timestamp >= now() - interval '90 days'
      GROUP BY doctor_uid, doctor_name_with_speciality`
}

/** cdmss-ref/lib/proms/schedule.ts:46-51 */
export const surgeryCasesSql = (uid: string): string => {
  if (!isUid(uid)) throw new Error('bad uid')
  return `SELECT individual_uid, procedure_name, NULLIF(surgery_type_uid,'') AS surgery_type_uid,
       NULLIF(prescription_uid,'') AS prescription_uid, planned_surgery_date, status, created_at
FROM surgery_cases
WHERE individual_uid = '${uid}'
ORDER BY planned_surgery_date DESC NULLS LAST`
}

/** schedule.ts:53-59 */
export const surgicalFlagSql = (uid: string): string => {
  if (!isUid(uid)) throw new Error('bad uid')
  return `SELECT dp.individual_uid, pm.requires_surgery_or_procedure, pm.surgery_or_procedure_recommendation, p.uploaded_at
FROM dpipe_prescription_pipeline__plan_of_management pm
JOIN dpipe_prescription_pipeline dp ON dp._id = pm._parent_id
JOIN "individuals-prescriptions" p ON p._doc_id = dp.presc_uid
WHERE dp.individual_uid = '${uid}' AND pm.requires_surgery_or_procedure = true
ORDER BY p.uploaded_at DESC`
}

/** schedule.ts:61-66 (the source marks the kx_billing shape INFERRED) */
export const dischargeSql = (uid: string): string => {
  if (!isUid(uid)) throw new Error('bad uid')
  return `SELECT b.admission_date_time, b.discharge_date_time
FROM individuals i
JOIN kx_billing_records b ON b.uhid = i.kx_uhid
WHERE i._doc_id = '${uid}' AND b.discharge_date_time IS NOT NULL
ORDER BY b.discharge_date_time DESC LIMIT 1`
}

/** cdmss-ref/lib/preop/db13.ts:109-119 */
const EPISODE_SELECT = `
      SELECT sc._doc_id, sc.individual_uid, sc.procedure_name, sc.financial__procedure_name,
             sc.status, sc.clinical__urgency, sc.pac__status,
             sc.clinical__comorbidities::text AS comorbidities,
             sc.hospital_info__hospital_uid,
             sc.planned_surgery_date::date::text AS surgery_date,
             sc.created_at::text AS created_at, sc._update_time::text AS updated_at,
             i.kx_uhid, i.display_name, i.first_name, i.last_name, i.gender,
             date_part('year', age((NOW() AT TIME ZONE 'Asia/Kolkata')::date, i.dob::date))::int AS age_years
        FROM surgery_cases sc
        JOIN individuals i ON i._doc_id = sc.individual_uid`

/** preop/db13.ts:150-158 */
export function upcomingEpisodesSql(horizonDays = 60): string {
  const days = intArg(horizonDays, 'days', 365)
  return `${EPISODE_SELECT}
        WHERE sc.planned_surgery_date >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date
          AND sc.planned_surgery_date < (NOW() AT TIME ZONE 'Asia/Kolkata')::date + INTERVAL '${days} days'
          AND sc.status <> 'CANCELLED'
        ORDER BY sc.planned_surgery_date ASC, sc._doc_id ASC
        LIMIT 500`
}

/** preop/db13.ts:181-188 */
export function pacCoveredEpisodesSql(limit = 300): string {
  const n = intArg(limit, 'limit', 500)
  return `${EPISODE_SELECT}
        WHERE sc.status <> 'CANCELLED'
          AND i.kx_uhid IS NOT NULL
          AND EXISTS (SELECT 1 FROM kx_clinical_template_pac_reports p WHERE p.uhid = i.kx_uhid)
        ORDER BY sc.planned_surgery_date DESC NULLS LAST, sc._doc_id ASC
        LIMIT ${n}`
}

/** preop/db13.ts:214 */
export const hospitalNamesSql = (): string => `SELECT _doc_id, name FROM even_hospitals LIMIT 100`

function inList(values: string[], ok: (v: string) => boolean, cap = 400): string | null {
  const clean = Array.from(new Set(values.filter((v) => typeof v === 'string' && ok(v)))).slice(0, cap)
  return clean.length ? clean.map((v) => `'${esc(v)}'`).join(', ') : null // preop/db13.ts:46-50
}

function parentPathList(uids: string[], cap = 400): string | null {
  const clean = Array.from(new Set(uids.filter((v) => typeof v === 'string' && isUid(v)))).slice(0, cap)
  return clean.length ? clean.map((v) => `'/individuals/${esc(v)}'`).join(', ') : null // preop/db13.ts:53-57
}

/** preop/db13.ts:272-278; null when no valid uhids */
export function pacReportsSql(uhids: string[]): string | null {
  const list = inList(uhids, isUhid)
  if (!list) return null
  return `SELECT uid, uhid, status, template_name, created_at::text AS created_at, note,
              component_json::text AS component_json
         FROM kx_clinical_template_pac_reports
        WHERE uhid IN (${list}) AND status = 'final'
        ORDER BY created_at ASC
        LIMIT 500`
}

/** preop/db13.ts:323-330; null when no valid uids */
export function creatinineSql(individualUids: string[]): string | null {
  const list = parentPathList(individualUids)
  if (!list) return null
  return `SELECT replace(pv._parent_path, '/individuals/', '') AS individual_uid,
              pv.name, pv.data_value, pv.data_unit, pv.result_date::text AS at
         FROM "individuals-parameter_digital_values__parameters" pv
        WHERE pv._parent_path IN (${list})
          AND pv.name ILIKE '%creatinine%'
          AND pv.name NOT ILIKE '%ratio%'
        ORDER BY pv.result_date ASC
        LIMIT 500`
}

/** preop/db13.ts:384-391; null when no valid uids */
export function opdComorbiditiesSql(individualUids: string[]): string | null {
  const list = parentPathList(individualUids)
  if (!list) return null
  return `SELECT replace(p._parent_path, '/individuals/', '') AS individual_uid,
              p._doc_id, p.uploaded_at::text AS at, p.comorbidities::text AS comorbidities
         FROM "individuals-prescriptions" p
        WHERE p._parent_path IN (${list})
          AND p.is_draft = false
          AND p.comorbidities IS NOT NULL
          AND length(p.comorbidities::text) > 4
        ORDER BY p.uploaded_at ASC
        LIMIT 500`
}

/** preop/db13.ts:431-437; null when no valid uids */
export function opdIcdSql(individualUids: string[]): string | null {
  const list = parentPathList(individualUids)
  if (!list) return null
  return `SELECT replace(p._parent_path, '/individuals/', '') AS individual_uid,
              p._doc_id, p.uploaded_at::text AS at,
              p.diagnosis_icd_codes::text AS dx, p.impression_icd_codes::text AS imp
         FROM "individuals-prescriptions" p
        WHERE p._parent_path IN (${list})
          AND p.is_draft = false
        ORDER BY p.uploaded_at ASC
        LIMIT 1000`
}
