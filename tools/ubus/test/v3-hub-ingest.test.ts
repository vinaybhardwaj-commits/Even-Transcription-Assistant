import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HubServer } from "../src/v3/hub/server.js";
import { cleanupAfter, ev, rig, up } from "./v3-hub-helpers.js";

cleanupAfter();

test("a) 500-event batch with a duplicate seq stores 499 and acks 499", async () => {
  const r = rig();
  const h = await up(r);
  try {
    const batch = Array.from({ length: 500 }, (_, i) => ev(i + 1, { kind: "node.heartbeat", agent: null, state: null }));
    batch[499] = ev(250, { kind: "node.heartbeat", agent: null, state: null });
    const before = h.srv.hub.log.count();
    const res = await h.post(batch);
    assert.equal(res.status, 200);
    assert.equal(res.json.ack_seq, 499);
    assert.equal(res.json.stored, 499);
    assert.equal(res.json.duplicates, 1);
    assert.equal(h.srv.hub.log.count() - before, 499);
    const again = await h.post(batch.slice(0, 10));
    assert.equal(again.json.stored, 0);
    assert.equal(again.json.ack_seq, 499);
  } finally {
    await h.srv.close();
  }
});

test("b) bad HMAC, skew, wrong node, unknown node, loose key file: nothing stored", async () => {
  const r = rig();
  const h = await up(r);
  try {
    const base = h.srv.hub.log.count();
    assert.equal((await h.post([ev(1)], { key: "wrong" })).status, 401);
    assert.equal((await h.post([ev(1)], { skewMs: 6_000 })).status, 401, "forward skew is capped at 5 s");
    assert.equal((await h.post([ev(1)], { skewMs: 301_000 })).status, 401);
    assert.equal((await h.post([ev(1)], { skewMs: -301_000 })).status, 401);
    assert.equal((await h.post([ev(1)], { node: "c3" })).status, 401);
    assert.equal((await h.post([ev(1, { node: "mini" })])).status, 403);
    assert.equal((await h.post([ev(1), ev(2, { node: "mini" })])).status, 403);
    chmodSync(join(r.cfg.keyDir, "t4.key"), 0o644);
    assert.equal((await h.post([ev(1)])).status, 401);
    chmodSync(join(r.cfg.keyDir, "t4.key"), 0o600);
    assert.equal(h.srv.hub.log.count(), base);
    assert.equal((await h.post([ev(1)], { skewMs: 4_000 })).status, 200);
  } finally {
    await h.srv.close();
  }
});

test("c) replay after restart gives an identical agents view", async () => {
  const r = rig();
  let h = await up(r);
  const evs = [ev(1), ev(2, { agent: { id: "w2@t4", kind: "claude-code", pane: null, lane: null, model: null, runtime: "max", pid: null }, state: "idle" }), ev(3, { kind: "node.heartbeat", agent: null, state: null }), ev(4, { state: "stalled", reason: "no_output_10m" })];
  await h.post(evs);
  const agents = (await h.get("/api/v3/agents")).json;
  const lanes = (await h.get("/api/v3/lanes")).json;
  assert.equal(agents.agents.length, 2);
  await h.srv.close();
  h = await up(r);
  try {
    assert.deepEqual((await h.get("/api/v3/agents")).json, agents);
    assert.deepEqual((await h.get("/api/v3/lanes")).json, lanes);
    assert.equal((await h.post([ev(4)])).json.stored, 0);
    // offline once the node heartbeat is older than 90 s
    r.clock.advance(91_000);
    const stale = (await h.get("/api/v3/agents?node=t4")).json.agents;
    assert.ok(stale.every((a: any) => a.state === "offline" && a.stale));
    assert.equal((await h.get("/api/v3/agents?node=mini")).json.agents.length, 0);
  } finally {
    await h.srv.close();
  }
});

test("d) errored event yields exactly one alert to the lane owner", async () => {
  const r = rig();
  let h = await up(r);
  try {
    await h.post([ev(1)]);
    await h.post([ev(2, { state: "errored", reason: "rate_limit" })]);
    await h.post([ev(3, { state: "errored", reason: "rate_limit" })]);
    await h.post([ev(2, { state: "errored", reason: "rate_limit" })]);
    const msgs = h.srv.hub.messages.snapshot().messages.filter((m) => m.kind === "alert");
    assert.equal(msgs.length, 1);
    assert.match(msgs[0].body, /state=errored rule=rate_limit/);
    assert.equal(h.srv.hub.stateOf(msgs[0].id, "newcat-orch")?.state, "stored");
    const unacked = (await h.get("/api/v3/messages?state=unacked", true)).json.messages;
    assert.equal(unacked.length, 1);
    assert.equal((await h.get("/api/v3/messages?state=unacked")).status, 401);
    await h.srv.close();
    h = await up(r);
    await h.post([ev(4, { state: "errored", reason: "rate_limit" })]);
    assert.equal(h.srv.hub.messages.snapshot().messages.filter((m) => m.kind === "alert").length, 1);
    await h.post([ev(5, { state: "working" }), ev(6, { state: "stalled", reason: "no_output_10m" })]);
    assert.equal(h.srv.hub.messages.snapshot().messages.filter((m) => m.kind === "alert").length, 2);
    const since = (await h.get("/api/v3/since?cursor=0&limit=5", true)).json;
    assert.equal(since.events.length, 5);
    assert.equal(since.next_cursor, since.events[4].id);
  } finally {
    await h.srv.close();
  }
});

test("e) 281-char field and PHI-like string are rejected with a rule id, seq consumed", async () => {
  const r = rig();
  const h = await up(r);
  try {
    const res = await h.post([ev(1, { meta: { note: "x".repeat(281) } }), ev(2, { meta: { note: "patient 9876543210" } }), ev(3, { reason: "has space" }), ev(4)]);
    assert.equal(res.status, 200);
    assert.equal(res.json.stored, 1);
    assert.deepEqual(res.json.rejected.map((x: any) => x.rule), ["too_long", "phi.phone_in", "schema.reason"]);
    assert.equal(res.json.ack_seq, 4);
    const rows = h.srv.hub.log.all().filter((x) => x.kind === "hub.ev.rejected");
    assert.equal(rows.length, 3);
    assert.ok(!JSON.stringify(rows).includes("9876543210"));
  } finally {
    await h.srv.close();
  }
});

test("f) refuses to bind 0.0.0.0 and other wildcards; health works", async () => {
  for (const host of ["0.0.0.0", "::", "", "0", "000.0.0.0", "localhost"]) {
    const r = rig();
    r.cfg.listen = { host, port: 0 };
    assert.throws(() => new HubServer(r.cfg, r.clock), /wildcard|IP literal/, host);
  }
  const r = rig();
  const h = await up(r);
  try {
    await h.post([ev(1)]);
    const health = (await h.get("/api/v3/health")).json;
    assert.equal(health.ok, true);
    assert.equal(health.events, 1);
    assert.equal(health.nodes.t4.ack_seq, 1);
  } finally {
    await h.srv.close();
  }
});
