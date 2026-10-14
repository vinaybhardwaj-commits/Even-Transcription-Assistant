/**
 * Identifier columns across both CDMSS legs. They are read for joins only: they never enter a model
 * prompt, a log line or a bus post. `stripIdentifiers` is the one door for anything model-bound.
 * Keys are the column names exactly as the SQL returns them (snake_case).
 */
export const IDENTIFIER_KEYS: ReadonlySet<string> = new Set([
  'id',
  'uid',
  'doc_id',
  '_doc_id',
  'consult_uid',
  'doctor_uid',
  'doctor_name',
  'doctor_name_with_speciality',
  'kx_encounter_id',
  'encounter_id',
  'encounter_ref',
  'individual_uid',
  'member_uid',
  'source_uid',
  'episode_key',
  'uhid',
  'kx_uhid',
  'patient_name',
  'display_name',
  'first_name',
  'last_name',
  'prescription_uid',
  'prescription_url',
  'presc_uid',
  'surgery_type_uid',
  'pac_report_uid',
  'hospital_uid',
  'hospital_info__hospital_uid',
  'label',
  'trace_id',
  'ref',
  'name_with_prefix',
])

/** Returns a shallow copy of `row` without identifier keys. `source` and all non-identifier keys survive. */
export function stripIdentifiers<T extends Record<string, unknown>>(row: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (!IDENTIFIER_KEYS.has(key)) out[key] = value
  }
  return out as Partial<T>
}

/**
 * Free-text fields that `stripIdentifiers` does NOT remove and that carry names or free text:
 * preop `surgeon` and `reviewed_by` (staff names), PAC report `note` and `component_json`
 * (db13.ts PAC recipe). Nothing model-bound may use these until the per-recipe allowlist ruled in
 * F3-B classifies them. `stripIdentifiers` behaviour is deliberately unchanged in this round.
 */
export const NEEDS_ALLOWLIST_REVIEW: readonly string[] = ['surgeon', 'reviewed_by', 'note', 'component_json']
