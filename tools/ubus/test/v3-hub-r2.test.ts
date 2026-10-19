import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { HubServer } from "../src/v3/hub/server.js";
import { alerts, cleanupAfter, ev, hb, rig, up } from "./v3-hub-helpers.js";

/** Tailnet-range (100.x) addresses are built at run time so the tree holds no such literal. */
const cgnat = (b: number, c: number, d: number): string => ["100", b, c, d].join(".");

cleanupAfter();

test("A1 nonce: a nonce is single use inside the window, per node, and refused after a valid sig only", async () => {
  const r = rig(); const h = await up(r);
  try {
    const nonce = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    assert.equal((await h.post([hb(1)], { nonce })).status, 200);
    assert.equal((await h.post([hb(2)], { nonce })).status, 401);
    // a forged request cannot burn a victim's nonce
    const n2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    assert.equal((await h.post([hb(2)], { nonce: n2, key: "wrong" })).status, 401);
    assert.equal((await h.post([hb(2)], { nonce: n2 })).status, 200);
    // after 600 s the nonce is forgotten, but then the old ts is already outside the skew window
    r.clock.advance(601_000);
    assert.equal((await h.post([hb(3)], { nonce })).status, 200);
  } finally { await h.srv.close(); }
});

test("A1 epoch: a new epoch restarting at seq 1 is stored, logged as epoch_reset, never deduped", async () => {
  const r = rig(); let h = await up(r);
  try {
    assert.equal((await h.post([ev(1), ev(2)])).json.ack_seq, 2);
    const res = await h.post([ev(1, { epoch: "f1e2d3c4b5a69788f1e2d3c4b5a69788" }), ev(2, { epoch: "f1e2d3c4b5a69788f1e2d3c4b5a69788" })]);
    assert.equal(res.json.stored, 2);
    assert.equal(res.json.duplicates, 0);
    assert.equal(res.json.ack_seq, 2);
    assert.equal(res.json.epoch, "f1e2d3c4b5a69788f1e2d3c4b5a69788");
    const resets = h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.node.epoch_reset");
    assert.equal(resets.length, 1);
    assert.deepEqual([(resets[0].meta as any).old_epoch, (resets[0].meta as any).new_epoch], ["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", "f1e2d3c4b5a69788f1e2d3c4b5a69788"]);
    // the old epoch still dedupes
    assert.equal((await h.post([ev(2)])).json.duplicates, 1);
    assert.equal((await h.post([ev(1), ev(1, { epoch: "f1e2d3c4b5a69788f1e2d3c4b5a69788" })])).status, 400);
    await h.srv.close(); h = await up(r);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.node.epoch_reset").length, 1);
    assert.equal((await h.post([ev(2, { epoch: "f1e2d3c4b5a69788f1e2d3c4b5a69788" })])).json.duplicates, 1);
    assert.equal((await h.get("/api/v3/health")).json.nodes.t4.epoch, "f1e2d3c4b5a69788f1e2d3c4b5a69788");
    assert.equal((await h.post([ev(3, { epoch: "BAD" })])).json.rejected[0].rule, "schema.epoch");
  } finally { await h.srv.close(); }
});

test("A1 bind: every spelling of the any-address is refused, specific addresses are fine", () => {
  for (const host of ["::ffff:0.0.0.0", "::0.0.0.0", "::ffff:0:0", "0:0:0:0:0:ffff:0:0", "[::ffff:0.0.0.0]", "::0", "0000:0000:0000:0000:0000:0000:0000:0000", "0.0.0.0", "::"]) {
    const r = rig(); r.cfg.listen = { host, port: 0 };
    assert.throws(() => new HubServer(r.cfg, r.clock), /wildcard/, host);
  }
  for (const host of ["127.0.0.1", "::1", cgnat(64, 1, 2), "fd7a:115c:a1e0::1", "::ffff:127.0.0.1"]) {
    const r = rig(); r.cfg.listen = { host, port: 0 };
    void new HubServer(r.cfg, r.clock).close();
  }
});

test("A1 reads: off loopback every endpoint needs node auth; on loopback only /since and /messages do", async () => {
  const r = rig(); const h = await up(r);
  try {
    for (const p of ["/api/v3/health", "/api/v3/agents", "/api/v3/lanes"]) assert.equal((await h.get(p)).status, 200);
    (r.cfg.listen as { host: string }).host = cgnat(64, 0, 9);
    for (const p of ["/api/v3/health", "/api/v3/agents", "/api/v3/lanes", "/api/v3/since", "/api/v3/messages"]) {
      assert.equal((await h.get(p)).status, 401, p);
      assert.equal((await h.get(p, true)).status, 200, p);
    }
  } finally { await h.srv.close(); }
});

test("PHI: ts must be strict ISO-8601; free text and lenient Date.parse forms are rejected", async () => {
  const r = rig(); const h = await up(r);
  try {
    const bad = ["Sun Oct 18 2026 9876543210", "2026-10-18", "2026-10-18 08:00:00", "1792310400000", "2026-10-18T08:00:00.123456Z", "Oct 18, 2026 08:00:00Z", "2026-10-18T08:00:00"];
    const res = await h.post(bad.map((ts, i) => ev(i + 1, { ts })));
    assert.equal(res.json.stored, 0);
    assert.ok(res.json.rejected.every((x: any) => x.rule === "schema.ts"), JSON.stringify(res.json.rejected));
    assert.equal((await h.post([ev(8, { ts: "2026-10-18T13:30:00.5+05:30" })])).json.stored, 1);
  } finally { await h.srv.close(); }
});

test("PHI: meta keys must be [a-z_][a-z0-9_]{0,40}; numbers over 9 digits are refused", async () => {
  const r = rig(); const h = await up(r);
  try {
    const keys = ["9876543210", "Upper", "has-dash", "a.b", "", "k".repeat(42), "jane_doe@x"];
    const res = await h.post(keys.map((k, i) => ev(i + 1, { meta: { [k]: 1 } })));
    assert.equal(res.json.stored, 0);
    assert.ok(res.json.rejected.every((x: any) => x.rule === "schema.meta_key"), JSON.stringify(res.json.rejected));
    const nums = await h.post([ev(8, { meta: { n: 999999999 } }), ev(9, { meta: { n: 1000000000 } }), ev(10, { meta: { n: -1234567890 } }), ev(11, { meta: { n: 0.123456789 } }), ev(12, { meta: { _k0: 1.5 } }), ev(13, { meta: { k: "k".repeat(41) } })]);
    assert.deepEqual(nums.json.rejected.map((x: any) => [x.seq, x.rule]), [[9, "meta.long_number"], [10, "meta.long_number"], [11, "meta.long_number"]]);
    assert.equal(nums.json.stored, 3);
    const p = await h.post([ev(14, { agent: { ...ev(1).agent, pid: 1234567890 } })]);
    assert.equal(p.json.rejected[0].rule, "schema.pid");
    assert.equal((await h.post([ev(1234567890)])).json.rejected[0].rule, "schema.seq");
  } finally { await h.srv.close(); }
});

test("alerts: agent.seen carrying errored alerts once; the following agent.state errored does not repeat", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1, { kind: "agent.seen", state: "stalled", reason: "no_output_10m" }), ev(2, { state: "stalled" }), ev(3, { kind: "agent.seen", state: "errored", reason: "auth" })]);
    assert.deepEqual(alerts(h).map((m) => m.body).sort(), ["agent=lead@t4 lane=bc-s6 state=errored rule=auth", "agent=lead@t4 lane=bc-s6 state=stalled rule=no_output_10m"]);
  } finally { await h.srv.close(); }
});

test("alerts: a failed send is recorded with its source event id and retried at startup; sent rows name the source", async () => {
  const r = rig(); writeFileSync(r.cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "ehrc-kiosk1" }));
  let h = await up(r);
  try {
    await h.post([ev(1, { state: "errored", reason: "auth" })]);
    const src = h.srv.hub.log.all().find((x) => x.kind === "hub.ev.agent.state")!.id;
    let failed = h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.failed");
    assert.equal(failed.length, 1);
    assert.equal((failed[0].meta as any).source_event, src);
    assert.equal(alerts(h).length, 0);
    // later batches do not retry (no flood) ...
    await h.post([ev(2, { state: "errored", reason: "auth" }), hb(3)]);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.failed").length, 1);
    // ... the owner is fixed and the next startup sends it
    await h.srv.close();
    writeFileSync(r.cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "newcat-orch" }));
    h = await up(r);
    assert.equal(alerts(h).length, 1);
    const sent = h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.sent");
    assert.equal(sent.length, 1);
    assert.equal((sent[0].meta as any).source_event, src);
    assert.equal((sent[0].meta as any).message_id, alerts(h)[0].id);
    await h.srv.close(); h = await up(r);
    assert.equal(alerts(h).length, 1, "restart must not resend");
  } finally { await h.srv.close(); }
});

test("alerts: a crash between event and alert (no outcome row) is repaired at startup; unowned lanes are skipped once", async () => {
  const r = rig(); let h = await up(r);
  await h.post([ev(1, { state: "errored", reason: "auth", agent: { ...ev(1).agent, lane: "no-owner", id: "z@t4" } })]);
  assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.skipped").length, 1);
  await h.srv.close();
  // simulate the crash: store the event without running the alert flush
  const srv = new HubServer(r.cfg, r.clock);
  const orig = (srv as any).flushAlerts;
  (srv as any).flushAlerts = () => undefined;
  srv.ingest("t4", [ev(2, { state: "errored", reason: "auth" })], "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6");
  (srv as any).flushAlerts = orig;
  await srv.close();
  h = await up(r);
  try {
    assert.equal(alerts(h).length, 1);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.skipped").length, 1);
  } finally { await h.srv.close(); }
});

test("mutants: /since limit is capped at 1000 rows", async () => {
  const r = rig(); const h = await up(r);
  try {
    for (const from of [1, 501, 1001]) await h.post(Array.from({ length: 500 }, (_, i) => hb(from + i)));
    assert.equal((await h.get("/api/v3/since?cursor=0&limit=99999", true)).json.events.length, 1000);
    assert.equal((await h.get("/api/v3/since?cursor=0", true)).json.events.length, 1000);
    assert.equal((await h.get("/api/v3/since?cursor=1400&limit=1000", true)).json.events.length, h.srv.hub.log.count() - 1400);
  } finally { await h.srv.close(); }
});

test("mutants: lane.done marks the agent finished and the lane finished", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1), hb(2), ev(3, { kind: "lane.done", state: null })]);
    const a = (await h.get("/api/v3/agents")).json.agents[0];
    assert.equal(a.state, "finished");
    assert.equal((await h.get("/api/v3/lanes?state=finished")).json.lanes.length, 1);
    assert.equal((await h.get("/api/v3/lanes?state=working")).json.lanes.length, 0);
  } finally { await h.srv.close(); }
});

test("R3 boot: a request stamped before (or at) hub boot is refused, even with an unused nonce", async () => {
  const r = rig(); const h = await up(r);
  try {
    const boot = r.clock.now() - 1;
    assert.equal((await h.post([hb(1)], { ts: new Date(boot).toISOString() })).status, 401);
    assert.equal((await h.post([hb(1)], { ts: new Date(boot - 1000).toISOString() })).status, 401);
    assert.equal((await h.post([hb(1)], { ts: new Date(boot + 1).toISOString() })).status, 200);
  } finally { await h.srv.close(); }
});

test("R3 rejected rows: an out-of-cap seq never reaches the log; epoch must be 32 hex with a letter", async () => {
  const r = rig(); const h = await up(r);
  try {
    const rules = [(await h.post([ev(1234567890)])).json.rejected[0].rule];
    for (const epoch of ["12345678901234567890123456789012", "ABCDEF0123456789ABCDEF0123456789", "abc"]) rules.push((await h.post([ev(2, { epoch })])).json.rejected[0].rule);
    assert.deepEqual(rules, ["schema.seq", "schema.epoch", "schema.epoch", "schema.epoch"]);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.ev.rejected").length, 0);
    assert.ok(!JSON.stringify(h.srv.hub.log.all()).includes("1234567890"));
  } finally { await h.srv.close(); }
});

test("R3 nonce cap: at the cap new nonces get 503 and nothing in-window is evicted", async () => {
  const { NonceCache } = await import("../src/v3/hub/auth.js");
  const c = new NonceCache();
  for (let i = 0; i < 20_000; i++) assert.equal(c.take("t4", i.toString(16).padStart(32, "0"), i), true);
  assert.equal(c.full("t4", 30_000), true);
  assert.equal(c.take("t4", "f".repeat(32), 30_000), false);
  assert.equal(c.has("t4", "0".repeat(32), 30_000), true);
  assert.equal(c.full("t4", 600_001 + 100), false, "expired nonces free the room");
  assert.equal(c.full("mini", 0), false);
});

test("R4 an over-long seq is not echoed back and leaves no row; forward skew boundary is 5 s", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = await h.post([ev(9876543210), ev(1)]);
    assert.deepEqual(res.json.rejected, [{ seq: null, rule: "schema.seq" }]);
    assert.ok(!JSON.stringify(res.json).includes("9876543210"));
    r.clock.advance(400_000);
    assert.equal((await h.post([ev(2)], { skewMs: 5_000 })).status, 200);
    assert.equal((await h.post([ev(3)], { skewMs: 5_001 })).status, 401);
    assert.equal((await h.post([ev(3)], { skewMs: -300_000 })).status, 200);
    assert.equal((await h.post([ev(4)], { skewMs: -300_001 })).status, 401);
  } finally { await h.srv.close(); }
});

test("R4 boot floor includes the forward-skew window: nothing stamped up to boot+5 s is accepted", async () => {
  const r = rig(); const srv = new HubServer(r.cfg, r.clock);
  const boot = r.clock.now();
  await srv.close();
  const { authenticate, NonceCache } = await import("../src/v3/hub/auth.js");
  const { signA1 } = await import("./v3-hub-helpers.js");
  const check = (offset: number) => {
    const ts = new Date(boot + offset).toISOString(); const nonce = "ab".repeat(16);
    return authenticate(r.cfg.keyDir, { method: "GET", pathQuery: "/x", authorization: `Node t4:${signA1("t4-secret-key", "GET", "/x", ts, nonce, "")}`, ts, nonce, body: Buffer.alloc(0) }, boot + 6_000, new NonceCache(), boot);
  };
  assert.deepEqual(check(5_000), { ok: false, status: 401, reason: "before_boot" });
  assert.deepEqual(check(5_001), { ok: true, node: "t4" });
});

test("R5 a bad epoch is never echoed: the response carries null and the rule id only", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = await h.post([ev(1, { epoch: "a9876543210" + "b".repeat(21) })]);
    assert.equal(res.json.epoch, null);
    assert.deepEqual(res.json.rejected, [{ seq: 1, rule: "schema.epoch" }]);
    assert.ok(!JSON.stringify(res.json).includes("9876543210"));
    const mixed = await h.post([ev(1, { epoch: "a9876543210" + "b".repeat(21) }), ev(2)]);
    assert.equal(mixed.status, 400);
    assert.ok(!JSON.stringify(mixed.json).includes("9876543210"));
  } finally { await h.srv.close(); }
});

test("R6 a batch that makes ingest throw answers 400 bad_batch with no detail, and the hub keeps serving", async () => {
  const r = rig(); const h = await up(r);
  try {
    const real = h.srv.ingest.bind(h.srv);
    (h.srv as any).ingest = () => { throw new Error("boom 9876543210"); };
    const res = await h.post([ev(1)]);
    assert.deepEqual([res.status, res.json], [400, { ok: false, error: "bad_batch" }]);
    (h.srv as any).ingest = real;
    assert.equal((await h.post([ev(1)])).json.stored, 1);
    // hostile shapes never throw out of the handler
    for (const events of [[null], [1], ["x"], [[]], [{ node: "t4", seq: { toString: 1 } }]]) assert.ok([200, 400, 403].includes((await h.post(events as unknown[])).status));
    // ingest() itself never hands on an unvalidated epoch
    assert.equal(h.srv.ingest("t4", [], "a9876543210" + "b".repeat(21)).epoch, null);
  } finally { await h.srv.close(); }
});
