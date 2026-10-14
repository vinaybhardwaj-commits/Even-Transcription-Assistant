import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite/vector'
import { neonConfig, Pool } from '@neondatabase/serverless'
import ws from 'ws'
import type { Sql } from './sql.js'

interface QueryResult {
  rows: unknown[]
}

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<QueryResult>
  exec?: (text: string) => Promise<unknown>
}

interface PoolClientLike extends Queryable {
  release(): void
}

interface PoolLike {
  query(text: string, params?: unknown[]): Promise<QueryResult>
  connect(): Promise<PoolClientLike>
  end(): Promise<void>
}

class DbSql implements Sql {
  constructor(
    private readonly queryable: Queryable,
    private readonly tx: ((fn: (tx: Queryable) => Promise<unknown>) => Promise<unknown>) | null,
    private readonly closer: (() => Promise<void>) | null,
    private readonly nested: boolean,
  ) {}

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const result = await this.queryable.query(text, params)
    return { rows: result.rows as T[] }
  }

  async exec(text: string): Promise<void> {
    if (this.queryable.exec) {
      await this.queryable.exec(text)
      return
    }
    await this.queryable.query(text)
  }

  async withTx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    if (this.nested || !this.tx) throw new Error('nested transaction')
    const result = await this.tx(async (tx) => {
      const child = new DbSql(tx, null, null, true)
      return fn(child)
    })
    return result as T
  }

  async close(): Promise<void> {
    if (this.closer) await this.closer()
  }
}

export function wrapPglite(db: PGlite): Sql {
  return new DbSql(
    db as unknown as Queryable,
    async (fn) => db.transaction(async (tx) => fn(tx as unknown as Queryable)),
    async () => {
      await db.close()
    },
    false,
  )
}

export function wrapPool(pool: PoolLike): Sql {
  return new DbSql(
    {
      query: (text, params) => pool.query(text, params),
    },
    async (fn) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({
          query: (text, params) => client.query(text, params),
          exec: async (text) => {
            await client.query(text)
          },
        })
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally {
        client.release()
      }
    },
    async () => {
      await pool.end()
    },
    false,
  )
}

/** In-memory Postgres when no URL is set. Neon serverless driver when DATABASE_URL is set. */
export async function openDatabase(url: string | undefined): Promise<Sql> {
  if (!url) return wrapPglite(new PGlite({ extensions: { vector } }))
  if (!globalThis.WebSocket) neonConfig.webSocketConstructor = ws
  const pool = new Pool({ connectionString: url })
  return wrapPool(pool as unknown as PoolLike)
}
