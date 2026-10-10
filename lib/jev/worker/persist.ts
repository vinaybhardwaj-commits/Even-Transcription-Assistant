/**
 * lib/jev/worker/persist.ts — the worker's writes: the call ledger row and the decision rows (PRD §5).
 *
 * IDEMPOTENT on the worker key (subject_type, subject_id, question_id, question_set_sha256, order_variant, mode): a replayed step
 * overwrites the same rows and writes NONE new. No text in any column: `answer` is a closed-vocabulary JevAnswer (or a typed
 * placeholder), `evidence` holds ids and counts, `state_sha256` is an HMAC.
 */
import { customAlphabet } from "nanoid";
import { createHmac } from "node:crypto";
import { sql } from "@/lib/db";
import { canonicalJson } from "./canonical";
import type { JevMode } from "./flags";

const nano = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 10);
export const newCallId = (): string => `jc_${nano()}`;
export const newDecisionId = (): string => `jd_${nano()}`;

export type CallRecord = {
  id: string; jobId: string | null; use: string; mode: JevMode; setSha: string | null; subjectCount: number; questionCount: number;
  modelRequested: string | null; modelReturned: string | null; httpStatus: number | null; errorClass: string | null; latencyMs: number | null;
  inputTokens: number; outputTokens: number; costUsd: number; stateBytes: number; mock: boolean; breakerState: string | null;
};

export async function insertCall(c: CallRecord): Promise<void> {
  await sql`
    INSERT INTO jev_call (id, job_id, use, mode, question_set_sha256, subject_count, question_count, model_requested, model_returned, http_status,
                          error_class, latency_ms, input_tokens, output_tokens, cost_usd, state_bytes, mock, breaker_state)
    VALUES (${c.id}, ${c.jobId}, ${c.use}, ${c.mode}, ${c.setSha}, ${c.subjectCount}, ${c.questionCount}, ${c.modelRequested}, ${c.modelReturned}, ${c.httpStatus},
            ${c.errorClass}, ${c.latencyMs}, ${c.inputTokens}, ${c.outputTokens}, ${c.costUsd}, ${c.stateBytes}, ${c.mock}, ${c.breakerState})
    ON CONFLICT (id) DO NOTHING`;
}

export type WorkerDecision = {
  subjectType: string; subjectId: string; questionId: string; promptVersion: string; model: string;
  setId: string; setVersion: string; setSha: string; orderVariant: "fwd" | "rev" | "derived"; optionOrderSha: string | null; lane: "timeline" | "text";
  answer: unknown; probabilities: Record<string, number> | null; confidence: number | null; band: "act" | "caution" | "review" | "abstain" | null;
  outcome: "answered" | "no_answer" | "off_menu_rejected" | "gated_overwritten" | "state_too_large" | "error";
  callId: string | null; jobId: string | null; mode: JevMode; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
  evidence: Record<string, unknown>; stateSha: string | null; mock: boolean;
};

export async function upsertDecisions(rows: WorkerDecision[]): Promise<number> {
  if (rows.length === 0) return 0;
  const payload = rows.map((r) => ({
    id: newDecisionId(), subject_type: r.subjectType, subject_id: r.subjectId, question_id: r.questionId, prompt_version: r.promptVersion, model: r.model,
    question_set_id: r.setId, question_set_version: r.setVersion, question_set_sha256: r.setSha, order_variant: r.orderVariant, option_order_sha256: r.optionOrderSha,
    lane: r.lane, answer: r.answer, probabilities: r.probabilities, confidence: r.confidence, band: r.band, outcome: r.outcome, call_id: r.callId, job_id: r.jobId,
    mode: r.mode, latency_ms: r.latencyMs, input_tokens: r.inputTokens, output_tokens: r.outputTokens, cost_usd: r.costUsd, evidence: r.evidence, state_sha256: r.stateSha, mock: r.mock,
  }));
  await sql`
    INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant,
                              option_order_sha256, lane, answer, probabilities, confidence, band, outcome, call_id, job_id, mode, latency_ms, input_tokens, output_tokens,
                              cost_usd, evidence, state_sha256, mock)
    SELECT id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant,
           option_order_sha256, lane, answer, probabilities, confidence, band, outcome, call_id, job_id, mode, latency_ms, input_tokens, output_tokens,
           cost_usd, evidence, state_sha256, mock
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
        id text, subject_type text, subject_id text, question_id text, prompt_version text, model text, question_set_id text, question_set_version text,
        question_set_sha256 text, order_variant text, option_order_sha256 text, lane text, answer jsonb, probabilities jsonb, confidence real, band text,
        outcome text, call_id text, job_id text, mode text, latency_ms int, input_tokens int, output_tokens int, cost_usd numeric, evidence jsonb,
        state_sha256 text, mock boolean)
    ON CONFLICT (subject_type, subject_id, question_id, question_set_sha256, order_variant, mode) WHERE question_set_sha256 IS NOT NULL DO UPDATE SET
      model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version, answer = EXCLUDED.answer, probabilities = EXCLUDED.probabilities, confidence = EXCLUDED.confidence,
      band = EXCLUDED.band, outcome = EXCLUDED.outcome, call_id = EXCLUDED.call_id, job_id = EXCLUDED.job_id, latency_ms = EXCLUDED.latency_ms,
      input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens, cost_usd = EXCLUDED.cost_usd, evidence = EXCLUDED.evidence,
      state_sha256 = EXCLUDED.state_sha256, mock = EXCLUDED.mock, created_at = now()`;
  return rows.length;
}

/** HMAC-SHA256 of the canonical state with a server secret (a bare hash would let short text be confirmed by guessing). Null when the secret is unset. */
export function stateHmac(state: unknown): string | null {
  const key = process.env.JEV_STATE_HMAC_KEY;
  if (!key) return null;
  return createHmac("sha256", key).update(canonicalJson(state), "utf8").digest("hex");
}
