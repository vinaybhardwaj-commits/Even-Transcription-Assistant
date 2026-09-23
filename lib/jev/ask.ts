/**
 * lib/jev/ask.ts — J-CORE-1: the shared entry point. "No caller builds its own request"
 * (PLAN-v3.md §2): a use calls askJev with a state and a list of registered questions to ask
 * against it, and gets back typed, confidence-banded answers — the registry lookup, the fan-out
 * into one systemOne call, retry/timeout (both already inside lib/jev/client.ts), the confidence
 * band, the cost/latency counters, and the jev_decision persistence all happen here, once, for
 * every use.
 */
import { getJevClient } from "./client";
import { getJevQuestion } from "./registry";
import { confidenceBand, noulConfidence, type ConfidenceBand, type ConfidenceThresholds } from "./confidence";
import { recordJevBatchCall } from "./counters";
import { insertJevDecisions, type JevDecisionRow } from "./decision-store";
import type { JevAnswer, JevQuestion, JevSubjectType } from "./types";
import type { TraceHandle } from "@/lib/llm-trace/log";

export type JevAsk = {
  /** Key within this one batch's questions map — must be unique in the batch. Not stored; only
   * question_id + prompt_version identify a decision in jev_decision. */
  answerKey: string;
  subjectType: JevSubjectType;
  subjectId: string;
  questionId: string;
  promptVersion: string;
  /** Passed to the registered question builder, e.g. a window id for a per-window question. */
  args?: unknown[];
  /** Overrides confidenceBand's defaults for this one ask — "tuned per use" (plan principle 4). */
  thresholds?: ConfidenceThresholds;
};

export type JevAskAnswer = {
  answer: JevAnswer;
  confidence: number;
  band: ConfidenceBand;
  questionId: string;
  promptVersion: string;
  subjectType: JevSubjectType;
  subjectId: string;
};

export type JevAskOutcome = {
  model: string;
  latencyMs: number;
  /** Keyed by answerKey. An ask Jev did not answer is simply absent here — never a fabricated
   * default — so a caller's `results[key]` being undefined IS the "no answer" signal. */
  results: Record<string, JevAskAnswer>;
  persisted: { ok: boolean; written: number; error?: string };
};

function extractConfidence(answer: JevAnswer): number {
  switch (answer.type) {
    case "noul":
      return noulConfidence(answer.noul);
    case "choice":
    case "score":
      return answer.confidence;
  }
}

function extractProbabilities(answer: JevAnswer): Record<string, number> | null {
  switch (answer.type) {
    case "noul":
      return null; // a single probability, already the answer itself — nothing to key by
    case "choice":
    case "score":
      return answer.probabilities;
  }
}

export class DuplicateAskKeyError extends Error {
  constructor(answerKey: string) {
    super(`askJev: duplicate answerKey "${answerKey}" in one batch`);
  }
}

/**
 * ETA-NOTE-SAFETY-SHADOW-REFUTER-VERDICT-23-SEP-2026.md finding 2, Fable's ruling: `answer` being
 * jsonb satisfies "no text column" on its face while jsonb carries text perfectly well —
 * `scribe_jev_decisions` describes `choice` as "a structured, closed-vocabulary value", but
 * nothing enforced that a returned `choice` is actually one of the question's own registered
 * options before this function persisted it. A `choice` outside that closed set is rejected here,
 * before the row is built — never stored, never returned in `results` (the same "absent means
 * unanswered" shape an ask Jev never answered already has). The rejected VALUE is never logged —
 * only its length — because the whole point is that it could be arbitrary text.
 */
function isValidChoice(question: JevQuestion, choice: string): boolean {
  if (question.type !== "choice") return true;
  return Object.prototype.hasOwnProperty.call(question.criteria, choice);
}

/**
 * ONE systemOne call for the whole batch (fan-out, plan principle 7), whatever `asks.length` is.
 * `opts.persist` defaults true; a caller benching against a labelled set with no intent to keep
 * the answers (lib/jev/bench.ts) passes persist:false so a bench run does not pollute jev_decision.
 */
export async function askJev(
  state: unknown,
  asks: JevAsk[],
  opts?: { signal?: AbortSignal; trace?: TraceHandle; model?: string; persist?: boolean },
): Promise<JevAskOutcome> {
  if (asks.length === 0) return { model: "", latencyMs: 0, results: {}, persisted: { ok: true, written: 0 } };

  const seenKeys = new Set<string>();
  const questions: Record<string, JevQuestion> = {};
  for (const ask of asks) {
    if (seenKeys.has(ask.answerKey)) throw new DuplicateAskKeyError(ask.answerKey);
    seenKeys.add(ask.answerKey);
    const build = getJevQuestion(ask.questionId, ask.promptVersion);
    questions[ask.answerKey] = build(...(ask.args ?? []));
  }

  const client = getJevClient();
  const result = await client.systemOne({ state, questions, model: opts?.model }, { signal: opts?.signal, trace: opts?.trace });

  recordJevBatchCall({
    questionIds: asks.map((a) => a.questionId),
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    latencyMs: result.latency_ms,
  });
  const inputTokensShare = Math.round(result.usage.input_tokens / asks.length);

  const results: Record<string, JevAskAnswer> = {};
  const rows: JevDecisionRow[] = [];
  for (const ask of asks) {
    const answer = result.answers[ask.answerKey];
    if (!answer) continue;
    if (answer.type === "choice" && !isValidChoice(questions[ask.answerKey]!, answer.choice)) {
      console.warn(
        "[jev] answer rejected: choice is not one of the question's own registered options",
        JSON.stringify({ questionId: ask.questionId, promptVersion: ask.promptVersion, subjectType: ask.subjectType, choiceLength: answer.choice.length }),
      );
      continue; // not stored, not returned — same shape as "Jev did not answer this key"
    }
    const confidence = extractConfidence(answer);
    const band = confidenceBand(confidence, ask.thresholds);
    results[ask.answerKey] = {
      answer, confidence, band,
      questionId: ask.questionId, promptVersion: ask.promptVersion,
      subjectType: ask.subjectType, subjectId: ask.subjectId,
    };
    rows.push({
      subjectType: ask.subjectType, subjectId: ask.subjectId,
      questionId: ask.questionId, promptVersion: ask.promptVersion,
      model: result.model, answer, probabilities: extractProbabilities(answer), confidence,
      latencyMs: result.latency_ms, inputTokens: inputTokensShare,
    });
  }

  const shouldPersist = opts?.persist ?? true;
  const persisted = shouldPersist ? await insertJevDecisions(rows) : { ok: true as const, written: 0 };
  if (!persisted.ok) {
    console.warn("[jev] decision persist failed", JSON.stringify({ error: persisted.error, rows: rows.length }));
  }

  return { model: result.model, latencyMs: result.latency_ms, results, persisted };
}
