import { createHash } from 'node:crypto'
import { z } from 'zod'
import { AuditNoteInput } from '../../api/schema.js'
import type { Outbox } from './outbox.js'
import type { EmrAdapter } from './types.js'

/**
 * Derived from audit.note's existing input (src/api/schema.ts), quoted:
 *   AuditNoteInput = z.object({
 *     source: z.string().min(1), source_uid: z.string().min(1),
 *     source_timestamp: z.string().datetime(), body: z.string().min(1).max(200_000),
 *     structured_fields: z.record(z.string(), z.unknown()).optional(),
 *   }).strict()
 * INFERRED: Pulse's real event shape is TBD; this wraps AuditNoteInput with an Rx/note kind.
 */
export const PulseEvent = z.object({ kind: z.enum(['rx', 'note']), event: AuditNoteInput }).strict()
export type PulseEvent = z.infer<typeof PulseEvent>

export const PULSE_INBOUND_KINDS = ['rx', 'note']

/** Inbound events run audit.note. Outbound is store_only: Pulse receives nothing. */
export function createPulseAdapter(deps: { outbox: Outbox }): EmrAdapter {
  return {
    id: 'pulse',
    inbound: {
      kinds: PULSE_INBOUND_KINDS,
      toAgentInput(kind, event) {
        const parsed = PulseEvent.parse({ kind, event })
        const { source, source_uid } = parsed.event
        // the key is a hash: source_uid may be derived from the record
        const idempotencyKey = `pulse:${createHash('sha256').update(`${source}|${source_uid}`).digest('hex').slice(0, 32)}`
        return { agentId: 'audit.note', input: parsed.event, idempotencyKey }
      },
    },
    outbound: {
      mode: 'store_only',
      async deliver(result) {
        const { id } = await deps.outbox.record('pulse', result)
        return { status: 'stored', outboxId: id }
      },
    },
  }
}
