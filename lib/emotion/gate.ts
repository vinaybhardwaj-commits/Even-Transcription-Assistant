/**
 * lib/emotion/gate.ts — the two emotion switches. Both ship UNSET.
 *
 *   EMOTION_ENABLED          gates COMPUTE AND STORAGE: the enqueue scan, and the emotion_window job
 *                            re-checks it when it runs.
 *   EMOTION_SURFACE_ENABLED  gates anything a clinician can SEE. Nothing reads emotion rows for a
 *                            clinician yet; canSurfaceEmotion() is the one gate a future surface
 *                            must call, and a test states that nothing calls it today.
 *
 * Two flags, because storing a signal and showing it are different decisions: rows can accumulate
 * for validation long before anyone is allowed to see them.
 */
import { parseFlag } from "@/lib/flags";

export const EMOTION_ENABLED_ENV = "EMOTION_ENABLED";
export const EMOTION_SURFACE_ENABLED_ENV = "EMOTION_SURFACE_ENABLED";

/** Throws FlagValueError on an unrecognised value. */
export function emotionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(EMOTION_ENABLED_ENV, env);
}

/**
 * PURE. May emotion output be shown to a clinician? Requires BOTH flags: nothing can be surfaced
 * that is not also being computed under the compute flag. Throws on an unrecognised value in either.
 */
export function canSurfaceEmotion(env: Record<string, string | undefined> = process.env): boolean {
  const compute = parseFlag(EMOTION_ENABLED_ENV, env);
  const surface = parseFlag(EMOTION_SURFACE_ENABLED_ENV, env);
  return compute && surface;
}
