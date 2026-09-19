/**
 * lib/night-drain/store.ts — every statement the night drain sends to the database, in one place.
 *
 * The SQL here was checked against the LIVE schema (read-only) on 19 Sep 2026: bench_window,
 * bench_chunk, room_diarize_window, diarize_slot and scribe_job all have the columns used below, and
 * `slot` is the primary key of diarize_slot. It is exercised in tests against a real postgres:16.
 *
 * ─── THE CLAIM IS ONE STATEMENT ───────────────────────────────────────────────────────────────
 * Ruling D: the lease lives in `diarize_slot`, the same table (and the same atomic idiom) that
 * lib/diarize-gate.ts uses for the Mini's one diarize slot. The key is `night:<window_id>`, so the
 * lease is PER WINDOW; the global `diarize` key is still taken, per call, by `runDiarize`, which is
 * what makes the drain yield to a live encounter instead of racing it.
 *
 * `claimNext` picks the oldest eligible window that no live lease covers and takes its lease in the
 * SAME statement: INSERT … ON CONFLICT (slot) DO UPDATE … WHERE expires_at < now() RETURNING. The
 * primary key arbitrates. Two workers that pick the same candidate both INSERT; one wins, the other's
 * conflicting UPDATE is filtered out by the WHERE and returns no row. There is no SELECT-then-UPDATE.
 *
 * WHY NOT `scribe_job`: Vercel's every-minute runner claims ANY queued job, or a running one whose lease
 * expired, whatever its kind. A drain job would have been run by Vercel at 3 pm.
 *
 * A LEASE THAT EXPIRES RETURNS THE WINDOW TO THE QUEUE, because the lease is the only thing standing
 * between a window and the candidate list. The terminal state is the ROW in room_diarize_window: a
 * window with a final row is not a candidate, so a restart can never redo a finished window.
 */
import type { RangeChunk } from "@/lib/bench-range";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sql = (strings: TemplateStringsArray, ...values: any[]) => PromiseLike<unknown[]>;

export const LEASE_KEY_PREFIX = "night:";

/**
 * Lease length: 600 s. The worker's own hard cap for one window is 480 s (fetch + join + a diarize call
 * bounded by DIARIZE_TIMEOUT_MS, 300 s by default), and measured service time is 64–71 s. The lease must
 * outlast the hard cap so a live worker never loses its window; it should not be much longer, so a
 * crashed worker's window comes back the same night.
 */
export const LEASE_SECONDS = 600;
export const WINDOW_HARD_CAP_MS = 480_000;

/** A failed window is not offered again until this long after its last attempt. */
export const RETRY_COOLDOWN_SECONDS = 1800;

/** How long a deferred window is parked before the drain will take it again. */
export const PARK_SECONDS = 900;

export type ClaimedWindow = {
  id: string;
  session_id: string;
  room_day_id: string;
  start_ms: number;
  end_ms: number;
  source: "primary" | "backup";
  is_retry: boolean;
};

export type Remaining = {
  never_handled: number;
  retry_pending: number;
  /** Failed windows that have used every attempt. Visible so a stuck window is never silent. */
  exhausted: number;
  /** Windows closed in the last 24 hours — the growth the drain has to outrun. */
  closed_last_24h: number;
};

type Row = Record<string, unknown>;

const toClaimed = (r: Row): ClaimedWindow => ({
  id: String(r.id),
  session_id: String(r.session_id),
  room_day_id: String(r.room_day_id),
  start_ms: Number(r.start_ms),
  end_ms: Number(r.end_ms),
  source: r.source_mic === "backup" ? "backup" : "primary",
  is_retry: r.is_retry === true,
});

export function makeStore(sql: Sql, maxAttempts: number) {
  return {
    /** Claim the next window. Null when nothing is claimable right now. NEVER two workers on one window. */
    async claimNext(holder: string): Promise<ClaimedWindow | null> {
      const rows = (await sql`
        WITH cand AS (
          SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic,
                 (d.window_id IS NOT NULL) AS is_retry
            FROM bench_window w
            LEFT JOIN room_diarize_window d ON d.window_id = w.id
           WHERE w.state IN ('closed', 'transcribed')
             AND w.grid_aligned = TRUE
             AND w.room_day_id IS NOT NULL
             AND (d.window_id IS NULL
                  OR (d.state = 'failed' AND d.attempts < ${maxAttempts}
                      AND d.diarized_at < now() - make_interval(secs => ${RETRY_COOLDOWN_SECONDS})))
             AND NOT EXISTS (SELECT 1 FROM diarize_slot s
                              WHERE s.slot = ${LEASE_KEY_PREFIX} || w.id AND s.expires_at >= now())
             AND NOT EXISTS (SELECT 1 FROM scribe_job j
                              WHERE j.kind = 'diarize_window' AND j.args->>'window_id' = w.id
                                AND j.status IN ('queued', 'running'))
           ORDER BY (d.window_id IS NOT NULL) ASC, w.end_ms ASC, w.id ASC
           LIMIT 1
        ), claimed AS (
          INSERT INTO diarize_slot (slot, holder, acquired_at, expires_at)
          SELECT ${LEASE_KEY_PREFIX} || c.id, ${holder}, now(), now() + make_interval(secs => ${LEASE_SECONDS})
            FROM cand c
          ON CONFLICT (slot) DO UPDATE
             SET holder = EXCLUDED.holder, acquired_at = now(), expires_at = EXCLUDED.expires_at
           WHERE diarize_slot.expires_at < now()
          RETURNING slot
        )
        SELECT c.id, c.session_id, c.room_day_id, c.start_ms, c.end_ms, c.source_mic, c.is_retry
          FROM cand c JOIN claimed ON claimed.slot = ${LEASE_KEY_PREFIX} || c.id
      `) as Row[];
      return rows[0] ? toClaimed(rows[0]) : null;
    },

    /** Give the lease back. Only the holder can. Returns whether a lease row was removed. */
    async release(windowId: string, holder: string): Promise<boolean> {
      const rows = (await sql`
        DELETE FROM diarize_slot WHERE slot = ${(LEASE_KEY_PREFIX + windowId)} AND holder = ${holder}
        RETURNING slot
      `) as Row[];
      return rows.length > 0;
    },

    /**
     * PARK a window the drain could not fairly try (infrastructure trouble): keep OUR lease and push its
     * expiry out, so the oldest-first order does not hand the same window straight back. Only the holder can.
     */
    async park(windowId: string, holder: string, seconds: number): Promise<boolean> {
      const rows = (await sql`
        UPDATE diarize_slot SET expires_at = now() + make_interval(secs => ${seconds})
         WHERE slot = ${LEASE_KEY_PREFIX + windowId} AND holder = ${holder}
        RETURNING slot
      `) as Row[];
      return rows.length > 0;
    },

    /**
     * READ-ONLY twin of claimNext, for the dry-run modes: the same predicate and the same order, no lease.
     * A test proves the two agree on every seeded state.
     */
    async peek(limit: number): Promise<ClaimedWindow[]> {
      const rows = (await sql`
        SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic,
               (d.window_id IS NOT NULL) AS is_retry
          FROM bench_window w
          LEFT JOIN room_diarize_window d ON d.window_id = w.id
         WHERE w.state IN ('closed', 'transcribed')
           AND w.grid_aligned = TRUE
           AND w.room_day_id IS NOT NULL
           AND (d.window_id IS NULL
                OR (d.state = 'failed' AND d.attempts < ${maxAttempts}
                    AND d.diarized_at < now() - make_interval(secs => ${RETRY_COOLDOWN_SECONDS})))
           AND NOT EXISTS (SELECT 1 FROM diarize_slot s
                            WHERE s.slot = ${LEASE_KEY_PREFIX} || w.id AND s.expires_at >= now())
           AND NOT EXISTS (SELECT 1 FROM scribe_job j
                            WHERE j.kind = 'diarize_window' AND j.args->>'window_id' = w.id
                              AND j.status IN ('queued', 'running'))
         ORDER BY (d.window_id IS NOT NULL) ASC, w.end_ms ASC, w.id ASC
         LIMIT ${limit}
      `) as Row[];
      return rows.map(toClaimed);
    },

    /** The convergence numbers logged each night. Counts only. */
    async remaining(): Promise<Remaining> {
      const rows = (await sql`
        SELECT count(*) FILTER (WHERE d.window_id IS NULL)::int AS never_handled,
               count(*) FILTER (WHERE d.state = 'failed' AND d.attempts < ${maxAttempts})::int AS retry_pending,
               count(*) FILTER (WHERE d.state = 'failed' AND d.attempts >= ${maxAttempts})::int AS exhausted,
               (SELECT count(*)::int FROM bench_window
                 WHERE state IN ('closed', 'transcribed') AND closed_at > now() - interval '24 hours') AS closed_last_24h
          FROM bench_window w
          LEFT JOIN room_diarize_window d ON d.window_id = w.id
         WHERE w.state IN ('closed', 'transcribed') AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
           AND (d.window_id IS NULL OR d.state = 'failed')
      `) as Row[];
      const r = rows[0] ?? {};
      return {
        never_handled: Number(r.never_handled ?? 0),
        retry_pending: Number(r.retry_pending ?? 0),
        exhausted: Number(r.exhausted ?? 0),
        closed_last_24h: Number(r.closed_last_24h ?? 0),
      };
    },

    /** The chunks production's own join sees for this window's session — room-drain's exact query. */
    async chunksForSession(sessionId: string): Promise<RangeChunk[]> {
      const rows = (await sql`
        SELECT idx, source, r2_key, content_type, started_at, ended_at, upload_state
          FROM bench_chunk WHERE session_id = ${sessionId} ORDER BY source, idx
      `) as Row[];
      return rows.map((r) => ({
        idx: Number(r.idx),
        // A null source is a primary-stream chunk, as resolveRange itself reads it.
        source: r.source === "backup" ? "backup" : "primary",
        r2_key: String(r.r2_key),
        content_type: String(r.content_type),
        started_at: r.started_at as string | Date,
        ended_at: r.ended_at as string | Date,
        upload_state: String(r.upload_state ?? ""),
      }));
    },
  };
}

export type Store = ReturnType<typeof makeStore>;
