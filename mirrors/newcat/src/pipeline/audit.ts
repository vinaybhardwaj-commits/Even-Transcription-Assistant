import { applyDecisions, type AppliedDecision, type AppliedFinding } from '../decide/apply.js'
import { classifyAveraged } from '../decide/client.js'
import { questionsFor, QUESTION_SET_SHA } from '../decide/questions.js'
import { activeThresholds } from '../decide/thresholds.js'
import type { JevTransport } from '../decide/transport.js'
import type { Sql } from '../db/sql.js'
import type { Embedder } from '../evidence/embed.js'
import { retrieveEvidence } from '../evidence/retrieve.js'
import type { Audience } from '../facts/schema.js'
import { extractFacts } from '../extract/extract.js'
import type { ClinicalState } from '../facts/schema.js'
import { resolveIdentity } from '../identity/resolve.js'
import { getNote, ingestNote } from '../ingest/ingest.js'
import { enqueueWork, finishWork, getWork, leaseById, retryOrFail, type WorkItem } from '../ingest/queue.js'
import type { ModelClient } from '../llm/types.js'
import { newId } from '../ids.js'
import { DEFAULT_PACK, scoreFindings, type FindingDraft } from '../rules/pack.js'
import { CAPABILITY_VERSION, ENGINE_VERSION, EXTRACTOR_VERSION, RULE_PACK_VERSION } from '../version.js'
import {
  insertAuditRun,
  loadDecisions,
  loadExtraction,
  replaceQueue,
  saveDecisions,
  saveExtraction,
  saveFindings,
  servedModels,
} from './store.js'
import type { InternalAudit, InternalDecision, InternalFinding, QueueItem } from './types.js'

const DECIDE_VERSION = `${RULE_PACK_VERSION}:${QUESTION_SET_SHA}`

export interface AuditDeps {
  sql: Sql
  models: ModelClient
  jev: JevTransport
  embedder?: Embedder | undefined
  rerank?: 'off' | 'haiku' | undefined
}

export interface AuditRequest {
  traceId: string
  purpose: string
  patientRef?: string | undefined
  encounterRef?: string | undefined
  source: string
  sourceUid: string
  sourceTimestamp: string
  body: string
  structuredFields?: unknown
  backlogDays: number
  owner?: string | undefined
  audience?: Audience | undefined
}

export async function runAudit(deps: AuditDeps, request: AuditRequest): Promise<InternalAudit> {
  const owner = request.owner ?? `audit:${request.traceId}`
  const identity = resolveIdentity({ patient_ref: request.patientRef, encounter_ref: request.encounterRef })
  const ingested = await ingestNote(
    deps.sql,
    {
      source: request.source,
      source_uid: request.sourceUid,
      source_timestamp: request.sourceTimestamp,
      body: request.body,
      structured_fields: request.structuredFields ?? {},
    },
    { stage: 'extract', stageVersion: EXTRACTOR_VERSION },
  )
  if (ingested.status !== 'ok') {
    const error = 'error' in ingested ? ingested.error : { type: ingested.status, message: 'Ingest did not return a note version.' }
    return failed(request, error.type, error.message, [])
  }

  const note = ingested.data.note
  const factsResult = await ensureFacts(deps, note.id, note.body, request.traceId, owner)
  if (factsResult.status !== 'ok') {
    const audit = failed(request, factsResult.error.type, factsResult.error.message, await servedModels(deps.sql, note.id, request.traceId))
    audit.status = factsResult.envelope
    await persistRun(deps.sql, request, note.id, identity, audit.status)
    return audit
  }

  const findings = scoreFindings(factsResult.facts, DEFAULT_PACK)
  await saveFindings(deps.sql, note.id, DEFAULT_PACK.version, findings)
  const thresholds = activeThresholds(request.backlogDays)
  const decided = await ensureDecisions(deps, note.id, factsResult.facts, findings, request.traceId, owner, thresholds)
  if (decided.status !== 'ok') {
    const audit = failed(request, decided.error.type, decided.error.message, await servedModels(deps.sql, note.id, request.traceId))
    audit.status = decided.envelope
    await persistRun(deps.sql, request, note.id, identity, audit.status)
    return audit
  }

  const audit = await attachEvidence(deps, request, assemble(request, decided.applied, await servedModels(deps.sql, note.id, request.traceId)))
  const decisionIds = decided.decisionIds
  await replaceQueue(
    deps.sql,
    note.id,
    decided.applied
      .filter((item) => item.queue)
      .map((item) => ({
        decisionId: decisionIds.get(`${item.finding.id}:validity`) ?? decisionIds.get(`${item.finding.id}:route`) ?? newId(),
        findingId: item.finding.id,
        ruleId: item.finding.rule_id,
        reason: item.queue_reason ?? 'abstained',
      })),
  )
  await persistRun(deps.sql, request, note.id, identity, audit.status)
  return audit
}

export async function rescoreStoredNote(sql: Sql, noteId: string, pack = DEFAULT_PACK): Promise<FindingDraft[]> {
  const extraction = await loadExtraction(sql, noteId)
  if (!extraction || extraction.status !== 'ok' || !extraction.facts) throw new Error('no stored facts')
  const findings = scoreFindings(extraction.facts, pack)
  await saveFindings(sql, noteId, pack.version, findings)
  return findings
}

async function ensureFacts(
  deps: AuditDeps,
  noteId: string,
  body: string,
  traceId: string,
  owner: string,
): Promise<
  | { status: 'ok'; facts: ClinicalState }
  | { status: 'error'; envelope: 'failed' | 'unavailable'; error: { type: string; message: string } }
> {
  const existing = await loadExtraction(deps.sql, noteId)
  if (existing?.status === 'ok' && existing.facts) return { status: 'ok', facts: existing.facts }
  if (existing?.status === 'extraction_failed') {
    return {
      status: 'error',
      envelope: 'failed',
      error: { type: 'extraction_failed', message: 'Fact validation failed and was not retried.' },
    }
  }
  const claim = await claimWork(deps.sql, noteId, 'extract', EXTRACTOR_VERSION, owner)
  if (claim.kind === 'busy') {
    return { status: 'error', envelope: 'unavailable', error: { type: 'lease_held', message: 'Extraction is already leased.' } }
  }
  const work = claim.work
  if (work.status === 'extraction_failed' || work.status === 'failed') {
    return {
      status: 'error',
      envelope: 'failed',
      error: { type: work.status === 'failed' ? 'attempt_cap' : 'extraction_failed', message: 'Extraction is terminal for this note version.' },
    }
  }
  if (work.status !== 'leased') {
    return { status: 'error', envelope: 'unavailable', error: { type: 'lease_held', message: 'Extraction could not be leased.' } }
  }
  const extracted = await extractFacts(deps.models, body, traceId)
  if (extracted.status === 'ok') {
    await saveExtraction(deps.sql, noteId, 'ok', extracted.state, null, extracted.callIds)
    await finishWork(deps.sql, work.id, 'ok', null)
    return { status: 'ok', facts: extracted.state }
  }
  if (extracted.status === 'extraction_failed') {
    await saveExtraction(deps.sql, noteId, 'extraction_failed', null, extracted.errors, extracted.callIds, extracted.modelInput)
    await finishWork(deps.sql, work.id, 'extraction_failed', 'validation failed')
    return {
      status: 'error',
      envelope: 'failed',
      error: { type: 'extraction_failed', message: 'Fact validation failed after Haiku and one Sonnet re-run.' },
    }
  }
  if (extracted.status === 'refused') {
    await finishWork(deps.sql, work.id, 'failed', extracted.error.type)
    return { status: 'error', envelope: 'failed', error: extracted.error }
  }
  const next = await retryOrFail(deps.sql, work, extracted.error.type)
  return {
    status: 'error',
    envelope: extracted.status === 'unavailable' ? 'unavailable' : 'failed',
    error: {
      type: next === 'failed' ? 'attempt_cap' : extracted.error.type,
      message: extracted.error.message,
    },
  }
}

async function ensureDecisions(
  deps: AuditDeps,
  noteId: string,
  facts: ClinicalState,
  findings: FindingDraft[],
  traceId: string,
  owner: string,
  thresholds: ReturnType<typeof activeThresholds>,
): Promise<
  | { status: 'ok'; applied: AppliedFinding[]; decisionIds: Map<string, string> }
  | { status: 'error'; envelope: 'failed' | 'unavailable'; error: { type: string; message: string } }
> {
  if (findings.length === 0) return { status: 'ok', applied: [], decisionIds: new Map() }
  const stored = await loadDecisions(deps.sql, noteId, QUESTION_SET_SHA, thresholds.policyId)
  if (covers(findings, stored)) {
    return { status: 'ok', applied: rebuild(findings, stored), decisionIds: new Map() }
  }
  const claim = await claimWork(deps.sql, noteId, 'decide', DECIDE_VERSION, owner)
  if (claim.kind === 'busy') {
    return { status: 'error', envelope: 'unavailable', error: { type: 'lease_held', message: 'Decision work is already leased.' } }
  }
  const work = claim.work
  if (work.status === 'failed') {
    return { status: 'error', envelope: 'failed', error: { type: 'attempt_cap', message: 'Decision attempts are exhausted.' } }
  }
  if (work.status !== 'leased' && work.status !== 'ok') {
    return { status: 'error', envelope: 'unavailable', error: { type: 'lease_held', message: 'Decision work could not be leased.' } }
  }
  const questions = questionsFor(findings)
  const classified = await classifyAveraged(deps.jev, {
    traceId,
    state: decisionState(facts, findings),
    questions,
  })
  if (classified.status !== 'ok') {
    const message = 'error' in classified ? classified.error.message : 'The decision service did not complete.'
    const type = 'error' in classified ? classified.error.type : classified.status
    if (work.status === 'leased') await retryOrFail(deps.sql, work, type)
    const envelope = classified.status === 'unavailable' || classified.status === 'truncated' ? 'unavailable' : 'failed'
    return { status: 'error', envelope, error: { type, message } }
  }
  let applied: AppliedFinding[]
  try {
    applied = applyDecisions(findings, classified.data.answers, thresholds)
  } catch {
    if (work.status === 'leased') await retryOrFail(deps.sql, work, 'incomplete_decision')
    return { status: 'error', envelope: 'failed', error: { type: 'incomplete_decision', message: 'Decisions were incomplete.' } }
  }
  const flat = applied.flatMap((item) => item.decisions)
  const decisionIds = await saveDecisions(deps.sql, noteId, QUESTION_SET_SHA, thresholds.policyId, flat)
  if (work.status === 'leased') await finishWork(deps.sql, work.id, 'ok', null)
  return { status: 'ok', applied, decisionIds }
}

export function decisionState(facts: ClinicalState, findings: FindingDraft[]) {
  return {
    patient: {
      age_years: facts.patient.age_years?.value ?? null,
      sex: facts.patient.sex.value,
      pregnancy: facts.patient.pregnancy.value,
      renal_impairment: facts.patient.renal_impairment.value,
      hepatic_impairment: facts.patient.hepatic_impairment.value,
      allergies: facts.patient.allergies.map((item) => item.value),
      comorbidities: facts.patient.comorbidities.map((item) => item.value),
    },
    medications: facts.medications.map((item) => item.value),
    diagnoses: facts.diagnoses.map((item) => item.value),
    plan: facts.plan.map((item) => item.value),
    red_flags: facts.red_flags.map((item) => item.value),
    candidates: findings.map((finding) => ({
      finding_id: finding.id,
      rule_id: finding.rule_id,
      claim: finding.summary,
      severity_assigned_by_rule: finding.severity,
      safety_class: finding.safety_class,
      evidence_quotes: finding.evidence.map((quote) => quote.quote),
    })),
  }
}

function covers(findings: FindingDraft[], decisions: AppliedDecision[]): boolean {
  return findings.every((finding) => {
    const rows = decisions.filter((decision) => decision.finding_id === finding.id)
    const validity = rows.find((decision) => decision.question_id === 'validity')
    if (!validity) return false
    if (finding.severity === 'critical') {
      if (validity.action === 'valid' && validity.outcome === 'resolve') {
        return rows.some((decision) => decision.question_id === 'route' && decision.action === 'route' && decision.outcome === 'resolve')
      }
      return true
    }
    return rows.some((decision) => decision.question_id === 'route')
  })
}

function rebuild(findings: FindingDraft[], decisions: AppliedDecision[]): AppliedFinding[] {
  return findings.map((finding) => {
    const rows = decisions.filter((decision) => decision.finding_id === finding.id)
    const validity = rows.find((decision) => decision.question_id === 'validity')
    const route = rows.find((decision) => decision.question_id === 'route')
    const action = validity?.action === 'abstain' || validity?.action === 'suppressed_invalid' ? validity.action : (route?.action ?? 'abstain')
    const doctorVisible = validity?.action === 'valid' && route?.action === 'route' && route.outcome === 'resolve'
    const queue = action === 'abstain'
    return {
      finding,
      decisions: rows,
      doctor_visible: doctorVisible,
      action,
      queue,
      queue_reason: queue ? 'stored abstention' : null,
    }
  })
}

async function claimWork(
  sql: Sql,
  noteId: string,
  stage: string,
  stageVersion: string,
  owner: string,
): Promise<{ kind: 'ready'; work: WorkItem } | { kind: 'busy' }> {
  let work = await getWork(sql, noteId, stage, stageVersion)
  if (!work) work = await enqueueWork(sql, noteId, stage, stageVersion)
  if (work.status === 'leased' && work.lease_owner === owner) return { kind: 'ready', work }
  const expired = work.lease_until !== null && new Date(work.lease_until).getTime() < Date.now()
  if (work.status === 'queued' || (work.status === 'leased' && expired)) {
    const leased = await leaseById(sql, work.id, owner)
    if (!leased) return { kind: 'busy' }
    return { kind: 'ready', work: leased }
  }
  if (work.status === 'leased') return { kind: 'busy' }
  return { kind: 'ready', work }
}

function assemble(request: AuditRequest, applied: AppliedFinding[], models: string[]): InternalAudit {
  const findings: InternalFinding[] = applied.map((item) => ({
    ...item.finding,
    doctor_visible: item.doctor_visible,
    action: item.action,
  }))
  const decisions: InternalDecision[] = applied.flatMap((item) =>
    item.decisions.map((decision) => ({ ...decision, id: `${item.finding.id}:${decision.question_id}`, policy_id: activeThresholds(request.backlogDays).policyId })),
  )
  const queue: QueueItem[] = applied
    .filter((item) => item.queue)
    .map((item) => ({ finding_id: item.finding.id, rule_id: item.finding.rule_id, reason: item.queue_reason ?? 'abstained' }))
  let status: InternalAudit['status'] = 'ok'
  let reason: string | undefined
  if (applied.length === 0) {
    status = 'empty'
    reason = 'no_candidate_findings'
  } else if (queue.length > 0 && !applied.some((item) => item.doctor_visible)) {
    status = 'abstained'
    reason = 'below the abstention threshold'
  }
  return {
    trace_id: request.traceId,
    capability: 'audit.note',
    capability_version: CAPABILITY_VERSION,
    status,
    ...(reason ? { reason } : {}),
    findings,
    decisions,
    queue,
    versions: {
      engine: ENGINE_VERSION,
      rules: RULE_PACK_VERSION,
      extractor: EXTRACTOR_VERSION,
      models,
      question_set_sha: QUESTION_SET_SHA,
    },
  }
}

async function attachEvidence(deps: AuditDeps, request: AuditRequest, audit: InternalAudit): Promise<InternalAudit> {
  if (!deps.embedder) return audit
  if (audit.status === 'failed' || audit.status === 'unavailable') return audit
  if (audit.findings.length === 0) return { ...audit, evidence_status: 'empty', evidence_rerank: 'off' }
  const audience = request.audience ?? 'internal'
  let anyHit = false
  let anyUnavailable = false
  let rerank: 'off' | 'ok' | 'unavailable' = 'off'
  const findings: InternalFinding[] = []
  try {
    for (const finding of audit.findings) {
      const result = await retrieveEvidence(deps.sql, deps.embedder, {
        question: finding.summary,
        audience,
        limit: 4,
        traceId: request.traceId,
        rerank: deps.rerank,
        models: deps.models,
      })
      if (result.rerank === 'unavailable') rerank = 'unavailable'
      else if (result.rerank === 'ok' && rerank !== 'unavailable') rerank = 'ok'
      if (result.status === 'unavailable') {
        anyUnavailable = true
        findings.push(finding)
        continue
      }
      if (result.status === 'empty') {
        findings.push(finding)
        continue
      }
      anyHit = true
      findings.push({ ...finding, evidence_refs: result.data })
    }
  } catch {
    return { ...audit, evidence_status: 'unavailable', evidence_rerank: 'off' }
  }
  const evidence_status = anyUnavailable ? 'unavailable' : anyHit ? 'ok' : 'empty'
  return { ...audit, findings, evidence_status, evidence_rerank: rerank }
}

function failed(request: AuditRequest, type: string, message: string, models: string[]): InternalAudit {
  return {
    trace_id: request.traceId,
    capability: 'audit.note',
    capability_version: CAPABILITY_VERSION,
    status: 'failed',
    error: { type, message },
    findings: [],
    decisions: [],
    queue: [],
    versions: {
      engine: ENGINE_VERSION,
      rules: RULE_PACK_VERSION,
      extractor: EXTRACTOR_VERSION,
      models,
      question_set_sha: QUESTION_SET_SHA,
    },
  }
}

async function persistRun(
  sql: Sql,
  request: AuditRequest,
  noteId: string,
  identity: ReturnType<typeof resolveIdentity>,
  status: string,
): Promise<void> {
  await insertAuditRun(sql, {
    traceId: request.traceId,
    noteId,
    status,
    identityStatus: identity.status,
    patientRef: identity.status === 'ok' ? identity.patient_ref : null,
    encounterRef: identity.status === 'ok' ? identity.encounter_ref : null,
    purpose: request.purpose,
    questionSha: QUESTION_SET_SHA,
  })
}

export async function runLeasedWork(deps: AuditDeps, work: WorkItem, backlogDays: number): Promise<InternalAudit> {
  const note = await getNote(deps.sql, work.note_version_id)
  if (!note) {
    return failed(
      {
        traceId: newId(),
        purpose: 'work_tick',
        source: 'unknown',
        sourceUid: 'unknown',
        sourceTimestamp: new Date().toISOString(),
        body: 'missing',
        backlogDays,
      },
      'note_missing',
      'The leased work item has no note version.',
      [],
    )
  }
  return runAudit(deps, {
    traceId: newId(),
    purpose: 'work_tick',
    source: note.source,
    sourceUid: note.source_uid,
    sourceTimestamp: note.source_timestamp,
    body: note.body,
    structuredFields: note.structured_fields,
    backlogDays,
    owner: work.lease_owner ?? 'tick',
    audience: 'internal',
  })
}
