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
 * ─── ONE WINDOW PER TICK, NEWEST FIRST, SIX HOURS BACK ─────────────────────────────────────
 * The cap stays 1 until `route`'s realtime factor is measured on a genuine clinic-length window; it is
 * set from that measurement, not from arithmetic. Do not order oldest-first and do not raise the cap here.
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

/**
 * Offer up to AUTO_DRAIN_BATCH_LIMIT eligible windows to `drainRoomWindow`, newest first.
 *
 * ELIGIBLE: closed, grid-aligned, with a room_day, closed within AUTO_DRAIN_MAX_AGE_HOURS, not refused
 * within AUTO_DRAIN_REFUSAL_COOLDOWN_MINUTES, and no `room_window` job already queued or running for it.
 * The room's Transcript switch is NOT checked here — `drainRoomWindow` checks it on entry and answers
 * `flag_off`, which the cooldown then records.
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
  const windows = (await sql`
    SELECT w.id
      FROM bench_window w
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
     ORDER BY w.closed_at DESC
     LIMIT ${limit}
  `) as Array<{ id: string }>;
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
