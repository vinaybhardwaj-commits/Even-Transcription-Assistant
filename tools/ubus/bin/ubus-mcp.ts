#!/usr/bin/env node
/**
 * stdio shim. Speaks MCP on stdin/stdout and bridges to the ubus HTTP server.
 * On initialize it registers this session and heartbeats until stdin closes.
 */
import { existsSync, readFileSync } from "node:fs";
import { loadClientSettings } from "../src/client-config.js";
import { resolveIdentity, type DerivedIdentity } from "../src/derive.js";
import { VERSION } from "../src/version.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const client = loadClientSettings();
const endpoint = client.url;
const cacheDir = process.env.UBUS_CACHE_DIR || join(homedir(), ".cache", "ubus");
/** One id per shim process: the server uses it to tell a reconnecting shim from a second shim claiming the same handle. */
const instanceId = randomUUID();
let sessionId = "";
let closed = false;
let registered = false;
let registerTask: Promise<boolean> | null = null;

interface Rpc {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function cfHeaders(): Record<string, string> {
  const file = client.cfTokenFile || process.env.UBUS_CF_TOKEN_FILE;
  if (!file || !existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { id?: string; secret?: string; clients?: Array<{ id: string; secret: string }> };
    const client = raw.clients?.[0] ?? raw;
    if (!client.id || !client.secret || client.id.startsWith("REPLACE_")) return {};
    return { "cf-access-client-id": client.id, "cf-access-client-secret": client.secret };
  } catch {
    return {};
  }
}

let initParams: Record<string, unknown> | undefined;

/** Network errors (server restarting) retry with backoff ~31 s total, then throw. */
async function post(message: Rpc): Promise<{ status: number; json: Rpc | null; session?: string }> {
  const delays = [500, 1000, 2000, 4000, 8000, 16000];
  for (let i = 0; ; i++) {
    try {
      return await postOnce(message);
    } catch (err) {
      if (i >= delays.length || closed) throw err;
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

function resultError(json: Rpc | null): string {
  const text = (json as { result?: { content?: Array<{ text?: string }> } } | null)?.result?.content?.[0]?.text;
  if (!text) return "";
  try {
    const r = JSON.parse(text) as { ok?: boolean; error?: string };
    return r.ok === false ? r.error || "error" : "";
  } catch {
    return "";
  }
}

/** Server restarted: its session map is empty, so re-initialize upstream and re-register. */
async function recover(): Promise<void> {
  registered = false;
  sessionId = "";
  if (initParams) {
    await post({ jsonrpc: "2.0", id: "ubus-reinit", method: "initialize", params: initParams }).catch(() => undefined);
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => undefined);
  }
  await ensureRegistered();
}

async function postOnce(message: Rpc): Promise<{ status: number; json: Rpc | null; session?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-ubus-client": "ubus-mcp",
    "user-agent": "ubus-mcp",
    "x-ubus-instance": instanceId,
    ...cfHeaders(),
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) sessionId = sid;
  if (res.status === 202) return { status: 202, json: null, session: sid ?? undefined };
  const text = await res.text();
  const json = text ? (JSON.parse(text) as Rpc) : null;
  return { status: res.status, json, session: sid ?? undefined };
}

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function callOk(json: Rpc | null): boolean {
  const result = json && (json as { result?: { content?: Array<{ text?: string }> } }).result;
  const text = result?.content?.[0]?.text;
  if (!text) return false;
  try {
    return (JSON.parse(text) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

let identity: DerivedIdentity | null = null;

async function register(): Promise<boolean> {
  if (registered) return true;
  // The first registration resolves the identity (waiting for the hook's cache when it must).
  // Later ones, after a server restart, reuse it so the pane keeps one identity.
  if (!identity) identity = (await resolveIdentity(process.env, cacheDir)).identity;
  const idn = identity;
  try {
    const res = await post({
      jsonrpc: "2.0",
      id: "ubus-register",
      method: "tools/call",
      params: {
        name: "ubus_register",
        arguments: {
          handle: idn.handle,
          machine: idn.machine,
          runtime: idn.runtime,
          session: idn.session,
          owner: idn.owner,
          orchestrator: idn.orchestrator,
          capabilities: { wake: "hook", accepts: ["msg", "request", "handoff"], client_version: VERSION, client: "ubus-mcp" },
        },
      },
    });
    registered = callOk(res.json);
  } catch {
    /* fail open: the session can still call tools */
  }
  return registered;
}

/** Register from the configured handle and runtime before the first heartbeat. */
async function ensureRegistered(): Promise<void> {
  if (registered) return;
  if (!registerTask) {
    registerTask = register().finally(() => {
      registerTask = null;
    });
  }
  await registerTask;
}

async function heartbeatLoop(): Promise<void> {
  while (!closed) {
    await new Promise((r) => setTimeout(r, 60_000));
    if (closed) return;
    try {
      await ensureRegistered();
      const hb = await post({ jsonrpc: "2.0", id: "ubus-heartbeat", method: "tools/call", params: { name: "ubus_heartbeat", arguments: {} } });
      if (resultError(hb.json) === "not_registered") {
        await recover();
        await post({ jsonrpc: "2.0", id: "ubus-heartbeat", method: "tools/call", params: { name: "ubus_heartbeat", arguments: {} } });
      }
    } catch {
      /* next tick */
    }
  }
}

async function unregister(): Promise<void> {
  try {
    await post({ jsonrpc: "2.0", id: "ubus-unregister", method: "tools/call", params: { name: "ubus_unregister", arguments: {} } });
  } catch {
    /* process is exiting */
  }
}

async function onMessage(msg: Rpc): Promise<void> {
  if (!msg.method) return;
  if (msg.method.startsWith("notifications/")) {
    await post({ jsonrpc: "2.0", method: msg.method, params: msg.params }).catch(() => undefined);
    return;
  }
  if (msg.method === "initialize") {
    initParams = msg.params;
    const upstream = await post({ jsonrpc: "2.0", id: msg.id, method: "initialize", params: msg.params });
    write(upstream.json ?? { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "ubus-mcp", version: VERSION } } });
    await ensureRegistered();
    return;
  }
  if (msg.method === "tools/call" && msg.params?.name === "ubus_heartbeat") {
    await ensureRegistered();
  }
  let upstream = await post({ jsonrpc: "2.0", id: msg.id, method: msg.method, params: msg.params });
  if (msg.method === "tools/call" && msg.params?.name !== "ubus_register" && resultError(upstream.json) === "not_registered") {
    await recover();
    upstream = await post({ jsonrpc: "2.0", id: msg.id, method: msg.method, params: msg.params });
  }
  if (msg.method === "tools/call" && msg.params?.name === "ubus_register" && callOk(upstream.json)) registered = true;
  if (upstream.json) write(upstream.json);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  // Support both newline-delimited JSON and Content-Length framing.
  for (;;) {
    if (buffer.startsWith("Content-Length:")) {
      const sep = buffer.indexOf("\r\n\r\n");
      if (sep === -1) return;
      const header = buffer.slice(0, sep);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.slice(sep + 4);
        continue;
      }
      const len = Number(match[1]);
      const start = sep + 4;
      if (buffer.length < start + len) return;
      const body = buffer.slice(start, start + len);
      buffer = buffer.slice(start + len);
      void handle(body);
      continue;
    }
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) void handle(line);
  }
});

async function handle(line: string): Promise<void> {
  let msg: Rpc;
  try {
    msg = JSON.parse(line) as Rpc;
  } catch (err) {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: err instanceof Error ? err.message : "parse error" } });
    return;
  }
  try {
    await onMessage(msg);
  } catch (err) {
    // ubus unreachable after retries: answer this request (shim stays up; next call retries)
    if (msg.id !== undefined && msg.id !== null) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "ubus unreachable: " + (err instanceof Error ? err.message : "error") } });
    }
  }
}

process.stdin.on("end", () => {
  closed = true;
  void unregister().finally(() => process.exit(0));
});

void heartbeatLoop();
process.stdin.resume();
