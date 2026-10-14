import { readdirSync, readFileSync } from 'node:fs'
import type { ConsultAuditInput } from '../../../../src/agents/surgical-consult/input.js'
import { ConsultAuditInput as InputSchema } from '../../../../src/agents/surgical-consult/input.js'

export const FIXTURE_NAMES = readdirSync('fixtures/surgical-consult')
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''))
  .sort()

export const loadFixture = (name: string): ConsultAuditInput =>
  InputSchema.parse(JSON.parse(readFileSync(`fixtures/surgical-consult/${name}.json`, 'utf8')))

/** An agent input -> an S6 JSONL line object (the shape of S6-DATA-REQUEST). Turn times stay relative. */
export function toLine(input: ConsultAuditInput, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    encounter_id: input.encounter_id,
    doctor_uid: input.doctor_uid,
    room: input.room,
    window: { t0: input.window.start, t1: input.window.end, complete: input.window.complete },
    turns: input.turns.map((t) => ({ turn_id: t.id, role: t.role, t0: t.t0, t1: t.t1, text_en: t.text_en, text_native: t.text_native, lang: t.lang })),
    rx: input.rx
      ? { presc_uid: input.presc_uid, requires_surgery: input.rx.requires_surgery, procedure_text: input.rx.procedure_text, match_confidence: input.presc_match === 'window' ? 'window' : 'exact' }
      : null,
    source: 'cutter',
    ...over,
  }
}

export const fixtureJsonl = (): string => FIXTURE_NAMES.map((n) => JSON.stringify(toLine(loadFixture(n)))).join('\n') + '\n'
