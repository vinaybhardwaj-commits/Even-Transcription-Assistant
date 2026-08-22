/**
 * lib/brain/db.ts — Neon access for the Ambient Brain routes (/api/brain/*).
 *
 * PORTED from brain/src/db.ts (Kickoff A2, decision B10). Two changes, both forced by
 * the app's hard rules: (1) the app gains ZERO deps, so the driver is the app's existing
 * @neondatabase/serverless — its WebSocket `Pool` (NOT the http `neon()` helper: the /cues
 * transaction needs BEGIN → advisory lock → SET LOCAL → insert → reads → COMMIT on ONE
 * session, which the HTTP driver cannot do); (2) `sslmode` is left in the URL untouched —
 * the WS driver terminates TLS at the wss:// hop (forceDisablePgSSL default) and ignores it.
 *
 * Deliberately NOT lib/db.ts: that is the app's Neon HTTP + drizzle handle on
 * APP_DATABASE_URL. The brain has its own role (BRAIN_DATABASE_URL, decision B8) and its
 * own pool. Existing app code is untouched.
 *
 * Lazy initialization: nothing connects at import, so `next build` and every other route
 * are unaffected when BRAIN_DATABASE_URL is absent — callers get a thrown BrainConfigError
 * which the routes turn into 503 { ok:false, error:"brain_db_not_configured" }.
 *
 * WebSocket: on Node ≥ 22 (Vercel project runs 24.x) the driver uses the global WebSocket.
 * If it is somehow missing, health says so and routes fail closed with 503 — never a crash.
 */

import { Pool, neonConfig } from "@neondatabase/serverless";
import type { PoolClient, QueryResult, QueryResultRow } from "@neondatabase/serverless";

export const DB_URL_ENV = "BRAIN_DATABASE_URL";
export const TOKEN_ENV = "BRAIN_SERVICE_TOKEN";

/** Thrown (and caught by the routes) when the brain cannot run for a configuration reason. */
export class BrainConfigError extends Error {
  constructor(public code: "brain_db_not_configured" | "brain_ws_unavailable") {
    super(code);
  }
}

let _pool: Pool | null = null;

/** Does the driver have a WebSocket implementation to use? (global on Node ≥ 22.) */
export function wsAvailable(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function" || neonConfig.webSocketConstructor !== undefined;
}

/** Configuration snapshot for /api/brain/health — names and booleans only, never values. */
export function brainConfigStatus(): { db_env_set: boolean; token_env_set: boolean; ws_available: boolean; missing: string[] } {
  const db_env_set = Boolean(process.env[DB_URL_ENV]);
  const token_env_set = Boolean(process.env[TOKEN_ENV]);
  const missing: string[] = [];
  if (!db_env_set) missing.push(DB_URL_ENV);
  if (!token_env_set) missing.push(TOKEN_ENV);
  return { db_env_set, token_env_set, ws_available: wsAvailable(), missing };
}

function init(): Pool {
  if (_pool) return _pool;
  const connectionString = process.env[DB_URL_ENV];
  if (!connectionString) throw new BrainConfigError("brain_db_not_configured");
  if (!wsAvailable()) throw new BrainConfigError("brain_ws_unavailable");
  const pool = new Pool({
    connectionString,
    max: 5, // one function instance: small pool, Neon-friendly
    idleTimeoutMillis: 10_000, // serverless: don't hold WS sessions across long idles
    connectionTimeoutMillis: 8_000,
    application_name: "even-scribe-brain-app",
  });
  pool.on("error", (err) => {
    // Idle client dropped (function suspended, Neon blip). Log and carry on; the next
    // query checks out a fresh client. Unhandled, this would take the function down.
    console.error(JSON.stringify({ at: new Date().toISOString(), lvl: "error", where: "brain-pool", msg: String(err?.message ?? err) }));
  });
  _pool = pool;
  return pool;
}

/** The shared pool (lazily created). Throws BrainConfigError when unconfigured. */
export function getPool(): Pool {
  return init();
}

/** Run one query on the pool. */
export async function query<R extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<R>> {
  return init().query<R>(text, params);
}

/** Probe for /health: SELECT 1 with latency. Never throws. */
export async function probe(): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    await query("SELECT 1 AS ok");
    return { ok: true, latency_ms: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof BrainConfigError ? e.code : String((e as Error)?.message ?? e);
    return { ok: false, latency_ms: Date.now() - t0, error: msg };
  }
}

export type { PoolClient };

// ── shared route plumbing (kept here so the three routes stay thin) ─────────────

/** One JSON line per event (Vercel log drain parses it). Never called with a payload. */
export function brainLog(lvl: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), lvl, msg, ...extra });
  if (lvl === "error") console.error(line);
  else console.log(line);
}

/**
 * Map a thrown error to the { status, code } the routes send. Codes match the Kickoff A
 * report; the ONE change (A2 rule 2, "never 500 on the recorder path"): DB/unknown faults
 * are 503 brain_unavailable rather than 500 internal_error.
 */
export function classifyBrainError(e: unknown): { status: number; code: string; hint?: string; log: boolean } {
  if (e instanceof BrainConfigError) return { status: 503, code: e.code, log: false };
  const err = e as { code?: string; message?: string };
  const pgCode = typeof err?.code === "string" ? err.code : undefined;
  if (pgCode === "23503") return { status: 404, code: "unknown_room", log: false }; // FK: room vanished between check and insert
  if (pgCode === "42P01") return { status: 503, code: "brain_tables_missing", hint: "run migration 0042 via /api/run-migrations", log: true };
  // Fuse slice 2: the scratch path reads room_day.scratch and writes cue.session_id / cue.source.
  // Between the deploy and migration 0046 those columns do not exist yet; say which migration is
  // missing rather than hide it inside brain_unavailable. The live path touches no new column.
  if (pgCode === "42703") return { status: 503, code: "brain_columns_missing", hint: "run migration 0046 via /api/run-migrations", log: true };
  // K3 follow-up: the third "you forgot part of the schema" case, and the one that cost an hour.
  // The brain role is granted its verbs OUT OF BAND, so a statement using a verb no previous
  // statement used fails at runtime with a code the server already knew and the caller never saw.
  // That is exactly what happened when K3's batch path issued the first DELETE FROM cue ever
  // written here: 503 brain_unavailable at the door, `permission denied for table cue` visible
  // only in the log. A privilege gap is not an outage — it is a missing GRANT, and the answer
  // fits in the hint.
  if (pgCode === "42501") {
    return {
      status: 503,
      code: "brain_permission_denied",
      hint: "the brain role is missing a table privilege (e.g. DELETE on cue) — run migration 0053 via /api/run-migrations, which grants them",
      log: true,
    };
  }
  return { status: 503, code: "brain_unavailable", log: true };
}
