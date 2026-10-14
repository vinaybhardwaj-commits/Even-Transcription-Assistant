const CLOSED = new Set([
  'female',
  'male',
  'other',
  'unknown',
  'yes',
  'no',
  'mg',
  'mcg',
  'g',
  'ml',
  'unit',
  'iu',
  'tablet',
  'puff',
  'drop',
  'percent',
  'od',
  'bd',
  'tds',
  'qid',
  'hs',
  'sos',
  'weekly',
  'once',
  'stat',
  'daily',
  'nightly',
  'bid',
  'tid',
  'prn',
  'q4h',
  'q6h',
  'q8h',
  'q12h',
  'oral',
  'iv',
  'im',
  'sc',
  'topical',
  'inhaled',
  'pr',
  'sl',
  'ophthalmic',
  'otic',
  'nasal',
  'mmhg',
  'bpm',
  'c',
  'kg',
  'cm',
  'sbp',
  'dbp',
  'hr',
  'temp_c',
  'spo2',
  'rr',
  'weight_kg',
  'height_cm',
])

/** Keeps keys, enums, and numbers. Free text becomes a character count. */
export function redactModelInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactModelInput(item))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactModelInput(item)
    return out
  }
  if (typeof value === 'string') {
    if (CLOSED.has(value) || CLOSED.has(value.toLowerCase())) return value
    return { redacted: true, chars: value.length }
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  return null
}
