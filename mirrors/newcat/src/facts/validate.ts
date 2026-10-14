import { sha256 } from '../hash.js'
import { log } from '../log.js'
import type { ValidationIssue } from '../outcome.js'
import { EXTRACTOR_VERSION } from '../version.js'
import { findQuote, type Cursor } from './quote.js'
import { ClinicalStateSchema, ModelPayload, type ClinicalState, type Span } from './schema.js'

const DOSE_UNITS = new Set(['mg', 'mcg', 'g', 'ml', 'unit', 'iu', 'tablet', 'puff', 'drop', 'percent'])
const FREQUENCIES = new Set([
  'od', 'bd', 'tds', 'qid', 'hs', 'sos', 'weekly', 'once', 'stat', 'daily', 'nightly', 'bid', 'tid', 'prn',
  'q4h', 'q6h', 'q8h', 'q12h',
])
const ROUTES = new Set(['oral', 'iv', 'im', 'sc', 'topical', 'inhaled', 'pr', 'sl', 'ophthalmic', 'otic', 'nasal'])
const VITAL_UNITS = new Set(['mmhg', 'bpm', 'c', 'percent', 'kg', 'cm'])

const VITAL_RANGES: Record<string, [number, number]> = {
  sbp: [50, 250],
  dbp: [30, 150],
  hr: [30, 220],
  temp_c: [34, 42],
  spo2: [50, 100],
  rr: [6, 60],
  weight_kg: [0.4, 400],
  height_cm: [30, 250],
}

function downgrade(path: string, code: string): void {
  log('warn', 'extract.downgrade', { path, downgrade: code })
}

function fatalQuote(path: string, issues: ValidationIssue[]): void {
  issues.push({ code: 'span', path, message: 'quote was not found in the note' })
}

function negated(quote: string, label: string): boolean {
  return /^(no|none|nil|nkda)\b/i.test(label.trim()) || /\bno known\b/i.test(quote)
}

function factId(kind: string, slot: string, span: Span): string {
  return sha256(`${kind}|${slot}|${span.start}|${span.end}`).slice(0, 16)
}

function stamp<T>(kind: string, slot: string, value: T, span: Span) {
  return { id: factId(kind, slot, span), value, span, extractor_version: EXTRACTOR_VERSION }
}

function unanchored<T>(kind: string, value: T) {
  const span = { start: 0, end: 0, quote: '' }
  return { id: factId(kind, String(value), span), value, span: null, extractor_version: EXTRACTOR_VERSION }
}

function resolveSex(
  value: 'female' | 'male' | 'other' | 'unknown',
  span: { quote: string } | null,
  body: string,
  cursor: Cursor,
): { value: 'female' | 'male' | 'other' | 'unknown'; span: Span | null } {
  const located = span ? findQuote(span.quote, body, cursor) : null
  if (located) return { value, span: located }
  if (value !== 'unknown') downgrade('patient.sex', `${value}_to_unknown`)
  else if (span) downgrade('patient.sex', 'quote_not_found')
  return { value: 'unknown', span: null }
}

function resolveTri(
  field: 'pregnancy' | 'renal_impairment' | 'hepatic_impairment',
  value: 'yes' | 'no' | 'unknown',
  span: { quote: string } | null,
  sex: { value: string; span: Span | null },
  body: string,
  cursor: Cursor,
): { value: 'yes' | 'no' | 'unknown'; span: Span | null } {
  const path = `patient.${field}`
  const located = span ? findQuote(span.quote, body, cursor) : null
  if (located) return { value, span: located }
  if (value === 'unknown') {
    if (span) downgrade(path, 'quote_not_found')
    return { value: 'unknown', span: null }
  }
  if (field === 'pregnancy' && value === 'no' && sex.value === 'male' && sex.span) {
    downgrade(path, 'reused_sex_span')
    return { value: 'no', span: sex.span }
  }
  downgrade(path, `${value}_to_unknown`)
  return { value: 'unknown', span: null }
}

function cleanMedication(
  med: { dose: number | null; unit: string | null; frequency: string | null; route: string | null },
  path: string,
): { dose: number | null; unit: string | null; frequency: string | null; route: string | null } {
  let dose = med.dose
  let unit = med.unit?.trim().toLowerCase() ?? null
  let frequency = med.frequency?.trim().toLowerCase() ?? null
  let route = med.route?.trim().toLowerCase() ?? null
  if (dose !== null && !(dose > 0 && dose <= 10_000)) {
    downgrade(`${path}.dose`, 'out_of_range')
    dose = null
  }
  if (unit && !DOSE_UNITS.has(unit)) {
    downgrade(`${path}.unit`, 'unit_cleared')
    unit = null
  }
  if (dose !== null && !unit) {
    downgrade(`${path}.dose`, 'dose_without_unit')
    dose = null
  }
  if (frequency && !FREQUENCIES.has(frequency)) {
    downgrade(`${path}.frequency`, 'frequency_cleared')
    frequency = null
  }
  if (route && !ROUTES.has(route)) {
    downgrade(`${path}.route`, 'route_cleared')
    route = null
  }
  return { dose, unit, frequency, route }
}

export function validateModel(raw: unknown, body: string): { ok: true; state: ClinicalState } | { ok: false; errors: ValidationIssue[] } {
  const parsed = ModelPayload.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        code: 'schema' as const,
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }
  const model = parsed.data
  const issues: ValidationIssue[] = []
  const patient = model.patient
  const cursor: Cursor = { at: 0 }

  let age: ClinicalState['patient']['age_years'] = null
  if (patient.age_years === null) {
    if (patient.age_span !== null) downgrade('patient.age_span', 'span_ignored')
  } else if (patient.age_years < 0 || patient.age_years > 120) {
    downgrade('patient.age_years', 'out_of_range')
  } else if (!patient.age_span) {
    downgrade('patient.age_span', 'quote_missing')
  } else {
    const span = findQuote(patient.age_span.quote, body, cursor)
    if (span) age = stamp('age', String(patient.age_years), patient.age_years, span)
    else downgrade('patient.age_span', 'quote_not_found')
  }

  const sex = resolveSex(patient.sex, patient.sex_span, body, cursor)
  const pregnancy = resolveTri('pregnancy', patient.pregnancy, patient.pregnancy_span, sex, body, cursor)
  const renal = resolveTri('renal_impairment', patient.renal_impairment, patient.renal_span, sex, body, cursor)
  const hepatic = resolveTri('hepatic_impairment', patient.hepatic_impairment, patient.hepatic_span, sex, body, cursor)

  const allergies = []
  for (const [index, allergy] of patient.allergies.entries()) {
    const path = `patient.allergies.${index}`
    if (negated(allergy.span.quote, allergy.substance)) {
      downgrade(path, 'negated_allergy_dropped')
      continue
    }
    const span = findQuote(allergy.span.quote, body, cursor)
    if (!span) {
      fatalQuote(path, issues)
      continue
    }
    allergies.push(stamp('allergy', allergy.substance.trim().toLowerCase(), allergy.substance.trim(), span))
  }

  const comorbidities = []
  for (const [index, item] of patient.comorbidities.entries()) {
    const path = `patient.comorbidities.${index}`
    const span = findQuote(item.span.quote, body, cursor)
    if (!span) {
      downgrade(path, 'quote_not_found')
      continue
    }
    comorbidities.push(stamp('comorbidity', item.name.trim().toLowerCase(), item.name.trim(), span))
  }

  const medications = []
  for (const [index, med] of model.medications.entries()) {
    const path = `medications.${index}`
    const span = findQuote(med.span.quote, body, cursor)
    if (!span) {
      fatalQuote(path, issues)
      continue
    }
    const cleaned = cleanMedication(med, path)
    medications.push(
      stamp(
        'medication',
        med.drug.trim().toLowerCase(),
        {
          drug: med.drug.trim(),
          dose: cleaned.dose,
          unit: cleaned.unit,
          frequency: cleaned.frequency,
          route: cleaned.route,
          duration: med.duration?.trim() || null,
        },
        span,
      ),
    )
  }

  const diagnoses = []
  for (const [index, item] of model.diagnoses.entries()) {
    const path = `diagnoses.${index}`
    const span = findQuote(item.span.quote, body, cursor)
    if (!span) {
      downgrade(path, 'quote_not_found')
      continue
    }
    diagnoses.push(stamp('diagnosis', item.name.trim().toLowerCase(), item.name.trim(), span))
  }

  const vitals = []
  for (const [index, vital] of model.vitals.entries()) {
    const path = `vitals.${index}`
    const span = findQuote(vital.span.quote, body, cursor)
    const name = vital.name.trim().toLowerCase()
    const unit = vital.unit.trim().toLowerCase()
    const range = VITAL_RANGES[name]
    if (!span) {
      downgrade(path, 'quote_not_found')
      continue
    }
    if (!VITAL_UNITS.has(unit) || !range || vital.value < range[0] || vital.value > range[1]) {
      downgrade(path, 'vital_dropped')
      continue
    }
    vitals.push(stamp('vital', name, { name, value: vital.value, unit }, span))
  }

  const investigations = []
  for (const [index, item] of model.investigations.entries()) {
    const path = `investigations.${index}`
    const span = findQuote(item.span.quote, body, cursor)
    if (!span) {
      downgrade(path, 'quote_not_found')
      continue
    }
    investigations.push(
      stamp('investigation', item.name.trim().toLowerCase(), { name: item.name.trim(), result: item.result }, span),
    )
  }

  const plan = []
  for (const [index, item] of model.plan.entries()) {
    const path = `plan.${index}`
    const span = findQuote(item.span.quote, body, cursor)
    if (!span) {
      downgrade(path, 'quote_not_found')
      continue
    }
    plan.push(stamp('plan', item.text.trim().toLowerCase(), item.text.trim(), span))
  }

  const redFlags = []
  for (const [index, item] of model.red_flags.entries()) {
    const path = `red_flags.${index}`
    if (negated(item.span.quote, item.text)) {
      downgrade(path, 'negated_red_flag_dropped')
      continue
    }
    const span = findQuote(item.span.quote, body, cursor)
    if (!span) {
      downgrade(path, 'quote_not_found')
      continue
    }
    redFlags.push(stamp('red_flag', item.text.trim().toLowerCase(), item.text.trim(), span))
  }

  if (issues.length > 0) return { ok: false, errors: issues }

  const state = {
    extractor_version: EXTRACTOR_VERSION,
    patient: {
      age_years: age,
      sex: sex.span ? stamp('sex', sex.value, sex.value, sex.span) : unanchored('sex', sex.value),
      pregnancy: pregnancy.span ? stamp('pregnancy', pregnancy.value, pregnancy.value, pregnancy.span) : unanchored('pregnancy', pregnancy.value),
      renal_impairment: renal.span
        ? stamp('renal', renal.value, renal.value, renal.span)
        : unanchored('renal', renal.value),
      hepatic_impairment: hepatic.span
        ? stamp('hepatic', hepatic.value, hepatic.value, hepatic.span)
        : unanchored('hepatic', hepatic.value),
      allergies,
      comorbidities,
    },
    medications,
    diagnoses,
    vitals,
    investigations,
    plan,
    red_flags: redFlags,
  }
  const checked = ClinicalStateSchema.safeParse(state)
  if (!checked.success) {
    return {
      ok: false,
      errors: checked.error.issues.map((issue) => ({
        code: 'schema' as const,
        path: issue.path.join('.'),
        message: issue.message,
      })),
    }
  }
  return { ok: true, state: checked.data }
}
