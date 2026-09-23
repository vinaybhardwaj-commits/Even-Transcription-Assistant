/**
 * lib/emotion/enqueue.ts — find diarized windows that need emotion scores, and ENQUEUE them.
 * It writes nothing itself; room_span_emotion and room_emotion_window have one writer, the job.
 *
 * ELIGIBLE: room_diarize_window is `ok` with a last_run_id, the window has a clip, and emotion has not
 * been recorded for THAT diarize run — never, or against an earlier run (diarize re-ran, successfully
 * or not, so the turns were rewritten), or it FAILED with attempts left (EMOTION_MAX_ATTEMPTS).
 *
 * ONE AT A TIME BY DEFAULT. Nothing is enqueued while any emotion_window job is queued or running
 * (unchanged — this file never touches that gate), and EMOTION_BATCH_LIMIT windows are taken per
 * tick once it is not busy (default 1). The Mini has one emotion model on shared RAM beside
 * whisper, the router, diarize and the recorder; a backlog should drain slowly by default. The
 * limit is an env override, not a hardcoded bump, so a night with the Mini otherwise idle (kiosks
 * off) can pre-load more work per tick without a code change or redeploy, and it reverts to the
 * conservative default the moment the env var is unset again.
 */
import { sql } from "@/lib/db";
import { emotionEnabled, EMOTION_ENABLED_ENV } from "./gate";
import { emotionSecretConfigured, EMOTION_SECRET_ENV } from "./client";
import { clampedIntEnv } from "@/lib/stt/auto-drain";

export const EMOTION_MAX_ATTEMPTS = 3;

/** Windows offered to the emotion queue per tick. Default 1 (see file header). Env override
 *  clamped 1..10 — e.g. EMOTION_BATCH_LIMIT=10 for a backlog push while the Mini is idle. */
export const EMOTION_BATCH_LIMIT_ENV = "EMOTION_BATCH_LIMIT";
export const EMOTION_BATCH_LIMIT = clampedIntEnv(EMOTION_BATCH_LIMIT_ENV, 1, 1, 10);

export type EmotionEnqueueResult = {
  enabled: boolean;
  busy: boolean;
  enqueued: Array<{ window_id: string; job_id: string; retry_of_attempt: number | null }>;
  /** Failed windows with every attempt used, for the current diarize run. Counted, never silent. */
  exhausted: number;
};

/** Throws on an unrecognised flag value and on any read or submit failure — the route makes it a non-2xx. */
export async function enqueueEmotionWindows(opts: { actor: string; origin?: string; log?: (m: string) => void }): Promise<EmotionEnqueueResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const result: EmotionEnqueueResult = { enabled: false, busy: false, enqueued: [], exhausted: 0 };
  if (!emotionEnabled()) {
    log(`[emotion] ${EMOTION_ENABLED_ENV} is off — enqueueing nothing (this is the shipped state)`);
    return result;
  }
  result.enabled = true;
  // ENABLED BUT NOT CONFIGURED is a loud failure, not a quiet tick: every job would fail at its first
  // call. The route turns this into a non-2xx.
  if (!emotionSecretConfigured()) throw new Error(`${EMOTION_ENABLED_ENV} is on but ${EMOTION_SECRET_ENV} is not set — nothing can be scored`);

  const exhausted = (await sql`
    SELECT count(*)::int AS n FROM room_emotion_window e JOIN room_diarize_window d ON d.window_id = e.window_id
     WHERE e.state = 'failed' AND e.diarize_run_id = d.last_run_id AND e.attempts >= ${EMOTION_MAX_ATTEMPTS}
  `) as Array<{ n: number }>;
  result.exhausted = Number(exhausted[0]?.n ?? 0);

  const busy = (await sql`SELECT 1 FROM scribe_job WHERE kind = 'emotion_window' AND status IN ('queued', 'running') LIMIT 1`) as unknown[];
  if (busy.length > 0) {
    result.busy = true;
    log("[emotion] an emotion_window job is already queued or running — enqueueing nothing this tick");
    return result;
  }

  const rows = (await sql`
    SELECT d.window_id, e.attempts
      FROM room_diarize_window d
      JOIN bench_window w ON w.id = d.window_id
      LEFT JOIN room_emotion_window e ON e.window_id = d.window_id
     WHERE d.state = 'ok'
       AND d.last_run_id IS NOT NULL
       AND w.clip_r2_key IS NOT NULL
       AND (e.window_id IS NULL
            OR e.diarize_run_id IS DISTINCT FROM d.last_run_id
            OR (e.state = 'failed' AND e.attempts < ${EMOTION_MAX_ATTEMPTS}))
     ORDER BY (e.window_id IS NOT NULL) ASC, w.start_ms ASC
     LIMIT ${EMOTION_BATCH_LIMIT}
  `) as Array<{ window_id: string; attempts: number | null }>;

  const { submitJob } = await import("@/lib/jobs/submit");
  for (const r of rows) {
    // NOT caught: a job that could not be queued must never be counted as queued.
    const job = await submitJob({
      kind: "emotion_window",
      args: { window_id: r.window_id },
      actor: opts.actor,
      ...(opts.origin ? { origin: opts.origin } : {}),
      scopes: new Set(["invoke"] as const),
    });
    result.enqueued.push({ window_id: r.window_id, job_id: job.id, retry_of_attempt: r.attempts == null ? null : Number(r.attempts) });
  }
  log(`[emotion] enqueued ${result.enqueued.length}; ${result.exhausted} failed window(s) at the ${EMOTION_MAX_ATTEMPTS}-attempt bound`);
  return result;
}
