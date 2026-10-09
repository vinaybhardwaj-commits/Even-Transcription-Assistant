import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reviewWithJev } from "../src/evaluation/review.js";
import { JEV_MODEL, JevClient } from "../src/jev/client.js";

describe("reviewWithJev guard", () => {
  it("screens files[].path for secret-like content, and never calls fetch", async () => {
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
      reviewWithJev(
        {
          task: "Review this",
          files: [{ path: "AKIAIOSFODNN7EXAMPLE.txt", content: "harmless content" }]
        },
        { client }
      ),
      (error: unknown) => error instanceof Error && error.message.includes("aws_access_key_id")
    );

    assert.equal(fetchCalled, false);
  });

  it("screens multiline env-style secret assignments in the diff, not just the serialized body", async () => {
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
      reviewWithJev(
        {
          diff: "config:\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIKbPxRfiCYEXAMPLEKEY\nend"
        },
        { client }
      ),
      (error: unknown) =>
        error instanceof Error && error.message.includes("env_style_secret_assignment")
    );

    assert.equal(fetchCalled, false);
  });
});
