import type { Sql } from '../db/sql.js'

const LEASE_MS = 10 * 60 * 1000

/** Claims one queued job, or a running job whose lease has expired. */
export async function claimNextJob(sql: Sql, owner: string): Promise<string | null> {
  return sql.withTx(async (tx) => {
    const picked = await tx.query<{ id: string }>(
      `select id from jobs
       where status = 'queued'
          or (status = 'running' and lease_until is not null and lease_until < now())
       order by created_at
       limit 1
       for update`,
    )
    const id = picked.rows[0]?.id
    if (!id) return null
    await tx.query(
      `update jobs
       set status = 'running', lease_owner = $2, lease_until = now() + ($3 * interval '1 millisecond')
       where id = $1`,
      [id, owner, LEASE_MS],
    )
    return id
  })
}
