/**
 * brain/src/db.ts — Neon access for the Ambient Brain (Cloud Run).
 *
 * The brain does NOT reuse the app's lib/db.ts (Neon HTTP + drizzle). It owns
 * a plain `pg` Pool over BRAIN_DATABASE_URL (dedicated role, decision B8) —
 * we need real sessions for pg_advisory_xact_lock + BEGIN/COMMIT, which the
 * HTTP driver cannot give us.
 *
 * Lazy initialization (same convention as lib/db.ts): the pool is built on
 * first use so the process boots and /health answers even when the env var
 * is missing; callers get a thrown Error which the server turns into
 * { ok:false }.
 *
 * Errors: the pool's 'error' event (idle-client failures) is handled — an
 * unhandled one would crash the process, which A.6 forbids.
 */

import pg from "pg";

const { Pool } = pg;

let _pool: pg.Pool | null = null;

/** Where the env var name lives — used in messages, never the value. */
export const DB_URL_ENV = "BRAIN_DATABASE_URL";

/**
 * Split the connection string into { url, ssl } so TLS behaviour is explicit.
 * pg 8.13 honours `sslmode=require` but logs a deprecation warning per pool;
 * we strip it and set ssl ourselves: verified TLS unless `sslmode=disable`.
 */
function normalize(raw: string): { connectionString: string; ssl: false | { rejectUnauthorized: true } } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    // Not URL-shaped (e.g. key=value libpq form). Hand it to pg untouched.
    return { connectionString: raw, ssl: { rejectUnauthorized: true } };
  }
  const mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  return {
    connectionString: u.toString(),
    ssl: mode === "disable" ? false : { rejectUnauthorized: true },
  };
}

function init(): pg.Pool {
  if (_pool) return _pool;
  const raw = process.env[DB_URL_ENV];
  if (!raw) {
    throw new Error(`${DB_URL_ENV} not set. Configure it on the Cloud Run service (see brain/README-DEPLOY.md).`);
  }
  const { connectionString, ssl } = normalize(raw);
  const pool = new Pool({
    connectionString,
    ssl,
    max: 5, // min-instances 1, one container: small pool, Neon-friendly
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: "even-scribe-brain",
  });
  pool.on("error", (err) => {
    // Idle client dropped (Neon scale-to-zero, network blip). Log and carry on;
    // the next query checks out a fresh client.
    console.error(JSON.stringify({ at: new Date().toISOString(), lvl: "error", where: "pg-pool", msg: String(err?.message ?? err) }));
  });
  _pool = pool;
  return pool;
}

/** The shared pool (lazily created). Throws if BRAIN_DATABASE_URL is unset. */
export function getPool(): pg.Pool {
  return init();
}

/** Run one query on the pool. Thin wrapper so callers don't touch pg directly. */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult<R>> {
  return init().query<R>(text, params);
}

/** Probe for /health: SELECT 1 with latency. Never throws. */
export async function probe(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await query("SELECT 1 AS ok");
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: String((e as Error)?.message ?? e) };
  }
}

/** Graceful shutdown (SIGTERM from Cloud Run). Safe to call when never initialized. */
export async function closePool(): Promise<void> {
  const p = _pool;
  _pool = null;
  if (p) await p.end().catch(() => undefined);
}

export type { PoolClient } from "pg";
