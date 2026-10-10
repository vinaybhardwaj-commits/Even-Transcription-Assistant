/**
 * lib/stt/diarize-job.ts — RETIRED for rooms (10 Oct 2026): the scheduled enqueue is a no-op.
 *
 * Room diarization is driven by the Nemotron ingest: /api/diarize/nemotron/ingest stores a window's turns and
 * submits the `diarize_window` job itself (app/api/diarize/nemotron/ingest/route.ts). This module used to SCAN
 * `bench_window` for windows with no `room_diarize_window` row and enqueue them for pyannote on a five-minute
 * cron; with pyannote gone from production that scan has nothing to enqueue and nothing it may call.
 *
 * WHAT IS LEFT: the entry point and the flag name, so the cron route (still in vercel.json, FLAGGED for removal
 * in a later slice) answers a clean 200 that SAYS why it did nothing. `ROOM_DIARIZE_ENABLED` is still read
 * (strictly: a typo still throws) but no value of it enqueues anything. One writer per table stays the job.
 */

import { parseFlag } from "@/lib/flags";

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

/** Bounded so one tick enqueues a handful of windows beside the Mini's serialised service. */
export const DIARIZE_BATCH_LIMIT = 4;

/**
 * THE RETRY BOUND. A window whose row is `failed` is re-enqueued until it has been attempted this
 * many times in total, and then left alone. 0074 made `failed` a permanent destination so a broken
 * clip could not hold the Mini's one diarize slot all night; that also meant a transient failure
 * blocked a window forever. Three attempts is the middle: a flaky tunnel gets two more chances, a
 * clip that is genuinely bad costs at most three calls. Every earlier failure is kept in
 * `failure_history` (0088), and windows at the bound are COUNTED on every enqueue response.
 */
export const DIARIZE_MAX_ATTEMPTS = 3;

type Logger = (msg: string) => void;

/** The words the cron route and the admin POST answer with. */
export const ROOM_DIARIZE_RETIRED = "retired: nemotron ingest drives diarize_window";

export type DiarizeEnqueueResult = {
  enabled: boolean;
  scanned: number;
  enqueued: Array<{ window_id: string; job_id: string; retry_of_attempt: number | null }>;
  /** Always 0 now: nothing is scanned, so nothing can be at a retry bound. */
  exhausted: number;
  n_blind_excluded: number;
  errors: string[];
  /** Why nothing was enqueued: the scheduled enqueue is retired. */
  note: string;
};

/** A NO-OP, by design. It reads the flag (so a typo still throws and the retired-name warning still logs) and enqueues nothing. */
export async function enqueueDiarizeWindows(
  opts: { limit?: number; log?: Logger; origin?: string; actor: string },
): Promise<DiarizeEnqueueResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const enabled = roomDiarizeEnabled(process.env, log);
  log(`[room-diarize] ${ROOM_DIARIZE_RETIRED} — enqueueing nothing (${ROOM_DIARIZE_ENABLED_ENV} is ${enabled ? "on" : "off"}, and no longer matters)`);
  return { enabled, scanned: 0, enqueued: [], exhausted: 0, n_blind_excluded: 0, errors: [], note: ROOM_DIARIZE_RETIRED };
}
