/**
 * lib/stt/diarize-job.ts — the room diarize SWEEPER (R2-2). It no longer chooses windows to diarize for pyannote.
 *
 * Room diarization is TRIGGERED by the Nemotron ingest (app/api/diarize/nemotron/ingest/route.ts submits the
 * `diarize_window` job when a window's answer is stored). This module is the RECOVERY for a window whose job ended without
 * an ok / no_speakers row — a refused engine, a missing clip, a Mini outage that outlasted the retries, a lost submit — and
 * nothing re-posts, because the worker already got its 200. The scheduled route (/api/admin/diarize-windows, every 5 minutes) calls it:
 * with DIARIZE_NEMOTRON_SHADOW on it submits `diarize_window` for windows `windowsToSweep` returns (answered, row absent or
 * failed, nothing open, fewer than SWEEP_MAX_FAILED_JOBS failed jobs; oldest first, at most SWEEP_LIMIT). No pyannote, no other engine.
 *
 * `ROOM_DIARIZE_ENABLED` is still READ (strictly: a typo still throws) but no value of it matters any more.
 */

import { parseFlag } from "@/lib/flags";
import { nemotronShadowEnabled, pushEngine, DiarizeEngineError } from "@/lib/diarize-engine";
import { blindWindowIds } from "@/lib/room-access/check";
import { SWEEP_LIMIT, SWEEP_MAX_FAILED_JOBS, countSweepExhausted, windowsToSweep } from "@/lib/room-access/nemotron-store";
import { JobArgsError } from "@/lib/jobs/types";

/**
 * THE ON-SWITCH. Renamed from SPEAKER_CLUSTERS_ENABLED in C2: clustering is deleted, and a name that
 * promises clustering on a switch that only enqueues diarize jobs is a name that gets set for the
 * wrong reason.
 *
 * ONE NAME. The old variable is never read for behaviour — reading both would let a stale setting
 * quietly keep a path alive. If it is still present in an environment it is IGNORED, and that is
 * logged loudly, because the operator who set it believes something is on that is not.
 */
export const ROOM_DIARIZE_ENABLED_ENV = "ROOM_DIARIZE_ENABLED";
const RETIRED_ENV = "SPEAKER_CLUSTERS_ENABLED";

/**
 * THE VALUES THIS FLAG UNDERSTANDS are lib/flags.ts's, shared with the emotion flags so no two flags
 * can disagree about what "true" means. Re-exported under the names C2 shipped.
 */
export { FLAG_TRUTHY as ROOM_DIARIZE_TRUTHY, FLAG_FALSY as ROOM_DIARIZE_FALSY, FlagValueError } from "@/lib/flags";

export function roomDiarizeEnabled(env: Record<string, string | undefined> = process.env, log: (m: string) => void = console.error): boolean {
  if ((env[RETIRED_ENV] ?? "").trim() !== "") {
    log(`[room-diarize] ${RETIRED_ENV} is set and is IGNORED — it was renamed ${ROOM_DIARIZE_ENABLED_ENV}. Room diarize enqueue is controlled by ${ROOM_DIARIZE_ENABLED_ENV} only; move the setting.`);
  }
  return parseFlag(ROOM_DIARIZE_ENABLED_ENV, env);
}

/** Windows one sweep tick submits at most (R2-2). */
export const DIARIZE_BATCH_LIMIT = SWEEP_LIMIT;

type Logger = (msg: string) => void;

export type DiarizeEnqueueResult = {
  enabled: boolean;
  /** Windows the sweep found to re-drive this tick. */
  scanned: number;
  enqueued: Array<{ window_id: string; job_id: string; retry_of_attempt: number | null }>;
  /** Windows at the failed-job cap: answered, still no ok row, no longer re-driven. */
  exhausted: number;
  n_blind_excluded: number;
  errors: string[];
  note: string;
};

export const ROOM_DIARIZE_SWEEP_OFF = "sweeper off: DIARIZE_NEMOTRON_SHADOW is off";
export const ROOM_DIARIZE_SWEEP_REFUSED = "sweeper idle: DIARIZE_ENGINE is refused for room diarization";

/**
 * Re-drive the windows whose diarize job left no ok row. Deduped exactly as ingest is (the kind's dedupeOn on window_id, so a
 * window with an open job is never queued twice). A submit that THROWS propagates, like every enqueue: a job that could not be
 * queued must not be counted as queued. A held-out window refused at submit is skipped and not counted.
 */
export async function enqueueDiarizeWindows(
  opts: { limit?: number; log?: Logger; origin?: string; actor: string },
): Promise<DiarizeEnqueueResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result: DiarizeEnqueueResult = { enabled: false, scanned: 0, enqueued: [], exhausted: 0, n_blind_excluded: 0, errors: [], note: "" };
  result.enabled = roomDiarizeEnabled(process.env, log);
  if (!nemotronShadowEnabled()) {
    result.note = ROOM_DIARIZE_SWEEP_OFF;
    log(`[room-diarize] ${result.note}`);
    return result;
  }
  try {
    pushEngine();
  } catch (e) {
    // a refused engine would fail every job it submitted: say so here, once, instead of queueing 20 doomed jobs a tick
    if (e instanceof DiarizeEngineError) {
      result.note = ROOM_DIARIZE_SWEEP_REFUSED;
      log(`[room-diarize] ${result.note}`);
      return result;
    }
    throw e;
  }
  const limit = Math.max(1, Math.min(SWEEP_LIMIT, Math.trunc(opts.limit ?? SWEEP_LIMIT) || SWEEP_LIMIT));
  const blind = await blindWindowIds();
  result.n_blind_excluded = blind.length;
  const ids = await windowsToSweep(limit, blind);
  result.scanned = ids.length;
  result.exhausted = await countSweepExhausted();
  const { submitJob } = await import("@/lib/jobs/submit");
  for (const id of ids) {
    try {
      const job = await submitJob({ kind: "diarize_window", args: { window_id: id }, actor: opts.actor, ...(opts.origin ? { origin: opts.origin } : {}), scopes: new Set(["invoke"] as const) });
      if (!job.deduped) result.enqueued.push({ window_id: id, job_id: job.id, retry_of_attempt: null });
    } catch (e) {
      if (e instanceof JobArgsError) continue; // refused at submit (held out / unplaceable)
      throw e;
    }
  }
  log(`[room-diarize] sweep: ${result.enqueued.length} submitted of ${ids.length} found; ${result.exhausted} window(s) at the ${SWEEP_MAX_FAILED_JOBS}-failed-job cap`);
  return result;
}
