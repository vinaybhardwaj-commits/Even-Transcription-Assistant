/** Deterministic stand-in for a model, used only by the fake client. It is not a clinical parser on the live path. */

function spanOf(body: string, quote: string): { start: number; end: number; quote: string } {
  const start = body.indexOf(quote)
  if (start < 0) throw new Error('scripted quote missing from note')
  return { start, end: start + quote.length, quote }
}

function field(line: string, prefix: string): string {
  return line.slice(prefix.length).trim()
}

function emptyToNull(value: string | undefined): string | null {
  if (!value || value.trim() === '') return null
  return value.trim()
}

export function scriptedModelPayload(body: string): unknown {
  const lines = body.split('\n').filter((line) => line.trim() !== '')
  const patient: Record<string, unknown> = {
    age_years: null,
    age_span: null,
    allergies: [],
    comorbidities: [],
  }
  const medications = []
  const diagnoses = []
  const vitals = []
  const investigations = []
  const plan = []
  const redFlags = []

  for (const line of lines) {
    const quote = spanOf(body, line)
    if (line.startsWith('AGE:')) {
      const raw = field(line, 'AGE:')
      if (raw !== 'unknown') {
        patient.age_years = Number(raw)
        patient.age_span = quote
      }
    } else if (line.startsWith('SEX:')) {
      patient.sex = field(line, 'SEX:')
      patient.sex_span = quote
    } else if (line.startsWith('PREGNANT:')) {
      patient.pregnancy = field(line, 'PREGNANT:')
      patient.pregnancy_span = quote
    } else if (line.startsWith('RENAL:')) {
      patient.renal_impairment = field(line, 'RENAL:')
      patient.renal_span = quote
    } else if (line.startsWith('HEPATIC:')) {
      patient.hepatic_impairment = field(line, 'HEPATIC:')
      patient.hepatic_span = quote
    } else if (line.startsWith('ALLERGY:')) {
      const substance = field(line, 'ALLERGY:')
      if (substance !== 'none') (patient.allergies as unknown[]).push({ substance, span: quote })
    } else if (line.startsWith('COMORBIDITY:')) {
      const name = field(line, 'COMORBIDITY:')
      if (name !== 'none') (patient.comorbidities as unknown[]).push({ name, span: quote })
    } else if (line.startsWith('DIAGNOSIS:')) {
      diagnoses.push({ name: field(line, 'DIAGNOSIS:'), span: quote })
    } else if (line.startsWith('MEDICATION:')) {
      const parts = field(line, 'MEDICATION:').split('|').map((part) => part.trim())
      const doseRaw = emptyToNull(parts[1])
      medications.push({
        drug: parts[0] ?? '',
        dose: doseRaw === null ? null : Number(doseRaw),
        unit: emptyToNull(parts[2]),
        frequency: emptyToNull(parts[3]),
        route: emptyToNull(parts[4]),
        duration: emptyToNull(parts[5]),
        span: quote,
      })
    } else if (line.startsWith('VITAL:')) {
      const raw = field(line, 'VITAL:')
      if (raw !== 'none') {
        const parts = raw.split('|').map((part) => part.trim())
        vitals.push({ name: parts[0], value: Number(parts[1]), unit: parts[2], span: quote })
      }
    } else if (line.startsWith('INVESTIGATION:')) {
      const raw = field(line, 'INVESTIGATION:')
      if (raw !== 'none') {
        const parts = raw.split('|').map((part) => part.trim())
        investigations.push({ name: parts[0], result: parts[1] ?? null, span: quote })
      }
    } else if (line.startsWith('PLAN:')) {
      plan.push({ text: field(line, 'PLAN:'), span: quote })
    } else if (line.startsWith('REDFLAG:')) {
      const text = field(line, 'REDFLAG:')
      if (text !== 'none') redFlags.push({ text, span: quote })
    } else {
      throw new Error('unknown scripted line')
    }
  }

  return { patient, medications, diagnoses, vitals, investigations, plan, red_flags: redFlags }
}
