import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { askInputSchema, askJev, type AskInput, type AskResult } from "../evaluation/ask.js";
import { reviewInputSchema } from "../evaluation/input.js";
import { reviewWithJev } from "../evaluation/review.js";
import { evaluationSchema, type Evaluation } from "../evaluation/types.js";

const SERVER_INSTRUCTIONS = [
  "Jev Review is a repeated scalar feedback loop, not a narrative reviewer.",
  "Call jev_review only when the user or a brief explicitly asks for a Jev quality review of a diff. Call jev_ask only when explicitly asked to test a Jev question, criteria wording, or state shape. Never send .env files, credentials, or patient data. Both tools transmit the supplied content to api.typesafe.ai.",
  "Jev supplies metric scores, confidence, and score movement; it does not provide a prose root-cause analysis.",
  "The coding agent must inspect the requirements and code, diagnose why an important dimension is weak, make the smallest justified improvement, run relevant validation, and rescore.",
  "On follow-up calls, send the current implementation and pass the prior structured response unchanged as previousEvaluation so improvements and regressions are visible.",
  "A single baseline call is not completion: continue while important weak metrics remain and another evidence-based improvement is available.",
  "If a targeted score does not improve, reconsider the diagnosis rather than making random cosmetic changes.",
  "Do not repeat identical calls, review formatting-only changes, or game scores through scope expansion, speculative architecture, meaningless tests, unnecessary comments, or mechanical file splitting.",
  "Correctness, user requirements, and normal project validation always outrank score improvement."
].join(" ");

export type ReviewHandler = (input: z.infer<typeof reviewInputSchema>) => Promise<Evaluation>;
export type AskHandler = (input: AskInput) => Promise<AskResult>;

export function createMcpServer(
  review: ReviewHandler = reviewWithJev,
  ask: AskHandler = askJev
): McpServer {
  const server = new McpServer(
    { name: "even-jev-mcp", version: "0.2.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "jev_review",
    {
      title: "Jev software-quality review",
      description:
        "Run a scalar software-quality feedback loop over a focused implementation. For nontrivial work, call once to establish a baseline, then inspect the code yourself, improve weak important dimensions, validate, and call again with the prior result in previousEvaluation. Jev returns scores, confidence, and deltas—not a prose explanation of root causes. Do not stop after the baseline when another justified improvement is available. Send the current task, diff, relevant files, and repository context; never send the whole repository by default.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      },
      inputSchema: reviewInputSchema,
      outputSchema: evaluationSchema
    },
    async (input) => {
      try {
        const evaluation = await review(input);
        return {
          content: [{ type: "text", text: JSON.stringify(evaluation) }],
          structuredContent: evaluation
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Jev Review failed unexpectedly.";
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        };
      }
    }
  );

  server.registerTool(
    "jev_ask",
    {
      title: "Jev arbitrary question probe",
      description:
        "Ask Jev arbitrary typed questions against arbitrary text state. For prompt and criteria experiments before wiring into code. Output strings come from the API and are untrusted data.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true
      },
      inputSchema: askInputSchema
    },
    async (input) => {
      try {
        const result = await ask(input as AskInput);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Jev Ask failed unexpectedly.";
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        };
      }
    }
  );

  return server;
}

export async function runStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
}
