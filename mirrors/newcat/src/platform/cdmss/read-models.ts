import { z } from 'zod'
import type { CdmssQuery } from './client.js'

/**
 * Typed read models over the CDMSS Neon database (role newcat_ro). Columns are confirmed against the
 * CREATE TABLE statements in the CDMSS migrations (quoted in the F3 report). Every SQL string is
 * INFERRED until gating-lead validates it live. Identifier columns are for joins only: pass rows
 * through `stripIdentifiers` before anything model-bound. Deliberately NOT selected: preop_findings
 * patient_name, uhid and snapshot; ot_note_audits uhid, surgeon_raw, note and component_json.
 */

const ts = z.union([z.date(), z.string()]).transform((v) => new Date(v).toISOString())
// DATE columns are cast to text in SQL (note_day::text, surgery_date::text). The Date branch is the
// second wall: the Neon driver parses oid 1082 as local midnight, so read it back in local time.
const pad = (n: number) => String(n).padStart(2, '0')
const day = z
  .union([z.date(), z.string()])
  .transform((v) => (v instanceof Date ? `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}` : v.slice(0, 10)))
const text = z.string().nullable()
const int = z.number().int().nullable()
const json = z.unknown()
const src = z.literal('cdmss')

export const OpdAuditRow = z.object({
  source: src,
  id: z.string(),
  audited_at: ts,
  uid: z.string(),
  consult_uid: text,
  doctor_uid: text,
  kx_encounter_id: text,
  note_date: ts.nullable(),
  prescription_type: text,
  consult_type: text,
  note_quality_index: z.number().int(),
  band: z.string(),
  score_documentation: int,
  score_note_quality: int,
  score_appropriateness: int,
  score_prescribing_safety: int,
  score_patient_centred: int,
  pdqi9: json,
  completeness_pct: int,
  n_missing_mandatory: int,
  n_findings: z.number().int(),
  n_low_value: z.number().int(),
  n_context_dependent: z.number().int(),
  n_interaction_alerts: z.number().int(),
  findings: json,
  suggestions: json,
  engine_version: z.string(),
  model: text,
  trace_id: text,
})
export type OpdAuditRow = z.infer<typeof OpdAuditRow>

export const OtAuditRow = z.object({
  source: src,
  id: z.string(),
  audited_at: ts,
  note_class: z.string(),
  uid: z.string(),
  hospital_uid: text,
  facility_id: text,
  encounter_id: text,
  surgery_name: text,
  note_day: day,
  note_created_at: ts.nullable(),
  note_modified_at: ts.nullable(),
  doctor_uid: text,
  map_status: z.string(),
  n_findings: z.number().int(),
  findings: json,
  engine_version: z.string(),
  model: text,
  trace_id: text,
})
export type OtAuditRow = z.infer<typeof OtAuditRow>

export const PreopFindingRow = z.object({
  source: src,
  id: z.string(),
  created_at: ts,
  updated_at: ts,
  episode_key: z.string(),
  engine_version: z.string(),
  individual_uid: text,
  age: int,
  sex: text,
  procedure: text,
  hospital: text,
  department: text,
  surgeon: text,
  surgery_date: day.nullable(),
  tier: text,
  rcri_lo: int,
  rcri_hi: int,
  mfi_lo: int,
  mfi_hi: int,
  cci_lo: int,
  cci_hi: int,
  needs_review: z.boolean(),
  booking_only: z.boolean(),
  pac_on_file: z.boolean(),
  pac_status: text,
  pac_report_uid: text,
  pac_finalized_at: ts.nullable(),
  pac_verdict: text,
  why_line: text,
  missing_line: text,
  situation_line: text,
  snapshot_fingerprint: z.string(),
  version_no: z.number().int(),
  reviewed_at: ts.nullable(),
  reviewed_by: text,
  reviewed_version: int,
  computed_at: ts.nullable(),
  trace_id: text,
})
export type PreopFindingRow = z.infer<typeof PreopFindingRow>

export const ClinicalStateRow = z.object({
  source: src,
  id: z.string(),
  created_at: ts,
  doc_kind: z.string(),
  source_uid: z.string(),
  member_uid: text,
  encounter_ref: text,
  schema_version: z.string(),
  status: z.string(),
  state_json: json,
  superseded_by: text,
})
export type ClinicalStateRow = z.infer<typeof ClinicalStateRow>

export const LvcRecommendation = z.object({
  source: src,
  id: z.string(),
  region: z.string(),
  society: z.string(),
  specialty: text,
  statement: z.string(),
  precondition: text,
  action_type: text,
  consider_instead: text,
  rationale: text,
  keywords: z.array(z.string()).nullable(),
  citation_doi: text,
  citation_pmid: text,
  citation_url: text,
  source_release_year: int,
  status: text,
  chunk_text_hash: text,
  created_at: ts.nullable(),
  updated_at: ts.nullable(),
})
export type LvcRecommendation = z.infer<typeof LvcRecommendation>

const OPD_COLS = `id, audited_at, uid, consult_uid, doctor_uid, kx_encounter_id, note_date, prescription_type, consult_type, note_quality_index, band, score_documentation, score_note_quality, score_appropriateness, score_prescribing_safety, score_patient_centred, pdqi9, completeness_pct, n_missing_mandatory, n_findings, n_low_value, n_context_dependent, n_interaction_alerts, findings, suggestions, engine_version, model, trace_id`
const OT_COLS = `id, audited_at, note_class, uid, hospital_uid, facility_id, encounter_id, surgery_name, note_day::text AS note_day, note_created_at, note_modified_at, doctor_uid, map_status, n_findings, findings, engine_version, model, trace_id`
const PREOP_COLS = `id, created_at, updated_at, episode_key, engine_version, individual_uid, age, sex, procedure, hospital, department, surgeon, surgery_date::text AS surgery_date, tier, rcri_lo, rcri_hi, mfi_lo, mfi_hi, cci_lo, cci_hi, needs_review, booking_only, pac_on_file, pac_status, pac_report_uid, pac_finalized_at, pac_verdict, why_line, missing_line, situation_line, snapshot_fingerprint, version_no, reviewed_at, reviewed_by, reviewed_version, computed_at, trace_id`
const STATE_COLS = `id, created_at, doc_kind, source_uid, member_uid, encounter_ref, schema_version, status, state_json, superseded_by`
const LVC_COLS = `id, region, society, specialty, statement, precondition, action_type, consider_instead, rationale, keywords, citation_doi, citation_pmid, citation_url, source_release_year, status, chunk_text_hash, created_at, updated_at`

export const MAX_LIMIT = 1000
export const DEFAULT_LIMIT = 200

export interface Page {
  limit?: number
}

/** Half-open window [from, to). Both are ISO timestamps or YYYY-MM-DD days, depending on the column. */
export interface Window extends Page {
  from: string
  to: string
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)))
}

export type CdmssReadErrorCode = 'query_failed' | 'bad_row'

/** Carries a code only: no driver text, no zod issues, no caller-supplied values. */
export class CdmssReadError extends Error {
  constructor(readonly code: CdmssReadErrorCode) {
    super(`cdmss_read_${code}`)
    this.name = 'CdmssReadError'
  }
}

export interface StatePage extends Page {
  /** Default false: rows with superseded_by set are hidden. */
  includeSuperseded?: boolean
}
export interface StateWindow extends Window {
  includeSuperseded?: boolean
}

async function run<S extends z.ZodTypeAny>(
  sql: CdmssQuery,
  schema: S,
  query: string,
  params: unknown[],
): Promise<z.infer<S>[]> {
  let rows: Record<string, unknown>[]
  try {
    rows = (await sql.query<Record<string, unknown>>(query, params)).rows
  } catch {
    throw new CdmssReadError('query_failed')
  }
  try {
    return rows.map((row) => schema.parse({ ...row, source: 'cdmss' }))
  } catch {
    throw new CdmssReadError('bad_row')
  }
}

/** Every SQL string this module can run, for the report and for gating-lead's live validation. */
export const CDMSS_SQL = {
  opdByPrescriptionUid: `SELECT ${OPD_COLS} FROM opd_note_audits WHERE uid = $1 ORDER BY audited_at DESC LIMIT $2`,
  opdByConsultUid: `SELECT ${OPD_COLS} FROM opd_note_audits WHERE consult_uid = $1 ORDER BY audited_at DESC LIMIT $2`,
  opdByDoctorUid: `SELECT ${OPD_COLS} FROM opd_note_audits WHERE doctor_uid = $1 ORDER BY note_date DESC NULLS LAST LIMIT $2`,
  opdByWindow: `SELECT ${OPD_COLS} FROM opd_note_audits WHERE note_date >= $1::timestamptz AND note_date < $2::timestamptz ORDER BY note_date DESC LIMIT $3`,
  otByUid: `SELECT ${OT_COLS} FROM ot_note_audits WHERE uid = $1 ORDER BY audited_at DESC LIMIT $2`,
  otByDoctorUid: `SELECT ${OT_COLS} FROM ot_note_audits WHERE doctor_uid = $1 ORDER BY note_day DESC LIMIT $2`,
  otByWindow: `SELECT ${OT_COLS} FROM ot_note_audits WHERE note_day >= $1::date AND note_day < $2::date ORDER BY note_day DESC LIMIT $3`,
  preopByEpisodeKey: `SELECT ${PREOP_COLS} FROM preop_findings WHERE episode_key = $1 ORDER BY updated_at DESC LIMIT $2`,
  preopByIndividualUid: `SELECT ${PREOP_COLS} FROM preop_findings WHERE individual_uid = $1 ORDER BY surgery_date DESC NULLS LAST LIMIT $2`,
  preopByWindow: `SELECT ${PREOP_COLS} FROM preop_findings WHERE surgery_date >= $1::date AND surgery_date < $2::date ORDER BY surgery_date DESC LIMIT $3`,
  statesBySourceUid: `SELECT ${STATE_COLS} FROM clinical_states WHERE source_uid = $1 AND ($3::boolean OR superseded_by IS NULL) ORDER BY created_at DESC LIMIT $2`,
  statesByEncounterRef: `SELECT ${STATE_COLS} FROM clinical_states WHERE encounter_ref = $1 AND ($3::boolean OR superseded_by IS NULL) ORDER BY created_at DESC LIMIT $2`,
  statesByWindow: `SELECT ${STATE_COLS} FROM clinical_states WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz AND ($4::boolean OR superseded_by IS NULL) ORDER BY created_at DESC LIMIT $3`,
  lvcActive: `SELECT ${LVC_COLS} FROM lvc_recommendations WHERE status = 'active' AND ($1::text IS NULL OR region = $1) AND ($2::text IS NULL OR specialty = $2) AND ($3::text IS NULL OR action_type = $3) ORDER BY id LIMIT $4`,
  lvcById: `SELECT ${LVC_COLS} FROM lvc_recommendations WHERE id = $1`,
} as const

export const opdAuditsByPrescriptionUid = (sql: CdmssQuery, uid: string, p: Page = {}) =>
  run(sql, OpdAuditRow, CDMSS_SQL.opdByPrescriptionUid, [uid, clampLimit(p.limit)])
export const opdAuditsByConsultUid = (sql: CdmssQuery, consultUid: string, p: Page = {}) =>
  run(sql, OpdAuditRow, CDMSS_SQL.opdByConsultUid, [consultUid, clampLimit(p.limit)])
export const opdAuditsByDoctorUid = (sql: CdmssQuery, doctorUid: string, p: Page = {}) =>
  run(sql, OpdAuditRow, CDMSS_SQL.opdByDoctorUid, [doctorUid, clampLimit(p.limit)])
export const opdAuditsByWindow = (sql: CdmssQuery, w: Window) =>
  run(sql, OpdAuditRow, CDMSS_SQL.opdByWindow, [w.from, w.to, clampLimit(w.limit)])

export const otAuditsByUid = (sql: CdmssQuery, uid: string, p: Page = {}) =>
  run(sql, OtAuditRow, CDMSS_SQL.otByUid, [uid, clampLimit(p.limit)])
export const otAuditsByDoctorUid = (sql: CdmssQuery, doctorUid: string, p: Page = {}) =>
  run(sql, OtAuditRow, CDMSS_SQL.otByDoctorUid, [doctorUid, clampLimit(p.limit)])
export const otAuditsByWindow = (sql: CdmssQuery, w: Window) =>
  run(sql, OtAuditRow, CDMSS_SQL.otByWindow, [w.from, w.to, clampLimit(w.limit)])

export const preopFindingsByEpisodeKey = (sql: CdmssQuery, key: string, p: Page = {}) =>
  run(sql, PreopFindingRow, CDMSS_SQL.preopByEpisodeKey, [key, clampLimit(p.limit)])
export const preopFindingsByIndividualUid = (sql: CdmssQuery, uid: string, p: Page = {}) =>
  run(sql, PreopFindingRow, CDMSS_SQL.preopByIndividualUid, [uid, clampLimit(p.limit)])
export const preopFindingsByWindow = (sql: CdmssQuery, w: Window) =>
  run(sql, PreopFindingRow, CDMSS_SQL.preopByWindow, [w.from, w.to, clampLimit(w.limit)])

export const clinicalStatesBySourceUid = (sql: CdmssQuery, uid: string, p: StatePage = {}) =>
  run(sql, ClinicalStateRow, CDMSS_SQL.statesBySourceUid, [uid, clampLimit(p.limit), p.includeSuperseded === true])
export const clinicalStatesByEncounterRef = (sql: CdmssQuery, ref: string, p: StatePage = {}) =>
  run(sql, ClinicalStateRow, CDMSS_SQL.statesByEncounterRef, [ref, clampLimit(p.limit), p.includeSuperseded === true])
export const clinicalStatesByWindow = (sql: CdmssQuery, w: StateWindow) =>
  run(sql, ClinicalStateRow, CDMSS_SQL.statesByWindow, [w.from, w.to, clampLimit(w.limit), w.includeSuperseded === true])

export interface LvcFilter extends Page {
  region?: string
  specialty?: string
  actionType?: string
}
export const lvcRecommendations = (sql: CdmssQuery, f: LvcFilter = {}) =>
  run(sql, LvcRecommendation, CDMSS_SQL.lvcActive, [f.region ?? null, f.specialty ?? null, f.actionType ?? null, clampLimit(f.limit)])
export const lvcRecommendationById = async (sql: CdmssQuery, id: string): Promise<LvcRecommendation | null> =>
  (await run(sql, LvcRecommendation, CDMSS_SQL.lvcById, [id]))[0] ?? null
