export type IdentityResolution =
  | {
      status: 'ok'
      patient_ref: string
      encounter_ref: string
      match_source: 'caller_asserted'
    }
  | { status: 'unmapped'; reason: string }

/**
 * Caller-supplied refs are stored as asserted, not resolved against another database.
 * Missing refs stay unmapped. There is no name, department, or display-string match.
 */
export function resolveIdentity(input: {
  patient_ref?: string | undefined
  encounter_ref?: string | undefined
}): IdentityResolution {
  if (input.patient_ref && input.encounter_ref) {
    return {
      status: 'ok',
      patient_ref: input.patient_ref,
      encounter_ref: input.encounter_ref,
      match_source: 'caller_asserted',
    }
  }
  return { status: 'unmapped', reason: 'patient_ref and encounter_ref are both required' }
}
