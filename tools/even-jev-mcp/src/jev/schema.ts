import { z } from "zod";

const probabilityMapSchema = z.record(z.string(), z.number().min(0).max(1));

export const jevNoulAnswerSchema = z
  .object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1)
  })
  .passthrough();

export const jevChoiceAnswerSchema = z
  .object({
    type: z.literal("choice"),
    choice: z.string(),
    probabilities: probabilityMapSchema,
    confidence: z.number().min(0).max(1)
  })
  .passthrough();

export const jevScoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number().min(0).max(9),
    legend: z.record(z.string(), z.string()),
    probabilities: probabilityMapSchema,
    confidence: z.number().min(0).max(1)
  })
  .passthrough();

export const jevAnswerSchema = z.discriminatedUnion("type", [
  jevNoulAnswerSchema,
  jevChoiceAnswerSchema,
  jevScoreAnswerSchema
]);

export const jevResponseSchema = z
  .object({
    model: z.string(),
    answers: z.record(z.string(), jevAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative()
      })
      .passthrough()
  })
  .passthrough();

export type JevResponse = z.infer<typeof jevResponseSchema>;
