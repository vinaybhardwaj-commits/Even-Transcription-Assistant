import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/mcp/server.js";
import { fakeEvaluation } from "./helpers.js";

describe("MCP server", () => {
  it("exposes machine-readable jev_review and jev_ask tools", async () => {
    const expected = fakeEvaluation();
    const server = createMcpServer(async () => expected);
    const client = new Client({ name: "jev-review-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name).sort(),
        ["jev_ask", "jev_review"]
      );

      const result = await client.callTool({
        name: "jev_review",
        arguments: { task: "Test the MCP boundary", diff: "+ safe change" }
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, expected);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
