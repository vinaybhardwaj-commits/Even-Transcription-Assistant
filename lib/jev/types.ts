/**
 * lib/jev/types.ts — Slice J1 (ETA-JEV-ARM-D §4). The Jev wire contract, as the repo speaks it.
 *
 * Mirrors docs.typesafe.ai's three primitives (noul/choice/score) verbatim (spec §1, §4). No SDK
 * type is imported anywhere in this tree — v1.0 talks to `/v1/systemone` over raw fetch, and this
 * file is the only place that shape is declared.
 */
import type { TraceHandle } from "@/lib/llm-trace/log";

export type JevNoulQ = { type: "noul"; instructions: string; criteria?: { true: string; false: string } };
export type JevChoiceQ<K extends string = string> = { type: "choice"; instructions: string; criteria: Record<K, string | null> };
export type JevScoreQ = { type: "score"; instructions: string; criteria: string[] }; // ordered low→high, 2..10
export type JevQuestion = JevNoulQ | JevChoiceQ | JevScoreQ;

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

/** Thrown by `client.ts` before any fetch when `ETA_JEV_ENABLED` is unset — proved by test. */
export class JevDisabledError extends Error {
  constructor() {
    super("ETA_JEV_ENABLED is not set — refusing to call Jev");
  }
}

/** state estimate over ~100k chars (~25k tokens); callers must chunk (spec §4). */
export class JevStateTooLargeError extends Error {
  constructor(public chars: number) {
    super(`state is ${chars} chars, over the 100,000-char guard — chunk the caller's batch`);
  }
}

/** A vendor error the client itself could not recover (401/422, or retries exhausted on 429/529). */
export class JevHttpError extends Error {
  constructor(public status: number, public body: string) {
    super(`jev http ${status}: ${body.slice(0, 200)}`);
  }
}
