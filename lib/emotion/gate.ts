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
 *
 *   EMOTION_WAVLM_RETIRED    RETIREMENT (Timbre #79, GO 11 Oct 2026): WavLM Aniemore is retired from every scoring
 *                            path; Timbre (affect_* tables, 0155) replaces it. UNSET MEANS RETIRED: emotionEnabled()
 *                            is false whatever EMOTION_ENABLED says, so no new room_emotion_window / room_span_emotion
 *                            rows are written (the enqueue scan and the job's own re-check both go through it). The
 *                            0089/0097 tables stay as read-only history; their readers are unchanged. Only an
 *                            explicit EMOTION_WAVLM_RETIRED=0 (with EMOTION_ENABLED=1) runs the Mac mini endpoint again,
 *                            for an A/B against history, until Vinay decommissions it.
 */
import { parseFlag } from "@/lib/flags";

export const EMOTION_ENABLED_ENV = "EMOTION_ENABLED";
export const EMOTION_SURFACE_ENABLED_ENV = "EMOTION_SURFACE_ENABLED";
export const EMOTION_WAVLM_RETIRED_ENV = "EMOTION_WAVLM_RETIRED";

/** PURE. True unless EMOTION_WAVLM_RETIRED is explicitly off ("0"/"false"/"off"/"no"). Throws on an unrecognised value. */
export function wavlmRetired(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[EMOTION_WAVLM_RETIRED_ENV];
  if (raw === undefined || raw.trim() === "") return true;
  return parseFlag(EMOTION_WAVLM_RETIRED_ENV, env);
}

/** Throws FlagValueError on an unrecognised value. */
export function emotionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return parseFlag(EMOTION_ENABLED_ENV, env) && !wavlmRetired(env);
}

/**
 * PURE. May emotion output be shown to a clinician? Requires BOTH flags: nothing can be surfaced
 * that is not also being computed under the compute flag. Throws on an unrecognised value in either.
 */
export function canSurfaceEmotion(env: Record<string, string | undefined> = process.env): boolean {
  const compute = emotionEnabled(env);
  const surface = parseFlag(EMOTION_SURFACE_ENABLED_ENV, env);
  return compute && surface;
}
