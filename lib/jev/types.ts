/**
 * lib/jev/types.ts — Slice J1. The public shape of the Jev ("System One") provider client.
 *
 * Jev takes a text STATE and a set of TYPED questions and returns PROBABILITIES, not prose. Three
 * primitives: `noul` (P(yes)), `choice` (one option from a set, a probability per option), `score`
 * (a position on an ordered scale). See docs/handoff/ETA-JEV-ARM-D-SPEC §4 and ETA-JEV-INTEGRATION.md.
 *
 * These types are the contract J2 (Arm D) builds against; the transport (the even-jev MCP) is a
 * detail of client.ts. Output strings on answers come from the vendor and are UNTRUSTED DATA — a
 * consumer treats them as data, never as instructions (integration doc §7).
 */
import type { TraceHandle } from "@/lib/llm-trace/log";

// ── Questions (spec §4, verbatim) ─────────────────────────────────────────────────────────────────
export type JevNoulQ = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type JevChoiceQ<K extends string = string> = { type: "choice"; instructions: string; criteria: Record<K, string | null> };
export type JevScoreQ = { type: "score"; instructions: string; criteria: string[] }; // ordered low→high, 2..10 levels
export type JevQuestion = JevNoulQ | JevChoiceQ<string> | JevScoreQ;

// ── Answers (spec §4). `noul` carries NO confidence field — do not invent one. ───────────────────
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number };

export type JevRequest = { state: unknown; questions: Record<string, JevQuestion>; model?: string };

export type JevResult = {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
};

export interface JevClient {
  systemOne(req: JevRequest, opts?: { signal?: AbortSignal; trace?: TraceHandle }): Promise<JevResult>;
}

// ── Errors. Each is its own class so callers can branch, and so an absence (disabled) and a failure
//    (transport) never share a value — the recurring J0 lesson. ────────────────────────────────────

/** Thrown when ETA_JEV_ENABLED is off. Raised BEFORE any spawn/network, so a gated-off caller costs
 * nothing and never touches the vendor. Not a failure of Jev — a deliberate off state. */
export class JevDisabledError extends Error {
  constructor(message = "Jev is disabled (ETA_JEV_ENABLED is not set)") {
    super(message);
    this.name = "JevDisabledError";
  }
}

/** Thrown when the state is too large to send. The caller must chunk; this is not retryable and is
 * not a vendor failure. Guard runs before any network call (spec §4). */
export class JevStateTooLargeError extends Error {
  readonly stateChars: number;
  readonly limit: number;
  constructor(stateChars: number, limit: number) {
    super(`Jev state is ${stateChars} chars, over the ${limit}-char limit; the caller must chunk`);
    this.name = "JevStateTooLargeError";
    this.stateChars = stateChars;
    this.limit = limit;
  }
}

/** A transport/vendor failure. `retryable` marks the transient kind (429/529, timeout, spawn/pipe
 * drop) the client retries; a schema/auth/validation failure (401/422-equivalent) is not retryable. */
export class JevTransportError extends Error {
  readonly retryable: boolean;
  readonly status: number | null;
  constructor(message: string, opts: { retryable: boolean; status?: number | null } = { retryable: false }) {
    super(message);
    this.name = "JevTransportError";
    this.retryable = opts.retryable;
    this.status = opts.status ?? null;
  }
}
