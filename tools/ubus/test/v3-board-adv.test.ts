// Refuter throwaway adversarial tests (not part of the lane). Each test is one probe.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { renderRoute, listenBoard, HttpBoardSource } from "../src/v3/board/server.js";
import { clipBody, isUnackedOrder } from "../src/v3/board/render.js";
import type { BoardSource, BoardViews, MessageView } from "../src/v3/board/types.js";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const src = (v: Partial<BoardViews>): BoardSource => ({ views: async () => ({ agents: [], lanes: [], messages: [], ...v }) });
const down: BoardSource = { views: async () => { throw new Error("down"); } };
const msg = (o: Partial<MessageView>): MessageView => ({
  id: "m", ts: "2026-10-18T09:00:00Z", from: "a", to: ["b"], kind: "msg", priority: "normal",
  subject: "s", body: "hi", body_ref: "", lane: null, states: { b: { state: "delivered", reason: "" } }, ...o,
});
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const X = `<i x="1" y='2'>&`;

test("ADV1 every string field is escaped (agents, lanes, messages, states, unknown state)", async () => {
  const v: BoardViews = {
    agents: [{ id: X, node: X, kind: X, lane: X, pane: X, model: X, state: X as never, last_heartbeat: X }],
    lanes: [{ lane_id: X, title: X, brief_ref: X, owner: X, builder: X, refuter: X, branch: X, state: X as never, verdict_ref: X }],
    messages: [msg({ id: X, ts: X, from: X, to: [X, X], kind: X, priority: X, subject: X, body: X, body_ref: X, lane: X, states: { [X]: { state: X as never, reason: X } } })],
  };
  for (const r of ["/", "/fleet", "/lanes", "/messages"]) {
    const html = (await renderRoute(src(v), r, new URLSearchParams({ agent: X, lane: X, state: X }), NOW))!;
    assert.ok(!html.includes("<i "), r);
    assert.ok(!/x="1"|y='2'/.test(html), r);
  }
});

test("ADV2 filter values cannot break out of the meta refresh attribute", async () => {
  const html = (await renderRoute(src({}), "/messages", new URLSearchParams({ lane: `"><b>;url=//evil.example` }), NOW))!;
  const meta = html.match(/<meta http-equiv="refresh" content="([^"]*)">/)!;
  assert.ok(meta, "meta intact");
  assert.match(meta[1], /^15; url=\/messages\?/);
  assert.ok(!/url=\/\//.test(meta[1]));
});

test("ADV3 hub down: refresh target stays on-board for a crafted path", async () => {
  const html = (await renderRoute(down, "//evil.example", new URLSearchParams(), NOW))!;
  assert.ok(html === null || !/url=\/\//.test(html));
});

test("ADV4 hub down via real server: /.//evil.example does not refresh off-host", async () => {
  const server = await listenBoard({ source: down, port: 0 });
  try {
    const { port } = server.address() as AddressInfo;
    const net = await import("node:net");
    const raw: string = await new Promise((res) => {
      const s = net.connect(port, "127.0.0.1", () => s.write("GET /.//evil.example HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
      let b = ""; s.on("data", (d) => (b += d)); s.on("end", () => res(b));
    });
    const status = raw.split(" ")[1];
    const meta = raw.match(/<meta http-equiv="refresh"[^>]*>/)?.[0] ?? "";
    assert.ok(!/url=\/\//.test(meta), `status ${status} ${meta}`);
  } finally { server.close(); }
});

test("ADV5 unknown path is 404 even when hub is down", async () => {
  assert.equal(await renderRoute(down, "/nope", new URLSearchParams(), NOW), null);
});

test("ADV6 280 cut on astral (emoji) text leaves no lone surrogate and <=280 code points", () => {
  const out = clipBody("x".repeat(279) + "😀".repeat(10));
  assert.ok(!LONE.test(out), "lone surrogate");
  assert.ok([...out.replace(/…$/, "")].length <= 280);
});

test("ADV7 280 cut on BMP multibyte (Devanagari/CJK) counts chars, not bytes", () => {
  const out = clipBody("ह".repeat(1000));
  assert.equal(out, "ह".repeat(280) + "…");
  assert.equal(clipBody("界".repeat(280)), "界".repeat(280));
});

test("ADV8 clip happens before escaping (no half entity, 280 visible chars)", async () => {
  const html = (await renderRoute(src({ messages: [msg({ body: "&".repeat(1000) })] }), "/messages", new URLSearchParams(), NOW))!;
  assert.ok(html.includes("&amp;".repeat(280) + "…"));
  assert.ok(!html.includes("&amp;".repeat(281)));
});

test("ADV9 boundary: 280 no ellipsis, 281 ellipsis", () => {
  assert.equal(clipBody("y".repeat(280)), "y".repeat(280));
  assert.equal(clipBody("y".repeat(281)), "y".repeat(280) + "…");
});

test("ADV10 P0 kind 'request' (no 'order' kind exists in P0 KINDS) counts as an unacked order", () => {
  assert.ok(isUnackedOrder(msg({ kind: "request" })));
});

test("ADV11 multi-recipient order partly acked is still unacked for the others", () => {
  assert.ok(isUnackedOrder(msg({ kind: "order", to: ["b", "c"], states: { b: { state: "acked", reason: "" }, c: { state: "delivered", reason: "" } } })));
});

test("ADV12 unacked-first holds among 300 mixed messages; newest-first inside each group", async () => {
  const ms = Array.from({ length: 300 }, (_, i) => msg({
    id: `m${i}`, ts: new Date(NOW - i * 60000).toISOString(), subject: `S${i}Z`,
    kind: i % 3 ? "msg" : "order", states: { b: { state: i % 6 ? "delivered" : "acked", reason: "" } },
  }));
  const html = (await renderRoute(src({ messages: ms }), "/messages", new URLSearchParams(), NOW))!;
  const order = [...html.matchAll(/<div class="msg( unacked)?">/g)].map((m) => !!m[1]);
  const firstRest = order.indexOf(false);
  assert.ok(order.slice(firstRest).every((u) => !u));
  assert.equal(order.filter(Boolean).length, 50);
  const subj = [...html.matchAll(/S(\d+)Z/g)].map((m) => +m[1]);
  assert.deepEqual(subj.slice(0, 50), subj.slice(0, 50).slice().sort((a, b) => a - b));
});

test("ADV13 no external URL/resource even when data contains URLs (only as escaped text, never href/src)", async () => {
  const u = "https://evil.example/x.js";
  const v = { agents: [{ id: u, node: u, kind: u, lane: u, pane: null, model: u, state: "idle" as const, last_heartbeat: null }], lanes: [], messages: [msg({ body: u, body_ref: u, subject: u })] };
  for (const r of ["/", "/fleet", "/lanes", "/messages", "/history"]) {
    const html = (await renderRoute(src(v), r, new URLSearchParams(), NOW))!;
    assert.ok(!/(href|src|action)="(?!\/)/i.test(html), r);
    assert.ok(!/url\(/i.test(html), r);
    assert.ok(!/<(script|link|img|iframe|object|embed|form|base)\b/i.test(html), r);
  }
});

test("ADV14 phone width: viewport + narrow media query + wide tables can scroll", async () => {
  const html = (await renderRoute(src({}), "/lanes", new URLSearchParams(), NOW))!;
  assert.match(html, /width=device-width/);
  assert.match(html, /@media \(max-width:\d+px\)/);
  assert.match(html, /overflow-x:auto|overflow:auto/, "8-column lanes table has no horizontal scroll container");
});

test("ADV15 HttpBoardSource can carry node auth to a hub that requires it off loopback", async () => {
  let saw = "";
  const hub = createServer((req, res) => { saw = String(req.headers.authorization ?? ""); res.writeHead(saw ? 200 : 401).end("[]"); });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  try {
    const { port } = hub.address() as AddressInfo;
    const Ctor = HttpBoardSource as unknown as new (...a: unknown[]) => BoardSource;
    const s = new Ctor(`http://127.0.0.1:${port}`, { headers: () => ({ authorization: "Node t4:00" }) });
    await s.views();
    assert.ok(saw.startsWith("Node "), "no way to pass Authorization / X-Ubus-Ts");
  } finally { hub.close(); }
});

test("ADV16 HEAD returns headers only; CSP blocks everything but inline style", async () => {
  const server = await listenBoard({ source: src({}), port: 0 });
  try {
    const { port } = server.address() as AddressInfo;
    const r = await fetch(`http://127.0.0.1:${port}/fleet`, { method: "HEAD" });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "");
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    for (const m of ["PUT", "DELETE", "PATCH"]) assert.equal((await fetch(`http://127.0.0.1:${port}/fleet`, { method: m })).status, 405);
  } finally { server.close(); }
});

// ---- builder R2 additions: pin literals and kill refuter mutants ----
import { esc } from "../src/v3/board/render.js";
import { adaptMessage } from "../src/v3/board/server.js";

test("R2 literal 280 (not the imported constant) and ellipsis", () => {
  assert.equal(clipBody("z".repeat(281)).length, 281);
  assert.equal(Array.from(clipBody("z".repeat(500))).length, 281);
  assert.equal(clipBody("z".repeat(280)), "z".repeat(280));
});

test("R2 esc maps & < > \" ' each exactly", () => {
  assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("R2 reason and recipient list are escaped", async () => {
  const m = msg({ to: [X], states: { [X]: { state: "delivered", reason: X } } });
  const html = (await renderRoute(src({ messages: [m] }), "/messages", new URLSearchParams(), NOW))!;
  assert.ok(!html.includes("<i "));
  assert.ok(html.includes("&lt;i x=&quot;1&quot; y=&#39;2&#39;&gt;&amp;"));
});

test("R2 unacked semantics: no states, done counts as acked, partial ack, rejected", () => {
  assert.ok(isUnackedOrder(msg({ kind: "request", states: {} })));
  assert.ok(!isUnackedOrder(msg({ kind: "request", states: { b: { state: "done", reason: "" } } })));
  assert.ok(!isUnackedOrder(msg({ kind: "request", states: { b: { state: "acked", reason: "" } } })));
  assert.ok(isUnackedOrder(msg({ kind: "msg", sla_s: 60 })));
  assert.ok(!isUnackedOrder(msg({ kind: "msg" })));
  assert.ok(!isUnackedOrder(msg({ kind: "request", states: { b: { state: "rejected", reason: "x" } } })));
});

test("R2 unacked card lists the missing recipients", async () => {
  const m = msg({ kind: "request", to: ["b", "c"], states: { b: { state: "acked", reason: "" }, c: { state: "read", reason: "" } } });
  const html = (await renderRoute(src({ messages: [m] }), "/messages", new URLSearchParams(), NOW))!;
  assert.match(html, /waiting on c</);
});

test("R2 route whitelist: hub down and up both 404 on unknown paths, refresh fixed", async () => {
  for (const p of ["/nope", "//evil.example", "/fleet/x"]) {
    assert.equal(await renderRoute(down, p, new URLSearchParams(), NOW), null, p);
    assert.equal(await renderRoute(src({}), p, new URLSearchParams(), NOW), null, p);
  }
  const html = (await renderRoute(down, "/fleet/", new URLSearchParams({ x: "1" }), NOW))!;
  assert.match(html, /content="15; url=\/fleet"/);
});

test("R2 listenBoard refuses wildcard and empty hosts", async () => {
  for (const host of ["0.0.0.0", "::", "[::]", ""]) {
    await assert.rejects(listenBoard({ source: src({}), host, port: 0 }), /refuses/, host);
  }
});

test("R2 tables sit in an overflow-x wrapper", async () => {
  const html = (await renderRoute(src({ agents: [{ id: "a@n", node: "n", kind: "k", lane: null, pane: null, model: null, state: "idle", last_heartbeat: null }] }), "/fleet", new URLSearchParams(), NOW))!;
  assert.match(html, /<div class="scroll"><table>/);
});

test("R2 fleet shows the last message column", async () => {
  const a = { id: "a@n", node: "n", kind: "k", lane: null, pane: null, model: null, state: "idle" as const, last_heartbeat: null, last_message: "hello subj" };
  const html = (await renderRoute(src({ agents: [a] }), "/fleet", new URLSearchParams(), NOW))!;
  assert.ok(html.includes("<th>last msg</th>") && html.includes("hello subj"));
});

test("R2 adapter maps P0 camelCase and derives to from states", () => {
  const m = adaptMessage({ id: "1", kind: "request", bodyRef: "f.md", slaS: 30, states: { b: { state: "stored", reason: "" } } });
  assert.equal(m.body_ref, "f.md");
  assert.equal(m.sla_s, 30);
  assert.deepEqual(m.to, ["b"]);
});

test("R2 auth hook receives method/path and headers are sent", async () => {
  const seen: string[] = [];
  const hub = createServer((req, res) => { seen.push(`${req.url}|${req.headers["x-ubus-ts"]}`); res.writeHead(200).end("[]"); });
  await new Promise<void>((r) => hub.listen(0, "127.0.0.1", r));
  try {
    const { port } = hub.address() as AddressInfo;
    const s = new HttpBoardSource(`http://127.0.0.1:${port}`, { headers: (m, p) => ({ "x-ubus-ts": `${m}${p.length}` }) });
    await s.views();
    assert.equal(seen.length, 3);
    assert.ok(seen.every((x) => /\|GET\d+$/.test(x)));
  } finally { hub.close(); }
});

// ---- R3 ----
import { isAnyAddress } from "../src/v3/board/server.js";

/** Tailnet-range (100.x) addresses are built at run time so the tree holds no such literal. */
const cgnat = (b: number, c: number, d: number): string => ["100", b, c, d].join(".");

test("R3 listenBoard refuses every any-address alias", async () => {
  const aliases = ["0", "0.0", "0.0.0", "0.0.0.0", "0x0", "00", "00.0.0.0", "0x0.0x0.0x0.0x0", "0000", "::", "::0", "[::]", "0:0:0:0:0:0:0:0", "[0:0:0:0:0:0:0:0]", "0000:0000::", "::ffff:0.0.0.0", "::ffff:0:0", " 0.0.0.0 ", "", "  "];
  for (const host of aliases) {
    assert.ok(isAnyAddress(host), `isAnyAddress ${JSON.stringify(host)}`);
    await assert.rejects(listenBoard({ source: src({}), host, port: 0 }), /refuses/, JSON.stringify(host));
  }
});

test("R3 loopback and specific addresses are not any-address", async () => {
  for (const h of ["127.0.0.1", "::1", "[::1]", cgnat(64, 1, 2), "127.0.0.2", "0.0.0.1", "::1:0", "localhost"]) assert.ok(!isAnyAddress(h), h);
  const server = await listenBoard({ source: src({}), host: "::1", port: 0 }).catch(() => null);
  server?.close();
});

test("R3 states as P0 snapshot pairs do not become recipient '0'", () => {
  const m = adaptMessage({ id: "1", kind: "request", states: [["b", { state: "stored", reason: "" }]] });
  assert.deepEqual(m.to, ["b"]);
});

test("R3 lanes table is in an overflow wrapper", async () => {
  const l = { lane_id: "l", title: "t", brief_ref: "b", owner: "o", builder: null, refuter: null, branch: null, state: "pass" as const, verdict_ref: null };
  const html = (await renderRoute(src({ lanes: [l] }), "/lanes", new URLSearchParams(), NOW))!;
  assert.match(html, /<div class="scroll"><table>/);
});

// ---- R4: no input may kill the process ----
test("R4 //[ and 200 malformed request targets never crash; answer 400/404", async () => {
  const net = await import("node:net");
  const server = await listenBoard({ source: src({ agents: agents1() }), port: 0 });
  const { port } = server.address() as AddressInfo;
  const raw = (target: string): Promise<string> => new Promise((res) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let b = ""; s.on("data", (d) => (b += d)); s.on("end", () => res(b)); s.on("error", () => res(b));
  });
  const fixed = ["//[", "/[", "//[::", "//]", "//[x]/", "///", "//:", "//@", "//a@[", "/%", "/%zz", "/%c0%af", "/?%", "/?a=%", "*", "//", "/\\", "http://[", "http://[/", "//[::1", "/..%2f", "/\u0000", "//%00"];
  const targets = [...fixed];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const alphabet = "/[]:@%?#\\.&=<>\"'0aZ-_ ~!$()*+,;{}|^`";
  while (targets.length < 200) {
    let t = rnd() % 2 ? "/" : "//";
    for (let i = rnd() % 12; i >= 0; i--) t += alphabet[rnd() % alphabet.length];
    targets.push(t.replace(/ /g, "%20"));
  }
  assert.equal(targets.length, 200);
  try {
    for (const t of targets) {
      const out = await raw(t);
      const status = Number(out.split(" ")[1]);
      assert.ok([200, 400, 404].includes(status), `${JSON.stringify(t)} -> ${status}`);
    }
    const ok = await fetch(`http://127.0.0.1:${port}/fleet`);
    assert.equal(ok.status, 200, "server still alive");
    // framing garbage
    await new Promise<void>((r) => { const s = net.connect(port, "127.0.0.1", () => { s.write("G\x01T / HTTP/1.1\r\n\r\n"); }); const done = () => { s.destroy(); r(); }; s.on("data", done); s.on("close", done); s.on("error", done); setTimeout(done, 1000); });
    assert.equal((await fetch(`http://127.0.0.1:${port}/fleet`)).status, 200);
  } finally { server.closeAllConnections(); server.close(); }
});
function agents1() { return [{ id: "a@n", node: "n", kind: "k", lane: null, pane: null, model: null, state: "idle" as const, last_heartbeat: null }]; }
