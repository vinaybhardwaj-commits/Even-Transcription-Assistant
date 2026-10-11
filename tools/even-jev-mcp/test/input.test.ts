import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewInputSchema, toJevState } from "../src/evaluation/input.js";
import { fakeEvaluation } from "./helpers.js";

describe("review input", () => {
  it("requires focused implementation context", () => {
    const result = reviewInputSchema.safeParse({});
    assert.equal(result.success, false);
  });

  it("does not impose plugin-specific context or file-count limits", () => {
    const result = reviewInputSchema.safeParse({
      task: "t".repeat(10_001),
      diff: "d".repeat(80_001),
      repositoryContext: "r".repeat(25_001),
      files: Array.from({ length: 31 }, (_, index) => ({
        path: `${"p".repeat(1_025)}-${index}`,
        content: "c".repeat(60_001)
      }))
    });
    assert.equal(result.success, true);
  });

  it("does not send previous scores back as current code context", () => {
    const input = reviewInputSchema.parse({
      task: "Add safe retries",
      diff: "+ retry();",
      previousEvaluation: fakeEvaluation()
    });
    assert.deepEqual(toJevState(input), {
      task: "Add safe retries",
      diff: "+ retry();"
    });
  });
});
