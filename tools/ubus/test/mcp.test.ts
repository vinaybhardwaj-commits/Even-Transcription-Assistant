import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpServer } from "../src/http.js";
import { TOOL_NAMES } from "../src/tools.js";
import { caller, register, setup } from "./helpers.js";

const REQUIRED = [
  "ubus_register",
  "ubus_heartbeat",
  "ubus_directory",
  "ubus_resolve",
  "ubus_groups",
  "ubus_send",
  "ubus_reply",
  "ubus_inbox",
  "ubus_wait",
  "ubus_thread",
  "ubus_ack",
  "ubus_request",
  "ubus_await",
  "ubus_escalate",
  "ubus_broadcast",
  "ubus_handoff",
];

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function post(port: number, body: unknown, headers: Record<string, string> = {}, path = "/mcp"): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

test("streamable HTTP exposes ubus_* tools and keeps a session handle", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
    const init = await post(port, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    assert.equal(init.status, 200);
    const sid = init.headers.get("mcp-session-id");
    assert.ok(sid);
    const list = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list" }, { "mcp-session-id": sid! });
    const tools = ((list.json.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
    for (const name of REQUIRED) assert.equal(tools.includes(name), true, name);
    for (const name of TOOL_NAMES) assert.equal(name.startsWith("ubus_"), true);
    const reg = await post(
      port,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "ubus_register",
          arguments: { handle: "cc-mini", machine: "mini", runtime: "claude-code", session: "s:cc-mini", owner: "fable", orchestrator: "fable" },
        },
      },
      { "mcp-session-id": sid! },
    );
    const regText = JSON.parse(((reg.json.result as { content: Array<{ text: string }> }).content)[0]!.text) as { ok: boolean; handle: string };
    assert.equal(regText.ok, true);
    assert.equal(regText.handle, "cc-mini");
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const send = await post(
      port,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "ubus_send", arguments: { to: ["fable"], subject: "ping", body: "count=1 path=~/dev/eta-lab/p.json" } },
      },
      { "mcp-session-id": sid! },
    );
    const sendText = JSON.parse(((send.json.result as { content: Array<{ text: string }> }).content)[0]!.text) as { ok: boolean };
    assert.equal(sendText.ok, true);
    const who = await rig.ubus.call("ubus_whoami", {}, caller("cc-mini"));
    assert.equal(who.machine, "mini");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test("edge auth accepts an access service token or a secret path and rejects a bare cloudflare request", async () => {
  const rig = setup((cfg) => {
    cfg.edgeAuth.enabled = true;
    cfg.edgeAuth.allowLoopback = true;
    const dir = mkdtempSync(join(tmpdir(), "ubus-auth-"));
    cfg.edgeAuth.tokensFile = join(dir, "tokens.json");
    cfg.edgeAuth.secretPathsFile = join(dir, "paths.json");
    writeFileSync(cfg.edgeAuth.tokensFile, JSON.stringify({ clients: [{ id: "grok-id", secret: "grok-secret", class: "grok-platform" }] }));
    writeFileSync(cfg.edgeAuth.secretPathsFile, JSON.stringify({ paths: [{ secret: "path-secret-value", class: "cursor-cloud" }] }));
  });
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  try {
    const bare = await post(port, init, { "cf-ray": "abc" });
    assert.equal(bare.status, 401);
    const token = await post(port, init, { "cf-ray": "abc", "cf-access-client-id": "grok-id", "cf-access-client-secret": "grok-secret" });
    assert.equal(token.status, 200);
    const bad = await post(port, init, { "cf-ray": "abc", "cf-access-client-id": "grok-id", "cf-access-client-secret": "nope" });
    assert.equal(bad.status, 401);
    const path = await post(port, init, { "cf-ray": "abc" }, "/mcp/path-secret-value");
    assert.equal(path.status, 200);
    const local = await post(port, init, {});
    assert.equal(local.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});
