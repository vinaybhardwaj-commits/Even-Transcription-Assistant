/**
 * lib/stt/auto-drain.ts — Slice S1. Find recently closed room windows and hand each to the drain.
 *
 * ─── THE MISSING LINK ─────────────────────────────────────────────────────────────────────
 * A window closing (lib/bench-window.ts) inserts a legacy `stt_subject_job` row and stops. Nothing
 * drained it: `drainRoomWindow` was only reachable from two admin-authenticated routes, so a room
 * transcribed only when a person clicked. This is the scheduled caller, on a five-minute cron
 * (/api/admin/drain-windows), mirroring /api/admin/diarize-windows.
 *
 * `drainRoomWindow` does its own guards (actor, Transcript switch, state, grid, room_day, length, join
 * config), its own claim, and its own `room_window` submit. This file chooses which windows to offer
 * it, and does not re-check what it checks. It WRITES two things, and only these:
 *
 *   - the legacy queue row, via enqueueSubject, BEFORE the drain (FIX2 C1). The drain's retry bound is
 *     that row's `attempts`; a window that closed while Transcript was off never got one, so a failure
 *     counted 0 attempts, the window went back to `closed`, and it was retried every tick. The admin
 *     doors enqueue first for the same reason. ON CONFLICT DO NOTHING, so an existing row is untouched.
 *   - bench_window.auto_drain_refused_at / _reason (0092, FIX2 C6): set on any step but `enqueued`,
 *     cleared on `enqueued`. A refusal that returns before the claim leaves the window `closed`; without
 *     the cooldown the same refused window held the one slot on every tick.
 *
 * ─── ONE WINDOW PER TICK, SIX HOURS BACK ─────────────────────────────────────────────────────
 * The cap stays 1 until `route`'s realtime factor is measured on a genuine clinic-length window; it is
 * set from that measurement, not from arithmetic. Do not order oldest-first and do not raise the cap here.
 *
 * ─── FAIR ACROSS ROOMS, NEWEST FIRST WITHIN A ROOM (E17) ─────────────────────────────────────
 * The order was `closed_at DESC` over all windows. Each kiosk closes its windows at a fixed offset after
 * every grid line (sd 0.0 s within one kiosk run), so the same room was "newest" on every tick and a
 * second room got nothing for as long as neither kiosk restarted: live, 25 of 25 slots to one room and
 * zero to a room holding 113 windows. Now:
 *   - ROOMS are ranked first: least recently served first. "Served" is a `room_window` job created for
 *     one of the room's windows within AUTO_DRAIN_MAX_AGE_HOURS (the drain's own submit writes it, so no
 *     new column; the scan is bounded by jobs in that horizon, not by the backlog). A room with no such
 *     job ranks first.
 *   - ONE window per room per tick, so a room cannot take two slots while another waits.
 *   - WITHIN a room, newest first by the window's grid slot (`end_ms`), which is cut from the recorder's
 *     own chunk timestamps. Not `closed_at`: that is stamped when the covering chunk is verified, and a
 *     window verified 18 hours late would arrive "fresh" and jump material recorded minutes ago (R6).
 * This redistributes the slots; it does not add any. Capacity is still one window per tick.
 *
 * SHIPS DARK behind ROOM_AUTO_DRAIN_ENABLED. Unset, this is a clean no-op: no scan, no write, no drain.
 */

import { sql } from "@/lib/db";
import { parseFlag } from "@/lib/flags";
import { SYSTEM_ACTOR, actorProblem, type RunActor } from "@/lib/stt/receipt";
import { drainRoomWindow } from "@/lib/stt/room-drain";
import { enqueueSubject } from "@/lib/stt/fanout";
import { ROOM_WINDOW_KIND } from "@/lib/jobs/kinds/room-window-kind";

export const ROOM_AUTO_DRAIN_ENABLED_ENV = "ROOM_AUTO_DRAIN_ENABLED";

/**
 * PURE — an integer setting from the environment, clamped. Unset, empty, or not a whole number
 * gives the default: every default here is the conservative value, so a typo can never widen the
 * pass. A value outside the range is clamped to it.
 */
export function clampedIntEnv(
  name: string,
  def: number,
  min: number,
  max: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[name] ?? "").trim();
  if (!/^-?\d+$/.test(raw)) return def;
  return Math.max(min, Math.min(max, Number(raw)));
}

/** Windows offered to the drain per tick. Default 1, env override clamped to 1..10. */
export const AUTO_DRAIN_BATCH_LIMIT = clampedIntEnv("AUTO_DRAIN_BATCH_LIMIT", 1, 1, 10);

/** Only windows closed within this many hours are offered. Default 6, env override clamped to 1..48. */
export const AUTO_DRAIN_MAX_AGE_HOURS = clampedIntEnv("AUTO_DRAIN_MAX_AGE_HOURS", 6, 1, 48);

/** A window the drain refused is not offered again for this many minutes. Default 60, clamped to 5..1440. */
export const AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES = clampedIntEnv("AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES", 60, 5, 1440);

export type AutoDrainResult = {
  enqueued: number;
  considered: number;
  results: Array<{ window_id: string; step: string; detail?: string; job_id?: string }>;
};

/** An eligible window as the scan returns it. Times are epoch ms; `last_served_ms` is the room's, or null. */
export type DrainCandidate = {
  id: string;
  room_id: string;
  start_ms: number;
  end_ms: number;
  closed_ms: number;
  last_served_ms: number | null;
};

/**
 * PURE — the E17 order. From every eligible window, the windows to offer this tick:
 *   1. per room, the newest window by grid slot (`end_ms`, then `start_ms`; `closed_ms` and `id` only break
 *      an exact tie, e.g. two lanes of one slot);
 *   2. rooms least recently served first — never served (null) before any served room — then the room whose
 *      chosen window is newest, then `room_id`, so the order is total and repeatable;
 *   3. at most `limit` windows, one per room.
 */
export function orderAutoDrainOffers(candidates: DrainCandidate[], limit: number): DrainCandidate[] {
  const newer = (a: DrainCandidate, b: DrainCandidate) =>
    b.end_ms - a.end_ms || b.start_ms - a.start_ms || b.closed_ms - a.closed_ms || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const perRoom = new Map<string, DrainCandidate>();
  for (const c of candidates) {
    const held = perRoom.get(c.room_id);
    if (!held || newer(c, held) < 0) perRoom.set(c.room_id, c);
  }
  const served = (c: DrainCandidate) => (c.last_served_ms === null ? -Infinity : c.last_served_ms);
  return [...perRoom.values()]
    .sort((a, b) => served(a) - served(b) || newer(a, b) || (a.room_id < b.room_id ? -1 : a.room_id > b.room_id ? 1 : 0))
    .slice(0, Math.max(0, limit));
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Offer up to AUTO_DRAIN_BATCH_LIMIT eligible windows to `drainRoomWindow`, in `orderAutoDrainOffers` order.
 *
 * ELIGIBLE: in a room with Transcript on, closed, grid-aligned, with a room_day, closed within
 * AUTO_DRAIN_MAX_AGE_HOURS, not refused within AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES, and no `room_window`
 * job already queued or running for it. `drainRoomWindow` still checks the Transcript switch on entry and
 * is the authority; a switch turned off between the scan and the drain answers `flag_off`, which the
 * cooldown records.
 *
 * ACTOR: `SYSTEM_ACTOR` through the cron door unless the caller names a person. An unusable actor is
 * refused as a batch, before anything is read or written.
 *
 * THROWS on an unrecognised flag value, an unusable actor, or a failed read or write, so the route
 * reports failure: an empty result must only ever mean "nothing eligible", never "could not look".
 */
export async function enqueueAutoDrain(
  origin: string,
  opts: { limit?: number; log?: (m: string) => void; actor?: RunActor } = {},
): Promise<AutoDrainResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result: AutoDrainResult = { enqueued: 0, considered: 0, results: [] };

  if (!parseFlag(ROOM_AUTO_DRAIN_ENABLED_ENV)) {
    log(`[auto-drain] ${ROOM_AUTO_DRAIN_ENABLED_ENV} is off — draining nothing (this is the shipped state)`);
    return result;
  }

  const actor: RunActor = opts.actor ?? { actor: SYSTEM_ACTOR, via: "cron" };
  const problem = actorProblem(actor);
  if (problem) throw new Error(`auto-drain refused: ${problem}`);

  const limit = Math.max(1, Math.min(AUTO_DRAIN_BATCH_LIMIT, Math.trunc(opts.limit ?? AUTO_DRAIN_BATCH_LIMIT) || AUTO_DRAIN_BATCH_LIMIT));
  // THE TRANSCRIPT FILTER (FIX3b C8) is a join, applied BEFORE the LIMIT, so a window in a room with
  // Transcript off never takes the slot and never gets a legacy row (which would drop it out of the room
  // card's "waiting" count). It reads room.transcript_enabled DIRECTLY — the column lib/room-switches
  // reads — because that module has only per-room readers, and a per-room check after the LIMIT would
  // let Transcript-off windows hold the slot again. drainRoomWindow's isTranscriptEnabled on entry stays
  // the authority; this is an optimisation on top. An unknown room drops out of the join: fail closed,
  // as the helper does.
  // Every filter is applied in SQL, before any ranking, exactly as before; the scan returns all eligible
  // windows (bounded by AUTO_DRAIN_MAX_AGE_HOURS) and orderAutoDrainOffers picks the slot(s). LAST SERVED:
  // the newest `room_window` job per room inside the same horizon. `status IN (...)` lists 0082's five
  // CHECKed states so the (status, created_at) index can bound the job scan to the horizon.
  const eligible = (await sql`
    WITH served AS (
      SELECT ss.room_id, MAX(j.created_at) AS last_served_at
        FROM scribe_job j
        JOIN bench_window sw ON sw.id = j.args->>'window_id'
        JOIN bench_session ss ON ss.id = sw.session_id
       WHERE j.kind = ${ROOM_WINDOW_KIND}
         AND j.status IN ('queued', 'running', 'done', 'failed', 'cancelled')
         AND j.created_at >= NOW() - (${AUTO_DRAIN_MAX_AGE_HOURS}::int * INTERVAL '1 hour')
       GROUP BY ss.room_id
    )
    SELECT w.id, s.room_id, w.start_ms, w.end_ms,
           (EXTRACT(EPOCH FROM w.closed_at) * 1000)::float8 AS closed_ms,
           (EXTRACT(EPOCH FROM served.last_served_at) * 1000)::float8 AS last_served_ms
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
      LEFT JOIN served ON served.room_id = s.room_id
     WHERE w.state = 'closed'
       AND w.grid_aligned = TRUE
       AND w.room_day_id IS NOT NULL
       AND w.closed_at >= NOW() - (${AUTO_DRAIN_MAX_AGE_HOURS}::int * INTERVAL '1 hour')
       AND (w.auto_drain_refused_at IS NULL
            OR w.auto_drain_refused_at < NOW() - (${AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES}::int * INTERVAL '1 minute'))
       AND NOT EXISTS (
         SELECT 1 FROM scribe_job j
          WHERE j.kind = ${ROOM_WINDOW_KIND}
            AND j.args->>'window_id' = w.id
            AND j.status IN ('queued', 'running')
       )
  `) as Array<Record<string, unknown>>;
  const windows = orderAutoDrainOffers(
    eligible.map((e) => ({
      id: String(e.id), room_id: String(e.room_id),
      start_ms: num(e.start_ms) ?? 0, end_ms: num(e.end_ms) ?? 0, closed_ms: num(e.closed_ms) ?? 0,
      last_served_ms: num(e.last_served_ms),
    })),
    limit,
  );
  result.considered = windows.length;

  for (const w of windows) {
    // The legacy row first, so the drain's attempt bound has something to count on (C1).
    await enqueueSubject("bench_window", w.id, "asr");
    // drainRoomWindow never throws: every outcome is a named step, reported per window.
    const out = await drainRoomWindow(w.id, origin, actor);
    result.results.push({
      window_id: w.id, step: out.step,
      ...(out.detail ? { detail: out.detail } : {}),
      ...(out.job_id ? { job_id: out.job_id } : {}),
    });
    if (out.step === "enqueued") {
      result.enqueued += 1;
      await sql`UPDATE bench_window SET auto_drain_refused_at = NULL, auto_drain_refused_reason = NULL WHERE id = ${w.id}`;
    } else {
      await sql`UPDATE bench_window SET auto_drain_refused_at = NOW(), auto_drain_refused_reason = ${out.step} WHERE id = ${w.id}`;
    }
  }
  log(`[auto-drain] enqueued ${result.enqueued} of ${result.considered} considered window(s) (cap ${limit}, ${AUTO_DRAIN_MAX_AGE_HOURS} h, cooldown ${AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES} min)`);
  return result;
}
