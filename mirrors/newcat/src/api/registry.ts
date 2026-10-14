import type { z } from 'zod'
import type { GovernanceSerializer } from '../audience/serialize.js'
import type { Audience } from '../facts/schema.js'
import type { Env } from '../config.js'
import type { Sql } from '../db/sql.js'
import type { JevTransport } from '../decide/transport.js'
import type { Embedder } from '../evidence/embed.js'
import { retrieveEvidence, type RetrievalOutcome } from '../evidence/retrieve.js'
import type { ModelClient } from '../llm/types.js'
import { AGENTS } from '../agents/index.js'
import { runAudit } from '../pipeline/audit.js'
import { toCapability } from '../platform/agent/define.js'
import type { InternalAudit } from '../pipeline/types.js'
import { CAPABILITY_VERSION, ENGINE_VERSION, EXTRACTOR_VERSION, RULE_PACK_VERSION } from '../version.js'
import { QUESTION_SET_SHA } from '../decide/questions.js'
import {
  AppropriatenessInput,
  AppropriatenessOutput,
  AskInput,
  AskOutput,
  AuditNoteInput,
  AuditNoteOutput,
  DdxInput,
  DdxOutput,
  EvidenceRetrieveInput,
  EvidenceRetrieveOutput,
  MedReconcileInput,
  MedReconcileOutput,
  TriageDecideInput,
  TriageDecideOutput,
} from './schema.js'

export interface CapabilityContext {
  sql: Sql
  models: ModelClient
  jev: JevTransport
  embedder: Embedder
  env: Env
  traceId: string
  /** The request envelope's idempotency_key. Absent on async jobs and internal callers. */
  idempotencyKey?: string | undefined
  purpose: string
  audience: Audience
  patientRef?: string | undefined
  encounterRef?: string | undefined
}

export interface Capability {
  id: string
  version: string
  summary: string
  modes: Array<'sync' | 'async'>
  requiredScopes: string[]
  audiences: Audience[]
  input: z.ZodTypeAny
  output: z.ZodTypeAny
  run: (ctx: CapabilityContext, input: unknown) => Promise<InternalAudit>
  /** Agent-owned audience bodies. Only governance today. */
  serializers?: { governance?: GovernanceSerializer | undefined } | undefined
}

const ALL: Audience[] = ['internal', 'operator', 'doctor']

function unavailable(capability: string, traceId: string): InternalAudit {
  return {
    trace_id: traceId,
    capability,
    capability_version: CAPABILITY_VERSION,
    status: 'unavailable',
    error: { type: 'not_implemented', message: `${capability} is registered but not implemented in phase 0.` },
    findings: [],
    decisions: [],
    queue: [],
    versions: {
      engine: ENGINE_VERSION,
      rules: RULE_PACK_VERSION,
      extractor: EXTRACTOR_VERSION,
      models: [],
      question_set_sha: QUESTION_SET_SHA,
    },
  }
}

function stub(id: string, summary: string, input: z.ZodTypeAny, output: z.ZodTypeAny): Capability {
  return {
    id,
    version: CAPABILITY_VERSION,
    summary,
    modes: ['sync', 'async'],
    requiredScopes: [id],
    audiences: ALL,
    input,
    output,
    async run(ctx) {
      return unavailable(id, ctx.traceId)
    },
  }
}

const auditNote: Capability = {
  id: 'audit.note',
  version: CAPABILITY_VERSION,
  summary: 'OPD note audit: ingest, extract facts, apply rules, decide, and return an audience-safe envelope.',
  modes: ['sync', 'async'],
  requiredScopes: ['audit.note'],
  audiences: ALL,
  input: AuditNoteInput,
  output: AuditNoteOutput,
  async run(ctx, input) {
    const note = AuditNoteInput.parse(input)
    return runAudit(
      { sql: ctx.sql, models: ctx.models, jev: ctx.jev, embedder: ctx.embedder, rerank: ctx.env.BEDROCK_RERANK },
      {
        traceId: ctx.traceId,
        purpose: ctx.purpose,
        patientRef: ctx.patientRef,
        encounterRef: ctx.encounterRef,
        audience: ctx.audience,
        source: note.source,
        sourceUid: note.source_uid,
        sourceTimestamp: note.source_timestamp,
        body: note.body,
        structuredFields: note.structured_fields ?? {},
        backlogDays: ctx.env.ABSTENTION_BACKLOG_DAYS,
      },
    )
  },
}

const evidenceRetrieve: Capability = {
  id: 'evidence.retrieve',
  version: CAPABILITY_VERSION,
  summary: 'Hybrid search of the evidence index. Internal audience only. Licensed passages stay on that audience.',
  modes: ['sync', 'async'],
  requiredScopes: ['evidence.retrieve'],
  audiences: ['internal'],
  input: EvidenceRetrieveInput,
  output: EvidenceRetrieveOutput,
  async run(ctx, input) {
    const query = EvidenceRetrieveInput.parse(input)
    const result = await retrieveEvidence(ctx.sql, ctx.embedder, {
      question: query.question,
      audience: 'internal',
      limit: query.limit,
      traceId: ctx.traceId,
      rerank: ctx.env.BEDROCK_RERANK,
      models: ctx.models,
    })
    return retrievalAudit(ctx.traceId, result)
  },
}

function retrievalAudit(traceId: string, result: RetrievalOutcome): InternalAudit {
  const versions = {
    engine: ENGINE_VERSION,
    rules: RULE_PACK_VERSION,
    extractor: EXTRACTOR_VERSION,
    models: [] as string[],
    question_set_sha: QUESTION_SET_SHA,
  }
  const shell = {
    trace_id: traceId,
    capability: 'evidence.retrieve',
    capability_version: CAPABILITY_VERSION,
    findings: [],
    decisions: [],
    queue: [],
    versions,
  }
  if (result.status === 'unavailable') {
    return { ...shell, status: 'unavailable', error: result.error }
  }
  if (result.status === 'empty') {
    return {
      ...shell,
      status: 'empty',
      reason: result.reason,
      evidence_status: 'empty',
      evidence_rerank: result.rerank,
      evidence_hits: [],
    }
  }
  return {
    ...shell,
    status: 'ok',
    evidence_status: 'ok',
    evidence_rerank: result.rerank,
    evidence_hits: result.data,
  }
}

const CORE_CAPABILITIES: Capability[] = [
  auditNote,
  evidenceRetrieve,
  stub('ask', 'Question answering over cited evidence. Not implemented in phase 0.', AskInput, AskOutput),
  stub('med_reconcile', 'Medication list reconciliation. Not implemented in phase 0.', MedReconcileInput, MedReconcileOutput),
  stub('ddx', 'Differential diagnosis. Not implemented in phase 0.', DdxInput, DdxOutput),
  stub('appropriateness', 'RightCare appropriateness. Not implemented in phase 0.', AppropriatenessInput, AppropriatenessOutput),
  stub('triage.decide', 'Triage verb for one finding. Not implemented in phase 0.', TriageDecideInput, TriageDecideOutput),
]

export const CAPABILITIES: Capability[] = [...CORE_CAPABILITIES, ...AGENTS.map((agent) => toCapability(agent))]

export function getCapability(id: string): Capability | undefined {
  return CAPABILITIES.find((capability) => capability.id === id)
}
