/**
 * lib/jobs/errors.ts — Tier 2 Slice B fix-up 4, on the Refuter's (e).
 *
 * THE LEAK THIS CLOSES. `error` on a job row was free text, and the transcribe kind interpolated the
 * downstream failure into it — which `lib/whisper.ts` builds from up to 200 characters of the STT
 * service's raw RESPONSE BODY. A body can echo the audio it was asked about, and `jobView` handed
 * `error` to any `read` token with no flag at all. The result was carefully scrubbed to pointers
 * while the error channel beside it carried speech.
 *
 * So: a job row's `error` now begins with a CODE from this list, and the prose after it is for the
 * server log and for `invoke`-scope callers only. `read` gets the code and nothing else — which is
 * all a code is for: it says which box to go and look at, without quoting what that box said.
 */

/** Every code the kinds and the runner can actually produce. Nothing is derived from a response. */
export const JOB_ERROR_CODES = [
  // transcribe_range
  "no_session_for_window",
  "session_unresolved",
  "no_audio_in_range",
  "progress_incomplete",
  "clip_missing_in_r2",
  "whisper_failed",
  // stitch + transcribe_range
  "join_failed",
  "empty_range",
  "blind_room_day",
  "window_unplaced",
  // the runner itself
  "unknown_kind",
  "unknown_step",
  "step_threw",
  "failures_exceeded",
  "lease_lost",
  // route_transcribe (Slice C1)
  "route_submit_failed",
  "route_job_failed",
  "route_job_unknown",
  "route_empty_transcript",
  "presign_failed",
  // room_window (Slice C1b) — detail is a DrainStep, a closed union of our own names.
  "room_window_failed",
  // room_window: the router forgot the job (restart) or never finished it inside the bound. The window is
  // recorded as a failure and returns to the drain, which submits a NEW router job.
  "router_job_lost",
  // diarize_window (Slice C2)
  "diarize_failed",
  // nemotron_lab_run (0143): a window input with no clip, a span that could not be cut, a run no worker finished in time
  "lab_input_unresolved",
  "lab_cut_failed",
  "lab_timeout",
  // the room job refuses DIARIZE_ENGINE=local|pyannoteai by name, before any call (nemotron is the only room engine)
  "diarize_engine_refused",
  "diarize_unavailable",
  "diarize_would_exceed_budget",
  // emotion_window (Slice C3)
  "emotion_disabled",
  "emotion_unavailable",
  "emotion_refused",
  "diarize_not_ok",
  "diarize_changed",
  // E16: the stored diarize intervals do not belong to the run whose turns are being scored
  "diarize_segments_stale",
  "emotion_window_failed",
  "emotion_not_configured",
  "emotion_cap_changed",
  // sarvam_transcribe / sarvam_translate (S8A) — closed codes; the gateway's own error text is never stored
  "sarvam_gateway_not_configured",
  "sarvam_daily_cap",
  "sarvam_submit_failed",
  "sarvam_job_failed",
  "sarvam_timeout",
  "sarvam_result_failed",
  "sarvam_translate_failed",
  "source_not_found",
  "source_ambiguous",
  "window_too_long",
  "result_write_failed",
  // S8A-FIX: only isolated consult audio (or a doctor-recorded encounter) goes to Sarvam
  "scope_consult_only",
  "scope_check_unavailable",
  // rubric_run / rubric_bench (S7-0)
  "unknown_rubric",
  "rubric_units_unresolved",
  "bench_set_missing",
  "bench_metric_unsupported",
  "consult_index_unavailable",
  "duration_unknown",
  // the stubs
  "not_implemented",
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

const CODE_SET = new Set<string>(JOB_ERROR_CODES);

/** Build the durable `error` string: a code, then optional prose for invoke-scope eyes. */
export const jobError = (code: JobErrorCode, detail?: string): string =>
  detail ? `${code}: ${detail}` : code;

/**
 * PURE — the code a read-scope caller is given.
 *
 * The leading token up to the first colon, IF it is one we published. Anything else is
 * `unknown_error`: a row written by an older build, or a code that drifted, must never fall back to
 * returning the prose — that is the leak, and a fallback that "helpfully" shows more is how it
 * would come back.
 */
export function errorCodeOf(error: string | null): JobErrorCode | "unknown_error" | null {
  if (!error) return null;
  const head = error.split(":", 1)[0]!.trim();
  return CODE_SET.has(head) ? (head as JobErrorCode) : "unknown_error";
}
