import type { Outbox } from './outbox.js'
import type { EmrAdapter, InboundAgentCall } from './types.js'

export const ETA_INBOUND_KINDS = ['consult.closed']

/** The agent input shape is consult-audit-owned: the agent registration supplies the mapper. */
export type ConsultClosedMapper = (event: unknown) => InboundAgentCall

/** Outbound is store_only: a row in the outbox. The HMAC webhook path stays in http.ts. */
export function createEtaAdapter(deps: { outbox: Outbox; mapConsultClosed: ConsultClosedMapper }): EmrAdapter {
  return {
    id: 'eta',
    inbound: {
      kinds: ETA_INBOUND_KINDS,
      toAgentInput(kind, event) {
        if (kind !== 'consult.closed') throw new Error('unsupported_kind')
        return deps.mapConsultClosed(event)
      },
    },
    outbound: {
      mode: 'store_only',
      async deliver(result) {
        const { id } = await deps.outbox.record('eta', result)
        return { status: 'stored', outboxId: id }
      },
    },
  }
}
