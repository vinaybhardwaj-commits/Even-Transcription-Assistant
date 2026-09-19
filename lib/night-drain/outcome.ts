/**
 * lib/night-drain/outcome.ts — every way a window can end, named.
 *
 * WHY THIS FILE EXISTS. Three defects this month were one shape: a status the callee returned and the
 * caller threw away (the router's `silent_skipped`, the VAD starvation). So the drain has no free-form
 * result. A window ends in exactly one of four KINDS, each with a closed code set, and the worker's
 * switch over them ends in `assertNever` — a fifth kind is a compile error, not a dropped status.
 *
 *   recorded    a `room_diarize_window` row was written and is TERMINAL for this pass:
 *                 ok | no_speakers                       final for ever
 *                 failed (+ code)                        attempts + 1; retried after a cooldown, at
 *                                                        most DIARIZE_MAX_ATTEMPTS times in all
 *   deferred    NO row. The window never got a fair try (infrastructure was down, the diarize slot was
 *               busy). It stays eligible. It is logged every time and counted in the night summary.
 *   abandoned   NO row. Closed hours ended or the process was stopped mid-window. The lease is released;
 *               nothing is half-written because the only DB write is the last.
 *   fatal       The worker itself must stop (a credential is refused, config is missing). A systemic
 *               fault must not spend three attempts on each of 2,450 windows.
 */

/** Window-specific failures that are recorded on the row (`failed`). */
export const FAILED_CODES = [
  "no_covering_chunks",   // bench_chunk has nothing over the window (resolveRange: none)
  "chunk_not_found",      // the door has no such chunk
  "chunk_link_missing",   // the door answered ok but with no presigned link
  "chunk_gone",           // R2 says 404/403 for a listed chunk
  "audio_corrupt",        // ffmpeg could not decode the pieces
  "audio_empty",          // decoded, but under one second of audio
  "diarize_timeout",      // the service did not answer inside DIARIZE_TIMEOUT_MS
  "diarize_network",      // the connection died mid-call (service killed, out of memory)
  "diarize_http_4xx",     // the service refused the audio
  "diarize_http_5xx",     // the service failed on the audio
  "diarize_other",        // any other non-retryable diarize error
  "hard_cap",             // the window used its whole 480 s cap; recorded so it cannot loop for ever
] as const;
export type FailedCode = (typeof FAILED_CODES)[number];

/** Infrastructure trouble: no row, try again later. */
export const DEFERRED_CODES = [
  "db_error",             // the claim or a read threw
  "mcp_unreachable",      // the door did not answer
  "mcp_http_error",       // any non-2xx from the door other than 401/403 (those are fatal)
  "chunk_download_failed",// network / 5xx / 429 fetching a piece
  "diarize_busy",         // no diarize slot inside the wait (a live encounter holds it)
  "service_down",         // /health failed
  "record_write_failed",  // the terminal row could not be written; the window is not done
] as const;
export type DeferredCode = (typeof DEFERRED_CODES)[number];

export const ABANDONED_CODES = ["closed_hours_ended", "stopped"] as const;
export type AbandonedCode = (typeof ABANDONED_CODES)[number];

export const FATAL_CODES = ["mcp_auth_refused", "mcp_not_configured", "diarize_base_url_missing", "db_not_configured"] as const;
export type FatalCode = (typeof FATAL_CODES)[number];

export type Outcome =
  | { kind: "recorded"; state: "ok" | "no_speakers"; speakers: number; segments: number }
  | { kind: "recorded"; state: "failed"; code: FailedCode }
  | { kind: "deferred"; code: DeferredCode }
  | { kind: "abandoned"; code: AbandonedCode }
  | { kind: "fatal"; code: FatalCode };

export function assertNever(x: never): never {
  throw new Error(`unhandled outcome: ${JSON.stringify(x)}`);
}

/** A diarize failure as `runDiarize` reports it (`error` string + `retryable`). */
export type DiarizeFailure = { error: string; retryable: boolean };

/**
 * PURE — map `runDiarize`'s failure onto the closed set. The strings it emits are:
 * `diarize_base_url_missing`, `diarize_busy_<reason>_<n>ms`, `http_<status>: <body>`,
 * `timeout_<n>ms`, `aborted`, `network: <message>`. The body and message are dropped: they can
 * describe the audio, and the row and the log carry a code.
 */
export function mapDiarizeFailure(f: DiarizeFailure): Extract<Outcome, { kind: "recorded" | "deferred" | "abandoned" | "fatal" }> {
  const e = f.error;
  if (e === "diarize_base_url_missing") return { kind: "fatal", code: "diarize_base_url_missing" };
  if (e === "aborted") return { kind: "abandoned", code: "stopped" };
  if (/^diarize_busy_/.test(e) || f.retryable) return { kind: "deferred", code: "diarize_busy" };
  if (/^timeout_/.test(e)) return { kind: "recorded", state: "failed", code: "diarize_timeout" };
  if (/^network:/.test(e)) return { kind: "recorded", state: "failed", code: "diarize_network" };
  const http = /^http_(\d{3})/.exec(e);
  if (http) return { kind: "recorded", state: "failed", code: http[1]!.startsWith("4") ? "diarize_http_4xx" : "diarize_http_5xx" };
  return { kind: "recorded", state: "failed", code: "diarize_other" };
}
