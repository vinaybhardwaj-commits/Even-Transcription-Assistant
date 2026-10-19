import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HubServer } from "../src/v3/hub/server.js";
import { alerts, cleanupAfter, ev, hb, KEYS, rig, up } from "./v3-hub-helpers.js";

cleanupAfter();

test("K1 skew boundaries, ts forms, missing ts/nonce; nothing stored", async () => {
  const r = rig(); const h = await up(r);
  try {
    const base = h.srv.hub.log.count();
    r.clock.advance(400_000);
    const t = r.clock.now();
    assert.equal((await h.post([ev(1)], { ts: new Date(t - 300_001).toISOString() })).status, 401);
    assert.equal((await h.post([ev(1)], { ts: new Date(t + 300_001).toISOString() })).status, 401);
    assert.equal((await h.post([ev(1)], { ts: "garbage" })).status, 401);
    assert.equal((await h.post([ev(1)], { ts: String(Math.floor(t / 1000)) })).status, 401);
    assert.equal((await h.post([ev(1)], { noTs: true })).status, 401);
    assert.equal((await h.post([ev(1)], { noNonce: true })).status, 401);
    assert.equal((await h.post([ev(1)], { nonce: "abc" })).status, 401);
    assert.equal((await h.post([ev(1)], { auth: "" })).status, 401);
    assert.equal(h.srv.hub.log.count(), base);
    assert.equal((await h.post([ev(1)], { ts: new Date(t - 300_000).toISOString() })).status, 200);
  } finally { await h.srv.close(); }
});

test("K2 signature over other body/path/method, truncated sig, traversal node -> 401", async () => {
  const r = rig(); const h = await up(r);
  try {
    const base = h.srv.hub.log.count();
    const other = JSON.stringify({ events: [ev(2)] });
    assert.equal((await h.post([ev(1)], { signBody: other })).status, 401);
    assert.equal((await h.post([ev(1)], { signPath: "/api/v3/events?x=1" })).status, 401);
    assert.equal((await h.post([ev(1)], { signMethod: "GET" })).status, 401);
    assert.equal((await h.post([ev(1)], { auth: `Node t4:${"a".repeat(63)}` })).status, 401);
    assert.equal((await h.post([ev(1)], { auth: `Node ../t4:${"a".repeat(64)}` })).status, 401);
    assert.equal((await h.post([ev(1)], { auth: `Node mini:${"a".repeat(64)}` })).status, 401);
    assert.equal(h.srv.hub.log.count(), base);
  } finally { await h.srv.close(); }
});

test("K3 key file perms: 0640/0604 refused, 0400 accepted, empty refused", async () => {
  const r = rig(); const h = await up(r);
  try {
    const kf = join(r.cfg.keyDir, "t4.key");
    for (const m of [0o640, 0o604, 0o610]) { chmodSync(kf, m); assert.equal((await h.post([ev(1)])).status, 401, m.toString(8)); }
    chmodSync(kf, 0o400); assert.equal((await h.post([ev(1)])).status, 200);
    chmodSync(kf, 0o600); writeFileSync(kf, "  \n");
    assert.equal((await h.post([ev(2)], { key: "" })).status, 401);
  } finally { await h.srv.close(); }
});

test("K4 node claims: agent id of other node rejected; mixed batch 403 stores nothing", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = await h.post([ev(1, { agent: { ...ev(1).agent, id: "lead@mini" } })]);
    assert.deepEqual(res.json.rejected.map((x: any) => x.rule), ["schema.agent_id"]);
    const base = h.srv.hub.log.count();
    assert.equal((await h.post([ev(2), ev(3), ev(4, { node: "air" })])).status, 403);
    assert.equal(h.srv.hub.log.count(), base);
    assert.equal(h.srv.registry.ackSeq("t4", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"), 1);
  } finally { await h.srv.close(); }
});

test("K5 idempotency: in-batch dup keeps first, gaps hold ack_seq, 501 refused", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = await h.post([ev(1, { state: "idle" }), ev(1, { state: "working" }), ev(2), ev(4)]);
    assert.equal(res.json.stored, 3); assert.equal(res.json.duplicates, 1); assert.equal(res.json.ack_seq, 2);
    const first = h.srv.hub.log.all().find((x) => x.kind === "hub.ev.agent.state" && (x.meta as any).seq === 1)!;
    assert.equal((first.meta as any).state, "idle");
    assert.equal((await h.post([ev(3)])).json.ack_seq, 4);
    const base = h.srv.hub.log.count();
    assert.equal((await h.post(Array.from({ length: 501 }, (_, i) => hb(i + 10)))).status, 400);
    assert.equal(h.srv.hub.log.count(), base);
    assert.equal((await h.post(Array.from({ length: 500 }, (_, i) => hb(i + 5)))).json.ack_seq, 504);
    assert.equal(h.srv.registry.eventCount(), 504);
  } finally { await h.srv.close(); }
});

test("K6 replay after restart: agents, lanes, health identical incl. rejected rows and lane.done", async () => {
  const r = rig(); let h = await up(r);
  await h.post([ev(1), ev(2, { meta: { x: "y".repeat(281) } }), hb(3), ev(4, { state: "errored", reason: "rate_limit" }), ev(5, { kind: "lane.done", state: null, agent: { ...ev(1).agent, id: "w9@t4", lane: "bc-s7" } }), ev(6, { kind: "agent.gone", state: null, agent: { ...ev(1).agent, id: "w8@t4", lane: null } })]);
  r.clock.advance(5000);
  const snap = async () => [(await h.get("/api/v3/agents")).json, (await h.get("/api/v3/lanes")).json, (await h.get("/api/v3/health")).json, (await h.get("/api/v3/lanes?state=finished")).json];
  const before = await snap();
  const nAlerts = alerts(h).length;
  await h.srv.close(); h = await up(r);
  try {
    assert.deepEqual(await snap(), before);
    assert.equal(alerts(h).length, nAlerts);
    assert.equal(h.srv.registry.ackSeq("t4", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"), 6);
  } finally { await h.srv.close(); }
});

test("K7 offline boundary: 90 s fresh, 90.001 s stale; heartbeat refreshes", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1), hb(2)]);
    r.clock.advance(90_000);
    assert.equal((await h.get("/api/v3/agents")).json.agents[0].state, "working");
    r.clock.advance(1);
    assert.equal((await h.get("/api/v3/agents")).json.agents[0].state, "offline");
    await h.post([hb(3)]);
    assert.equal((await h.get("/api/v3/agents")).json.agents[0].stale, false);
  } finally { await h.srv.close(); }
});

test("K8 alerts: one per state change, reason change no repeat, no owner no alert, body ids only", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1, { state: "errored", reason: "rate_limit", meta: { tag: "secretish" } })]);
    await h.post([ev(2, { state: "errored", reason: "auth" })]);
    assert.equal(alerts(h).length, 1);
    await h.post([ev(3, { state: "stalled", reason: "no_output_10m" })]);
    await h.post([ev(4, { state: "errored", reason: "auth", agent: { ...ev(1).agent, lane: null } })]);
    const a = alerts(h);
    assert.equal(a.length, 3);
    assert.deepEqual(a.map((m: any) => m.body).sort(), ["agent=lead@t4 lane=bc-s6 state=errored rule=auth", "agent=lead@t4 lane=bc-s6 state=errored rule=rate_limit", "agent=lead@t4 lane=bc-s6 state=stalled rule=no_output_10m"]);
    assert.equal(a[0].from, "ubus-hub");
    assert.ok(!a.some((m: any) => m.body.includes("secretish")));
    await h.post([ev(5, { state: "errored", agent: { ...ev(1).agent, id: "x@t4", lane: "no-owner" } })]);
    await h.post([ev(6, { state: "working" }), ev(7, { state: "idle" }), ev(8, { state: "finished" })]);
    assert.equal(alerts(h).length, 3);
  } finally { await h.srv.close(); }
});

test("K9 every string field: 280 ok, 281 too_long; PHI in lane/pane/model/id rejected, rule only stored", async () => {
  const r = rig(); const h = await up(r);
  try {
    const A = ev(1).agent;
    const ok = await h.post([ev(1, { meta: { s: "a".repeat(280) } })]);
    assert.equal(ok.json.stored, 1);
    const bad = await h.post([
      ev(2, { agent: { ...A, pane: "p".repeat(281) } }),
      ev(3, { agent: { ...A, lane: "l".repeat(281) } }),
      ev(4, { agent: { ...A, model: "m".repeat(281) } }),
      ev(5, { reason: "r".repeat(281) }),
      ev(6, { agent: { ...A, lane: "jane.doe@example.com" } }),
      ev(7, { agent: { ...A, model: "9876543210" } }),
    ]);
    assert.equal(bad.json.stored, 0);
    assert.deepEqual(bad.json.rejected.slice(0, 4).map((x: any) => x.rule), ["too_long", "too_long", "too_long", "too_long"]);
    assert.ok(bad.json.rejected.slice(4).every((x: any) => /^(phi|secret)/.test(x.rule)), JSON.stringify(bad.json.rejected));
    const text = JSON.stringify(h.srv.hub.log.all()) + JSON.stringify(bad.json);
    assert.ok(!text.includes("jane.doe") && !text.includes("9876543210"));
    assert.equal(bad.json.ack_seq, 7);
  } finally { await h.srv.close(); }
});

test("K10 /since and /messages need auth; paging walks every row once; limit clamped", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post(Array.from({ length: 30 }, (_, i) => hb(i + 1)));
    assert.equal((await h.get("/api/v3/since?cursor=0")).status, 401);
    assert.equal((await h.get("/api/v3/messages")).status, 401);
    const seen: number[] = []; let cur = 0;
    for (;;) { const p = (await h.get(`/api/v3/since?cursor=${cur}&limit=7`, true)).json; if (!p.events.length) break; seen.push(...p.events.map((e: any) => e.id)); cur = p.next_cursor; }
    assert.equal(seen.length, h.srv.hub.log.count()); assert.equal(new Set(seen).size, seen.length);
    assert.ok((await h.get("/api/v3/since?cursor=0&limit=99999", true)).json.events.length <= 1000);
  } finally { await h.srv.close(); }
});

test("K11 no key or body/PHI text reaches stdout/stderr/console", async () => {
  const out: string[] = [];
  const o = { log: console.log, error: console.error, warn: console.warn, info: console.info, so: process.stdout.write, se: process.stderr.write };
  const cap = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.log = console.error = console.warn = console.info = cap as any;
  (process.stdout as any).write = (c: any, ...r: any[]) => (out.push(String(c)), o.so.call(process.stdout, c, ...r));
  (process.stderr as any).write = (c: any) => (out.push(String(c)), true);
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1)], { key: "wrong" });
    await h.post([ev(1, { agent: { ...ev(1).agent, lane: "jane.doe@example.com" } }), ev(2, { state: "errored", reason: "rate_limit" })]);
    await h.post([ev(3, { node: "mini" })]);
    await h.raw("POST", "/api/v3/events", "{not json 9876543210");
  } finally {
    await h.srv.close();
    Object.assign(console, { log: o.log, error: o.error, warn: o.warn, info: o.info });
    (process.stdout as any).write = o.so; (process.stderr as any).write = o.se;
  }
  const all = out.join("\n");
  for (const s of Object.values(KEYS).concat(["jane.doe", "9876543210", "rate_limit"])) assert.ok(!all.includes(s), s);
});

test("K12 wildcard binds refused at construct and at listen()", async () => {
  for (const host of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", " 0.0.0.0 ", "*"]) {
    const r = rig(); r.cfg.listen = { host, port: 0 };
    assert.throws(() => new HubServer(r.cfg, r.clock), /./, host);
  }
  const r = rig(); const srv = new HubServer(r.cfg, r.clock);
  (srv.cfg as any).listen = { host: "0.0.0.0", port: 0 };
  assert.throws(() => srv.listen()); await srv.close();
});
