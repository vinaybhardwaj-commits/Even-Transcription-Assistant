/**
 * lib/brain/lock.ts — per-room_day write serialization (PRD §15A).
 *
 * PORTED unchanged from brain/src/lock.ts (Kickoff A2) except the driver import.
 *
 * Cues arrive from independent sources (ears, watcher, kiosk). Every write to a room_day's
 * graph runs inside ONE transaction that first takes pg_advisory_xact_lock(hashtext(
 * room_day_id)). The lock is released at COMMIT/ROLLBACK, so load→(fuse, later)→write can
 * never interleave for the same room_day. Different room_days never block each other.
 *
 * hashtext() is int4 → implicit cast to the bigint pg_advisory_xact_lock overload. A hash
 * collision across two room_day ids merely over-serializes; it is never unsafe.
 */

import { getPool, type PoolClient } from "./db";

/** Upper bound on any single statement inside the locked txn (stuck-lock guard). */
const LOCKED_TXN_STATEMENT_TIMEOUT = "10s";

export const SQL_ADVISORY_LOCK = "SELECT pg_advisory_xact_lock(hashtext($1))";

/**
 * Run `fn` inside a transaction holding the room_day advisory lock. Commits on success,
 * rolls back on throw (and rethrows). The client is always released back to the pool.
 */
export async function withRoomDayLock<T>(roomDayId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // SET LOCAL is scoped to this txn; a stuck lock fails this request instead of hanging the pool.
    await client.query(`SET LOCAL statement_timeout = '${LOCKED_TXN_STATEMENT_TIMEOUT}'`);
    await client.query(SQL_ADVISORY_LOCK, [roomDayId]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection may already be gone; release below */
    }
    throw e;
  } finally {
    client.release();
  }
}
