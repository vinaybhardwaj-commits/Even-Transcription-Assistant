import type { ConsultAuditInput } from './input.js'
import { prepass } from './prepass.js'

// The one source of a consult (opaque).
export const CONSULT_SOURCE_ID = 's1'

// Opaque segment ids by position in the pre-pass output; never derived from record text.
export const segmentId = (index: number): string => `seg-${String(index + 1).padStart(4, '0')}`

/**
 * The rule context (F7.4): plain JSON derived from the parsed input, for rule logic only. It never reaches a judge, a
 * claim, a log or any audience body, and rules never copy any of it (or any quote) into summaries, meta values or errors.
 */
export interface ConsultContext {
  // The written side of said-vs-written: what the prescription records.
  rx: { requires_surgery: boolean | null; procedure_text: string | null } | null
  // The pre-pass completeness verdict (the same logic as the definition's completeness hook). Rules pass it on, so absence
  // is never evidence on an incomplete window even if the hook is bypassed.
  complete: boolean
  // The consult window's segments in source order: lets an absence rule name the whole window's doctor and patient segments.
  segments: Array<{ id: string; role: string }>
}

export function consultContext(input: ConsultAuditInput): ConsultContext {
  const pass = prepass(input)
  return {
    rx: input.rx === null ? null : { requires_surgery: input.rx.requires_surgery, procedure_text: input.rx.procedure_text },
    complete: pass.complete,
    segments: pass.turns.map((turn, i) => ({ id: segmentId(i), role: turn.role })),
  }
}
