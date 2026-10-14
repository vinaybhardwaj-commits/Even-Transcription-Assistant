import { z } from 'zod'

export const ROLES = ['doctor', 'patient', 'attendant', 'unknown'] as const
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>

const IsoSchema = z.string().datetime({ offset: true })

// t0 and t1 are SECONDS FROM WINDOW START (not epoch, not ms), with 0 <= t0 <= t1.
export const ConsultTurnSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    role: RoleSchema,
    t0: z.number().finite(),
    t1: z.number().finite(),
    text_en: z.string(),
    text_native: z.string().nullable(),
    lang: z.string(),
  })
  .strict()
  .refine((t) => t.t0 >= 0, { message: 't0 must be >= 0', path: ['t0'] })
  .refine((t) => t.t1 >= t.t0, { message: 't1 must be >= t0', path: ['t1'] })
export type ConsultTurn = z.infer<typeof ConsultTurnSchema>

export const ConsultAuditInput = z
  .object({
    encounter_id: z.string(),
    room: z.string(),
    specialty: z.string().nullable(),
    doctor_uid: z.string().nullable(),
    presc_uid: z.string().nullable(),
    presc_match: z.enum(['exact', 'window', 'none']),
    window: z
      .object({ start: IsoSchema, end: IsoSchema, complete: z.boolean() })
      .strict()
      .refine((w) => Date.parse(w.end) >= Date.parse(w.start), { message: 'window.end must be >= window.start', path: ['end'] }),
    turns: z.array(ConsultTurnSchema).min(1).max(2000),
    rx: z
      .object({
        requires_surgery: z.boolean().nullable(),
        procedure_text: z.string().nullable(),
      })
      .strict()
      .nullable(),
    clips: z.array(
      z
        .object({
          turn_ids: z.array(z.string()),
          url: z.string(),
          expires_at: IsoSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>()
    input.turns.forEach((turn, i) => {
      if (seen.has(turn.id)) ctx.addIssue({ code: 'custom', message: 'turn ids must be unique', path: ['turns', i, 'id'] })
      seen.add(turn.id)
      const prev = input.turns[i - 1]
      if (prev && turn.t0 < prev.t0) {
        ctx.addIssue({ code: 'custom', message: 'turns must be non-decreasing by t0', path: ['turns', i, 't0'] })
      }
    })
  })
export type ConsultAuditInput = z.infer<typeof ConsultAuditInput>
