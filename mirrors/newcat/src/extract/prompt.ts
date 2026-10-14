import { zodToJsonSchema } from 'zod-to-json-schema'
import { ModelPayload } from '../facts/schema.js'
import type { ModelToolSpec } from '../llm/types.js'

export const EXTRACT_TOOL_NAME = 'record_clinical_facts'

/** Inlined JSON Schema for the forced Converse tool. `$schema` is omitted because Bedrock rejects it. */
export function extractionInputSchema(): Record<string, unknown> {
  const schema = zodToJsonSchema(ModelPayload, { $refStrategy: 'none' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}

export function extractionTool(): ModelToolSpec {
  return {
    name: EXTRACT_TOOL_NAME,
    description:
      'Record the typed facts extracted from the outpatient note. Pregnancy, renal impairment, and hepatic impairment must be unknown unless the note states it.',
    inputSchema: extractionInputSchema(),
  }
}

export const EXTRACT_SYSTEM = [
  'You extract typed clinical facts from an outpatient note.',
  'Return one JSON object and nothing else.',
  'Copy each quote exactly from the note. Do not count character offsets.',
  'Do not judge appropriateness, severity, or whether a finding should be raised.',
  'Do not invent facts that are not written in the note.',
  'Use null when a value is absent. Use "unknown" for sex when the note does not say.',
  'Pregnancy, renal impairment, and hepatic impairment must be unknown unless the note states it.',
  'Use a null span when sex, pregnancy, renal impairment, or hepatic impairment is unknown.',
  'Allowed medication units: mg, mcg, g, ml, unit, iu, tablet, puff, drop, percent.',
  'Allowed routes: oral, iv, im, sc, topical, inhaled, pr, sl, ophthalmic, otic, nasal.',
  'Allowed frequencies: od, bd, tds, qid, hs, sos, weekly, once, stat, daily, nightly, bid, tid, prn, q4h, q6h, q8h, q12h.',
].join('\n')

/** System text includes the schema so a model that returns plain JSON still has the shape. */
export function extractionSystem(): string {
  return [
    EXTRACT_SYSTEM,
    'Call the record_clinical_facts tool with one object of that shape.',
    'If a tool call is not available, return one JSON object matching this schema and nothing else.',
    JSON.stringify(extractionInputSchema()),
  ].join('\n')
}

export function extractUser(body: string): string {
  return [
    'Extract patient context, medications, diagnoses, vitals, investigations, plan, and red flags.',
    'NOTE_BODY_START',
    body,
    'NOTE_BODY_END',
  ].join('\n')
}

export const EXTRACT_MAX_OUTPUT_TOKENS = 4096
