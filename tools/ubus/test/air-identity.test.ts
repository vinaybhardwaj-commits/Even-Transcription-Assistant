import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createHttpServer } from "../src/http.js";
import { setup } from "./helpers.js";

type Json = Record<string, unknown>;

async function listen(server: ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

/** One stdio shim as the Air runs it: its own MCP connection, registered once under the shim's default identity. */
class Shim {
  private sid = "";
  private n = 0;
  private readonly instance = randomUUID();
  constructor(private readonly port: number, private readonly client: string | null = "ubus-mcp") {}
  private async rpc(method: string, params: Json): Promise<Json> {
    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(this.client ? { "x-ubus-client": this.client } : {}), ...(this.client ? { "x-ubus-instance": this.instance } : {}), ...(this.sid ? { "mcp-session-id": this.sid } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.n, method, params }),
    });
    this.sid = res.headers.get("mcp-session-id") || this.sid;
    return (await res.json()) as Json;
  }
  /** The server forgot this connection (restart): same shim process, new MCP session. */
  reconnect(): void {
    this.sid = "";
  }
  async init(): Promise<void> {
    await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  }
  async call(name: string, args: Json = {}): Promise<Json> {
    const r = (await this.rpc("tools/call", { name, arguments: args })) as { result: { content: Array<{ text: string }> } };
    return JSON.parse(r.result.content[0]!.text) as Json;
  }
  register(handle: string, session?: string): Promise<Json> {
    return this.call("ubus_register", { handle, machine: "air", runtime: "cowork", ...(session ? { session } : {}) });
  }
}

const NAMES = ["cc-air-work-local", "gov-orch", "newcat-orch"];

test("three Air Cowork sessions on one shim each get their own whoami, inbox and send label", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const shim = new Shim(port);
    await shim.init();
    // the shim's own default registration (what resolved every session to gov-orch before)
    assert.equal((await shim.register("air-cowork-shim", "cc:air-shim")).ok, true);
    for (const n of NAMES) assert.equal((await shim.register(n)).handle, n);

    // an unrelated sender on the Mini
    const mini = new Shim(port);
    await mini.init();
    await mini.call("ubus_register", { handle: "fable", machine: "mini", runtime: "claude-code", session: "s:fable" });
    for (const n of NAMES) assert.equal((await mini.call("ubus_send", { to: n, subject: `for ${n}`, body: "x" })).ok, true);

    for (const n of NAMES) {
      const who = await shim.call("ubus_whoami", { from: n });
      assert.equal(who.handle, n, `whoami ${n}`);
      const inbox = (await shim.call("ubus_inbox", { from: n })) as { messages?: Array<{ subject?: string }> };
      const subjects = (inbox.messages ?? []).map((m) => m.subject);
      assert.deepEqual(subjects, [`for ${n}`], `inbox ${n}`);
      const sent = await shim.call("ubus_send", { from: { handle: n }, to: "fable", subject: `from ${n}`, body: "y" });
      assert.equal(sent.ok, true, `send ${n}`);
    }
    const got = ((await mini.call("ubus_inbox")) as { messages?: Array<{ subject?: string; from?: unknown }> }).messages ?? [];
    for (const n of NAMES) {
      const m = got.find((x) => x.subject === `from ${n}`);
      assert.ok(m, `fable received from ${n}`);
      assert.match(JSON.stringify(m!.from), new RegExp(`"${n}"`));
    }
    // with no `from`, the shim default is unchanged
    assert.equal((await shim.call("ubus_whoami")).handle, "air-cowork-shim");
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("a from owned by another connection, or unregistered, is refused", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const air = new Shim(port);
    const other = new Shim(port);
    await air.init();
    await other.init();
    await air.register("air-cowork-shim", "cc:air-shim");
    await air.register("gov-orch");
    await other.register("other-shim", "cc:other-shim");

    for (const tool of ["ubus_whoami", "ubus_inbox"]) {
      const r = await other.call(tool, { from: "gov-orch" });
      assert.equal(r.error, "from_not_owned", tool);
    }
    const send = await other.call("ubus_send", { from: "gov-orch", to: "air-cowork-shim", subject: "spoof", body: "z" });
    assert.equal(send.error, "from_not_owned");
    assert.equal((await air.call("ubus_inbox")).count ?? 0, 0, "nothing was delivered under gov-orch's name");
    assert.equal((await other.call("ubus_whoami", { from: "never-registered" })).error, "from_not_owned");
    // objects naming a handle are held to the same rule
    assert.equal((await other.call("ubus_whoami", { from: { handle: "gov-orch", machine: "air" } })).error, "from_not_owned");
    // the owner is unaffected and register on the other connection does not steal the label
    assert.equal((await air.call("ubus_whoami", { from: "gov-orch" })).handle, "gov-orch");
    const steal = await other.register("gov-orch");
    assert.equal(steal.error, "handle_in_use", "a second live shim cannot take over the handle by registering it");
    assert.equal((await other.call("ubus_whoami", { from: "gov-orch" })).error, "from_not_owned");
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("a restarted shim takes its Cowork handles back after a clean exit or once the old connection has gone quiet", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const first = new Shim(port);
    await first.init();
    await first.register("air-cowork-shim", "cc:air-shim");
    await first.register("gov-orch");
    // same shim process on a new MCP session (server restart / recover): not a second shim
    first.reconnect();
    await first.init();
    assert.equal((await first.register("air-cowork-shim", "cc:air-shim")).ok, true);
    assert.equal((await first.register("gov-orch")).renamed, false);
    // crash: no unregister. Still live, so refused.
    const second = new Shim(port);
    await second.init();
    // a connection's own first registration is never blocked (hard-killed pane restart), but the secondary claim holds
    assert.equal((await second.register("air-cowork-shim", "cc:air-shim")).ok, true);
    assert.equal((await second.register("gov-orch")).error, "handle_in_use");
    rig.clock.advance(4 * 60 * 1000);
    assert.equal((await second.register("gov-orch")).renamed, false);
    assert.equal((await second.call("ubus_whoami", { from: "gov-orch" })).handle, "gov-orch");
    assert.equal((await first.call("ubus_whoami", { from: "gov-orch" })).error, "from_not_owned");
    // clean exit frees the claims at once
    await second.call("ubus_unregister");
    const third = new Shim(port);
    await third.init();
    assert.equal((await third.register("air-cowork-shim", "cc:air-shim")).ok, true);
    assert.equal((await third.register("gov-orch")).renamed, false);
  } finally {
    server.close();
    rig.cleanup();
  }
});

const SESSION = "h:gov-orch";

test("R1 a bound shim cannot take gov-orch by registering another handle onto gov-orch's session", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const air = new Shim(port);
    await air.init();
    await air.register("air-cowork-shim", "cc:air-shim");
    await air.register("gov-orch");
    const evil = new Shim(port);
    await evil.init();
    await evil.register("evil-shim", "cc:evil");
    const r = await evil.call("ubus_register", { handle: "whatever", machine: "air", runtime: "cowork", session: SESSION });
    assert.equal(r.error, "handle_in_use");
    assert.equal((await evil.call("ubus_whoami", { from: "gov-orch" })).error, "from_not_owned");
    assert.equal((await air.call("ubus_whoami", { from: "gov-orch" })).handle, "gov-orch");
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("R2 a plain MCP client (no shim header), bound or not, cannot register onto gov-orch", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const air = new Shim(port);
    await air.init();
    await air.register("air-cowork-shim", "cc:air-shim");
    await air.register("gov-orch");
    const plain = new Shim(port, null);
    await plain.init();
    assert.equal((await plain.register("gov-orch")).error, "handle_in_use");
    assert.notEqual((await plain.call("ubus_whoami")).handle, "gov-orch");
    assert.equal((await air.call("ubus_whoami", { from: "gov-orch" })).handle, "gov-orch");
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("R3 a hard-killed pane restarted with the same handle and session gets it back at once", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const pane = { handle: "eta-refuter", machine: "mini", runtime: "claude-code", session: "herdr:default/eta-refuter" };
    const a = new Shim(port);
    await a.init();
    assert.equal((await a.call("ubus_register", pane)).ok, true);
    // a is SIGKILLed: no unregister. The pane relaunches inside CLAIM_IDLE_MS on a new shim instance.
    rig.clock.advance(30_000);
    const b = new Shim(port);
    await b.init();
    const r = await b.call("ubus_register", pane);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.renamed, false);
    assert.equal((await b.call("ubus_whoami")).handle, "eta-refuter");
    // and the same for a hard-killed Cowork shim's own default identity
    const c = new Shim(port);
    await c.init();
    await c.register("air-cowork-shim", "cc:air-shim");
    const d = new Shim(port);
    await d.init();
    assert.equal((await d.register("air-cowork-shim", "cc:air-shim")).ok, true);
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("R4 sessions on one shim can speak for each other (documented: no isolation inside a shim)", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const air = new Shim(port);
    await air.init();
    await air.register("air-cowork-shim", "cc:air-shim");
    for (const n of NAMES) await air.register(n);
    for (const n of NAMES) assert.equal((await air.call("ubus_whoami", { from: n })).handle, n);
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("R5 a shim per session with the same default env: later shims fall back to registering their own handle", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  try {
    const s1 = new Shim(port);
    const s2 = new Shim(port);
    await s1.init();
    await s2.init();
    await s1.register("air-cowork-shim", "cc:air-shim");
    assert.equal((await s2.register("air-cowork-shim", "cc:air-shim")).ok, true);
    const g = await s2.register("gov-orch");
    assert.equal(g.handle, "gov-orch");
  } finally {
    server.close();
    rig.cleanup();
  }
});

async function airWithGov(): Promise<{ rig: ReturnType<typeof setup>; server: ReturnType<typeof createHttpServer>; port: number; air: Shim }> {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  const port = await listen(server);
  const air = new Shim(port);
  await air.init();
  await air.register("air-cowork-shim", "cc:air-shim");
  await air.register("gov-orch");
  return { rig, server, port, air };
}

test("H1 a bound connection cannot register gov-orch by leaving out machine", async () => {
  const { rig, server, port, air } = await airWithGov();
  try {
    for (const client of ["ubus-mcp", null]) {
      const evil = new Shim(port, client);
      await evil.init();
      assert.equal((await evil.call("ubus_register", { handle: `ev-${client ?? "plain"}`, machine: "air", runtime: "cowork", session: `cc:ev-${client ?? "plain"}` })).ok, true);
      const r = await evil.call("ubus_register", { handle: "gov-orch", runtime: "cowork" });
      assert.equal(r.error, "handle_in_use", String(client));
      assert.equal((await evil.call("ubus_whoami", { from: "gov-orch" })).error, "from_not_owned");
    }
    assert.equal((await air.call("ubus_whoami", { from: "gov-orch" })).handle, "gov-orch");
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("H5 an unbound connection naming a held handle in from is refused; unheld handles resolve as before", async () => {
  const { rig, server, port, air } = await airWithGov();
  try {
    const plain = new Shim(port, null);
    await plain.init();
    assert.equal((await plain.call("ubus_whoami", { from: "gov-orch" })).error, "from_not_owned");
    assert.equal((await plain.call("ubus_send", { from: "gov-orch", to: "air-cowork-shim", subject: "spoof", body: "z" })).error, "from_not_owned");
    assert.equal((await air.call("ubus_inbox")).count ?? 0, 0);
    // a stateless client's own handle (no shim instance, so no stable claim) still resumes by name
    const grok = new Shim(port, null);
    await grok.init();
    await grok.call("ubus_register", { handle: "stateless-x", machine: "air", runtime: "other" });
    const again = new Shim(port, null);
    await again.init();
    const w = await again.call("ubus_whoami", { from: "stateless-x" });
    assert.equal(w.handle, "stateless-x", JSON.stringify(w));
  } finally {
    server.close();
    rig.cleanup();
  }
});

test("H7 a squatter cannot take a secondary claim on a live pane, and the pane restart then succeeds", async () => {
  const { rig, server, port, air } = await airWithGov();
  try {
    const pane = { handle: "eta-refuter", machine: "mini", runtime: "claude-code", session: "herdr:default/eta-refuter" };
    const a = new Shim(port);
    await a.init();
    assert.equal((await a.call("ubus_register", pane)).ok, true);
    assert.equal((await air.call("ubus_register", pane)).error, "handle_in_use");
    assert.equal((await air.call("ubus_whoami", { from: "eta-refuter" })).error, "from_not_owned");
    // the pane is hard-killed and relaunches while the squatter keeps calling
    rig.clock.advance(30_000);
    await air.call("ubus_heartbeat");
    const b = new Shim(port);
    await b.init();
    const r = await b.call("ubus_register", pane);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.renamed, false);
    assert.equal((await b.call("ubus_whoami")).handle, "eta-refuter");
  } finally {
    server.close();
    rig.cleanup();
  }
});
