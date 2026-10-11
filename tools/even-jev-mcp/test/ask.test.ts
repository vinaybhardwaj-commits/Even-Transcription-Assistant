import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { askInputSchema, askJev } from "../src/evaluation/ask.js";
import { JEV_MODEL, JevClient } from "../src/jev/client.js";

const noulQuestion = {
  type: "noul" as const,
  instructions: "Is this a noul question?",
  criteria: { true: "yes", false: "no" }
};

const choiceQuestion = {
  type: "choice" as const,
  instructions: "Pick one.",
  criteria: { a: "Option A", b: "Option B", none: null }
};

const scoreQuestion = {
  type: "score" as const,
  instructions: "Rate it.",
  criteria: ["1", "2", "3"]
};

describe("askInputSchema", () => {
  it("rejects unknown top-level keys", () => {
    const result = askInputSchema.safeParse({
      state: "hello",
      questions: { q1: noulQuestion },
      extra: "not allowed"
    });
    assert.equal(result.success, false);
  });

  it("rejects unknown keys inside a question", () => {
    const result = askInputSchema.safeParse({
      state: "hello",
      questions: { q1: { ...noulQuestion, bogus: true } }
    });
    assert.equal(result.success, false);
  });

  it("rejects zero questions", () => {
    const result = askInputSchema.safeParse({ state: "hello", questions: {} });
    assert.equal(result.success, false);
  });

  it("rejects more than 200 questions", () => {
    const questions = Object.fromEntries(
      Array.from({ length: 201 }, (_, index) => [`q${index}`, noulQuestion])
    );
    const result = askInputSchema.safeParse({ state: "hello", questions });
    assert.equal(result.success, false);
  });

  it("accepts exactly 200 questions", () => {
    const questions = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [`q${index}`, noulQuestion])
    );
    const result = askInputSchema.safeParse({ state: "hello", questions });
    assert.equal(result.success, true);
  });

  it("accepts all three question primitives", () => {
    const result = askInputSchema.safeParse({
      state: { some: "object" },
      questions: { noulQuestion, choiceQuestion, scoreQuestion }
    });
    assert.equal(result.success, true);
  });

  it("accepts string, object, and array state", () => {
    for (const state of ["text state", { a: 1 }, [1, 2, 3]]) {
      const result = askInputSchema.safeParse({ state, questions: { q1: noulQuestion } });
      assert.equal(result.success, true);
    }
  });
});

describe("askJev handler", () => {
  it("passes state and questions through unchanged to the client and returns usage plus telemetry", async () => {
    let observedState: unknown;
    let observedQuestions: unknown;
    const fakeFetch: typeof fetch = async (input, init) => {
      observedState = JSON.parse(String(init?.body)).state;
      observedQuestions = JSON.parse(String(init?.body)).questions;
      return new Response(
        JSON.stringify({
          model: JEV_MODEL,
          answers: {
            q1: { type: "noul", noul: 0.7 }
          },
          usage: { input_tokens: 5, output_tokens: 2 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });
    const state = { task: "check something", diff: "+ change" };
    const questions = { q1: noulQuestion };

    const result = await askJev({ state, questions }, { client });

    assert.deepEqual(observedState, state);
    assert.deepEqual(observedQuestions, questions);
    assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 2 });
    assert.equal(typeof result.latency_ms, "number");
    assert.equal(typeof result.input_bytes, "number");
    assert.deepEqual(result.answers, { q1: { type: "noul", noul: 0.7 } });
  });

  it("runs the guard before calling fetch, and never calls fetch on a guard failure", async () => {
    let fetchCalled = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        { status: 200 }
      );
    };
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });

    await assert.rejects(
      askJev(
        { state: "AKIA" + "ABCDEFGHIJKLMNOP", questions: { q1: noulQuestion } },
        { client }
      ),
      (error: unknown) => error instanceof Error && error.message.includes("aws_access_key_id")
    );

    assert.equal(fetchCalled, false);
  });

  it("screens question instructions for secret-like content, not just state", async () => {
    let fetchCalled = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        { status: 200 }
      );
    };
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });
    const leakedKey = `sk-${"a".repeat(30)}`;

    await assert.rejects(
      askJev(
        {
          state: "harmless state",
          questions: {
            q1: { ...noulQuestion, instructions: `Consider this key: ${leakedKey}` }
          }
        },
        { client }
      ),
      (error: unknown) => error instanceof Error && error.message.includes("openai_style_key")
    );

    assert.equal(fetchCalled, false);
  });

  it("screens choice question criteria values for secret-like content", async () => {
    let fetchCalled = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        { status: 200 }
      );
    };
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });
    const leakedKey = `sk-${"b".repeat(30)}`;

    await assert.rejects(
      askJev(
        {
          state: "harmless state",
          questions: {
            q1: { ...choiceQuestion, criteria: { ...choiceQuestion.criteria, a: leakedKey } }
          }
        },
        { client }
      ),
      (error: unknown) => error instanceof Error && error.message.includes("openai_style_key")
    );

    assert.equal(fetchCalled, false);
  });

  it("applies the byte cap to the full request body, not just state", async () => {
    let fetchCalled = false;
    const fakeFetch: typeof fetch = async () => {
      fetchCalled = true;
      return new Response(
        JSON.stringify({ model: JEV_MODEL, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        { status: 200 }
      );
    };
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });

    await assert.rejects(
      askJev(
        {
          state: "x",
          questions: {
            q1: { ...noulQuestion, instructions: "i".repeat(900_000) }
          }
        },
        { client }
      ),
      (error: unknown) => error instanceof Error && error.message.includes("exceeds the allowed size")
    );

    assert.equal(fetchCalled, false);
  });

  it("honours a valid model and rejects an invalid one", async () => {
    const validResult = askInputSchema.safeParse({
      state: "hello",
      questions: { q1: noulQuestion },
      model: "jev-preview"
    });
    assert.equal(validResult.success, true);

    const invalidResult = askInputSchema.safeParse({
      state: "hello",
      questions: { q1: noulQuestion },
      model: "not-a-real-model"
    });
    assert.equal(invalidResult.success, false);

    let observedModel: unknown;
    const fakeFetch: typeof fetch = async (input, init) => {
      observedModel = JSON.parse(String(init?.body)).model;
      return new Response(
        JSON.stringify({ model: "jev-preview", answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }),
        { status: 200 }
      );
    };
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });

    await askJev({ state: "hello", questions: { q1: noulQuestion }, model: "jev-preview" }, { client });
    assert.equal(observedModel, "jev-preview");
  });
});
