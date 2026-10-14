// sc-facts/0.1.0 field types (spec section 4 names the fields only; these types were accepted in I1b):
// - recommendation: procedure_text string; laterality left|right|both|unspecified; firmness firm|conditional|option_mentioned;
//   urgency today|elective|unspecified.
// - indication: symptom_duration string|null; conservative_tried {what, how_long|null}|null; imaging_cited boolean;
//   exam_cited boolean; red_flags string[].
// - consent, patient_response, pressure: each element is a boolean; one fact = one quote covering the flagged elements.
// - ConsultFacts holds an array of facts per group. All schemas strict; quote and segment_id are non-empty.
// S1 (F7): facts are keyed by segment_id (opaque ids from the pre-pass turns), not turn_id. The wire shape is
// {group, quote, segment_id, ...fields} (ExtractedFact). The platform gate stamps role, t0, t1 and offsets.
// F6 (multi-procedure): a recommendation carries rec_id; every other fact carries rec_ref (a rec_id or null).
import { z } from 'zod'
import { ROLES, type Role } from './input.js'

// Spec section 4. Every fact is {quote, segment_id} plus its group fields. The model never
// supplies offsets, roles or judgements; the platform gate stamps role, t0 and t1.
const base = { quote: z.string().min(1), segment_id: z.string().min(1) }
export const REC_ID = z.string().regex(/^r[0-9]{1,3}$/)
const link = { rec_ref: REC_ID.nullable() }

export const FIRMNESS = ['firm', 'conditional', 'option_mentioned'] as const
export const URGENCY = ['today', 'elective', 'unspecified'] as const
export const LATERALITY = ['left', 'right', 'both', 'unspecified'] as const

export const RecommendationFact = z
  .object({
    ...base,
    rec_id: REC_ID,
    procedure_text: z.string().min(1),
    laterality: z.enum(LATERALITY),
    firmness: z.enum(FIRMNESS),
    urgency: z.enum(URGENCY),
  })
  .strict()

export const IndicationFact = z
  .object({
    ...base,
    ...link,
    symptom_duration: z.string().nullable(),
    conservative_tried: z.object({ what: z.string(), how_long: z.string().nullable() }).strict().nullable(),
    imaging_cited: z.boolean(),
    exam_cited: z.boolean(),
    red_flags: z.array(z.string()),
  })
  .strict()

export const ConsentFact = z
  .object({
    ...base,
    ...link,
    risks: z.boolean(),
    alternatives: z.boolean(),
    no_surgery_option: z.boolean(),
    recovery: z.boolean(),
    cost: z.boolean(),
    second_opinion_offered: z.boolean(),
  })
  .strict()

export const PatientResponseFact = z
  .object({
    ...base,
    ...link,
    question_asked: z.boolean(),
    hesitation_stated: z.boolean(),
    agreement_stated: z.boolean(),
    concern_stated: z.boolean(),
  })
  .strict()

export const PressureFact = z
  .object({
    ...base,
    ...link,
    decide_today: z.boolean(),
    discount_or_package: z.boolean(),
    fear_framing: z.boolean(),
  })
  .strict()

export const FACT_GROUPS = ['recommendation', 'indication', 'consent', 'patient_response', 'pressure'] as const
export type FactGroup = (typeof FACT_GROUPS)[number]

export const FactSchemas = {
  recommendation: RecommendationFact,
  indication: IndicationFact,
  consent: ConsentFact,
  patient_response: PatientResponseFact,
  pressure: PressureFact,
} as const

export const ConsultFacts = z
  .object({
    recommendation: z.array(RecommendationFact),
    indication: z.array(IndicationFact),
    consent: z.array(ConsentFact),
    patient_response: z.array(PatientResponseFact),
    pressure: z.array(PressureFact),
  })
  .strict()
export type ConsultFacts = z.infer<typeof ConsultFacts>

export type RecommendationFact = z.infer<typeof RecommendationFact>
export type IndicationFact = z.infer<typeof IndicationFact>
export type ConsentFact = z.infer<typeof ConsentFact>
export type PatientResponseFact = z.infer<typeof PatientResponseFact>
export type PressureFact = z.infer<typeof PressureFact>

export interface FactByGroup {
  recommendation: RecommendationFact
  indication: IndicationFact
  consent: ConsentFact
  patient_response: PatientResponseFact
  pressure: PressureFact
}

// Section 4 table. "any" for indication means every role.
export const ALLOWED_ROLES: Record<FactGroup, Role[]> = {
  recommendation: ['doctor'],
  indication: [...ROLES],
  consent: ['doctor'],
  patient_response: ['patient', 'attendant'],
  pressure: ['doctor'],
}

// Wire shape: the one object the model emits per fact (spec section 4 plus the platform gate shape).
export const ExtractedFact = z.discriminatedUnion('group', [
  RecommendationFact.extend({ group: z.literal('recommendation') }),
  IndicationFact.extend({ group: z.literal('indication') }),
  ConsentFact.extend({ group: z.literal('consent') }),
  PatientResponseFact.extend({ group: z.literal('patient_response') }),
  PressureFact.extend({ group: z.literal('pressure') }),
])
export type ExtractedFact = z.infer<typeof ExtractedFact>

// What the platform gate produces after the quote and speaker checks (t0 and t1 are always set: every segment has them).
export type GatedFact<G extends FactGroup = FactGroup> = FactByGroup[G] & {
  id: string
  group: G
  source_id: string
  role: Role
  t0: number
  t1: number
  start: number
  end: number
}
