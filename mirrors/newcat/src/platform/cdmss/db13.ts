import { z } from 'zod'
import { stripIdentifiers } from './identifiers.js'
import * as r from './db13-recipes.js'

/**
 * db13 (Pulse prescriptions, notes, surgery_cases) read through the Metabase API (V3). Env NAMES
 * METABASE_URL and METABASE_API_KEY (header x-api-key), read inside this module. Read-only: every
 * recipe is a SELECT. Identifier columns are for joins only. Nothing here logs, and nothing here
 * hands rows to a prompt builder; anything model-bound goes through `stripIdentifiers` first.
 * Fail-safe: every failure is a typed `unavailable` outcome that names the recipe and a reason
 * code, never a raw body, never row content.
 */

export { stripIdentifiers }
export { OPD_MEDICAL_TYPES } from './db13-recipes.js'

export const METABASE_URL_ENV = 'METABASE_URL'
export const METABASE_KEY_ENV = 'METABASE_API_KEY'
const DB13 = 13 // cdmss-ref/lib/metabase.ts:15
const DEFAULT_TIMEOUT_MS = 15_000

export type Db13Reason =
  | 'not_configured'
  | 'invalid_input'
  | 'auth'
  | 'permission'
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'bad_response'
  | 'query_failed'

export interface Db13Unavailable {
  status: 'unavailable'
  /** Name of the failing recipe, so a too-narrow collection permission can be reported by query name. */
  recipe: string
  reason: Db13Reason
  httpStatus?: number
}
export interface Db13Ok<T> {
  status: 'ok'
  rows: T[]
}
export type Db13Outcome<T> = Db13Ok<T> | Db13Unavailable

export interface Db13Deps {
  fetch?: typeof fetch
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

const unavailable = (recipe: string, reason: Db13Reason, httpStatus?: number): Db13Unavailable =>
  httpStatus === undefined ? { status: 'unavailable', recipe, reason } : { status: 'unavailable', recipe, reason, httpStatus }

/** Metabase error text is never returned; it is only classified. */
function classifyQueryError(error: unknown): Db13Reason {
  return /permission|not authori[sz]ed|denied|forbidden/i.test(String(error ?? '')) ? 'permission' : 'query_failed'
}

/**
 * Runs one native SQL query against db13 via POST /api/dataset (cdmss-ref/lib/metabase.ts:111-129)
 * and returns rows as objects.
 */
async function db13Query(recipe: string, query: string, deps: Db13Deps = {}): Promise<Db13Outcome<Record<string, unknown>>> {
  const env = deps.env ?? process.env
  const rawUrl = env[METABASE_URL_ENV]
  const key = env[METABASE_KEY_ENV]
  if (!rawUrl || !key) return unavailable(recipe, 'not_configured')
  const doFetch = deps.fetch ?? fetch
  let res: Response
  let text: string
  try {
    res = await doFetch(`${rawUrl.replace(/\/+$/, '')}/api/dataset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify({ database: DB13, type: 'native', native: { query } }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    })
    text = await res.text()
  } catch (error) {
    const name = error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : ''
    return unavailable(recipe, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network')
  }
  if (res.status === 401) return unavailable(recipe, 'auth', 401)
  if (res.status === 403) return unavailable(recipe, 'permission', 403)
  if (!res.ok) return unavailable(recipe, 'http_error', res.status)
  let body: { status?: string; error?: unknown; data?: { rows?: unknown[][]; cols?: { name: string }[] } }
  try {
    body = JSON.parse(text)
  } catch {
    return unavailable(recipe, 'bad_response')
  }
  if (!body || typeof body !== 'object') return unavailable(recipe, 'bad_response')
  if (body.status === 'failed' || body.error) return unavailable(recipe, classifyQueryError(body.error))
  const cols = body.data?.cols
  const rows = body.data?.rows
  if (!Array.isArray(cols) || !Array.isArray(rows)) return unavailable(recipe, 'bad_response')
  const names = cols.map((c) => c.name)
  return {
    status: 'ok',
    rows: rows.map((row) => {
      const out: Record<string, unknown> = {}
      names.forEach((name, i) => {
        out[name] = row[i]
      })
      return out
    }),
  }
}

// ── row types (every row carries source: 'db13') ────────────────────────────────

const src = z.literal('db13')
const scalar = z.union([z.string(), z.number(), z.boolean()]).nullable()
const text = z.string().nullable()
const num = z.number().nullable()

/** Note projection. Join keys and metadata are typed; the remaining projected columns pass through. */
export const Db13NoteRow = z
  .object({
    source: src,
    uid: z.string(),
    consult_uid: text,
    doctor_uid: text,
    kx_encounter_id: text,
    type_of_prescription: text,
    consult_type: text,
    timestamp: text,
    dpipe_pc: text,
    dpipe_dx: text,
    dpipe_pom: text,
    dpipe_inv: text,
  })
  .catchall(z.unknown())
export type Db13NoteRow = z.infer<typeof Db13NoteRow>

export const Db13CountRow = z.object({ source: src, n: z.number() })
export const Db13DoctorNameRow = z.object({ source: src, uid: z.string(), name_with_prefix: text })
export const Db13SpecialityRow = z.object({ source: src, doctor_uid: z.string(), label: text, n: z.number() })
export const Db13SurgeryCaseRow = z.object({
  source: src,
  individual_uid: z.string(),
  procedure_name: text,
  surgery_type_uid: text,
  prescription_uid: text,
  planned_surgery_date: scalar,
  status: text,
  created_at: scalar,
})
export const Db13SurgicalFlagRow = z.object({
  source: src,
  individual_uid: z.string(),
  requires_surgery_or_procedure: z.boolean().nullable(),
  surgery_or_procedure_recommendation: z.unknown(),
  uploaded_at: scalar,
})
export const Db13DischargeRow = z.object({ source: src, admission_date_time: scalar, discharge_date_time: scalar })
export const Db13EpisodeRow = z.object({
  source: src,
  _doc_id: z.string(),
  individual_uid: z.string(),
  procedure_name: text,
  financial__procedure_name: text,
  status: text,
  clinical__urgency: text,
  pac__status: text,
  comorbidities: text,
  hospital_info__hospital_uid: text,
  surgery_date: text,
  created_at: text,
  updated_at: text,
  kx_uhid: text,
  display_name: text,
  first_name: text,
  last_name: text,
  gender: text,
  age_years: num,
})
export const Db13HospitalRow = z.object({ source: src, _doc_id: z.string(), name: text })
export const Db13PacReportRow = z.object({
  source: src,
  uid: z.string(),
  uhid: z.string(),
  status: text,
  template_name: text,
  created_at: text,
  note: text,
  component_json: text,
})
export const Db13CreatinineRow = z.object({
  source: src,
  individual_uid: z.string(),
  name: text,
  data_value: scalar,
  data_unit: text,
  at: text,
})
export const Db13OpdComorbidityRow = z.object({
  source: src,
  individual_uid: z.string(),
  _doc_id: text,
  at: text,
  comorbidities: text,
})
export const Db13OpdIcdRow = z.object({
  source: src,
  individual_uid: z.string(),
  _doc_id: text,
  at: text,
  dx: text,
  imp: text,
})

/** A postgres text[] as Metabase renders it ('{A,B}') or already an array. preop/db13.ts:57-65 */
export function parsePgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x))
  const t = v == null || v === '' ? null : String(v)
  if (!t) return []
  const inner = t.replace(/^\{|\}$/g, '')
  if (!inner) return []
  return inner.split(',').map((x) => x.replace(/^"|"$/g, '').trim()).filter(Boolean)
}

/** Comorbidity names out of the JSON array; an unrecognised shape yields nothing. preop/db13.ts:~410-424 */
export function comorbidityNames(raw: string | null): string[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: string[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const c = (item as Record<string, unknown>).comorbidity
    if (!c || typeof c !== 'object') continue
    const name = (c as Record<string, unknown>).name
    if (typeof name === 'string' && name.trim()) out.push(name.trim())
  }
  return out
}

// ── fetchers ────────────────────────────────────────────────────────────────────

async function fetchRows<S extends z.ZodTypeAny>(
  recipe: string,
  schema: S,
  build: () => string | null,
  deps: Db13Deps,
): Promise<Db13Outcome<z.infer<S>>> {
  let query: string | null
  try {
    query = build()
  } catch {
    return unavailable(recipe, 'invalid_input')
  }
  if (query === null) return { status: 'ok', rows: [] }
  const out = await db13Query(recipe, query, deps)
  if (out.status === 'unavailable') return out
  const rows: z.infer<S>[] = []
  for (const row of out.rows) {
    const parsed = schema.safeParse({ ...row, source: 'db13' })
    if (!parsed.success) return unavailable(recipe, 'bad_response')
    rows.push(parsed.data)
  }
  return { status: 'ok', rows }
}

export const countOpdNotesForDay = (day: string, excludeDoctorUids: string[] = [], deps: Db13Deps = {}) =>
  fetchRows('opd_notes_count', Db13CountRow, () => r.countOpdNotesForDaySql(day, excludeDoctorUids), deps)
export const fetchOpdNotesForDay = (day: string, excludeUids: string[], limit: number, excludeDoctorUids: string[] = [], deps: Db13Deps = {}) =>
  fetchRows('opd_notes_for_day', Db13NoteRow, () => r.opdNotesForDaySql(day, excludeUids, limit, excludeDoctorUids), deps)
export const fetchOpdNoteByUid = (uid: string, deps: Db13Deps = {}) =>
  fetchRows('opd_note_by_uid', Db13NoteRow, () => r.opdNoteByUidSql(uid), deps)
export const fetchOpdNotesByUids = (uids: string[], deps: Db13Deps = {}) =>
  fetchRows('opd_notes_by_uids', Db13NoteRow, () => r.opdNotesByUidsSql(uids), deps)
export const fetchDoctorNames = (uids: string[], deps: Db13Deps = {}) =>
  fetchRows('doctor_names', Db13DoctorNameRow, () => r.doctorNamesSql(uids), deps)
export const fetchDoctorSpecialities = (uids: string[], deps: Db13Deps = {}) =>
  fetchRows('doctor_specialities', Db13SpecialityRow, () => r.doctorSpecialitiesSql(uids), deps)
export const fetchSurgeryCases = (individualUid: string, deps: Db13Deps = {}) =>
  fetchRows('surgery_cases', Db13SurgeryCaseRow, () => r.surgeryCasesSql(individualUid), deps)
export const fetchSurgicalFlags = (individualUid: string, deps: Db13Deps = {}) =>
  fetchRows('plan_of_management_flag', Db13SurgicalFlagRow, () => r.surgicalFlagSql(individualUid), deps)
export const fetchDischarge = (individualUid: string, deps: Db13Deps = {}) =>
  fetchRows('kx_billing_discharge', Db13DischargeRow, () => r.dischargeSql(individualUid), deps)
export const fetchUpcomingEpisodes = (horizonDays = 60, deps: Db13Deps = {}) =>
  fetchRows('surgery_cases_upcoming', Db13EpisodeRow, () => r.upcomingEpisodesSql(horizonDays), deps)
export const fetchPacCoveredEpisodes = (limit = 300, deps: Db13Deps = {}) =>
  fetchRows('surgery_cases_pac_covered', Db13EpisodeRow, () => r.pacCoveredEpisodesSql(limit), deps)
export const fetchHospitalNames = (deps: Db13Deps = {}) =>
  fetchRows('even_hospitals', Db13HospitalRow, () => r.hospitalNamesSql(), deps)
export const fetchPacReports = (uhids: string[], deps: Db13Deps = {}) =>
  fetchRows('kx_clinical_template_pac_reports', Db13PacReportRow, () => r.pacReportsSql(uhids), deps)
export const fetchCreatinine = (individualUids: string[], deps: Db13Deps = {}) =>
  fetchRows('parameter_digital_values', Db13CreatinineRow, () => r.creatinineSql(individualUids), deps)
export const fetchOpdComorbidities = (individualUids: string[], deps: Db13Deps = {}) =>
  fetchRows('individuals_prescriptions_comorbidities', Db13OpdComorbidityRow, () => r.opdComorbiditiesSql(individualUids), deps)
export const fetchOpdIcd = (individualUids: string[], deps: Db13Deps = {}) =>
  fetchRows('individuals_prescriptions_icd', Db13OpdIcdRow, () => r.opdIcdSql(individualUids), deps)
