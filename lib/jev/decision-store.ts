/**
 * lib/jev/decision-store.ts — J-CORE-1/2: writes jev_decision rows (migration 116).
 *
 * The only writer to jev_decision this build ships — lib/jev/ask.ts calls it once per fan-out
 * ask, after a systemOne call returns. Best-effort: a write failure here must never take away an
 * answer the caller already has (same fail-safe discipline as every MCP tool and gcp-auth's
 * mint-elapsed log, lib/mcp/registry.ts's own header) — see recordJevDecisions below.
 */
import { customAlphabet } from "nanoid";
import { sql } from "@/lib/db";
import type { JevSubjectType } from "./types";

const decisionId = customAlphabet("abcdefghjkmnpqrstuvwxyz23456789", 8);

export function newJevDecisionId(): string {
  return `jd_${decisionId()}`;
}

export type JevDecisionRow = {
  subjectType: JevSubjectType;
  subjectId: string;
  questionId: string;
  promptVersion: string;
  model: string;
  /** The structured JevAnswer, never free text — see the migration's own column comment. */
  answer: unknown;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
};

/**
 * Upserts one batch in one round trip. `sql` (lib/db.ts) is a tagged-template client with no
 * bulk-VALUES helper, so this builds the batch as one INSERT ... SELECT * FROM jsonb_to_recordset
 * — a single parameter (the JSON array) rather than N separate statements or an N-way UNION ALL,
 * which is also why every row's `answer`/`probabilities` are passed through JSON.stringify: the
 * whole batch crosses the wire as one jsonb value that Postgres unpacks server-side.
 */
export async function insertJevDecisions(rows: JevDecisionRow[]): Promise<{ ok: boolean; written: number; error?: string }> {
  if (rows.length === 0) return { ok: true, written: 0 };
  const payload = rows.map((r) => ({
    id: newJevDecisionId(),
    subject_type: r.subjectType,
    subject_id: r.subjectId,
    question_id: r.questionId,
    prompt_version: r.promptVersion,
    model: r.model,
    answer: r.answer,
    probabilities: r.probabilities,
    confidence: r.confidence,
    latency_ms: r.latencyMs,
    input_tokens: r.inputTokens,
  }));
  try {
    await sql`
      INSERT INTO jev_decision
        (id, subject_type, subject_id, question_id, prompt_version, model, answer, probabilities, confidence, latency_ms, input_tokens)
      SELECT
        id, subject_type, subject_id, question_id, prompt_version, model, answer, probabilities, confidence, latency_ms, input_tokens
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
        id text, subject_type text, subject_id text, question_id text, prompt_version text,
        model text, answer jsonb, probabilities jsonb, confidence real, latency_ms int, input_tokens int
      )
      ON CONFLICT (subject_type, subject_id, question_id, prompt_version) DO UPDATE SET
        model = EXCLUDED.model, answer = EXCLUDED.answer, probabilities = EXCLUDED.probabilities,
        confidence = EXCLUDED.confidence, latency_ms = EXCLUDED.latency_ms, input_tokens = EXCLUDED.input_tokens,
        created_at = now()
    `;
    return { ok: true, written: payload.length };
  } catch (e) {
    return { ok: false, written: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
