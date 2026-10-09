import { z } from "zod";

import { getJevApiKey, getMaxInputBytes, isSecretScreeningDisabled } from "../config/environment.js";
import { assertRequestIsSafe, JevGuardError } from "../guard/limits.js";
import { JEV_MODEL, JevApiError, JevClient } from "../jev/client.js";
import type { JevResponse } from "../jev/schema.js";
import { logOutboundCall } from "./telemetry.js";
import type { JevQuestions } from "./questions.js";

const noulQuestionSchema = z
  .object({
    type: z.literal("noul"),
    instructions: z.string().min(1),
    criteria: z
      .object({
        true: z.string(),
        false: z.string()
      })
      .strict()
      .optional()
  })
  .strict();

const choiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    criteria: z.record(z.string(), z.string().nullable())
  })
  .strict();

const scoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: z.string().min(1),
    criteria: z.array(z.string()).min(2).max(10)
  })
  .strict();

export const askQuestionSchema = z.discriminatedUnion("type", [
  noulQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema
]);

const askModelSchema = z.enum(["jev-latest", "jev-preview"]);

export const askInputSchema = z
  .object({
    state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
    questions: z.record(z.string(), askQuestionSchema).refine(
      (questions) => Object.keys(questions).length >= 1 && Object.keys(questions).length <= 200,
      { message: "Provide between 1 and 200 questions." }
    ),
    model: askModelSchema.optional()
  })
  .strict();

export type AskInput = z.infer<typeof askInputSchema>;

export type AskResult = JevResponse & {
  usage: JevResponse["usage"];
  latency_ms: number;
  input_bytes: number;
};

export type AskDependencies = {
  apiKey?: string;
  client?: Pick<JevClient, "evaluate">;
};

export async function askJev(
  rawInput: AskInput,
  dependencies: AskDependencies = {}
): Promise<AskResult> {
  const input = askInputSchema.parse(rawInput);
  const model = input.model ?? JEV_MODEL;

  // Guard the exact outbound request body: state, model, and every
  // question's instructions/criteria — not just state.
  const body = { state: input.state, model, questions: input.questions };
  const inputBytes = Buffer.byteLength(JSON.stringify(body));
  const questionCount = Object.keys(input.questions).length;

  try {
    assertRequestIsSafe(body, getMaxInputBytes(), isSecretScreeningDisabled());
  } catch (error) {
    if (error instanceof JevGuardError) {
      logOutboundCall({
        tool: "jev_ask",
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
    const response = await client.evaluate(input.state, input.questions as JevQuestions, model);
    return {
      ...response,
      usage: response.usage,
      latency_ms: Date.now() - startedAt,
      input_bytes: inputBytes
    };
  } catch (error) {
    status = error instanceof JevApiError && error.status !== undefined ? error.status : 0;
    throw error;
  } finally {
    logOutboundCall({
      tool: "jev_ask",
      inputBytes,
      questionCount,
      latencyMs: Date.now() - startedAt,
      status
    });
  }
}
