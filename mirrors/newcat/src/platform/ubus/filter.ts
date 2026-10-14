/**
 * Local pre-filter for every outbound ubus message (the ubus PHI filter is the second wall).
 * A message is a plain object of opaque tokens, numbers, booleans and nested objects of the same.
 * Free text cannot pass: a string must be a single token from a narrow id alphabet.
 *
 * This checks structure only, not meaning. A one-word name passes the token rule, and a UUID-shaped string can carry
 * up to 32 digits. Safety rests on the closed set of fields the bridge chooses to send (agent_id, the status enum,
 * snake_case reasons, error types, numeric counts and ids generated in code), not on this filter. Do not add a
 * field to an outbound message on the strength of the filter passing it.
 */
export type FilterRule = 'digit_run' | 'email' | 'free_text' | 'shape'

export class FilterRejection extends Error {
  constructor(
    readonly rule: FilterRule,
    readonly path: string,
  ) {
    super(`ubus pre-filter rejected (${rule}) at ${path}`)
  }
}

const TOKEN = /^[A-Za-z0-9._:/-]{1,128}$/
const DIGIT_RUN = /\d{6,}/
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/
/** Random ids may carry long digit runs by chance; these two strict shapes are the only exemptions. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
/** agent_runs.run_id: sha256(...).slice(0, 32), lowercase hex. */
const RUN_ID = /^[0-9a-f]{32}$/
const isStrictId = (value: string): boolean => UUID.test(value) || RUN_ID.test(value)
const MAX_DEPTH = 3

export function checkString(value: string, path: string): void {
  const isUuid = isStrictId(value)
  if (EMAIL.test(value)) throw new FilterRejection('email', path)
  if (!isUuid && DIGIT_RUN.test(value)) throw new FilterRejection('digit_run', path)
  if (!isUuid && !TOKEN.test(value)) throw new FilterRejection('free_text', path)
}

function checkValue(value: unknown, path: string, depth: number): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new FilterRejection('shape', path)
    if (DIGIT_RUN.test(String(Math.abs(value)))) throw new FilterRejection('digit_run', path)
    return
  }
  if (typeof value === 'string') {
    const colon = value.indexOf(':')
    // `job:<uuid>` and `run:<run_id>` refs: check the prefix as a token and the tail as a strict id.
    if (colon > 0 && isStrictId(value.slice(colon + 1)) && TOKEN.test(value.slice(0, colon)) && !DIGIT_RUN.test(value.slice(0, colon))) return
    checkString(value, path)
    return
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) throw new FilterRejection('shape', path)
    value.forEach((item, i) => checkValue(item, `${path}[${i}]`, depth + 1))
    return
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) throw new FilterRejection('shape', path)
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      checkString(key, `${path}.${key}#key`)
      checkValue(item, `${path}.${key}`, depth + 1)
    }
    return
  }
  throw new FilterRejection('shape', path)
}

/** Throws FilterRejection on the first violation. The error names the rule and path, never the value. */
export function assertOutbound(subject: string, fields: Record<string, unknown>): void {
  checkString(subject, 'subject')
  checkValue(fields, 'body', 0)
}

export function checkOutbound(subject: string, fields: Record<string, unknown>): FilterRejection | null {
  try {
    assertOutbound(subject, fields)
    return null
  } catch (error) {
    if (error instanceof FilterRejection) return error
    throw error
  }
}
