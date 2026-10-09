import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toEvaluation } from "../src/evaluation/transform.js";
import { fakeJevResponse } from "./helpers.js";

describe("evaluation transformation", () => {
  it("normalizes Jev scores, keeps conditional metrics conditional, and prioritizes correctness", () => {
    const response = fakeJevResponse({
      scoreByMetric: { correctness: 2 },
      weaknessByMetric: { correctness: "missing_behavior" }
    });

    const result = toEvaluation(response);
    assert.equal(result.metrics.correctness.score, 3);
    assert.equal(result.metrics.correctness.issues?.[0]?.severity, "high");
    assert.match(result.metrics.correctness.issues?.[0]?.description ?? "", /missing or incomplete/);
    assert.equal(result.metrics.performance.applicable, false);
    assert.equal(result.priorities[0]?.metric, "correctness");
    assert.equal("overallScore" in result, false);
  });

  it("compares dimensions without inventing an overall score", () => {
    const previous = toEvaluation(fakeJevResponse({ scoreByMetric: { readability: 4, security: 7 } }));
    const current = toEvaluation(
      fakeJevResponse({ scoreByMetric: { readability: 7, security: 5 } }),
      previous
    );

    assert.deepEqual(current.comparison?.find((entry) => entry.metric === "readability"), {
      metric: "readability",
      previousScore: 5,
      currentScore: 8,
      delta: 3,
      direction: "improved"
    });
    assert.ok(current.improvements?.some((entry) => entry.startsWith("Readability and intent")));
    assert.ok(current.regressions?.some((entry) => entry.startsWith("Security")));
  });

  it("fails closed when Jev omits a required decision", () => {
    const response = fakeJevResponse();
    delete response.answers.correctness_score;
    assert.throws(() => toEvaluation(response), /omitted the score for correctness/);
  });
});
