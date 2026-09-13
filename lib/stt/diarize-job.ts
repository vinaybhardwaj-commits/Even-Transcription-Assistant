/**
 * lib/stt/diarize-job.ts — find room windows that need diarizing, and ENQUEUE them.
 *
 * ─── THIS USED TO BE A PASS THAT WROTE THREE TABLES ITSELF ────────────────────────────────
 * It diarized each window inline and wrote `room_diarize_window`, `speaker_cluster` (with
 * `room_speaker_cluster_member`) and `room_turn_speaker`. C2 moved the work onto the
 * `diarize_window` job and deleted the rest:
 *
 *   room_diarize_window  -> written by the job (lib/stt/diarize-window.ts recordDiarizeWindow)
 *   room_turn_speaker    -> written by the job (lib/stt/diarize-window.ts diarizeWindow)
 *   speaker_cluster      -> NO WRITER. Deleted, and it had never run in production: the gate was
 *   room_speaker_cluster_member    off and SPEAKER_MATCH_THRESHOLD unset, and speaker_cluster was
 *                          confirmed empty on the heaviest room-days on record. The tables are
 *                          left in place; see CLUSTERING_STATUS in lib/brain/state.ts.
 *
 * One writer per table. What is left here reads and enqueues, and writes nothing.
 *
 * A `failed` window is retried, BOUNDED — see DIARIZE_MAX_ATTEMPTS.
 *
 * ─── THE ON-SWITCH STAYS, AND IT IS NOT A SECOND PATH ─────────────────────────────────────
 * `/api/admin/diarize-windows` runs on a five-minute cron and `/api/jobs/run` every minute. With no
 * gate, this would start diarizing every closed window within minutes of deploy — putting a
 * pyannote call on the Mini's single diarize slot, continuously, while STT is on hold. So
 * ROOM_DIARIZE_ENABLED decides whether the scheduled enqueue runs at all. It chooses between
 * "enqueue" and "do nothing", never between two ways of writing.
 */

import { sql } from "@/lib/db";
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

/**
 * A read that degrades to empty rather than throwing — and SAYS SO where the caller can see it.
 *
 * `sink` is REQUIRED rather than optional, so a future read cannot quietly join the silent set by
 * forgetting it. That is why it was made required in the first place: a failed read used to return
 * an empty list, the pass did nothing, and the route answered 200 — a failure wearing the shape of
 * "there was nothing to do". The two call sites inside the deleted cluster and turn writers went
 * with them; the property stays on every read that remains.
 */
async function safeRead<T>(what: string, fallback: T, log: Logger, sink: string[], run: () => Promise<T>): Promise<{ ok: boolean; value: T }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    const msg = `[room-diarize] read failed (${what}): ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty, nothing enqueued`;
    log(msg);
    sink.push(msg);
    return { ok: false, value: fallback };
  }
}

export type DiarizeEnqueueResult = {
  enabled: boolean;
  scanned: number;
  enqueued: Array<{ window_id: string; job_id: string; retry_of_attempt: number | null }>;
  /** Failed windows that have used every attempt. Visible here so a stuck window is never silent. */
  exhausted: number;
  errors: string[];
};

/**
 * Enqueue a `diarize_window` job for each eligible window.
 *
 * ELIGIBLE is the pass's own predicate, unchanged — closed or transcribed, grid-aligned, with a
 * room_day and a joined clip, and no `room_diarize_window` row yet — plus ONE clause the pass never
 * needed: no diarize_window job already queued or running for that window. The pass diarized
 * synchronously, so a window it touched had its row before the next tick. A job does not: the row
 * lands when the job finishes, and without this clause a backlog longer than five minutes would
 * enqueue the same window on every tick.
 */
export async function enqueueDiarizeWindows(
  opts: { limit?: number; log?: Logger; origin?: string; actor: string },
): Promise<DiarizeEnqueueResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result: DiarizeEnqueueResult = { enabled: false, scanned: 0, enqueued: [], exhausted: 0, errors: [] };

  if (!roomDiarizeEnabled(process.env, log)) {
    log(`[room-diarize] ${ROOM_DIARIZE_ENABLED_ENV} is off — enqueueing nothing (this is the shipped state)`);
    return result;
  }
  result.enabled = true;

  const limit = Math.max(1, Math.min(DIARIZE_BATCH_LIMIT, Math.trunc(opts.limit ?? DIARIZE_BATCH_LIMIT) || DIARIZE_BATCH_LIMIT));
  const windows = await safeRead<Array<{ id: string; attempts: number | null }>>("bench_window scan", [], log, result.errors, async () =>
    (await sql`
      SELECT w.id, d.attempts
        FROM bench_window w
        LEFT JOIN room_diarize_window d ON d.window_id = w.id
       WHERE w.state IN ('closed', 'transcribed')
         AND w.grid_aligned = TRUE
         AND w.room_day_id IS NOT NULL
         AND w.clip_r2_key IS NOT NULL
         -- Never handled, or FAILED with attempts left. ok / no_speakers / skipped are final.
         AND (d.window_id IS NULL OR (d.state = 'failed' AND d.attempts < ${DIARIZE_MAX_ATTEMPTS}))
         AND NOT EXISTS (
           SELECT 1 FROM scribe_job j
            WHERE j.kind = 'diarize_window'
              AND j.args->>'window_id' = w.id
              AND j.status IN ('queued', 'running')
         )
       -- New windows before retries, so a failing clip never starves fresh work.
       ORDER BY (d.window_id IS NOT NULL) ASC, w.start_ms ASC
       LIMIT ${limit}
    `) as Array<{ id: string; attempts: number | null }>);
  if (!windows.ok) return result;
  result.scanned = windows.value.length;

  const exhausted = await safeRead<Array<{ n: number }>>("exhausted count", [], log, result.errors, async () =>
    (await sql`
      SELECT count(*)::int AS n FROM room_diarize_window
       WHERE state = 'failed' AND attempts >= ${DIARIZE_MAX_ATTEMPTS}
    `) as Array<{ n: number }>);
  if (!exhausted.ok) return result;
  result.exhausted = Number(exhausted.value[0]?.n ?? 0);

  // Imported lazily: the kind registry imports this module's neighbours, and a static import would
  // close a cycle through lib/jobs/submit.
  const { submitJob } = await import("@/lib/jobs/submit");
  for (const w of windows.value) {
    // NOT caught. An enqueue that throws propagates to the route, which reports failure — a job
    // that could not be queued must never be counted as queued.
    const job = await submitJob({
      kind: "diarize_window",
      args: { window_id: w.id },
      actor: opts.actor,
      ...(opts.origin ? { origin: opts.origin } : {}),
      scopes: new Set(["invoke"] as const),
    });
    result.enqueued.push({ window_id: w.id, job_id: job.id, retry_of_attempt: w.attempts == null ? null : Number(w.attempts) });
  }
  log(`[room-diarize] enqueued ${result.enqueued.length} of ${result.scanned} eligible window(s); ${result.enqueued.filter((e) => e.retry_of_attempt !== null).length} retr(ies); ${result.exhausted} failed window(s) at the ${DIARIZE_MAX_ATTEMPTS}-attempt bound`);
  return result;
}
