import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { metricDefinitions } from "../src/evaluation/metrics.js";
import { buildJevQuestions, questionId, SCORE_LEVELS } from "../src/evaluation/questions.js";

describe("Jev questions", () => {
  it("uses Jev-native decisions for every independent metric", () => {
    const questions = buildJevQuestions();
    assert.equal(Object.keys(questions).length, metricDefinitions.length * 3);

    for (const definition of metricDefinitions) {
      assert.equal(questions[questionId(definition.key, "applicable")]?.type, "noul");
      assert.equal(questions[questionId(definition.key, "score")]?.type, "score");
      assert.equal(questions[questionId(definition.key, "weakness")]?.type, "choice");
    }
  });

  it("provides all ten score levels and reserves 10 for exceptional work", () => {
    assert.equal(SCORE_LEVELS.length, 10);
    assert.match(SCORE_LEVELS[9], /Exceptional/);
    assert.match(SCORE_LEVELS[9], /Use rarely/);
  });
});
