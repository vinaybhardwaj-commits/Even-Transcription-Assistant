/** Reference to a stored agent run. Ids only: never result text. */
export interface AgentResultRef {
  agentId: string
  runId: string
}

export type DeliveryOutcome =
  | { status: 'stored'; outboxId: string }
  | { status: 'unavailable' }
  | { status: 'failed'; errorType: string }

export type EmrAdapterId = 'eta' | 'pulse' | 'ipemr'

export interface InboundAgentCall {
  agentId: string
  input: unknown
  idempotencyKey: string
}

export interface EmrAdapter {
  id: EmrAdapterId
  inbound?: { kinds: string[]; toAgentInput(kind: string, event: unknown): InboundAgentCall }
  outbound: { mode: 'store_only' | 'live'; deliver(result: AgentResultRef): Promise<DeliveryOutcome> }
}
