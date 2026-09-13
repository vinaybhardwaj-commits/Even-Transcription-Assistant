/**
 * lib/emotion/enqueue.ts — find diarized windows that need emotion scores, and ENQUEUE them.
 * It writes nothing itself; room_span_emotion and room_emotion_window have one writer, the job.
 *
 * ELIGIBLE: room_diarize_window is `ok`, the window has a clip, and emotion has not been recorded for
 * THIS diarize attempt — never, or against an older attempt (diarize re-ran, so the speakers changed),
 * or it FAILED with attempts left (EMOTION_MAX_ATTEMPTS).
 *
 * ONE AT A TIME. Nothing is enqueued while any emotion_window job is queued or running, and one
 * window is taken per tick. The Mini has one emotion model on shared RAM beside whisper, the router,
 * diarize and the recorder; a backlog should drain slowly rather than crowd them.
 */
import { sql } from "@/lib/db";
import { emotionEnabled, EMOTION_ENABLED_ENV } from "./gate";

export const EMOTION_MAX_ATTEMPTS = 3;

export type EmotionEnqueueResult = {
  enabled: boolean;
  busy: boolean;
  enqueued: Array<{ window_id: string; job_id: string; retry_of_attempt: number | null }>;
  /** Failed windows with every attempt used, for the current diarize attempt. Counted, never silent. */
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

  const exhausted = (await sql`
    SELECT count(*)::int AS n FROM room_emotion_window e JOIN room_diarize_window d ON d.window_id = e.window_id
     WHERE e.state = 'failed' AND e.diarize_attempt = d.attempts AND e.attempts >= ${EMOTION_MAX_ATTEMPTS}
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
       AND w.clip_r2_key IS NOT NULL
       AND (e.window_id IS NULL
            OR e.diarize_attempt <> d.attempts
            OR (e.state = 'failed' AND e.attempts < ${EMOTION_MAX_ATTEMPTS}))
     ORDER BY (e.window_id IS NOT NULL) ASC, w.start_ms ASC
     LIMIT 1
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
