/**
 * lib/readmission-load-core.ts — PURE load-state decisions for the readmissions board
 * (CDMSS Readmissions R5.1 PRD v1.0, 19 Aug 2026 — "the board stops hanging"). No React, no fetch.
 *
 * The board's list fetch runs under an AbortController aborted at LOAD_TIMEOUT_MS; if it is still
 * loading after SLOW_AFTER_MS a second, honest line appears; any failure (abort, network, non-OK)
 * becomes an error state with ONE plain detail line and a Retry button. One fetch per page load or
 * per Retry press — nothing polls, nothing retries on its own. The copy lives here so the tests pin
 * the exact strings the PRD names.
 */

export const LOAD_TIMEOUT_MS = 45_000;
export const SLOW_AFTER_MS = 8_000;

export const LOADING_COPY = 'Loading…';
export const SLOW_LOAD_COPY = 'Still loading — the record systems are slow right now.';
export const LOAD_ERROR_HEADING = 'The case list did not load.';
export const LOAD_ERROR_TIMEOUT_DETAIL = 'It took too long. The record systems may be slow.';
export const LOAD_ERROR_OTHER_DETAIL = 'Something went wrong on the way to the server.';
export const RETRY_LABEL = 'Retry';
/** R6.1 (R61-1): a failed REFRESH over a loaded board — the cards stay; this line appears by the control. */
export const REFRESH_FAILED_COPY = 'Refresh did not work.';

export type LoadFailureKind = 'timeout' | 'other';
export interface LoadFailure { kind: LoadFailureKind; heading: string; detail: string }

/** Was this thrown error the AbortController firing (our timeout)? fetch rejects with a DOMException
 *  named 'AbortError' (or, on some runtimes, an Error whose name / message says abort). */
export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = String((e as { name?: unknown }).name ?? '');
  const msg = String((e as { message?: unknown }).message ?? '');
  return name === 'AbortError' || name === 'TimeoutError' || /\baborted\b|\babort\b/i.test(msg);
}

/** PURE: the error state for a failed load — heading + the ONE detail line the PRD names. A
 *  timed-out fetch (abort) reads as slow record systems; everything else (network, non-OK, bad JSON)
 *  as "on the way to the server". Never throws, whatever it is handed. */
export function classifyLoadFailure(e: unknown): LoadFailure {
  return isAbortError(e)
    ? { kind: 'timeout', heading: LOAD_ERROR_HEADING, detail: LOAD_ERROR_TIMEOUT_DETAIL }
    : { kind: 'other', heading: LOAD_ERROR_HEADING, detail: LOAD_ERROR_OTHER_DETAIL };
}

/** PURE: what the loading area shows at `elapsedMs` into a load — the slow line joins after SLOW_AFTER_MS. */
export function loadingLines(elapsedMs: number): string[] {
  return elapsedMs >= SLOW_AFTER_MS ? [LOADING_COPY, SLOW_LOAD_COPY] : [LOADING_COPY];
}
