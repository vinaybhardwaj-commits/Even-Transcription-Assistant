import { log } from '../log.js'
import type { Sql } from '../db/sql.js'
import type { AnyAgentDefinition } from '../platform/agent/types.js'

export const JOB_REQUEST_RETENTION_DAYS = 90

/** Empties `jobs.request` of finished jobs older than `days`. Rows stay (no delete). Returns the number of rows emptied. */
export async function sweepJobRequests(sql: Sql, days = JOB_REQUEST_RETENTION_DAYS): Promise<number> {
  const result = await sql.query<{ id: string }>(
    `update jobs set request = '{}'::jsonb
     where created_at < now() - ($1 * interval '1 day') and request <> '{}'::jsonb and status not in ('queued','running')
     returning id`,
    [days],
  )
  return result.rows.length
}

export type RetentionLog = (fields: { event: 'agent.retention' | 'jobs.retention'; agent_id?: string; swept?: number; error_type?: string }) => void

/** Counts and codes only, through the log allowlist. */
export const logRetention: RetentionLog = ({ event, ...fields }) => log(fields.error_type ? 'warn' : 'info', event, fields)

export const RETENTION_HOOK_TIMEOUT_MS = 30_000

/** Non-negative integer or null (non-numbers, NaN, negatives and fractions-of-nothing never reach the log as text). */
function toCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

class RetentionTimeout extends Error {}

export interface RetentionRunner {
  /** Runs the pass if this UTC day has not run yet in this process. Returns true when it ran. Never throws. */
  tick(): Promise<boolean>
}

/** One pass per UTC day, tracked in memory (no state table exists); the first tick after a worker start always runs. */
export function createRetentionRunner(opts: {
  sql: Sql
  agents: readonly AnyAgentDefinition[]
  now?: () => Date
  log?: RetentionLog
  /** Per-hook deadline in ms (default 30000). On timeout the hook counts as failed with error_type 'timeout' and the pass moves on. */
  hookTimeoutMs?: number
}):  RetentionRunner {
  const now = opts.now ?? (() => new Date())
  const emit = opts.log ?? logRetention
  const hookTimeoutMs = opts.hookTimeoutMs ?? RETENTION_HOOK_TIMEOUT_MS
  let lastDay = ''
  return {
    async tick() {
      const at = now()
      const day = at.toISOString().slice(0, 10)
      if (day === lastDay) return false
      lastDay = day
      for (const agent of opts.agents) {
        if (!agent.retention) continue
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new RetentionTimeout()), hookTimeoutMs)
          })
          const result = await Promise.race([agent.retention({ sql: opts.sql, now: at }), timeout])
          const swept = toCount((result as { swept?: unknown } | undefined)?.swept)
          if (swept === null) emit({ event: 'agent.retention', agent_id: agent.id, error_type: 'bad_count' })
          else emit({ event: 'agent.retention', agent_id: agent.id, swept })
        } catch (err) {
          emit({ event: 'agent.retention', agent_id: agent.id, error_type: err instanceof RetentionTimeout ? 'timeout' : 'retention_failed' })
        } finally {
          clearTimeout(timer)
        }
      }
      try {
        emit({ event: 'jobs.retention', swept: await sweepJobRequests(opts.sql) })
      } catch {
        emit({ event: 'jobs.retention', error_type: 'retention_failed' })
      }
      return true
    },
  }
}
