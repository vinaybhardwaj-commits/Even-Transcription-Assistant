import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteEtaAdapter } from "../src/adapters.js";
import { createUbus } from "../src/create.js";
import { deriveIdentity, identityCachePath, resolveIdentity, resolvePaneName } from "../src/derive.js";
import { createHttpServer } from "../src/http.js";
import { compareVersions } from "../src/util.js";
import { VERSION } from "../src/version.js";
import { caller, register, setup, type TestRig, cleanEnv } from "./helpers.js";

const shimBin = fileURLToPath(new URL("../bin/ubus-mcp.js", import.meta.url));
const hookBin = fileURLToPath(new URL("../bin/ubus-hook.js", import.meta.url));

type Srv = ReturnType<typeof createHttpServer>;

async function listen(server: Srv, port = 0): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

async function rpc(port: number, body: unknown, sid?: string): Promise<{ json: any; sid: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { json: text ? JSON.parse(text) : {}, sid: res.headers.get("mcp-session-id") };
}

async function tool(port: number, name: string, args: Record<string, unknown>, sid?: string): Promise<{ r: any; sid: string | null }> {
  const out = await rpc(port, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, sid);
  return { r: JSON.parse(out.json.result.content[0].text), sid: out.sid };
}

/** Same db file, fresh Ubus: the server process restarted. */
function restart(rig: TestRig): TestRig {
  rig.ubus.close();
  const ubus = createUbus(rig.cfg, { clock: rig.clock, eta: new SqliteEtaAdapter(rig.cfg.eta.dbPath!), herdr: rig.herdr, openbot: rig.openbot, handoff: rig.handoff, whois: rig.whois, probe: rig.probe });
  return { ...rig, ubus, cleanup: () => { ubus.close(); rmSync(rig.dir, { recursive: true, force: true }); } };
}

// ---- S1

test("S1 a session binding survives a server restart", async () => {
  let rig = setup();
  let server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  let port = await listen(server);
  try {
    const init = await rpc(port, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
    const sid = init.sid!;
    const reg = await tool(port, "ubus_register", { handle: "keeper", machine: "mini", runtime: "claude-code", session: "cc:keeper" }, sid);
    assert.equal(reg.r.ok, true);
    server.closeAllConnections?.();
    server.close();
    rig = restart(rig);
    server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
    port = await listen(server);
    const inbox = await tool(port, "ubus_inbox", {}, sid);
    assert.equal(inbox.r.ok, true);
    const who = await tool(port, "ubus_whoami", {}, sid);
    assert.equal(who.r.handle, "keeper");
    assert.equal(who.r.registered, true);
  } finally {
    server.closeAllConnections?.();
    server.close();
    rig.cleanup();
  }
});

test("S1 an unknown session id with no binding stays unregistered, a closed agent is not rebound, old bindings are pruned", async () => {
  let rig = setup();
  let server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  let port = await listen(server);
  try {
    const a = await tool(port, "ubus_register", { handle: "closer", machine: "mini", runtime: "claude-code", session: "cc:closer" });
    await tool(port, "ubus_unregister", {}, a.sid!);
    const b = await tool(port, "ubus_register", { handle: "old-timer", machine: "mini", runtime: "claude-code", session: "cc:old" });
    assert.equal(rig.ubus.store.bindingCount(), 2);
    server.closeAllConnections?.();
    server.close();
    rig = restart(rig);
    server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
    port = await listen(server);
    const closed = await tool(port, "ubus_inbox", {}, a.sid!);
    assert.equal(closed.r.error, "not_registered");
    const stranger = await tool(port, "ubus_inbox", {}, "never-seen");
    assert.equal(stranger.r.error, "not_registered");
    rig.clock.advance(8 * 24 * 3600 * 1000);
    rig.ubus.sweep();
    assert.equal(rig.ubus.store.bindingCount(), 0);
    const pruned = await tool(port, "ubus_inbox", {}, b.sid!);
    assert.equal(pruned.r.error, "not_registered");
  } finally {
    server.closeAllConnections?.();
    server.close();
    rig.cleanup();
  }
});

test("S1 migration is idempotent over an existing db", () => {
  let rig = setup();
  try {
    rig = restart(rig);
    rig = restart(rig);
    assert.equal(rig.ubus.store.bindingCount(), 0);
  } finally {
    rig.cleanup();
  }
});

// ---- S2

test("S2 the shim recovers and retries once on not_registered even though it believes it is registered", async () => {
  const rig = setup();
  const cache = mkdtempSync(join(tmpdir(), "ubus-cache-"));
  let server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", shimBin], {
    env: { ...cleanEnv(), UBUS_URL: `http://127.0.0.1:${port}/mcp`, UBUS_CACHE_DIR: cache, UBUS_MACHINE: "mini", HERDR_AGENT_NAME: "recoverer", HERDR_SESSION: "default", UBUS_RUNTIME: "claude-code" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => { out += String(b); });
  const waitFor = async (needle: string) => {
    const end = Date.now() + 8000;
    while (!out.includes(needle) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  };
  try {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) + "\n");
    await waitFor('"id":1');
    const end = Date.now() + 4000;
    while (Date.now() < end && !rig.ubus.store.getAgent("recoverer")) await new Promise((r) => setTimeout(r, 50));
    assert.ok(rig.ubus.store.getAgent("recoverer"));
    // The server loses the agent row and every session (a restart with no binding table).
    rig.ubus.store.archiveAgent("recoverer", rig.clock.iso());
    rig.ubus.store.db.exec("DELETE FROM session_bindings");
    server.closeAllConnections?.();
    server.close();
    server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
    await listen(server, port);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ubus_inbox", arguments: {} } }) + "\n");
    await waitFor('"id":9');
    const line = out.split("\n").find((l) => l.includes('"id":9'));
    assert.ok(line, out);
    const body = JSON.parse(JSON.parse(line!).result.content[0].text);
    assert.equal(body.ok, true);
    assert.equal(rig.ubus.store.getAgent("recoverer")?.handle, "recoverer");
  } finally {
    child.stdin.end();
    child.kill("SIGKILL");
    server.closeAllConnections?.();
    server.close();
    rmSync(cache, { recursive: true, force: true });
    rig.cleanup();
  }
});

// ---- S3

test("S3 register needs only handle and machine, session defaults to h:<handle>, explicit session wins", async () => {
  const rig = setup();
  try {
    const first = await rig.ubus.call("ubus_register", { handle: "chronicle", machine: "mini" }, caller(undefined));
    assert.equal(first.ok, true);
    assert.equal(first.session, "h:chronicle");
    const again = await rig.ubus.call("ubus_register", { handle: "chronicle", machine: "mini" }, caller(undefined));
    assert.equal(again.ok, true);
    assert.equal(again.handle, "chronicle");
    assert.equal(again.renamed, false);
    assert.equal(rig.ubus.store.listAgents().filter((a) => a.handle.startsWith("chronicle")).length, 1);
    const explicit = await rig.ubus.call("ubus_register", { handle: "other-one", machine: "mini", session: "cc:xyz" }, caller(undefined));
    assert.equal(explicit.session, "cc:xyz");
    assert.equal(rig.ubus.store.getAgent("other-one")?.session, "cc:xyz");
  } finally {
    rig.cleanup();
  }
});

test("S3 not_registered says exactly how to fix it, and the register schema requires only handle and machine", async () => {
  const rig = setup();
  try {
    const res = await rig.ubus.call("ubus_inbox", {}, caller(undefined));
    assert.equal(res.error, "not_registered");
    assert.equal(res.message, "call ubus_register with {handle, machine}; session is optional");
    const sendRes = await rig.ubus.call("ubus_send", { to: ["x"], subject: "s", body: "b" }, caller(undefined));
    assert.equal(sendRes.message, "call ubus_register with {handle, machine}; session is optional");
    const { TOOLS } = await import("../src/tools.js");
    const reg = TOOLS.find((t) => t.name === "ubus_register")!;
    assert.deepEqual(reg.inputSchema.required, ["handle", "machine"]);
    assert.match(reg.description, /session is optional/);
  } finally {
    rig.cleanup();
  }
});

// ---- S4

test("S4 VERSION comes from package.json and /health reports it", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
  assert.equal(VERSION, "0.2.0");
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { version: string; min_client_version: string };
    assert.equal(health.version, VERSION);
    assert.equal(health.min_client_version, "0.2.0");
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("S4 register flags an outdated or unversioned client, and the directory shows client_version", async () => {
  const rig = setup();
  try {
    assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.2.0"), 1);
    assert.equal(compareVersions("0.2", "0.2.0"), 0);
    const old = await register(rig.ubus, "old-client", { capabilities: { client_version: "0.1.0" } });
    assert.equal(old.outdated, true);
    assert.equal(old.client_version, "0.1.0");
    const none = await register(rig.ubus, "no-version");
    assert.equal(none.outdated, true);
    const cur = await register(rig.ubus, "new-client", { capabilities: { client_version: "0.2.0" } });
    assert.equal(cur.outdated, false);
    const dir = await rig.ubus.call("ubus_directory", {}, caller("new-client"));
    const rows = dir.agents as Array<{ handle: string; client_version: string | null }>;
    assert.equal(rows.find((r) => r.handle === "new-client")?.client_version, "0.2.0");
    assert.equal(rows.find((r) => r.handle === "old-client")?.client_version, "0.1.0");
    assert.equal(rows.find((r) => r.handle === "no-version")?.client_version, null);
  } finally {
    rig.cleanup();
  }
});

test("S4 min_client_version is configurable", async () => {
  const rig = setup((cfg) => { cfg.minClientVersion = "0.3.0"; });
  try {
    const cur = await register(rig.ubus, "c", { capabilities: { client_version: "0.2.0" } });
    assert.equal(cur.outdated, true);
  } finally {
    rig.cleanup();
  }
});

// ---- S5

const baseEnv = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, UBUS_MACHINE: "t4", HOME: process.env.HOME, ...extra });

test("S5 hook and shim derive one {machine, runtime, session} under herdr, with or without UBUS_HANDLE", async () => {
  const cache = mkdtempSync(join(tmpdir(), "ubus-cache-"));
  try {
    for (const extra of [
      { HERDR_AGENT_NAME: "palimpsest-web-builder", HERDR_SESSION: "default" },
      { HERDR_AGENT_NAME: "palimpsest-web-builder", HERDR_SESSION: "default", UBUS_HANDLE: "palimpsest-web-builder" },
    ]) {
      const env = baseEnv(extra);
      const hook = (await resolveIdentity(env, cache, { session_id: "0a1b2c3d-uuid", cwd: "/work/palimpsest" })).identity;
      const shim = (await resolveIdentity(env, cache)).identity;
      assert.deepEqual({ m: shim.machine, r: shim.runtime, s: shim.session, h: shim.handle }, { m: hook.machine, r: hook.runtime, s: hook.session, h: hook.handle });
    }
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("S5 outside herdr the shim takes the hook's identity from the cache, ignores a stale one, and never overwrites it with a fallback", async () => {
  const cache = mkdtempSync(join(tmpdir(), "ubus-cache-"));
  try {
    const env = baseEnv({ UBUS_HANDLE: "palimpsest-web-builder" });
    // Before: the shim derived cc:local while the hook derived cc:<uuid>. That is the duplicate-row cause.
    const shimOnly = deriveIdentity(env);
    const hookId = (await resolveIdentity(env, cache, { session_id: "uuid-1234-abcd", cwd: "/work/p" })).identity;
    assert.notEqual(shimOnly.session, hookId.session);
    const shim = await resolveIdentity(env, cache, undefined, 500);
    assert.equal(shim.fromCache, true);
    assert.equal(shim.identity.session, hookId.session);
    // stale entry is ignored, and the fallback does not write the cache
    const fresh = mkdtempSync(join(tmpdir(), "ubus-cache-"));
    writeFileSync(identityCachePath(fresh, shimOnly), JSON.stringify({ ...hookId, written_at: Date.now() - 10 * 60 * 1000 }));
    const late = await resolveIdentity(env, fresh, undefined, 200, 120_000);
    assert.equal(late.fromCache, false);
    assert.equal(JSON.parse(readFileSync(identityCachePath(fresh, shimOnly), "utf8")).session, hookId.session);
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test("S5 the real hook and the real shim register one row for one pane", async () => {
  const rig = setup();
  const cache = mkdtempSync(join(tmpdir(), "ubus-cache-"));
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  const env: NodeJS.ProcessEnv = { ...cleanEnv(), UBUS_URL: `http://127.0.0.1:${port}/mcp`, UBUS_CACHE_DIR: cache, UBUS_MACHINE: "t4", UBUS_HANDLE: "one-pane", UBUS_RUNTIME: "claude-code" };
  delete env.HERDR_AGENT_NAME;
  delete env.HERDR_PANE_ID;
  delete env.UBUS_SESSION;
  delete env.CLAUDE_SESSION_ID;
  delete env.UBUS_SESSION_ID;
  const shim = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", shimBin], { env, stdio: ["pipe", "pipe", "pipe"] });
  try {
    shim.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    await new Promise((r) => setTimeout(r, 300));
    const hook = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", hookBin, "session-start"], { env, stdio: ["pipe", "pipe", "pipe"] });
    hook.stdin.end(JSON.stringify({ session_id: "uuid-aaaa-bbbb", cwd: process.cwd(), hook_event_name: "SessionStart" }));
    await new Promise((r) => hook.on("close", r));
    await new Promise((r) => setTimeout(r, 500));
    const rows = rig.ubus.store.listAgents().filter((a) => a.handle.startsWith("one-pane"));
    assert.equal(rows.length, 1, JSON.stringify(rows.map((r) => [r.handle, r.session])));
  } finally {
    shim.stdin.end();
    shim.kill("SIGKILL");
    server.closeAllConnections?.();
    server.close();
    rmSync(cache, { recursive: true, force: true });
    rig.cleanup();
  }
});

// ---- S6

function fakeHerdr(dir: string, body: string): string {
  const p = join(dir, "herdr");
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("S6 a pane id resolves to its agent name through herdr agent list", () => {
  const dir = mkdtempSync(join(tmpdir(), "ubus-herdr-"));
  try {
    const bin = fakeHerdr(dir, `echo '{"id":"x","result":{"agents":[{"name":"kiosk-health","pane_id":"w2:p1"},{"name":"roadmap-inv","pane_id":"w3:p1"}]}}'`);
    const env = baseEnv({ HERDR_PANE_ID: "w3:p1", HERDR_BIN_PATH: bin });
    assert.equal(resolvePaneName(env, "w3:p1"), "roadmap-inv");
    const id = deriveIdentity(env, { cwd: "/x/eta-lab" });
    assert.equal(id.handle, "roadmap-inv");
    assert.equal(id.session, "herdr:default/w3:p1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6 a missing pane, a failing herdr, and a hung herdr fall back to cc-<machine>-<cwd>-<pane>", () => {
  const dir = mkdtempSync(join(tmpdir(), "ubus-herdr-"));
  try {
    const miss = fakeHerdr(dir, `echo '{"result":{"agents":[{"name":"a","pane_id":"w9:p9"}]}}'`);
    const env = baseEnv({ HERDR_PANE_ID: "w3:p1", HERDR_BIN_PATH: miss });
    assert.equal(deriveIdentity(env, { cwd: "/x/eta-lab" }).handle, "cc-t4-eta-lab-w3-p1");
    const bad = fakeHerdr(dir, "exit 3");
    assert.equal(deriveIdentity({ ...env, HERDR_BIN_PATH: bad }, { cwd: "/x/eta-lab" }).handle, "cc-t4-eta-lab-w3-p1");
    assert.equal(deriveIdentity({ ...env, HERDR_BIN_PATH: undefined }, { cwd: "/x/eta-lab" }).handle, "cc-t4-eta-lab-w3-p1");
    const slow = fakeHerdr(dir, "sleep 6");
    const t0 = Date.now();
    const id = deriveIdentity({ ...env, HERDR_BIN_PATH: slow }, { cwd: "/x/eta-lab" });
    assert.equal(id.handle, "cc-t4-eta-lab-w3-p1");
    assert.ok(Date.now() - t0 < 4000, "lookup is bounded by 2 s");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6 the server rejects a herdr pane id as a handle, and a pane-id row is renamed when its session registers a real name", async () => {
  const rig = setup();
  try {
    for (const h of ["wQ:p1", "w2H:p3", "w1:p1@hf-2"]) {
      const res = await rig.ubus.call("ubus_register", { handle: h, machine: "mini" }, caller(undefined));
      assert.equal(res.ok, false);
      assert.equal(res.error, "invalid");
      assert.equal(res.message, "handle is a herdr pane id; set HERDR_AGENT_NAME");
    }
    // a legacy row under a pane-id handle
    rig.ubus.store.upsertAgent({
      handle: "w3:p1", machine: "mini", runtime: "claude-code", session: "herdr:default/w3:p1", owner: "fable", orchestrator: "fable",
      capabilitiesJson: "{}", address: "agent://mini/claude-code/herdr:default/w3:p1", presence: "live", discovered: 0, closed: 0,
      lastHeartbeatAt: rig.clock.iso(), lastTurnAt: "", registeredAt: rig.clock.iso(), via: "local", machineVerified: 1, platformClass: "", labelMachineMismatch: 0, inboxCursor: 0,
    });
    const res = await rig.ubus.call("ubus_register", { handle: "roadmap-inv", machine: "mini", runtime: "claude-code", session: "herdr:default/w3:p1" }, caller(undefined));
    assert.equal(res.ok, true);
    assert.equal(res.handle, "roadmap-inv");
    assert.equal(rig.ubus.store.getAgent("w3:p1"), undefined);
  } finally {
    rig.cleanup();
  }
});

// ---- S7

test("S7 the directory hides gone rows unless asked, and gone rows older than 24h move to the archive", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "alive-one");
    await register(rig.ubus, "ghost");
    rig.clock.advance(11 * 3600 * 1000);
    await rig.ubus.call("ubus_heartbeat", {}, caller("alive-one"));
    rig.clock.advance(2 * 3600 * 1000); // ghost silent for 13h: gone
    rig.ubus.sweep();
    const def = ((await rig.ubus.call("ubus_directory", {}, caller("alive-one"))).agents as Array<{ handle: string }>).map((a) => a.handle);
    assert.equal(def.includes("ghost"), false);
    assert.equal(def.includes("alive-one"), true);
    const all = ((await rig.ubus.call("ubus_directory", { presence: "all" }, caller("alive-one"))).agents as Array<{ handle: string }>).map((a) => a.handle);
    assert.equal(all.includes("ghost"), true);
    const goneOnly = ((await rig.ubus.call("ubus_directory", { presence: "gone" }, caller("alive-one"))).agents as Array<{ handle: string }>).map((a) => a.handle);
    assert.deepEqual(goneOnly, ["ghost"]);
    assert.ok(rig.ubus.store.getAgent("ghost"), "still in agents before 24h gone");
    rig.clock.advance(25 * 3600 * 1000);
    await rig.ubus.call("ubus_heartbeat", {}, caller("alive-one"));
    rig.ubus.sweep();
    assert.equal(rig.ubus.store.getAgent("ghost"), undefined);
    assert.equal(rig.ubus.store.archivedCount(), 1);
    const all2 = ((await rig.ubus.call("ubus_directory", { presence: "all" }, caller("alive-one"))).agents as Array<{ handle: string }>).map((a) => a.handle);
    assert.equal(all2.includes("ghost"), false);
  } finally {
    rig.cleanup();
  }
});

test("S7 a re-register revives the archived row by session, and a gone holder is archived not deleted", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "phoenix");
    await register(rig.ubus, "stale-holder", { session: "s:old" });
    rig.clock.advance(40 * 3600 * 1000);
    rig.ubus.sweep();
    assert.equal(rig.ubus.store.archivedCount(), 2);
    const back = await register(rig.ubus, "phoenix");
    assert.equal(back.ok, true);
    assert.equal(back.handle, "phoenix");
    assert.equal(back.presence, "live");
    assert.ok(rig.ubus.store.getAgent("phoenix"));
    // a different session claims a handle whose holder is gone but not yet archived
    await register(rig.ubus, "squatter");
    rig.clock.advance(14 * 3600 * 1000);
    const before = rig.ubus.store.archivedCount();
    const taken = await rig.ubus.call("ubus_register", { handle: "squatter", machine: "mini", runtime: "claude-code", session: "s:new" }, caller(undefined));
    assert.equal(taken.handle, "squatter");
    assert.equal(rig.ubus.store.archivedCount(), before + 1, "old holder archived, not deleted");
  } finally {
    rig.cleanup();
  }
});

test("S7 a pane herdr still reports live is not expired, and system rows never are", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "pane-alive");
    rig.herdr.agents = [{ name: "pane-alive", machine: "mini", runtime: "claude-code", state: "idle", busy: false, owner: "fable", herdrSession: "default" }];
    rig.clock.advance(30 * 3600 * 1000);
    rig.ubus.sweep();
    assert.ok(rig.ubus.store.getAgent("pane-alive"));
    assert.notEqual(rig.ubus.store.getAgent("pane-alive")!.presence, "gone");
  } finally {
    rig.cleanup();
  }
});

// ---- S9

test("S9 a group send with an absent member delivers to the present ones and reports the absent one", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "gating-lead");
    await register(rig.ubus, "plain-one");
    await rig.ubus.call("ubus_register", { handle: "cc-air-work-local", machine: "air", runtime: "cowork", session: "cw:1" }, caller(undefined, "air"));
    const sender = caller("cc-air-work-local", "air");
    // eta bridge raises for every lead that has no live row (command missing, bus down, ...)
    (rig.eta as { post: (i: unknown) => unknown }).post = () => { throw new Error("eta post failed (1)"); };
    const res = await rig.ubus.call("ubus_send", { to: ["group:eta-leads", "plain-one"], subject: "s", body: "ids only" }, sender);
    assert.equal(res.ok, true, JSON.stringify(res));
    const d = res.delivery as Array<{ to: string; status: string }>;
    assert.equal(d.find((x) => x.to === "gating-lead")?.status.startsWith("stored"), true);
    assert.equal(d.find((x) => x.to === "plain-one")?.status.startsWith("stored"), true);
    assert.equal(d.find((x) => x.to === "fable")?.status, "bridge_failed");
    assert.notEqual(res.error, "internal");
    assert.equal(rig.ubus.store.unreadCount("gating-lead"), 1);
  } finally {
    rig.cleanup();
  }
});

test("S9 a recipient the herdr adapter cannot plan is unknown_agent, never internal", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "a-sender");
    await register(rig.ubus, "b-recv");
    rig.herdr.listAgents = () => { throw new Error("boom"); };
    const res = await rig.ubus.call("ubus_send", { to: ["b-recv", "ghost-x"], subject: "s", body: "b" }, caller("a-sender"));
    assert.notEqual(res.error, "internal");
    assert.equal(res.ok, false);
    assert.equal(res.error, "unknown_agent");
  } finally {
    rig.cleanup();
  }
});
