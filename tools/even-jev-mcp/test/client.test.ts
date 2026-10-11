import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { JevApiError, JevClient, JEV_API_ENDPOINT, JEV_MODEL } from "../src/jev/client.js";

const validResponse = {
  model: JEV_MODEL,
  answers: {},
  usage: { input_tokens: 10, output_tokens: 2 }
};

describe("Jev client", () => {
  it("sends the key only in the direct Jev authorization header", async () => {
    let observedUrl = "";
    let observedAuthorization = "";
    let observedBody: Record<string, unknown> = {};
    const fakeFetch: typeof fetch = async (input, init) => {
      observedUrl = String(input);
      observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };

    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });
    await client.evaluate({ diff: "+ change" }, {});

    assert.equal(observedUrl, JEV_API_ENDPOINT);
    assert.equal(observedAuthorization, "Bearer test-secret");
    assert.equal(observedBody.model, JEV_MODEL);
    assert.deepEqual(observedBody.state, { diff: "+ change" });
  });

  it("retries documented transient failures with bounded backoff", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fakeFetch: typeof fetch = async () => {
      attempts += 1;
      if (attempts === 1) return new Response("overloaded", { status: 529 });
      return new Response(JSON.stringify(validResponse), { status: 200 });
    };

    const client = new JevClient({
      apiKey: "test-secret",
      fetchImplementation: fakeFetch,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      }
    });
    await client.evaluate("state", {});

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [250]);
  });

  it("never starts without an API key", () => {
    assert.throws(() => new JevClient({ apiKey: " " }), JevApiError);
  });

  it("explains Jev's upstream token-limit response", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ detail: { error_type: "max_tokens_exceeded" } }), {
        status: 400,
        headers: { "content-type": "application/json" }
      });
    const client = new JevClient({ apiKey: "test-secret", fetchImplementation: fakeFetch });

    await assert.rejects(
      client.evaluate({ diff: "+ oversized change" }, {}),
      (error: unknown) =>
        error instanceof JevApiError &&
        error.status === 400 &&
        error.message.includes("split the change across multiple review calls")
    );
  });
});
