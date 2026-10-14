import { z } from 'zod'

export const AUDIENCES = ['internal', 'operator', 'doctor', 'governance'] as const
export type Audience = (typeof AUDIENCES)[number]

export const SEVERITIES = ['critical', 'safety', 'quality', 'documentation'] as const
export type Severity = (typeof SEVERITIES)[number]

export const TRI = ['yes', 'no', 'unknown'] as const
export type Tri = (typeof TRI)[number]

export const SEXES = ['female', 'male', 'other', 'unknown'] as const
export type Sex = (typeof SEXES)[number]

/** Model-facing span. Offsets are computed later from the quote. */
export const QuoteIn = z.object({
  quote: z.string().min(1),
})
export type QuoteIn = z.infer<typeof QuoteIn>

export const MedicationIn = z.object({
  drug: z.string().min(1),
  dose: z.number().nullable(),
  unit: z.string().nullable(),
  frequency: z.string().nullable(),
  route: z.string().nullable(),
  duration: z.string().nullable(),
  span: QuoteIn,
})
export type Medication = Omit<z.infer<typeof MedicationIn>, 'span'>

export const ModelPayload = z.object({
  patient: z.object({
    age_years: z.number().int().nullable(),
    age_span: QuoteIn.nullable(),
    sex: z.enum(SEXES),
    sex_span: QuoteIn.nullable(),
    pregnancy: z.enum(TRI),
    pregnancy_span: QuoteIn.nullable(),
    renal_impairment: z.enum(TRI),
    renal_span: QuoteIn.nullable(),
    hepatic_impairment: z.enum(TRI),
    hepatic_span: QuoteIn.nullable(),
    allergies: z.array(z.object({ substance: z.string().min(1), span: QuoteIn })),
    comorbidities: z.array(z.object({ name: z.string().min(1), span: QuoteIn })),
  }),
  medications: z.array(MedicationIn),
  diagnoses: z.array(z.object({ name: z.string().min(1), span: QuoteIn })),
  vitals: z.array(
    z.object({
      name: z.string().min(1),
      value: z.number(),
      unit: z.string().min(1),
      span: QuoteIn,
    }),
  ),
  investigations: z.array(
    z.object({
      name: z.string().min(1),
      result: z.string().nullable(),
      span: QuoteIn,
    }),
  ),
  plan: z.array(z.object({ text: z.string().min(1), span: QuoteIn })),
  red_flags: z.array(z.object({ text: z.string().min(1), span: QuoteIn })),
})
export type ModelPayload = z.infer<typeof ModelPayload>

export const Span = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1),
})
export type Span = z.infer<typeof Span>

function contextFact<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    id: z.string().min(1),
    value,
    span: Span.nullable(),
    extractor_version: z.string().min(1),
  })
}

export function factSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    id: z.string().min(1),
    value,
    span: Span,
    extractor_version: z.string().min(1),
  })
}

const MedicationValue = z.object({
  drug: z.string().min(1),
  dose: z.number().nullable(),
  unit: z.string().nullable(),
  frequency: z.string().nullable(),
  route: z.string().nullable(),
  duration: z.string().nullable(),
})

export const ClinicalStateSchema = z.object({
  extractor_version: z.string().min(1),
  patient: z.object({
    age_years: factSchema(z.number().int()).nullable(),
    sex: contextFact(z.enum(SEXES)),
    pregnancy: contextFact(z.enum(TRI)),
    renal_impairment: contextFact(z.enum(TRI)),
    hepatic_impairment: contextFact(z.enum(TRI)),
    allergies: z.array(factSchema(z.string().min(1))),
    comorbidities: z.array(factSchema(z.string().min(1))),
  }),
  medications: z.array(factSchema(MedicationValue)),
  diagnoses: z.array(factSchema(z.string().min(1))),
  vitals: z.array(
    factSchema(
      z.object({
        name: z.string().min(1),
        value: z.number(),
        unit: z.string().min(1),
      }),
    ),
  ),
  investigations: z.array(
    factSchema(
      z.object({
        name: z.string().min(1),
        result: z.string().nullable(),
      }),
    ),
  ),
  plan: z.array(factSchema(z.string().min(1))),
  red_flags: z.array(factSchema(z.string().min(1))),
})

export type ClinicalState = z.infer<typeof ClinicalStateSchema>
export type Fact<T> = {
  id: string
  value: T
  span: z.infer<typeof Span>
  extractor_version: string
}
