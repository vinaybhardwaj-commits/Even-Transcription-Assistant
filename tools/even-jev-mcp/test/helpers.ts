import { metricDefinitions } from "../src/evaluation/metrics.js";
import { questionId } from "../src/evaluation/questions.js";
import type { Evaluation } from "../src/evaluation/types.js";
import type { JevResponse } from "../src/jev/schema.js";
import { toEvaluation } from "../src/evaluation/transform.js";

export function fakeJevResponse(options: {
  scoreByMetric?: Record<string, number>;
  applicabilityByMetric?: Record<string, number>;
  weaknessByMetric?: Record<string, string>;
} = {}): JevResponse {
  const answers: JevResponse["answers"] = {};

  for (const definition of metricDefinitions) {
    const score = options.scoreByMetric?.[definition.key] ?? 6;
    const applicability = options.applicabilityByMetric?.[definition.key]
      ?? (definition.conditional ? 0.1 : 0.95);
    const weakness = options.weaknessByMetric?.[definition.key] ?? "no_material_issue";

    answers[questionId(definition.key, "applicable")] = {
      type: "noul",
      noul: applicability
    };
    answers[questionId(definition.key, "score")] = {
      type: "score",
      score,
      legend: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index), String(index + 1)])),
      probabilities: Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index), index === Math.round(score) ? 1 : 0])),
      confidence: 0.86
    };
    answers[questionId(definition.key, "weakness")] = {
      type: "choice",
      choice: weakness,
      probabilities: Object.fromEntries(
        Object.keys(definition.weaknesses).map((key) => [key, key === weakness ? 1 : 0])
      ),
      confidence: 0.9
    };
  }

  return {
    model: "jev-latest",
    answers,
    usage: { input_tokens: 1_000, output_tokens: 100 }
  };
}

export function fakeEvaluation(): Evaluation {
  return toEvaluation(fakeJevResponse());
}
