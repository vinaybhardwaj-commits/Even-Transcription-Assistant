import { hostname } from 'node:os'
import type { Sql } from '../../db/sql.js'
import { asIso, asJson } from '../../db/sql.js'
import { newId } from '../../ids.js'
import { log } from '../../log.js'
import { assertOutbound, FilterRejection } from './filter.js'
import { HttpUbusTransport, type UbusTransport } from './transport.js'

/** Handles whose requests are obeyed. Everyone else gets a refusal reply. */
export const ALLOWLIST: readonly string[] = ['gating-lead', 'newcat-lead', 'newcat-orch', 'consult-audit-lead', 'cc-air-work-local']
/**
 * State-changing verbs (pause, resume, rerun) are off: ubus is a notification channel. Turning them on is this one-line change,
 * and they then still need a verified, allowlisted sender machine (below).
 */
export const UBUS_STATE_VERBS_ENABLED = false
/**
 * Machine labels allowed to drive state-changing verbs. INFERRED strings: Mini, c3, t4 labels and their hostnames.
 * Matched exactly, case-insensitively, against from.machine; from.machine_verified must also be strictly true.
 */
export const STATE_VERB_MACHINES: readonly string[] = ['vinays-mac-mini-3', 'eta-ci-c3', 'eta-lab-t4', 'e2e-147-28', 'e2e-80-13']
export const NOTIFY_TO: readonly string[] = ['newcat-lead']
export const SEND_CAP_PER_HOUR = 20
export const REPLY_CAP_PER_HOUR = 20
/** Refusals to non-allowlisted senders have their own small cap so they cannot starve real replies. */
export const REFUSAL_CAP_PER_HOUR = 5
export const HEARTBEAT_MS = 60_000
export const POLL_MS = 10_000
const HOUR_MS = 3_600_000
const ID_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/

export interface BridgeStats {
  sent: number
  replied: number
  errors: number
  suppressed: number
  rejected: Record<string, number>
  refused: number
  refusedUnverified: number
}

export interface BridgeOptions {
  sql: Sql
  transport: UbusTransport
  handle?: string
  machine?: string
  now?: () => number
  allowlist?: readonly string[]
  notifyTo?: readonly string[]
  stateVerbsEnabled?: boolean
  stateVerbMachines?: readonly string[]
}

interface RunRow {
  run_id: string
  agent_id: string
  trace_id: string
  status: string
  reason: string | null
  counts: unknown
  created_at: unknown
}

interface JobRow {
  id: string
  status: string
  capability: string
  capability_version: string
  principal: string
  audience: string
  purpose: string
  patient_ref: string | null
  encounter_ref: string | null
  request: unknown
}

/** Numeric leaves only, so a counts object can never carry text. */
export function numericCounts(value: unknown, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 1) return out
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'number' && Number.isFinite(item)) out[key] = item
    else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const inner = numericCounts(item, depth + 1)
      if (Object.keys(inner).length > 0) out[key] = inner
    }
  }
  return out
}

export class UbusBridge {
  readonly stats: BridgeStats = { sent: 0, replied: 0, errors: 0, suppressed: 0, rejected: {}, refused: 0, refusedUnverified: 0 }
  private readonly sql: Sql
  private readonly transport: UbusTransport
  private readonly handle: string
  private readonly machine: string
  private readonly now: () => number
  private readonly allowlist: readonly string[]
  private readonly notifyTo: readonly string[]
  private readonly stateVerbsEnabled: boolean
  private readonly stateVerbMachines: readonly string[]
  private registered = false
  private isPaused = false
  private cursor: number
  private seen = new Set<string>()
  private windowStart: number
  private sendsInWindow = 0
  private repliesInWindow = 0
  private refusalsInWindow = 0
  private suppressedInWindow = 0
  private timers: NodeJS.Timeout[] = []
  private busy = false

  constructor(options: BridgeOptions) {
    this.sql = options.sql
    this.transport = options.transport
    this.handle = options.handle ?? 'newcat'
    this.machine = options.machine ?? hostname()
    this.now = options.now ?? Date.now
    this.allowlist = options.allowlist ?? ALLOWLIST
    this.notifyTo = options.notifyTo ?? NOTIFY_TO
    this.stateVerbsEnabled = options.stateVerbsEnabled ?? UBUS_STATE_VERBS_ENABLED
    this.stateVerbMachines = (options.stateVerbMachines ?? STATE_VERB_MACHINES).map((m) => m.toLowerCase())
    this.cursor = this.now()
    this.windowStart = this.now()
  }

  get paused(): boolean {
    return this.isPaused
  }

  /** Best-effort: never throws, never blocks the job loop. */
  start(): void {
    void this.safe(() => this.register())
    this.timers.push(setInterval(() => void this.safe(() => this.heartbeat()), HEARTBEAT_MS))
    this.timers.push(setInterval(() => void this.safe(() => this.tick()), POLL_MS))
    for (const t of this.timers) t.unref()
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  async register(): Promise<void> {
    const result = await this.transport.call('ubus_register', {
      handle: this.handle,
      machine: this.machine,
      runtime: 'other',
      capabilities: { role: 'newcat-worker', verbs: ['status', 'rerun', 'pause', 'resume'] },
    })
    if (result.ok === false) throw new Error('register refused')
    this.registered = true
  }

  async heartbeat(): Promise<void> {
    if (!this.registered) return this.register()
    const result = await this.transport.call('ubus_heartbeat', {})
    if (result.ok === false) this.registered = false
  }

  /** One pass: finished runs out, inbox in, summary flush. Each part is isolated. */
  async tick(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      await this.safe(() => this.pollRuns())
      await this.safe(() => this.pollInbox())
      await this.safe(() => this.flushSummary())
    } finally {
      this.busy = false
    }
  }

  private async safe(fn: () => Promise<void>): Promise<void> {
    try {
      await fn()
    } catch {
      this.stats.errors += 1
      log('warn', 'ubus.error')
    }
  }

  // ---- outbound -----------------------------------------------------------------------------------------------

  async pollRuns(): Promise<void> {
    const since = new Date(this.cursor).toISOString()
    const rows = await this.sql.query<RunRow>(
      `select run_id, agent_id, trace_id, status, reason, counts, created_at
       from agent_runs where created_at >= $1 order by created_at, run_id limit 100`,
      [since],
    )
    let maxTs = this.cursor
    const nextSeen = new Set<string>()
    for (const row of rows.rows) {
      const ts = new Date(asIso(row.created_at)).getTime()
      if (this.seen.has(row.run_id) && ts <= this.cursor) continue
      await this.announce(row)
      if (ts > maxTs) {
        maxTs = ts
        nextSeen.clear()
      }
      if (ts === maxTs) nextSeen.add(row.run_id)
    }
    if (maxTs === this.cursor) for (const id of this.seen) nextSeen.add(id)
    this.cursor = maxTs
    this.seen = nextSeen
  }

  private async announce(row: RunRow): Promise<void> {
    const job = await this.sql.query<{ id: string }>('select id from jobs where trace_id = $1 limit 1', [row.trace_id])
    const ref = job.rows[0] ? `job:${job.rows[0].id}` : `run:${row.run_id}`
    const failed = row.status === 'failed' || row.status === 'unavailable'
    await this.post(failed ? 'job.failed' : 'job.done', {
      run_id: row.run_id,
      agent_id: row.agent_id,
      status: row.status,
      counts: numericCounts(row.counts),
      result_ref: ref,
    }, `${failed ? 'failed' : 'done'}:${row.run_id}`)
  }

  /** Filter, rate cap, send. Returns whether a message went out. Never throws. */
  async post(subject: string, fields: Record<string, unknown>, idempotencyKey?: string): Promise<boolean> {
    try {
      assertOutbound(subject, fields)
    } catch (error) {
      if (!(error instanceof FilterRejection)) throw error
      this.stats.rejected[error.rule] = (this.stats.rejected[error.rule] ?? 0) + 1
      log('warn', 'ubus.filter_rejected', { error_type: error.rule })
      return false
    }
    this.rollWindow()
    if (this.sendsInWindow >= SEND_CAP_PER_HOUR) {
      this.suppressedInWindow += 1
      this.stats.suppressed += 1
      return false
    }
    return this.deliver(subject, fields, idempotencyKey)
  }

  private async deliver(subject: string, fields: Record<string, unknown>, idempotencyKey?: string): Promise<boolean> {
    this.sendsInWindow += 1
    try {
      const result = await this.transport.call('ubus_send', {
        to: [...this.notifyTo],
        subject,
        body: JSON.stringify(fields),
        wake: false,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      })
      if (result.ok === false) throw new Error('send refused')
      this.stats.sent += 1
      return true
    } catch {
      this.stats.errors += 1
      return false
    }
  }

  private rollWindow(): void {
    if (this.now() - this.windowStart < HOUR_MS) return
    this.windowStart = this.now()
    this.sendsInWindow = 0
    this.repliesInWindow = 0
    this.refusalsInWindow = 0
  }

  /** Over the cap, messages are dropped; once the hour rolls over one summary says how many. */
  async flushSummary(): Promise<void> {
    if (this.now() - this.windowStart < HOUR_MS || this.suppressedInWindow === 0) return
    const count = this.suppressedInWindow
    this.suppressedInWindow = 0
    this.rollWindow()
    await this.post('job.summary', { suppressed: count, cap_per_hour: SEND_CAP_PER_HOUR })
  }

  // ---- inbound ------------------------------------------------------------------------------------------------

  async pollInbox(): Promise<void> {
    const result = await this.transport.call('ubus_inbox', { unread_only: true, limit: 20 })
    if (result.ok === false) throw new Error('inbox refused')
    const messages = Array.isArray(result.messages) ? (result.messages as Array<Record<string, unknown>>) : []
    for (const message of messages) {
      await this.safe(() => this.handleMessage(message))
    }
  }

  async handleMessage(message: Record<string, unknown>): Promise<void> {
    const id = typeof message.id === 'string' ? message.id : ''
    if (!id) return
    const from = message.from as { handle?: unknown; machine?: unknown; machine_verified?: unknown } | undefined
    const sender = typeof from?.handle === 'string' ? from.handle : ''
    const corr = message.corr as { corr_id?: unknown } | null | undefined
    const corrId = typeof corr?.corr_id === 'string' ? corr.corr_id : undefined
    const reply = (fields: Record<string, unknown>, refusal = false) => this.reply(id, corrId, fields, refusal)
    try {
      if (!this.allowlist.includes(sender)) {
        this.stats.refused += 1
        await reply({ ok: false, refused: 'not_allowed' }, true)
        return
      }
      const text = String(message.body ?? '').trim() || String(message.subject ?? '').trim()
      const verb = text.split(/\s+/)[0]?.toLowerCase()
      if ((verb === 'pause' || verb === 'resume' || verb === 'rerun') && !this.stateVerbPermitted(from)) {
        this.stats.refusedUnverified += 1
        await reply({ ok: false, refused: 'refused_unverified' }, true)
        return
      }
      await reply(await this.runVerb(text))
    } finally {
      try {
        await this.transport.call('ubus_ack', { ids: [id] })
      } catch {
        this.stats.errors += 1
      }
    }
  }

  /** Constant on, machine_verified strictly true, and from.machine on the code allowlist. Anything else is refused. */
  private stateVerbPermitted(from: { machine?: unknown; machine_verified?: unknown } | undefined): boolean {
    if (!this.stateVerbsEnabled) return false
    if (from?.machine_verified !== true) return false
    return typeof from.machine === 'string' && this.stateVerbMachines.includes(from.machine.toLowerCase())
  }

  private async runVerb(text: string): Promise<Record<string, unknown>> {
    const parts = text.split(/\s+/)
    const verb = parts[0]?.toLowerCase()
    const arg = parts[1]
    if (verb === 'pause' && parts.length === 1) {
      this.isPaused = true
      return { ok: true, paused: true }
    }
    if (verb === 'resume' && parts.length === 1) {
      this.isPaused = false
      return { ok: true, paused: false }
    }
    if ((verb === 'status' || verb === 'rerun') && parts.length === 2 && arg && ID_TOKEN.test(arg)) {
      return verb === 'status' ? this.statusOf(arg) : this.rerun(arg)
    }
    return { ok: false, error: 'unknown_verb' }
  }

  private async statusOf(runId: string): Promise<Record<string, unknown>> {
    const run = await this.findRun(runId)
    if (!run) return { ok: false, error: 'not_found' }
    return { ok: true, run_id: run.run_id, agent_id: run.agent_id, status: run.status, ...(run.reason ? { reason: run.reason } : {}), counts: numericCounts(run.counts) }
  }

  private async findRun(runId: string): Promise<RunRow | undefined> {
    const rows = await this.sql.query<RunRow>(
      'select run_id, agent_id, trace_id, status, reason, counts, created_at from agent_runs where run_id = $1',
      [runId],
    )
    return rows.rows[0]
  }

  /**
   * Re-enqueues a copy of the job that produced the run (same request, new job and trace ids, no webhook).
   * Idempotent per source job: while an earlier rerun of it is queued or running, no second one is created.
   */
  private async rerun(runId: string): Promise<Record<string, unknown>> {
    const run = await this.findRun(runId)
    if (!run) return { ok: false, error: 'not_found' }
    const found = await this.sql.query<JobRow>(
      `select id, status, capability, capability_version, principal, audience, purpose, patient_ref, encounter_ref, request
       from jobs where trace_id = $1 limit 1`,
      [run.trace_id],
    )
    const source = found.rows[0]
    if (!source) return { ok: false, error: 'no_job' }
    if (source.status === 'queued' || source.status === 'running') return { ok: false, error: 'still_running' }
    return this.sql.withTx(async (tx) => {
      const prior = await tx.query<{ new_job_id: string | null }>(
        `select e.payload->>'new_job_id' as new_job_id from events e
         join jobs j on j.id = e.payload->>'new_job_id'
         where e.type = 'ubus.rerun' and e.job_id = $1 and j.status in ('queued', 'running') limit 1`,
        [source.id],
      )
      if (prior.rows[0]) return { ok: true, already_pending: true, job_id: prior.rows[0].new_job_id }
      const jobId = newId()
      await tx.query(
        `insert into jobs (id, trace_id, capability, capability_version, principal, audience, purpose, patient_ref, encounter_ref, request, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'queued')`,
        [jobId, newId(), source.capability, source.capability_version, source.principal, source.audience, source.purpose, source.patient_ref, source.encounter_ref, JSON.stringify(asJson(source.request))],
      )
      await tx.query(`insert into events (principal, job_id, type, payload) values ($1, $2, 'ubus.rerun', $3::jsonb)`, [
        source.principal,
        source.id,
        JSON.stringify({ new_job_id: jobId, run_id: runId }),
      ])
      return { ok: true, queued: true, job_id: jobId }
    })
  }

  private async reply(replyTo: string, corrId: string | undefined, fields: Record<string, unknown>, refusal = false): Promise<void> {
    let body = fields
    try {
      assertOutbound('reply', fields)
    } catch (error) {
      if (!(error instanceof FilterRejection)) throw error
      this.stats.rejected[error.rule] = (this.stats.rejected[error.rule] ?? 0) + 1
      body = { ok: false, error: 'filtered' }
    }
    this.rollWindow()
    if (refusal ? this.refusalsInWindow >= REFUSAL_CAP_PER_HOUR : this.repliesInWindow >= REPLY_CAP_PER_HOUR) {
      this.stats.suppressed += 1
      return
    }
    if (refusal) this.refusalsInWindow += 1
    else this.repliesInWindow += 1
    const result = await this.transport.call('ubus_reply', { reply_to: replyTo, body: JSON.stringify(body), ...(corrId ? { corr_id: corrId } : {}) })
    if (result.ok === false) throw new Error('reply refused')
    this.stats.replied += 1
  }
}

/**
 * Worker entry. NEWCAT_UBUS unset or 'off' returns null with no calls made. 'on' without UBUS_URL refuses to start.
 * UBUS_TOKEN_FILE is optional (a tailnet peer registers by handle alone).
 */
export function createBridge(
  sql: Sql,
  env: Record<string, string | undefined> = process.env,
  overrides: { transport?: UbusTransport; now?: () => number } = {},
): UbusBridge | null {
  const mode = (env.NEWCAT_UBUS ?? 'off').trim().toLowerCase()
  if (mode === 'off' || mode === '') return null
  if (mode !== 'on') throw new Error('NEWCAT_UBUS must be on or off')
  const url = env.UBUS_URL?.trim()
  if (!url && !overrides.transport) throw new Error('NEWCAT_UBUS=on requires UBUS_URL')
  const handle = env.UBUS_HANDLE?.trim() || 'newcat'
  const transport =
    overrides.transport ??
    new HttpUbusTransport({ url: url as string, handle, ...(env.UBUS_TOKEN_FILE?.trim() ? { tokenFile: env.UBUS_TOKEN_FILE.trim() } : {}) })
  return new UbusBridge({ sql, transport, handle, ...(overrides.now ? { now: overrides.now } : {}) })
}
