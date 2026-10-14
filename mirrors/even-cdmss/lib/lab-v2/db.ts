/**
 * lib/lab-v2/db.ts — the v2 store's connection layer (LAB-MCP-V2-PRD-v1.0 §14.1, decision 8).
 *
 * V2 state lives in a SEPARATE Neon database addressed by LAB_V2_DATABASE_URL. That is the
 * whole of decision 8: research state cannot reach a production table if it is not in the
 * same database as one. Production audits are read elsewhere, over DATABASE_URL, through
 * the existing read paths — never from here.
 *
 * ⚠️ THIS MODULE REFUSES TO OPEN DATABASE_URL. Not "prefers not to" — refuses, and throws.
 * A fallback would be the single most expensive line in the platform: every table name
 * below also exists conceptually in production, so a v2 store that quietly opened the
 * production database would run migrations against it and write research rows into it.
 * An unconfigured deployment must be a DEAD one (§13: endpoint 503), never a
 * production-writing one.
 *
 * Two implementations, one interface. `postgres()` is node-postgres against Neon for the
 * real thing; `embedded()` is PGlite in-process for tests, so the whole store — claim,
 * lease, reap, budget arithmetic — is exercised against real SQL semantics (FOR UPDATE
 * SKIP LOCKED, transactional rollback) with no network and no fixture database.
 */
import type { Pool as PgPool, PoolClient } from 'pg';
import { LabError } from '../lab-execution-context';

/** The narrow surface the store needs. Deliberately not a leaky `pg` re-export. */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  /**
   * Run a MULTI-STATEMENT script (a migration file). Separate from `query` because the
   * extended wire protocol both drivers use for parameterised queries accepts exactly one
   * statement — PGlite rejects a whole migration with a bare syntax error otherwise, and
   * node-postgres only tolerates it because it falls back to the simple protocol when
   * there are no parameters. Making the distinction explicit means a migration cannot be
   * accidentally routed through the parameterised path.
   */
  exec(sql: string): Promise<void>;
  /** Runs `fn` inside BEGIN/COMMIT, rolling back on any throw. Nestable calls reuse the tx. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** §13 — the v2 database URL, or a typed refusal. Never falls back to DATABASE_URL. */
export function labV2Url(): string {
  const url = process.env.LAB_V2_DATABASE_URL;
  if (!url) throw new LabError('NOT_CONFIGURED', 'LAB_V2_DATABASE_URL is not set');
  const prod = process.env.DATABASE_URL;
  if (prod && url === prod) {
    throw new LabError('NOT_CONFIGURED', 'LAB_V2_DATABASE_URL must not equal DATABASE_URL — v2 state never shares the production database (decision 8)');
  }
  return url;
}

export function labV2Configured(): boolean {
  const url = process.env.LAB_V2_DATABASE_URL;
  return !!url && url !== process.env.DATABASE_URL;
}

let _pool: PgPool | null = null;

/**
 * The production connection. `max: 5` because this runs on Vercel functions where each
 * instance holds its own pool and Neon's connection budget is shared with the (much
 * busier) production Neon client; `statement_timeout` bounds a runaway claim query so a
 * stuck tick cannot hold a lease row forever; `application_name` makes v2's connections
 * identifiable in Neon's own dashboards, which matters the first time someone asks which
 * workload is holding a lock.
 */
export async function postgres(): Promise<Db> {
  const url = labV2Url();
  if (!_pool) {
    const { Pool } = await import('pg');
    _pool = new Pool({
      connectionString: url,
      max: 5,
      application_name: 'cdmss-lab-v2',
      statement_timeout: 15000,
    });
  }
  const pool = _pool;
  const wrapClient = (client: PoolClient): Db => ({
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const r = await client.query(text, params as unknown[]);
      return r.rows as T[];
    },
    async exec(text: string): Promise<void> { await client.query(text); },
    // Already inside a transaction: reuse it rather than opening a nested one.
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> { return fn(wrapClient(client)); },
    async close() { /* the outer transaction owns this client's lifetime */ },
  });
  return {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const r = await pool.query(text, params as unknown[]);
      return r.rows as T[];
    },
    async exec(text: string): Promise<void> { await pool.query(text); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(wrapClient(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* the original error is the one that matters */ }
        throw e;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); _pool = null; },
  };
}

/**
 * The test store. PGlite is a real Postgres compiled to WASM, so the store's SQL is the
 * SQL that ships — including `FOR UPDATE SKIP LOCKED`, which a mock would have to fake
 * and which is exactly the line the concurrent-claim test needs to be real.
 */
export async function embedded(): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  let depth = 0;
  const self: Db = {
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const r = await pg.query(text, params as unknown[]);
      return (r.rows ?? []) as T[];
    },
    async exec(text: string): Promise<void> { await pg.exec(text); },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      if (depth > 0) return fn(self);          // already in a tx — reuse, don't nest
      depth += 1;
      try {
        await pg.exec('BEGIN');
        const out = await fn(self);
        await pg.exec('COMMIT');
        return out;
      } catch (e) {
        try { await pg.exec('ROLLBACK'); } catch { /* surface the original */ }
        throw e;
      } finally {
        depth -= 1;
      }
    },
    async close() { await pg.close(); },
  };
  return self;
}

/**
 * Wrap any store failure as STORE_UNAVAILABLE (§13). A dead v2 database is a tool error
 * with a name the caller can act on, never a 500 and never a stack trace on the wire.
 */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LabError) throw e;
    throw new LabError('STORE_UNAVAILABLE', `lab v2 store unavailable: ${(e as Error).message}`);
  }
}
