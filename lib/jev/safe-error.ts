/**
 * lib/jev/safe-error.ts — the ONLY way a Jev-path error becomes text that is logged, traced or
 * stored (W27.7(a)). Provider text must never reach an error message: a Jev response body, and
 * anything parsed from one (res.json() SyntaxError messages quote the body), can carry the note
 * sentence or transcript excerpt we sent. The message is built from a closed allowlist — our own
 * error classes, whose messages are constructed from status codes, provider error CODES and
 * counts — and everything else collapses to the error's constructor name.
 */
import { JevBadResponseError, JevDisabledError, JevHttpError, JevMissingKeyError, JevStateTooLargeError } from "./types";

/**
 * A Postgres error carries a five-character SQLSTATE in `code` (42501 insufficient_privilege, ...).
 * The raw message can quote a relation, a column or a value, so it never leaves: only the code does,
 * and only when it has exactly the SQLSTATE shape.
 */
function pgCode(e: unknown): string | null {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^(?=.*[0-9])[0-9A-Z]{5}$/.test(c) ? c : null;
}

export function safeJevErrorMessage(e: unknown): string {
  const code = pgCode(e);
  if (code) return `db_error:${code}`;
  if (e instanceof JevHttpError || e instanceof JevBadResponseError || e instanceof JevDisabledError || e instanceof JevMissingKeyError || e instanceof JevStateTooLargeError) return e.message;
  if (e instanceof Error) return `jev_error: ${/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(e.name) ? e.name : "Error"}`;
  return "jev_error: non-error thrown";
}
