/**
 * lib/jev/safe-error.ts — the ONLY way a Jev-path error becomes text that is logged, traced or
 * stored (W27.7(a)). Provider text must never reach an error message: a Jev response body, and
 * anything parsed from one (res.json() SyntaxError messages quote the body), can carry the note
 * sentence or transcript excerpt we sent. The message is built from a closed allowlist — our own
 * error classes, whose messages are constructed from status codes, provider error CODES and
 * counts — and everything else collapses to the error's constructor name.
 */
import { JevBadResponseError, JevDisabledError, JevHttpError, JevStateTooLargeError } from "./types";

export function safeJevErrorMessage(e: unknown): string {
  if (e instanceof JevHttpError || e instanceof JevBadResponseError || e instanceof JevDisabledError || e instanceof JevStateTooLargeError) return e.message;
  if (e instanceof Error) return `jev_error: ${/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name) ? e.name : "Error"}`;
  return "jev_error: non-error thrown";
}
