import { z } from "zod";

import { evaluationSchema } from "./types.js";

export const reviewFileSchema = z
  .object({
    path: z.string().min(1).describe("Repository-relative path for this relevant file."),
    content: z.string().describe("Current file content needed to understand or evaluate the change.")
  })
  .strict();

export const reviewInputSchema = z
  .object({
    task: z
      .string()
      .min(1)
      .describe("The user's requested behavior, acceptance constraints, and relevant invariants.")
      .optional(),
    diff: z
      .string()
      .min(1)
      .describe("The current implementation diff, updated after the most recent improvement.")
      .optional(),
    files: z
      .array(reviewFileSchema)
      .describe("Only current files whose surrounding content is required to judge the implementation.")
      .optional(),
    repositoryContext: z
      .string()
      .min(1)
      .describe("Relevant architecture, conventions, test results, or constraints not evident from the diff.")
      .optional(),
    previousEvaluation: evaluationSchema
      .describe("The prior jev_review response, passed unchanged to calculate score deltas locally.")
      .optional()
  })
  .strict()
  .superRefine((input, context) => {
    const hasContext = Boolean(
      input.task || input.diff || input.repositoryContext || input.files?.length
    );
    if (!hasContext) {
      context.addIssue({
        code: "custom",
        message: "Provide at least one of task, diff, files, or repositoryContext"
      });
    }
  });

export type ReviewInput = z.infer<typeof reviewInputSchema>;

export type JevReviewState = {
  task?: string;
  diff?: string;
  files?: Array<{ path: string; content: string }>;
  repositoryContext?: string;
};

export function toJevState(input: ReviewInput): JevReviewState {
  const state: JevReviewState = {};
  if (input.task !== undefined) state.task = input.task;
  if (input.diff !== undefined) state.diff = input.diff;
  if (input.files !== undefined) state.files = input.files;
  if (input.repositoryContext !== undefined) state.repositoryContext = input.repositoryContext;
  return state;
}
