/**
 * lib/mcp/budgets.ts — Tier 2 §2.5. Named downstream budgets, and the one envelope a caller gets
 * when a downstream service outlasts its own.
 *
 * ─── THE FAILURE THIS REPLACES ────────────────────────────────────────────────────────────────
 * A tool that calls the Mini and waits has exactly one deadline today: the tool's own (55 s read,
 * 115 s invoke). When Whisper or the join service hangs, the tool burns its whole budget and then
 * returns a SHAPE-ONLY DEGRADE — an empty list, a null field, a `degraded` string — and the caller
 * cannot tell "there is nothing there" from "the thing that would have told me hung". An operator
 * reading an empty answer at 55 s learns nothing and waits again.
 *
 * So every outbound fetch gets an EXPLICIT budget strictly below the tool's, and blowing it is a
 * NAMED ERROR carrying both numbers: `{ error: "whisper_timeout", elapsed_ms, budget_ms }`. The gap
 * between the two is deliberate headroom — the tool must still have time to shape and return that
 * error rather than being killed by its own deadline mid-sentence.
 *
 * Anything that legitimately needs longer than an invoke budget is not a timeout problem; it is a
 * job, and Slice B is where it goes.
 */

/** The tool-level deadlines these sit under (lib/mcp/handler.ts owns the enforcement). */
export const READ_TOOL_BUDGET_MS = 55_000;
export const INVOKE_TOOL_BUDGET_MS = 115_000;

/** §2.5 — downstream ceilings, strictly below the tool budget they run inside. */
export const READ_DOWNSTREAM_BUDGET_MS = 40_000;
export const INVOKE_DOWNSTREAM_BUDGET_MS = 90_000;

/**
 * The services a tool can reach. The name is the error's prefix, so it is the thing an operator
 * reads first: `whisper_timeout` says which box to go and look at.
 */
export type DownstreamService =
  | "whisper"
  | "diarize"
  | "join"
  | "ollama"
  | "gemini"
  | "r2"
  | "emotion"
  | "indic";

/**
 * Per-service budgets. READ is what a read-scope tool may spend; INVOKE is what an invoke-scope
 * tool may. Nothing here exceeds its tier's ceiling, and the table is the only place these live —
 * a tool that wants longer changes this file, in review, rather than passing its own number.
 */
export const DOWNSTREAM_BUDGET_MS: Record<DownstreamService, { read: number; invoke: number }> = {
  // Transcription of a short clip. The long cases are jobs (Slice B), not longer timeouts.
  whisper: { read: READ_DOWNSTREAM_BUDGET_MS, invoke: INVOKE_DOWNSTREAM_BUDGET_MS },
  diarize: { read: READ_DOWNSTREAM_BUDGET_MS, invoke: INVOKE_DOWNSTREAM_BUDGET_MS },
  // The join service concatenates from R2 and is the slowest legitimate hop.
  join: { read: READ_DOWNSTREAM_BUDGET_MS, invoke: INVOKE_DOWNSTREAM_BUDGET_MS },
  indic: { read: READ_DOWNSTREAM_BUDGET_MS, invoke: INVOKE_DOWNSTREAM_BUDGET_MS },
  emotion: { read: READ_DOWNSTREAM_BUDGET_MS, invoke: INVOKE_DOWNSTREAM_BUDGET_MS },
  // A chat/embedding call that takes 10 s is already wrong; these are deliberately tight so a
  // hanging model surfaces fast instead of eating the whole tool budget.
  ollama: { read: 10_000, invoke: 10_000 },
  gemini: { read: 30_000, invoke: 30_000 },
  // Object storage. A HEAD or a presign that takes 15 s is a fault, not slowness.
  r2: { read: 15_000, invoke: 15_000 },
};

/** The envelope a blown budget returns. Never a bare null, never an empty list. */
export type DownstreamTimeout = {
  error: `${DownstreamService}_timeout`;
  elapsed_ms: number;
  budget_ms: number;
};

export const isDownstreamTimeout = (v: unknown): v is DownstreamTimeout =>
  typeof v === "object" && v !== null && typeof (v as DownstreamTimeout).error === "string" &&
  (v as DownstreamTimeout).error.endsWith("_timeout");

/** PURE — the budget for one service at one scope. */
export function budgetFor(service: DownstreamService, scope: "read" | "invoke"): number {
  return DOWNSTREAM_BUDGET_MS[service][scope];
}

/**
 * Run `fn` under its service budget. On timeout it RESOLVES with the named envelope rather than
 * throwing, because a tool that already answered "I asked Whisper and it did not come back" has
 * nothing to add by unwinding — and a throw would be caught by `failSafe` and flattened back into
 * the shape-only degrade this exists to prevent.
 *
 * The AbortSignal is passed through so the fetch itself is cancelled, not merely ignored: a hung
 * request left running would hold a connection for the rest of the lambda's life.
 */
export async function withBudget<T>(
  service: DownstreamService,
  scope: "read" | "invoke",
  fn: (signal: AbortSignal) => Promise<T>,
  now: () => number = Date.now,
): Promise<T | DownstreamTimeout> {
  const budget_ms = budgetFor(service, scope);
  const started = now();
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DownstreamTimeout>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve({ error: `${service}_timeout`, elapsed_ms: now() - started, budget_ms });
    }, budget_ms);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } catch (e) {
    // An abort that surfaces as a throw is still the timeout, named the same way.
    if ((e as Error)?.name === "AbortError") {
      return { error: `${service}_timeout`, elapsed_ms: now() - started, budget_ms };
    }
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
