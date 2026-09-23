/**
 * lib/jev/counters.ts — J-CORE-1: cost and latency counters, aggregated across calls.
 *
 * lib/jev/client.ts's JevResult already carries ONE call's usage/latency_ms; this aggregates
 * across every call this process makes, broken down by question_id, so "how much is this use
 * actually costing / how slow is it" is answerable without grepping trace logs. In-process only
 * (no persistence, no cross-instance aggregation) — jev_decision (migration 116) is the durable
 * record; this is a cheap running total for a dashboard or a log line, and resets on redeploy.
 *
 * JEV_INPUT_TOKEN_COST_USD matches the rate lib/jobs/kinds/jev-role.ts already computes inline
 * (`inputTokens * 42e-9`) — named and shared here rather than a second unlabelled copy of the same
 * number. Output tokens are not currently billed for systemOne's answer shape (fixed-format
 * choice/score/noul, not free text), so only input tokens are costed; the field is still tracked
 * per call in case that changes.
 *
 * APPORTIONMENT (why recordJevBatchCall takes every questionId in the call, not one). A fanned-out
 * systemOne call reports ONE usage total for every question it answered together — Jev does not
 * itemise per question. Crediting that whole total to EACH question would make `byQuestion`'s
 * token sum a multiple of what was actually spent, which is worse than not tracking it at all: a
 * caller reading the total off `jevCounterSnapshot().inputTokens` would see one true number, and
 * the sum of every `byQuestion[...].inputTokens` would silently disagree with it. Tokens are
 * therefore split EVENLY across the call's questions, so the two totals always reconcile. Latency
 * is NOT split: every question in one fanned-out call waited the SAME wall-clock time for it (they
 * answered together), so the full call latency is credited to each — `overall.latencyMsTotal`
 * counts it once per CALL, `byQuestion[...].latencyMsAvg` counts it once per call THAT QUESTION
 * WAS PART OF, and the two are answering different questions on purpose, not disagreeing.
 */

/** $ per input token. Matches lib/jobs/kinds/jev-role.ts's existing inline rate (42e-9/token). */
export const JEV_INPUT_TOKEN_COST_USD = 42e-9;

export type JevBatchCallRecord = {
  /** Every question_id answered in this one systemOne call — used to apportion tokens evenly. */
  questionIds: string[];
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
};

export type JevCounterSnapshot = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  latencyMsTotal: number;
  latencyMsAvg: number;
  byQuestion: Record<string, { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMsAvg: number }>;
};

type MutableTotals = { calls: number; inputTokens: number; outputTokens: number; latencyMsTotal: number };

function emptyTotals(): MutableTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, latencyMsTotal: 0 };
}

let overall: MutableTotals = emptyTotals();
const byQuestion = new Map<string, MutableTotals>();

/** Records ONE systemOne HTTP call, however many questions it fanned out to. */
export function recordJevBatchCall(rec: JevBatchCallRecord): void {
  overall.calls += 1;
  overall.inputTokens += rec.inputTokens;
  overall.outputTokens += rec.outputTokens;
  overall.latencyMsTotal += rec.latencyMs;

  const n = rec.questionIds.length;
  if (n === 0) return;
  const inputShare = rec.inputTokens / n;
  const outputShare = rec.outputTokens / n;
  for (const questionId of rec.questionIds) {
    const q = byQuestion.get(questionId) ?? emptyTotals();
    q.calls += 1;
    q.inputTokens += inputShare;
    q.outputTokens += outputShare;
    q.latencyMsTotal += rec.latencyMs; // full latency, deliberately not split — see file header
    byQuestion.set(questionId, q);
  }
}

function toSnapshotEntry(t: MutableTotals): { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number; latencyMsAvg: number } {
  return {
    calls: t.calls,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    estimatedCostUsd: t.inputTokens * JEV_INPUT_TOKEN_COST_USD,
    latencyMsAvg: t.calls > 0 ? t.latencyMsTotal / t.calls : 0,
  };
}

export function jevCounterSnapshot(): JevCounterSnapshot {
  const overallEntry = toSnapshotEntry(overall);
  const byQuestionSnapshot: JevCounterSnapshot["byQuestion"] = {};
  for (const [questionId, t] of byQuestion) byQuestionSnapshot[questionId] = toSnapshotEntry(t);
  return {
    calls: overallEntry.calls,
    inputTokens: overallEntry.inputTokens,
    outputTokens: overallEntry.outputTokens,
    estimatedCostUsd: overallEntry.estimatedCostUsd,
    latencyMsTotal: overall.latencyMsTotal,
    latencyMsAvg: overallEntry.latencyMsAvg,
    byQuestion: byQuestionSnapshot,
  };
}

/** Test-only: counters are process-lifetime state with no natural reset. */
export function _resetJevCountersForTests(): void {
  overall = emptyTotals();
  byQuestion.clear();
}
