/**
 * lib/stt/auto-drain.ts — Slice S1. Find recently closed room windows and hand each to the drain.
 *
 * ─── THE MISSING LINK ─────────────────────────────────────────────────────────────────────
 * A window closing (lib/bench-window.ts) inserts a legacy `stt_subject_job` row and stops. Nothing
 * drained it: `drainRoomWindow` was only reachable from two admin-authenticated routes, so a room
 * transcribed only when a person clicked. This is the scheduled caller, on a five-minute cron
 * (/api/admin/drain-windows), mirroring /api/admin/diarize-windows.
 *
 * It WRITES NOTHING ITSELF. `drainRoomWindow` does its own guards (actor, Transcript switch, state,
 * grid, room_day, length, join config), its own claim, and its own `room_window` submit. This file
 * only chooses which windows to offer it, and does not re-check what it checks.
 *
 * ─── ONE WINDOW PER TICK, NEWEST FIRST, SIX HOURS BACK ─────────────────────────────────────
 * `route`'s realtime factor on a genuine 900 s window has never been measured. One window per five
 * minutes is 288 a day, more than six recording rooms produce, so live traffic keeps up while the
 * backlog is left alone. The backlog is a separate, deliberate build: do not order oldest-first and
 * do not raise the cap here.
 *
 * SHIPS DARK behind ROOM_AUTO_DRAIN_ENABLED. Unset, this is a clean no-op: no scan, no drain call.
 */

import { sql } from "@/lib/db";
import { parseFlag } from "@/lib/flags";
import { SYSTEM_ACTOR } from "@/lib/stt/receipt";
import { drainRoomWindow } from "@/lib/stt/room-drain";
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

export type AutoDrainResult = {
  enqueued: number;
  considered: number;
  results: Array<{ window_id: string; step: string; job_id?: string }>;
};

/**
 * Offer up to AUTO_DRAIN_BATCH_LIMIT eligible windows to `drainRoomWindow`, newest first.
 *
 * ELIGIBLE: closed, grid-aligned, with a room_day, closed within AUTO_DRAIN_MAX_AGE_HOURS, and no
 * `room_window` job already queued or running for it. The room's Transcript switch is NOT checked
 * here — `drainRoomWindow` checks it on entry and answers `flag_off`.
 *
 * THROWS on an unrecognised flag value or a failed scan, so the route reports failure: an empty
 * result must only ever mean "nothing eligible", never "could not look".
 */
export async function enqueueAutoDrain(
  origin: string,
  opts: { limit?: number; log?: (m: string) => void } = {},
): Promise<AutoDrainResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result: AutoDrainResult = { enqueued: 0, considered: 0, results: [] };

  if (!parseFlag(ROOM_AUTO_DRAIN_ENABLED_ENV)) {
    log(`[auto-drain] ${ROOM_AUTO_DRAIN_ENABLED_ENV} is off — draining nothing (this is the shipped state)`);
    return result;
  }

  const limit = Math.max(1, Math.min(AUTO_DRAIN_BATCH_LIMIT, Math.trunc(opts.limit ?? AUTO_DRAIN_BATCH_LIMIT) || AUTO_DRAIN_BATCH_LIMIT));
  const windows = (await sql`
    SELECT w.id
      FROM bench_window w
     WHERE w.state = 'closed'
       AND w.grid_aligned = TRUE
       AND w.room_day_id IS NOT NULL
       AND w.closed_at >= NOW() - (${AUTO_DRAIN_MAX_AGE_HOURS}::int * INTERVAL '1 hour')
       AND NOT EXISTS (
         SELECT 1 FROM scribe_job j
          WHERE j.kind = ${ROOM_WINDOW_KIND}
            AND j.args->>'window_id' = w.id
            AND j.status IN ('queued', 'running')
       )
     ORDER BY w.closed_at DESC
     LIMIT ${limit}
  `) as Array<{ id: string }>;
  result.considered = windows.length;

  for (const w of windows) {
    // drainRoomWindow never throws: every outcome is a named step, reported per window.
    const out = await drainRoomWindow(w.id, origin, { actor: SYSTEM_ACTOR, via: "cron" });
    result.results.push({ window_id: w.id, step: out.step, ...(out.job_id ? { job_id: out.job_id } : {}) });
    if (out.step === "enqueued") result.enqueued += 1;
  }
  log(`[auto-drain] enqueued ${result.enqueued} of ${result.considered} considered window(s) (cap ${limit}, ${AUTO_DRAIN_MAX_AGE_HOURS} h)`);
  return result;
}
