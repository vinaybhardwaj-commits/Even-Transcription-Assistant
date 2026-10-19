import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request as forwardRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { hookEndpoint } from "../src/client-config.js";
import { createHttpServer } from "../src/http.js";
import { caller, register, setup, cleanEnv } from "./helpers.js";

const TS_HOST = ["mini", "tail000000", "ts", "net"].join(".");

const hookBin = fileURLToPath(new URL("../bin/ubus-hook.js", import.meta.url));
const shimBin = fileURLToPath(new URL("../bin/ubus-mcp.js", import.meta.url));

function runHook(op: string, env: NodeJS.ProcessEnv, extra: string[] = [], stdin = ""): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", hookBin, op, ...extra], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => {
      stdout += String(b);
    });
    child.stderr.on("data", (b) => {
      stderr += String(b);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("hooks register, count mail without bodies, block stop once, and re-wake", async () => {
  const rig = setup();
  const cache = mkdtempSync(join(tmpdir(), "ubus-cache-"));
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    UBUS_URL: `http://127.0.0.1:${port}/mcp`,
    UBUS_CACHE_DIR: cache,
    UBUS_MACHINE: "mini",
    UBUS_RUNTIME: "claude-code",
    UBUS_OWNER: "fable",
    HERDR_AGENT_NAME: "eta-refuter",
    HERDR_SESSION: "default",
  };
  const stdin = JSON.stringify({ session_id: "sess-1", cwd: "/tmp/eta-refuter", hook_event_name: "SessionStart", source: "startup" });
  try {
    const started = await runHook("session-start", env, [], stdin);
    assert.equal(started.code, 0);
    assert.match(started.stdout, /registered as eta-refuter \(agent:\/\/mini\/claude-code\/herdr:default\/eta-refuter\)/);
    assert.match(started.stdout, /0 unread/);

    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const sent = await rig.ubus.call(
      "ubus_send",
      { to: ["eta-refuter"], subject: "SUBJECTSECRET", body: "BODYSECRET count=1 path=~/dev/eta-lab/m.json" },
      caller("fable"),
    );
    assert.equal(sent.ok, true);

    const prompt = await runHook("prompt", env, [], stdin);
    assert.equal(prompt.code, 0);
    assert.match(prompt.stdout, /1 unread/);
    assert.match(prompt.stdout, /fable/);
    assert.equal(prompt.stdout.includes("SUBJECTSECRET"), false);
    assert.equal(prompt.stdout.includes("BODYSECRET"), false);
    assert.equal(prompt.stderr.includes("BODYSECRET"), false);

    const stop1 = await runHook("stop", env, [], stdin);
    assert.equal(stop1.code, 0);
    assert.match(stop1.stdout, /"decision":"block"/);
    assert.match(stop1.stdout, /ubus:/);
    assert.equal(stop1.stdout.includes("SUBJECTSECRET"), false);
    assert.equal(stop1.stdout.includes("BODYSECRET"), false);

    const stop2 = await runHook("stop", env, [], stdin);
    assert.equal(stop2.code, 0);
    assert.equal(stop2.stdout.trim(), "");

    // Clear the mail the stop hook already saw, so the watcher has to wake on new mail.
    await rig.ubus.call("ubus_inbox", {}, caller("eta-refuter"));
    const watch = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", hookBin, "watch", "--max-s", "8"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let watchErr = "";
    watch.stderr.on("data", (b) => {
      watchErr += String(b);
    });
    const closed = new Promise<number>((resolve) => watch.on("close", (c) => resolve(c ?? 1)));
    watch.stdin.end(stdin);
    await new Promise((r) => setTimeout(r, 200));
    const second = await rig.ubus.call(
      "ubus_send",
      { to: ["eta-refuter"], subject: "SUBJECTSECRET2", body: "BODYSECRET count=2 path=~/dev/eta-lab/m2.json" },
      caller("fable"),
    );
    assert.equal(second.ok, true);
    const code = await closed;
    assert.equal(code, 2);
    assert.match(watchErr, /new messages \(ids ubus:/);
    assert.equal(watchErr.includes("BODYSECRET"), false);
    assert.equal(watchErr.includes("SUBJECTSECRET"), false);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test("the stdio shim registers the herdr pane on initialize", async () => {
  const rig = setup();
  const cache = mkdtempSync(join(tmpdir(), "ubus-shim-"));
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", shimBin], {
    env: {
      ...cleanEnv(),
      UBUS_URL: `http://127.0.0.1:${port}/mcp`,
      UBUS_CACHE_DIR: cache,
      UBUS_MACHINE: "mini",
      HERDR_AGENT_NAME: "shim-pane",
      HERDR_SESSION: "default",
      UBUS_RUNTIME: "claude-code",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => {
    out += String(b);
  });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }) + "\n",
    );
    const deadline = Date.now() + 4000;
    while (!out.includes('"id":1') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /"name":"ubus"/);
    const deadline2 = Date.now() + 4000;
    let found = false;
    while (Date.now() < deadline2) {
      const dir = await rig.ubus.call("ubus_directory", { q: "shim-pane" }, caller());
      const agents = dir.agents as Array<{ handle: string; presence: string }>;
      if (agents.some((a) => a.handle === "shim-pane" && a.presence === "live")) {
        found = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(found, true);
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test("the stdio shim registers before the first heartbeat when initialize never ran", async () => {
  const rig = setup();
  const cache = mkdtempSync(join(tmpdir(), "ubus-shim-hb-"));
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", shimBin], {
    env: {
      ...cleanEnv(),
      UBUS_URL: `http://127.0.0.1:${port}/mcp`,
      UBUS_CACHE_DIR: cache,
      UBUS_MACHINE: "mini",
      UBUS_HANDLE: "shim-heartbeat",
      UBUS_RUNTIME: "claude-code",
      UBUS_SESSION: "cc:shim-heartbeat",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => {
    out += String(b);
  });
  try {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "ubus_heartbeat", arguments: {} },
      }) + "\n",
    );
    const deadline = Date.now() + 4000;
    while (!out.includes('"id":7') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /"id":7/);
    const line = out.split("\n").find((l) => l.includes('"id":7'));
    assert.ok(line);
    const msg = JSON.parse(line) as { result?: { content?: Array<{ text?: string }> } };
    const body = JSON.parse(msg.result?.content?.[0]?.text || "{}") as { ok?: boolean; handle?: string; error?: string };
    assert.equal(body.ok, true);
    assert.equal(body.handle, "shim-heartbeat");
    const dir = await rig.ubus.call("ubus_directory", { q: "shim-heartbeat" }, caller());
    const agents = dir.agents as Array<{ handle: string; presence: string }>;
    assert.equal(agents.some((a) => a.handle === "shim-heartbeat" && a.presence === "live"), true);
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test("hook endpoint keeps the mcp path prefix, including a secret segment", () => {
  assert.equal(hookEndpoint(`https://${TS_HOST}/ubus/mcp`), `https://${TS_HOST}/ubus/v1/hook`);
  assert.equal(hookEndpoint("http://127.0.0.1:8790/mcp"), "http://127.0.0.1:8790/v1/hook");
  assert.equal(hookEndpoint("https://bus.llmvinayminihome.uk/mcp/path-secret-value"), "https://bus.llmvinayminihome.uk/v1/hook/path-secret-value");
  assert.equal(hookEndpoint("https://bus.llmvinayminihome.uk/ubus/mcp/path-secret-value"), "https://bus.llmvinayminihome.uk/ubus/v1/hook/path-secret-value");
  assert.equal(hookEndpoint("http://127.0.0.1:8790/ubus/mcp/"), "http://127.0.0.1:8790/ubus/v1/hook");
  assert.equal(hookEndpoint("not a url"), "http://127.0.0.1:8790/v1/hook");
});

test("the hook posts to /ubus/v1/hook when the client url is /ubus/mcp", async () => {
  const rig = setup();
  const cache = mkdtempSync(join(tmpdir(), "ubus-hook-prefix-"));
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const seen: string[] = [];
  const door = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url || "/";
    seen.push(path.split("?")[0] || path);
    if (!path.startsWith("/ubus/")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }
    const up = forwardRequest(
      { hostname: "127.0.0.1", port, path, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    up.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", () => resolve()));
  const doorPort = (door.address() as AddressInfo).port;
  const env: NodeJS.ProcessEnv = {
    ...cleanEnv(),
    UBUS_URL: `http://127.0.0.1:${doorPort}/ubus/mcp`,
    UBUS_CACHE_DIR: cache,
    UBUS_MACHINE: "mini",
    UBUS_RUNTIME: "claude-code",
    UBUS_OWNER: "fable",
    HERDR_AGENT_NAME: "prefix-pane",
    HERDR_SESSION: "default",
  };
  const stdin = JSON.stringify({ session_id: "sess-prefix", cwd: "/tmp/prefix-pane", hook_event_name: "SessionStart" });
  try {
    const started = await runHook("session-start", env, [], stdin);
    assert.equal(started.code, 0);
    assert.match(started.stdout, /registered as prefix-pane/);
    assert.equal(seen.includes("/v1/hook"), false);
    assert.ok(seen.includes("/ubus/v1/hook"));
  } finally {
    door.closeAllConnections?.();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => door.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});

test("a secret-path mcp url has a matching hook route", async () => {
  const rig = setup((cfg) => {
    cfg.edgeAuth.enabled = true;
    cfg.edgeAuth.allowLoopback = true;
    const dir = mkdtempSync(join(tmpdir(), "ubus-hook-secret-"));
    cfg.edgeAuth.tokensFile = join(dir, "tokens.json");
    cfg.edgeAuth.secretPathsFile = join(dir, "paths.json");
    writeFileSync(cfg.edgeAuth.tokensFile, JSON.stringify({ clients: [] }));
    writeFileSync(cfg.edgeAuth.secretPathsFile, JSON.stringify({ paths: [{ secret: "path-secret-value", class: "grok-platform" }] }));
  });
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const body = {
    op: "session-start",
    handle: "hook-secret",
    machine: "mini",
    runtime: "claude-code",
    session: "s:hook-secret",
    owner: "fable",
    orchestrator: "fable",
  };
  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    const bare = await post("/v1/hook", { "cf-ray": "ray" });
    assert.equal(bare.status, 401);
    const wrong = await post("/v1/hook/nope", { "cf-ray": "ray" });
    assert.equal(wrong.status, 404);
    const secret = await post("/v1/hook/path-secret-value", { "cf-ray": "ray" });
    assert.equal(secret.status, 200);
    const secretJson = (await secret.json()) as { ok?: boolean; handle?: string };
    assert.equal(secretJson.ok, true);
    assert.equal(secretJson.handle, "hook-secret");
    const prefixed = await post("/ubus/v1/hook/path-secret-value", { "cf-ray": "ray" });
    assert.equal(prefixed.status, 200);
    const plain = await post("/ubus/v1/hook");
    assert.equal(plain.status, 200);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});
