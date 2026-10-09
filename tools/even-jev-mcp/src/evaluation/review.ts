import { reviewInputSchema, toJevState, type ReviewInput } from "./input.js";
import { buildJevQuestions } from "./questions.js";
import { toEvaluation } from "./transform.js";
import type { Evaluation } from "./types.js";
import { getJevApiKey, getMaxInputBytes, isSecretScreeningDisabled } from "../config/environment.js";
import { assertRequestIsSafe, JevGuardError } from "../guard/limits.js";
import { JEV_MODEL, JevApiError, JevClient } from "../jev/client.js";
import { logOutboundCall } from "./telemetry.js";

export type ReviewDependencies = {
  apiKey?: string;
  client?: Pick<JevClient, "evaluate">;
};

export async function reviewWithJev(
  rawInput: ReviewInput,
  dependencies: ReviewDependencies = {}
): Promise<Evaluation> {
  const input = reviewInputSchema.parse(rawInput);
  const state = toJevState(input);
  const questions = buildJevQuestions();

  // Guard the exact outbound request body: state (including files[].path),
  // model, and every question's instructions/criteria.
  const body = { state, model: JEV_MODEL, questions };
  const inputBytes = Buffer.byteLength(JSON.stringify(body));
  const questionCount = Object.keys(questions).length;

  try {
    assertRequestIsSafe(body, getMaxInputBytes(), isSecretScreeningDisabled());
  } catch (error) {
    if (error instanceof JevGuardError) {
      logOutboundCall({
        tool: "jev_review",
        inputBytes,
        questionCount,
        latencyMs: 0,
        status: 0,
        refused: error.code.join(",")
      });
    }
    throw error;
  }

  const client = dependencies.client ?? new JevClient({
    apiKey: dependencies.apiKey ?? getJevApiKey()
  });

  const startedAt = Date.now();
  let status = 200;

  try {
    const response = await client.evaluate(state, questions);
    return toEvaluation(response, input.previousEvaluation);
  } catch (error) {
    status = error instanceof JevApiError && error.status !== undefined ? error.status : 0;
    throw error;
  } finally {
    logOutboundCall({
      tool: "jev_review",
      inputBytes,
      questionCount,
      latencyMs: Date.now() - startedAt,
      status
    });
  }
}
