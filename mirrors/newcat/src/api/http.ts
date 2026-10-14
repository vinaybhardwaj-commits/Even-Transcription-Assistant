import { z } from 'zod'
import { asIso, asJson, type Sql } from '../db/sql.js'
import { jevReadiness, type Env } from '../config.js'
import { sha256, stableStringify } from '../hash.js'
import { newId } from '../ids.js'
import type { JevTransport } from '../decide/transport.js'
import type { Embedder } from '../evidence/embed.js'
import type { ModelClient } from '../llm/types.js'
import { IMPORT_SAMPLE_MAX_LINES, importCorpusText, nonEmptyLineCount } from '../evidence/import.js'
import { checkBedrock, type BedrockCheckReport, type Probe } from '../llm/self-check.js'
import { bedrockHealth } from './health-bedrock.js'
import type { BedrockSender } from '../llm/bedrock.js'
import { probeAws, type AwsProbeReport } from '../llm/aws-probe.js'
import { costForTrace } from '../llm/ledger.js'
import { leaseNext } from '../ingest/queue.js'
import { claimNextJob } from '../jobs/queue.js'
import { log } from '../log.js'
import { runLeasedWork } from '../pipeline/audit.js'
import type { Audience } from '../facts/schema.js'
import { CAPABILITY_VERSION } from '../version.js'
import { authenticateConsumer, authenticateCron, audienceAllowed } from '../auth/consumers.js'
import { signWebhook } from '../auth/crypto.js'
import { EmitRefusal, pendingBody, PendingBody, serialize } from '../audience/serialize.js'
import { AGENTS } from '../agents/index.js'
import type { AnyAgentDefinition } from '../platform/agent/types.js'
import type { CdmssQuery } from '../platform/cdmss/client.js'
import { CAPABILITIES, type Capability, type CapabilityContext } from './registry.js'
import { httpStatusFor, RequestEnvelope } from './schema.js'

const MAX_BODY = 1_000_000
const MAX_IMPORT_SAMPLE_BYTES = 8_000_000

const ImportSampleBody = z.object({ jsonl: z.string() }).strict()

function firstProbeError(...probes: Probe[]): string | null {
  for (const probe of probes) {
    if (!probe.ok) return probe.error_type
  }
  return null
}

export interface AppDeps {
  sql: Sql
  env: Env
  models: ModelClient
  jev: JevTransport
  embedder: Embedder
  /** Query-only CDMSS handle from boot; undefined means CDMSS reads are unavailable. */
  cdmss?: CdmssQuery | undefined
  /** Test seam: replaces the registry list for this app (invoke, jobs, /v1/capabilities). Production leaves it unset. */
  capabilities?: readonly Capability[] | undefined
  /** Test seam: agent definitions consulted for `storedInput` when a job starts. Production leaves it unset (AGENTS). */
  agents?: readonly AnyAgentDefinition[] | undefined
  fetchImpl?: typeof fetch
  now?: () => number
  checkBedrock?: () => Promise<BedrockCheckReport>
  probeAws?: () => Promise<AwsProbeReport>
  /** Test seam for GET /v1/health/bedrock. */
  healthSender?: BedrockSender
}

export interface AppOptions {
  /** When false, async jobs stay queued for the worker. Tests and the local server drain in process. */
  background?: boolean
}

interface Task {
  run: () => Promise<void>
}

export function createApp(deps: AppDeps, options: AppOptions = {}): { handle(request: Request): Promise<Response>; drain(): Promise<void> } {
  const background = options.background !== false
  const tasks: Task[] = []
  let draining = false
  async function drain(): Promise<void> {
    if (draining) return
    draining = true
    try {
      while (tasks.length > 0) {
        const task = tasks.shift()
        if (task) await task.run()
      }
    } finally {
      draining = false
      if (tasks.length > 0) await drain()
    }
  }
  return {
    drain,
    handle(request) {
      return handleRequest(deps, request, (run) => {
        if (!background) return
        tasks.push({ run })
      })
    },
  }
}

async function handleRequest(deps: AppDeps, request: Request, schedule: (run: () => Promise<void>) => void): Promise<Response> {
  const url = new URL(request.url)
  const traceId = newId()
  if (url.pathname === '/health' && request.method === 'GET') {
    return json(200, { status: 'ok', jev: jevReadiness(deps.env) })
  }
  if (url.pathname === '/v1/health/bedrock') {
    if (request.method !== 'GET') return errorResult(405, traceId, 'health.bedrock', 'method_not_allowed', 'GET is required.')
    const result = await bedrockHealth(deps.env, request.headers.get('authorization'), deps.sql, traceId, deps.healthSender)
    return json(result.status, { trace_id: traceId, ...result.body })
  }
  if (url.pathname === '/v1/internal/work/tick') {
    if (request.method !== 'POST') return errorResult(405, traceId, 'work.tick', 'method_not_allowed', 'POST is required.')
    return tick(deps, request, traceId)
  }
  const consumer = await authenticateConsumer(deps.sql, request.headers.get('authorization'))
  if (!consumer) return errorResult(401, traceId, 'unknown', 'unauthorized', 'A valid API key is required.')

  if (url.pathname === '/v1/internal/bedrock/check') {
    if (request.method !== 'POST') return errorResult(405, traceId, 'bedrock.check', 'method_not_allowed', 'POST is required.')
    if (!consumer.scopes.includes('admin')) {
      return errorResult(403, traceId, 'bedrock.check', 'forbidden', 'The API key does not include the admin scope.')
    }
    const report = await (deps.checkBedrock ?? (() => checkBedrock(deps.env, undefined, deps.sql)))()
    log('info', 'bedrock.check', {
      trace_id: traceId,
      status: report.status,
      auth_mode: report.auth_mode,
      credential_source: report.credential_source,
      region: report.region,
      model_id: report.model_id,
      error_type: firstProbeError(report.id_token, report.assume_role, report.caller_identity, report.converse),
    })
    return json(report.status === 'ok' ? 200 : 503, { trace_id: traceId, ...report })
  }

  if (url.pathname === '/v1/internal/aws/probe') {
    if (request.method !== 'GET') return errorResult(405, traceId, 'aws.probe', 'method_not_allowed', 'GET is required.')
    if (!consumer.scopes.includes('admin')) {
      return errorResult(403, traceId, 'aws.probe', 'forbidden', 'The API key does not include the admin scope.')
    }
    const report = await (deps.probeAws ?? (() => probeAws(deps.env)))()
    log('info', 'aws.probe', {
      trace_id: traceId,
      status: report.status,
      auth_mode: report.auth_mode,
      error_type: firstProbeError(
        { ok: report.s3_list_buckets.allowed, error_type: report.s3_list_buckets.error_type },
        { ok: report.bedrock_list_model_invocation_jobs.allowed, error_type: report.bedrock_list_model_invocation_jobs.error_type },
        { ok: report.iam_simulate.s3_create_bucket.allowed, error_type: report.iam_simulate.s3_create_bucket.error_type },
      ),
    })
    return json(200, { trace_id: traceId, ...report })
  }

  if (url.pathname === '/v1/internal/corpus/import-sample') {
    if (request.method !== 'POST') return errorResult(405, traceId, 'corpus.import-sample', 'method_not_allowed', 'POST is required.')
    if (!consumer.scopes.includes('admin')) {
      return errorResult(403, traceId, 'corpus.import-sample', 'forbidden', 'The API key does not include the admin scope.')
    }
    if (consumer.audience !== 'internal') {
      return errorResult(403, traceId, 'corpus.import-sample', 'audience_not_permitted', 'This route is limited to the internal audience.')
    }
    return importSample(deps, request, traceId)
  }

  if (url.pathname === '/v1/capabilities' && request.method === 'GET') {
    return json(200, {
      trace_id: traceId,
      capability: 'capabilities',
      capability_version: CAPABILITY_VERSION,
      status: 'ok',
      capabilities: (deps.capabilities ?? CAPABILITIES).map((capability) => ({
        id: capability.id,
        version: capability.version,
        summary: capability.summary,
        modes: capability.modes,
        required_scopes: capability.requiredScopes,
        audiences: capability.audiences,
      })),
    })
  }
  const runMatch = /^\/v1\/agents\/([^/]+)\/runs\/([^/]+)$/.exec(url.pathname)
  if (runMatch) {
    if (request.method !== 'GET') return errorResult(405, traceId, 'agents.run', 'method_not_allowed', 'GET is required.')
    return getAgentRun(deps, consumer, runMatch[1] ?? '', runMatch[2] ?? '', traceId)
  }
  if (url.pathname === '/v1/events' && request.method === 'GET') return listEvents(deps.sql, consumer.name, url, traceId)
  const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(url.pathname)
  if (jobMatch && request.method === 'GET') return getJob(deps.sql, consumer.name, jobMatch[1] ?? '', traceId)
  if (url.pathname === '/v1/invoke' && request.method === 'POST') {
    return invoke(deps, request, consumer, traceId, schedule)
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    return errorResult(405, traceId, 'unknown', 'method_not_allowed', 'Method is not allowed.')
  }
  return errorResult(404, traceId, 'unknown', 'not_found', 'No route matches this path.')
}

function findCapability(deps: AppDeps, id: string): Capability | undefined {
  return (deps.capabilities ?? CAPABILITIES).find((capability) => capability.id === id)
}

async function importSample(deps: AppDeps, request: Request, traceId: string): Promise<Response> {
  const raw = await request.text()
  if (raw.length > MAX_IMPORT_SAMPLE_BYTES) {
    return errorResult(413, traceId, 'corpus.import-sample', 'payload_too_large', 'The request body is too large.')
  }
  const jsonl = sampleJsonl(request.headers.get('content-type'), raw)
  if (jsonl === null) {
    return errorResult(422, traceId, 'corpus.import-sample', 'invalid_json', 'The request body is not a JSONL sample.')
  }
  if (nonEmptyLineCount(jsonl) > IMPORT_SAMPLE_MAX_LINES) {
    return errorResult(422, traceId, 'corpus.import-sample', 'too_many_lines', `A sample import accepts at most ${IMPORT_SAMPLE_MAX_LINES} lines.`)
  }
  const report = await importCorpusText(deps.sql, deps.embedder, jsonl, {
    signer: 'cat-corpus',
    batchSize: deps.env.EMBED_BATCH_SIZE,
    concurrency: deps.env.EMBED_CONCURRENCY,
    traceId,
  })
  const costUsd = await costForTrace(deps.sql, traceId)
  const status = report.status === 'ok' || report.status === 'empty' ? 200 : report.status === 'failed' ? 422 : 503
  return json(status, {
    trace_id: traceId,
    status: report.status,
    lines_read: report.lines_read,
    lines_imported: report.lines_imported,
    lines_skipped: report.lines_skipped,
    chunks_written: report.chunks_written,
    cost_usd: costUsd,
    ...(report.reason ? { reason: report.reason } : {}),
    ...(report.error ? { error: report.error } : {}),
  })
}

function sampleJsonl(contentType: string | null, raw: string): string | null {
  if (contentType?.includes('application/json')) {
    try {
      const parsed = ImportSampleBody.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data.jsonl : null
    } catch {
      return null
    }
  }
  return raw
}

async function invoke(
  deps: AppDeps,
  request: Request,
  consumer: { name: string; scopes: string[]; audience: Audience },
  traceId: string,
  schedule: (run: () => Promise<void>) => void,
): Promise<Response> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return errorResult(415, traceId, 'unknown', 'unsupported_media', 'Content-Type application/json is required.')
  }
  const raw = await request.text()
  if (raw.length > MAX_BODY) return errorResult(413, traceId, 'unknown', 'payload_too_large', 'The request body is too large.')
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch {
    return errorResult(422, traceId, 'unknown', 'invalid_json', 'The request body is not JSON.')
  }
  const envelope = RequestEnvelope.safeParse(parsedJson)
  if (!envelope.success) return errorResult(422, traceId, 'unknown', 'invalid_envelope', 'The request envelope is invalid.')
  const body = envelope.data
  if (body.caller.principal !== consumer.name) {
    return errorResult(403, traceId, body.capability, 'principal_mismatch', 'The caller principal does not match the API key.')
  }
  const capability = findCapability(deps, body.capability)
  if (!capability) return errorResult(404, traceId, body.capability, 'unknown_capability', 'The capability is not registered.')
  if (!capability.requiredScopes.every((scope) => consumer.scopes.includes(scope))) {
    return errorResult(403, traceId, body.capability, 'forbidden', 'The API key does not include the required scope.')
  }
  if (!audienceAllowed(consumer.audience, body.audience) || !capability.audiences.includes(body.audience)) {
    return errorResult(403, traceId, body.capability, 'audience_not_permitted', 'The API key cannot request this audience.')
  }
  if (!capability.modes.includes(body.mode)) {
    return errorResult(422, traceId, body.capability, 'mode_not_supported', 'This capability does not support that mode.')
  }
  const input = capability.input.safeParse(body.input)
  if (!input.success) return errorResult(422, traceId, body.capability, 'invalid_input', 'The capability input is invalid.')
  const requestHash = sha256(stableStringify(body))
  const existing = await deps.sql.query<{ request_hash: string; status_code: number; response: unknown }>(
    `select request_hash, status_code, response from idempotency_records
     where principal = $1 and capability = $2 and idempotency_key = $3`,
    [consumer.name, capability.id, body.idempotency_key],
  )
  const prior = existing.rows[0]
  if (prior) {
    if (prior.request_hash !== requestHash) {
      return errorResult(409, traceId, capability.id, 'idempotency_conflict', 'This idempotency key was already used for a different request.')
    }
    return json(prior.status_code, asJson(prior.response), { 'idempotency-replayed': 'true' })
  }
  if (body.mode === 'async') {
    const jobId = newId()
    const pending = pendingBody(
      { trace_id: traceId, capability: capability.id, capability_version: capability.version },
      jobId,
      'queued',
    )
    PendingBody.parse(pending)
    await deps.sql.query(
      `insert into jobs (
         id, trace_id, capability, capability_version, principal, audience, purpose, patient_ref, encounter_ref,
         request, status, callback_url
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'queued',$11)`,
      [
        jobId,
        traceId,
        capability.id,
        capability.version,
        consumer.name,
        body.audience,
        body.caller.purpose,
        body.patient_ref ?? null,
        body.encounter_ref ?? null,
        JSON.stringify(input.data),
        body.callback_url ?? null,
      ],
    )
    await remember(deps.sql, consumer.name, capability.id, body.idempotency_key, requestHash, 202, pending)
    schedule(() => runJob(deps, jobId))
    return json(202, pending)
  }
  const ctx: CapabilityContext = {
    sql: deps.sql,
    models: deps.models,
    jev: deps.jev,
    embedder: deps.embedder,
    env: deps.env,
    traceId,
    idempotencyKey: body.idempotency_key,
    purpose: body.caller.purpose,
    audience: body.audience,
    patientRef: body.patient_ref,
    encounterRef: body.encounter_ref,
    cdmss: deps.cdmss,
  }
  try {
    const audit = await capability.run(ctx, input.data)
    const projected = serialize(audit, body.audience, { governance: capability.serializers?.governance })
    const status = httpStatusFor(projected as { status?: string; error?: { type?: string } })
    await remember(deps.sql, consumer.name, capability.id, body.idempotency_key, requestHash, status, projected)
    return json(status, projected)
  } catch (error) {
    if (error instanceof EmitRefusal) {
      return errorResult(500, traceId, capability.id, 'refuse_emit', 'The response was refused because it contained internal fields.')
    }
    return errorResult(500, traceId, capability.id, 'failed', 'The capability failed.')
  }
}

/** The agent's `storedInput` projection of a job's request, as JSON text, or null (no projection, unparseable input, or a throw). Applied at completion, never at start. */
function storedRequestFor(deps: AppDeps, capability: Capability | undefined, request: unknown, jobId: string): string | null {
  const agent = capability ? (deps.agents ?? AGENTS).find((candidate) => candidate.id === capability.id) : undefined
  if (!capability || !agent?.storedInput) return null
  try {
    const parsed = capability.input.safeParse(asJson(request))
    if (!parsed.success) return null
    return JSON.stringify(agent.storedInput(parsed.data) ?? {})
  } catch {
    log('warn', 'job.stored_input', { job_id: jobId, error_type: 'stored_input_failed' })
    return null
  }
}

async function runJob(deps: AppDeps, jobId: string): Promise<void> {
  const rows = await deps.sql.query<{
    id: string
    trace_id: string
    capability: string
    capability_version: string
    principal: string
    audience: Audience
    purpose: string
    patient_ref: string | null
    encounter_ref: string | null
    request: unknown
    callback_url: string | null
    status: string
  }>('select * from jobs where id = $1', [jobId])
  const job = rows.rows[0]
  if (!job || (job.status !== 'queued' && job.status !== 'running')) return
  if (job.status === 'queued') await deps.sql.query(`update jobs set status = 'running' where id = $1`, [jobId])
  const capability = findCapability(deps, job.capability)
  let statusCode = 500
  let body: unknown = {
    trace_id: job.trace_id,
    capability: job.capability,
    capability_version: job.capability_version,
    status: 'failed',
    error: { type: 'failed', message: 'The job failed.' },
  }
  try {
    if (!capability) throw new Error('missing capability')
    const audit = await capability.run(
      {
        sql: deps.sql,
        models: deps.models,
        jev: deps.jev,
        embedder: deps.embedder,
        env: deps.env,
        traceId: job.trace_id,
        purpose: job.purpose,
        audience: job.audience,
        patientRef: job.patient_ref ?? undefined,
        encounterRef: job.encounter_ref ?? undefined,
        cdmss: deps.cdmss,
      },
      asJson(job.request),
    )
    body = serialize(audit, job.audience, { governance: capability.serializers?.governance })
    statusCode = httpStatusFor(body as { status?: string; error?: { type?: string } })
  } catch (error) {
    if (error instanceof EmitRefusal) {
      body = {
        trace_id: job.trace_id,
        capability: job.capability,
        capability_version: job.capability_version,
        status: 'failed',
        error: { type: 'refuse_emit', message: 'The response was refused because it contained internal fields.' },
      }
    }
  }
  const terminal = (body as { status?: string }).status ?? 'failed'
  const jobStatus = terminal === 'ok' || terminal === 'empty' || terminal === 'abstained' || terminal === 'unavailable' || terminal === 'failed' ? terminal : 'failed'
  await deps.sql.query(
    `update jobs set status = $2, http_status = $3, result = $4::jsonb, completed_at = now(), request = coalesce($5::jsonb, request) where id = $1`,
    [jobId, jobStatus, statusCode, JSON.stringify(body), storedRequestFor(deps, capability, job.request, jobId)],
  )
  await deps.sql.query(`insert into events (principal, job_id, type, payload) values ($1, $2, 'job.completed', $3::jsonb)`, [
    job.principal,
    jobId,
    JSON.stringify(body),
  ])
  if (job.callback_url) await deliverWebhook(deps, job.principal, jobId, job.callback_url, body)
  log('info', 'job.completed', {
    job_id: jobId,
    trace_id: job.trace_id,
    capability: job.capability,
    status: jobStatus,
    http_status: statusCode,
    note_id: job.patient_ref ?? undefined,
  })
}

export async function runQueuedJob(deps: AppDeps, owner: string): Promise<boolean> {
  const jobId = await claimNextJob(deps.sql, owner)
  if (!jobId) return false
  await runJob(deps, jobId)
  return true
}

async function deliverWebhook(deps: AppDeps, principal: string, jobId: string, url: string, body: unknown): Promise<void> {
  const secret = deps.env.WEBHOOK_SIGNING_SECRET
  if (!secret) {
    await deps.sql.query(`insert into events (principal, job_id, type, payload) values ($1, $2, 'webhook.refused', $3::jsonb)`, [
      principal,
      jobId,
      JSON.stringify({ status: 'refused', error: { type: 'missing_secret', message: 'WEBHOOK_SIGNING_SECRET is unset.' } }),
    ])
    return
  }
  const payload = JSON.stringify(body)
  const timestamp = String((deps.now ?? Date.now)())
  const signature = signWebhook(secret, timestamp, payload)
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-newcat-signature': signature },
      body: payload,
    })
    const type = response.ok ? 'webhook.delivered' : 'webhook.failed'
    await deps.sql.query(`insert into events (principal, job_id, type, payload) values ($1, $2, $3, $4::jsonb)`, [
      principal,
      jobId,
      type,
      JSON.stringify({ status: response.ok ? 'ok' : 'failed', http_status: response.status }),
    ])
  } catch {
    await deps.sql.query(`insert into events (principal, job_id, type, payload) values ($1, $2, 'webhook.failed', $3::jsonb)`, [
      principal,
      jobId,
      JSON.stringify({ status: 'failed', error: { type: 'transport', message: 'The webhook request failed.' } }),
    ])
  }
}

async function getJob(sql: Sql, principal: string, jobId: string, traceId: string): Promise<Response> {
  const rows = await sql.query<{ principal: string; status: string; http_status: number | null; result: unknown; trace_id: string; capability: string; capability_version: string }>(
    'select principal, status, http_status, result, trace_id, capability, capability_version from jobs where id = $1',
    [jobId],
  )
  const job = rows.rows[0]
  if (!job || job.principal !== principal) return errorResult(404, traceId, 'jobs', 'not_found', 'The job was not found.')
  if (job.status === 'queued' || job.status === 'running') {
    const pending = pendingBody(
      { trace_id: job.trace_id, capability: job.capability, capability_version: job.capability_version },
      jobId,
      job.status,
    )
    return json(202, pending)
  }
  return json(job.http_status ?? 200, asJson(job.result))
}

const JUDGE_KEYS = ['primary_p', 'second_p', 'agree', 'served_model_ids'] as const
const GOVERNANCE_JUDGE_KEYS = JUDGE_KEYS.filter((key) => key !== 'served_model_ids')
const REF_KEYS = ['source_id', 'segment_id', 'start', 'end'] as const

const MAX_SCALAR_LENGTH = 200
const VERSION_FIXED_KEYS = ['engine', 'rules', 'extractor', 'agent', 'models', 'question_set_id', 'question_set_sha', 'question_sets'] as const
const VERSION_KEY_TOKEN = /^[a-z][a-z0-9_]{0,39}$/
const VERSION_VALUE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@:/+-]{0,79}$/

/** Numbers, booleans, bounded strings and arrays of bounded strings; anything else is dropped. */
function safeValue(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length <= MAX_SCALAR_LENGTH ? value : undefined
  if (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length <= MAX_SCALAR_LENGTH)) return value
  return undefined
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const key of keys) {
    if (!(key in source)) continue
    const safe = safeValue(source[key])
    if (safe !== undefined) out[key] = safe
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Fixed version keys, plus agent-declared keys that are plain identifiers with bounded string values. Governance never gets a key naming a model. */
function projectVersions(value: unknown, governance: boolean): Record<string, unknown> {
  const source = isRecord(value) ? value : {}
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (governance && key.toLowerCase().includes('model')) continue
    if ((VERSION_FIXED_KEYS as readonly string[]).includes(key)) {
      if (key === 'question_sets') {
        if (!isRecord(entry)) continue
        out[key] = Object.fromEntries(
          Object.entries(entry).filter(([rule, id]) => typeof id === 'string' && id.length <= MAX_SCALAR_LENGTH && VERSION_KEY_TOKEN.test(rule.toLowerCase().replace(/[^a-z0-9_]/g, '_'))),
        )
        continue
      }
      const safe = safeValue(entry)
      if (safe !== undefined) out[key] = safe
    } else if (VERSION_KEY_TOKEN.test(key) && typeof entry === 'string' && VERSION_VALUE_TOKEN.test(entry)) {
      out[key] = entry
    }
  }
  return out
}

/** Counts: non-negative integers only, and objects of the same (one level or more); everything else is dropped. */
function projectCounts(value: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!isRecord(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number') {
      if (Number.isInteger(entry) && entry >= 0) out[key] = entry
    } else if (isRecord(entry)) {
      out[key] = projectCounts(entry)
    }
  }
  return out
}

/**
 * Read API over agent_runs / agent_findings (F8). Metadata and positions only: no input, quote or segment text,
 * and every stored jsonb field is projected through key allowlists and value type checks so a stray key or value can never reach the body.
 */
async function getAgentRun(
  deps: AppDeps,
  consumer: { scopes: string[]; audience: Audience },
  agentId: string,
  runId: string,
  traceId: string,
): Promise<Response> {
  const capability = 'agents.run'
  if (!consumer.scopes.includes(agentId)) {
    return errorResult(403, traceId, capability, 'forbidden', 'The API key does not include the required scope.')
  }
  const agent = findCapability(deps, agentId)
  if (consumer.audience === 'doctor' || (agent && !agent.audiences.includes(consumer.audience))) {
    return errorResult(403, traceId, capability, 'audience_not_permitted', 'The API key cannot read agent runs.')
  }
  if (!agent) return errorResult(404, traceId, capability, 'not_found', 'The run was not found.')
  const runs = await deps.sql.query<{
    run_id: string
    agent_id: string
    agent_version: string
    status: string
    reason: string | null
    versions: unknown
    counts: unknown
    created_at: unknown
  }>(
    `select run_id, agent_id, agent_version, status, reason, versions, counts, created_at
     from agent_runs where run_id = $1 and agent_id = $2`,
    [runId, agentId],
  )
  const run = runs.rows[0]
  if (!run) return errorResult(404, traceId, capability, 'not_found', 'The run was not found.')
  const findings = await deps.sql.query<{
    finding_id: string
    rule_id: string
    rule_version: string
    severity: string
    safety_class: boolean
    action: string
    judge: unknown
    evidence_refs: unknown
  }>(
    `select finding_id, rule_id, rule_version, severity, safety_class, action, judge, evidence_refs
     from agent_findings where run_id = $1 order by created_at, finding_id`,
    [runId],
  )
  // Spec 12: no model ids in governance output, and V1: abstentions appear only as counts by reason, never as findings.
  const governance = consumer.audience === 'governance'
  const shown = governance ? findings.rows.filter((row) => row.action === 'valid') : findings.rows
  const abstentions: Record<string, number> = {}
  if (governance) {
    for (const row of findings.rows) {
      if (row.action === 'valid') continue
      abstentions[row.action] = (abstentions[row.action] ?? 0) + 1
    }
  }
  return json(200, {
    trace_id: traceId,
    capability,
    capability_version: CAPABILITY_VERSION,
    status: 'ok',
    run: {
      run_id: run.run_id,
      agent_id: run.agent_id,
      agent_version: run.agent_version,
      status: run.status,
      reason: typeof run.reason === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(run.reason) ? run.reason : null,
      versions: projectVersions(asJson(run.versions), governance),
      counts: projectCounts(asJson(run.counts)),
      created_at: asIso(run.created_at),
    },
    findings: shown.map((row) => {
      const refs = asJson(row.evidence_refs)
      return {
        finding_id: row.finding_id,
        rule_id: row.rule_id,
        rule_version: row.rule_version,
        severity: row.severity,
        safety_class: row.safety_class,
        action: row.action,
        judge: pick(asJson(row.judge), governance ? GOVERNANCE_JUDGE_KEYS : JUDGE_KEYS),
        evidence_refs: Array.isArray(refs) ? refs.map((ref) => pick(ref, REF_KEYS)) : [],
      }
    }),
    ...(governance ? { abstentions } : {}),
  })
}

async function listEvents(sql: Sql, principal: string, url: URL, traceId: string): Promise<Response> {
  const after = Number(url.searchParams.get('after') ?? '0')
  const rows = await sql.query<{ id: number | string; type: string; payload: unknown; created_at: unknown }>(
    `select id, type, payload, created_at from events where principal = $1 and id > $2 order by id limit 100`,
    [principal, Number.isFinite(after) ? after : 0],
  )
  if (rows.rows.length === 0) {
    return json(200, {
      trace_id: traceId,
      capability: 'events',
      capability_version: CAPABILITY_VERSION,
      status: 'empty',
      reason: 'no_events',
      events: [],
    })
  }
  return json(200, {
    trace_id: traceId,
    capability: 'events',
    capability_version: CAPABILITY_VERSION,
    status: 'ok',
    events: rows.rows.map((row) => ({
      id: Number(row.id),
      type: row.type,
      payload: asJson(row.payload),
      created_at: asIso(row.created_at),
    })),
  })
}

async function tick(deps: AppDeps, request: Request, traceId: string): Promise<Response> {
  const auth = authenticateCron(request.headers.get('authorization'), deps.env.CRON_SECRET)
  if (auth === 'missing_secret') return errorResult(401, traceId, 'work.tick', 'missing_secret', 'CRON_SECRET is unset.')
  if (auth !== 'ok') return errorResult(401, traceId, 'work.tick', 'unauthorized', 'A cron bearer token is required.')
  const work = await leaseNext(deps.sql, `tick:${traceId}`)
  if (!work) {
    return json(200, {
      trace_id: traceId,
      capability: 'work.tick',
      capability_version: CAPABILITY_VERSION,
      status: 'empty',
      reason: 'no_queued_work',
    })
  }
  const audit = await runLeasedWork(
    { sql: deps.sql, models: deps.models, jev: deps.jev, embedder: deps.embedder, rerank: deps.env.BEDROCK_RERANK },
    work,
    deps.env.ABSTENTION_BACKLOG_DAYS,
  )
  const body = {
    trace_id: audit.trace_id,
    capability: 'work.tick',
    capability_version: CAPABILITY_VERSION,
    status: audit.status,
    work_id: work.id,
    ...(audit.reason ? { reason: audit.reason } : {}),
    ...(audit.error ? { error: audit.error } : {}),
  }
  return json(httpStatusFor(body), body)
}

async function remember(
  sql: Sql,
  principal: string,
  capability: string,
  key: string,
  requestHash: string,
  statusCode: number,
  response: unknown,
): Promise<void> {
  await sql.query(
    `insert into idempotency_records (principal, capability, idempotency_key, request_hash, status_code, response)
     values ($1, $2, $3, $4, $5, $6::jsonb)`,
    [principal, capability, key, requestHash, statusCode, JSON.stringify(response)],
  )
}

function errorResult(status: number, traceId: string, capability: string, type: string, message: string): Response {
  return json(status, {
    trace_id: traceId,
    capability,
    capability_version: CAPABILITY_VERSION,
    status: 'failed',
    error: { type, message },
  })
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}
