/**
 * Time budget for the nightly document-audit ingest (F5).
 *
 * The route is allowed 300 s (`export const maxDuration = 300` in the route file, which Next needs as
 * a literal; a test pins it to INGEST_MAX_DURATION_S). Until now the CDMSS export fetch aborted at a
 * hard-coded 20 s, so raising maxDuration changed nothing: a slow export failed the whole run. The
 * numbers below keep every deadline strictly inside the function limit:
 *
 *   export fetch      aborts at maxDuration - 120 s  (leaves time to write what came back)
 *   per-audit writes  stop   at maxDuration - 30 s   (leaves time to record the run and respond)
 *
 * When either deadline fires the run says so: a PARTIAL_RUN marker in the log and in
 * document_audit_ingest_meta.note, and the meta row is NOT marked successful.
 */

export const INGEST_MAX_DURATION_S = 300;
export const EXPORT_MARGIN_S = 120;
export const WORK_MARGIN_S = 30;
export const PARTIAL_RUN_MARKER = "PARTIAL_RUN";

export function exportTimeoutMs(maxDurationS: number = INGEST_MAX_DURATION_S): number {
  return Math.max(10, maxDurationS - EXPORT_MARGIN_S) * 1000;
}

export function workDeadlineMs(startMs: number, maxDurationS: number = INGEST_MAX_DURATION_S): number {
  return startMs + Math.max(10, maxDurationS - WORK_MARGIN_S) * 1000;
}

/** AbortSignal.timeout() rejects with TimeoutError; a manual abort with AbortError. */
export function isTimeoutError(e: unknown): boolean {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  return name === "TimeoutError" || name === "AbortError";
}
