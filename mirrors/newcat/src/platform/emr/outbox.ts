import { randomUUID } from 'node:crypto'
import type { Sql } from '../../db/sql.js'
import type { AgentResultRef, EmrAdapterId } from './types.js'

export interface Outbox {
  record(adapterId: EmrAdapterId, run: AgentResultRef): Promise<{ id: string; created: boolean }>
}

/** Idempotent on (adapter_id, run_id). Stores ids and status only, never payload text. */
export function createOutbox(sql: Sql): Outbox {
  return {
    async record(adapterId, run) {
      const inserted = await sql.query<{ id: string }>(
        `insert into outbox (id, adapter_id, run_id, status) values ($1, $2, $3, 'stored')
         on conflict (adapter_id, run_id) do nothing returning id`,
        [randomUUID(), adapterId, run.runId],
      )
      if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true }
      const existing = await sql.query<{ id: string }>('select id from outbox where adapter_id = $1 and run_id = $2', [adapterId, run.runId])
      return { id: existing.rows[0]!.id, created: false }
    },
  }
}
