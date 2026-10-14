import { z } from 'zod'
import { AUDIENCES } from '../facts/schema.js'

export const AuditNoteOutput = z
  .object({
    status: z.enum(['ok', 'empty', 'abstained', 'unavailable', 'failed']),
    findings: z.array(z.object({ id: z.string(), summary: z.string() }).passthrough()).optional(),
    decisions: z.array(z.object({ finding_id: z.string() }).passthrough()).optional(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  })
  .passthrough()

export const AuditNoteInput = z
  .object({
    source: z.string().min(1),
    source_uid: z.string().min(1),
    source_timestamp: z.string().datetime(),
    body: z.string().min(1).max(200_000),
    structured_fields: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()

export const EvidenceRetrieveInput = z
  .object({
    question: z.string().min(1).max(4_000),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .strict()

export const EvidenceRetrieveOutput = z
  .object({
    status: z.enum(['ok', 'empty', 'unavailable', 'failed']),
    evidence_status: z.enum(['ok', 'empty', 'unavailable']).optional(),
    evidence_rerank: z.enum(['off', 'ok', 'unavailable']).optional(),
    evidence_hits: z
      .array(
        z
          .object({
            chunk_id: z.string(),
            source_id: z.string(),
            source_name: z.string(),
            section_path: z.string(),
            licence_class: z.enum(['open', 'licensed_internal', 'india_regulatory', 'commercial_db']),
            quote: z.string(),
            url: z.string().nullable(),
          })
          .strict(),
      )
      .optional(),
    reason: z.string().optional(),
    error: z.object({ type: z.string(), message: z.string() }).optional(),
  })
  .passthrough()

export const AskInput = z.object({ question: z.string().min(1), context_note_id: z.string().min(1).optional() }).strict()
export const AskOutput = z.object({ answer: z.string(), citations: z.array(z.object({ source_id: z.string(), quote: z.string() }).strict()) }).strict()

export const MedReconcileInput = z
  .object({
    lists: z.array(z.object({ source: z.string().min(1), drugs: z.array(z.string()) }).strict()).min(1),
  })
  .strict()
export const MedReconcileOutput = z
  .object({
    conflicts: z.array(z.object({ drug: z.string(), sources: z.array(z.string()) }).strict()),
  })
  .strict()

export const DdxInput = z.object({ presentation: z.string().min(1) }).strict()
export const DdxOutput = z.object({ differentials: z.array(z.object({ name: z.string(), rank: z.number() }).strict()) }).strict()

export const AppropriatenessInput = z.object({ note_version_id: z.string().min(1) }).strict()
export const AppropriatenessOutput = z
  .object({ items: z.array(z.object({ rule_id: z.string(), appropriate: z.boolean() }).strict()) })
  .strict()

export const TriageDecideInput = z.object({ finding_id: z.string().min(1), note_version_id: z.string().min(1) }).strict()
export const TriageDecideOutput = z.object({ action: z.enum(['route', 'hold', 'drop_informational']) }).strict()

export const RequestEnvelope = z
  .object({
    capability: z.string().min(1),
    caller: z.object({ principal: z.string().min(1), purpose: z.string().min(1) }).strict(),
    patient_ref: z.string().min(1).optional(),
    encounter_ref: z.string().min(1).optional(),
    audience: z.enum(AUDIENCES),
    idempotency_key: z.string().min(8).max(200),
    mode: z.enum(['sync', 'async']),
    callback_url: z.string().url().optional(),
    input: z.unknown(),
  })
  .strict()

export type RequestEnvelope = z.infer<typeof RequestEnvelope>

export function httpStatusFor(body: { status?: string; error?: { type?: string } }, pending = false): number {
  if (pending) return 202
  if (body.status === 'ok' || body.status === 'empty' || body.status === 'abstained') return 200
  if (body.status === 'unavailable') return 503
  if (body.error?.type === 'budget_exhausted') return 429
  if (body.error?.type === 'truncated') return 502
  if (
    body.error?.type === 'extraction_failed' ||
    body.error?.type === 'invalid_envelope' ||
    body.error?.type === 'invalid_input' ||
    body.error?.type === 'invalid_json'
  ) {
    return 422
  }
  return 500
}
