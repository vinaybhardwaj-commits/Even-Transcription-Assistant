/**
 * lib/jev/worker/errors.ts — the typed error taxonomy (PRD §9.1): `error_class` on jev_call, `outcome` on jev_decision.
 *
 * ONE closed list. Only these strings reach a row, a log, a trace, MCP or Bench; a provider body, a driver message or a
 * relation name never does (the safe-error.ts discipline). A database fault is `db_error:<sqlstate>` and is NEVER reported
 * as a Jev fault (the P0 bug).
 */
import { JevBadResponseError, JevDisabledError, JevHttpError, JevMissingKeyError, JevStateTooLargeError } from "../types";

export const ERROR_CLASSES = [
  "disabled", "config_missing_key", "auth", "schema_rejected", "rate_limited", "overloaded", "provider_error", "timeout", "aborted",
  "bad_response", "state_too_large", "off_menu", "no_answer", "budget_exceeded", "circuit_open", "set_not_allowed", "persist_failed",
] as const;
export type FixedErrorClass = (typeof ERROR_CLASSES)[number];
export type ErrorClass = FixedErrorClass | `db_error:${string}`;

/** retry = the step throws so the runner retries it; breaker = the failure counts toward opening the circuit; immediate = opens it at once. */
export const CLASS_POLICY: Record<FixedErrorClass, { retry: boolean; breaker: boolean; immediate?: boolean }> = {
  disabled: { retry: false, breaker: false },
  config_missing_key: { retry: false, breaker: false },
  auth: { retry: false, breaker: true, immediate: true },
  schema_rejected: { retry: false, breaker: false },
  rate_limited: { retry: true, breaker: true },
  overloaded: { retry: true, breaker: true },
  provider_error: { retry: true, breaker: true },
  timeout: { retry: true, breaker: true },
  aborted: { retry: true, breaker: false },
  bad_response: { retry: true, breaker: true },
  state_too_large: { retry: false, breaker: false },
  off_menu: { retry: false, breaker: false },
  no_answer: { retry: false, breaker: false },
  budget_exceeded: { retry: false, breaker: false },
  circuit_open: { retry: false, breaker: false },
  set_not_allowed: { retry: false, breaker: false },
  persist_failed: { retry: true, breaker: false },
};

export function policyOf(c: ErrorClass): { retry: boolean; breaker: boolean; immediate?: boolean } {
  return c.startsWith("db_error:") ? { retry: true, breaker: false } : CLASS_POLICY[c as FixedErrorClass];
}

const sqlstate = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && /^(?=.*[0-9])[0-9A-Z]{5}$/.test(c) ? c : null;
};

/** Classify what a Jev CALL threw. `signalAborted` is the caller's own signal: it tells a caller abort from the client's timeout. */
export function classifyCallError(e: unknown, signalAborted = false): { cls: ErrorClass; status?: number } {
  const code = sqlstate(e);
  if (code) return { cls: `db_error:${code}` };
  if (e instanceof JevDisabledError) return { cls: "disabled" };
  if (e instanceof JevMissingKeyError) return { cls: "config_missing_key" };
  if (e instanceof JevStateTooLargeError) return { cls: "state_too_large" };
  if (e instanceof JevBadResponseError) return { cls: "bad_response" };
  if (e instanceof JevHttpError) {
    const s = e.status;
    if (s === 401 || s === 403) return { cls: "auth", status: s };
    if (s === 422) return { cls: "schema_rejected", status: s };
    if (s === 429) return { cls: "rate_limited", status: s };
    if (s === 529 || s === 503) return { cls: "overloaded", status: s };
    return { cls: "provider_error", status: s };
  }
  if (e instanceof Error && e.name === "AbortError") return { cls: signalAborted ? "aborted" : "timeout" };
  return { cls: "provider_error" };
}

/** Classify what a DATABASE write or read threw: a SQLSTATE is `db_error:<code>`, anything else is persist_failed. */
export function classifyDbError(e: unknown): ErrorClass {
  const code = sqlstate(e);
  return code ? `db_error:${code}` : "persist_failed";
}
