// oref3 (Opus 5.5 refuter, R3 @6d22cfa): adversarial probes. Y1/Y2 document residual holes (expected to show the hole).
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { alerts, cleanupAfter, ev, hb, KEYS, rig, up } from "./v3-hub-helpers.js";

cleanupAfter();
const a1 = (k: string, m: string, p: string, ts: string, n: string, b: string) =>
  createHmac("sha256", k).update([m, p, ts, n, createHash("sha256").update(b).digest("hex")].join("\n")).digest("hex");
const E = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";

test("Y1 forward skew is capped: a GET stamped +200 s is refused, and a +4 s one captured before a quick restart cannot replay", async () => {
  const r = rig(); let h = await up(r);
  try {
    const n = randomBytes(16).toString("hex"); const p = "/api/v3/since?cursor=0";
    const far = new Date(r.clock.now() + 200_000).toISOString();
    assert.equal((await fetch(h.base + p, { headers: { authorization: `Node t4:${a1(KEYS.t4, "GET", p, far, n, "")}`, "x-ubus-ts": far, "x-ubus-nonce": n } })).status, 401);
    const ts = new Date(r.clock.now() + 4_000).toISOString(); const n2 = randomBytes(16).toString("hex");
    const headers = { authorization: `Node t4:${a1(KEYS.t4, "GET", p, ts, n2, "")}`, "x-ubus-ts": ts, "x-ubus-nonce": n2 };
    assert.equal((await fetch(h.base + p, { headers })).status, 200);
    await h.srv.close(); r.clock.advance(1_000); h = await up(r); // restart well inside the forward-skew window
    assert.equal((await fetch(h.base + p, { headers })).status, 401, "replay across a quick restart");
  } finally { await h.srv.close(); }
});

test("Y2 epoch with a run of 7+ digits is refused and never reaches the log; 6-digit runs are fine", async () => {
  const r = rig(); const h = await up(r);
  try {
    const bad = "a9876543210" + "b".repeat(21);
    assert.equal((await h.post([ev(1, { epoch: bad })])).json.rejected[0].rule, "schema.epoch");
    assert.ok(!JSON.stringify(h.srv.hub.log.all()).includes("9876543210"));
    assert.equal((await h.post([ev(1, { epoch: "a123456" + "b".repeat(25) })])).json.stored, 1);
    assert.equal((await h.post([ev(2, { epoch: "a1234567" + "b".repeat(24) })])).json.rejected[0].rule, "schema.epoch");
  } finally { await h.srv.close(); }
});

test("Y3 HTTP nonce cap: valid new request 503 stores nothing, does not burn nonce; forged 401; replay 401", async () => {
  const r = rig(); const h = await up(r);
  try {
    const c = (h.srv as any).nonces; const now = r.clock.now();
    const n0 = randomBytes(16).toString("hex");
    assert.equal((await h.post([hb(1)], { nonce: n0 })).status, 200);
    for (let i = 0; i < 19_999; i++) c.take("t4", ("e" + i.toString(16)).padStart(32, "0"), now);
    const base = h.srv.hub.log.count();
    const n1 = randomBytes(16).toString("hex");
    const full = await h.post([hb(2)], { nonce: n1 });
    assert.deepEqual([full.status, full.json.error], [503, "nonce_cache_full"]);
    assert.equal(h.srv.hub.log.count(), base);
    assert.equal(c.has("t4", n1, now), false, "503 burnt the nonce");
    assert.equal((await h.post([hb(2)], { key: "wrong" })).status, 401);
    const rep = await h.post([hb(2)], { nonce: n0 });
    assert.deepEqual([rep.status, rep.json.error], [401, "nonce_replay"]);
    assert.equal((await h.post([hb(2)], { node: "mini" })).status !== 503, true, "cap is per node");
    r.clock.advance(600_001);
    assert.equal((await h.post([hb(2)])).status, 200, "expired nonces free room");
  } finally { await h.srv.close(); }
});

test("Y4 seq 999999999 stored; 1000000000 and bad epoch store no row; 32-digit/upper/31/33 epochs refused", async () => {
  const r = rig(); const h = await up(r);
  try {
    assert.equal((await h.post([ev(999_999_999)])).json.stored, 1);
    const before = h.srv.hub.log.count();
    assert.equal((await h.post([ev(1_000_000_000)])).json.rejected[0].rule, "schema.seq");
    for (const epoch of ["1".repeat(32), "A".repeat(32), "a".repeat(31), "a".repeat(33), "g".repeat(32), " " + "a".repeat(31)])
      assert.equal((await h.post([ev(5, { epoch })])).json.rejected[0].rule, "schema.epoch", epoch);
    assert.equal(h.srv.hub.log.count(), before);
    assert.equal((await h.post([ev(2, { epoch: "a".repeat(32) })])).json.stored, 1);
  } finally { await h.srv.close(); }
});

test("Y5 alerts exactly-once: crash after send repaired by the next ingest flush too, and across 2 restarts", async () => {
  const r = rig(); let h = await up(r);
  try {
    const srv = h.srv as any; const store = srv.store.bind(srv);
    srv.store = (node: string, kind: string, ...rest: unknown[]) => (kind === "hub.alert.sent" ? 0 : store(node, kind, ...rest));
    await h.post([ev(1, { state: "errored", reason: "auth" })]);
    srv.store = store;
    await h.post([hb(2)]);
    assert.equal(alerts(h).length, 1);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.sent").length, 1, "repair row written");
    await h.srv.close(); h = await up(r); await h.srv.close(); h = await up(r);
    assert.equal(alerts(h).length, 1);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.sent").length, 1);
    assert.equal(alerts(h)[0].threadId, `alert-${(h.srv.hub.log.all().find((x) => x.kind === "hub.alert.sent")!.meta as any).source_event}`);
  } finally { await h.srv.close(); }
});

test("Y6 alerts: failed send then restart sends exactly one; a second transition sends a second", async () => {
  const r = rig(); let h = await up(r);
  try {
    writeFileSync(r.cfg.laneOwnersPath, "{broken");
    await h.post([ev(1, { state: "errored", reason: "auth" })]);
    assert.equal(alerts(h).length, 0);
    writeFileSync(r.cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "owner-x" }));
    await h.srv.close(); h = await up(r);
    assert.equal(alerts(h).length, 1);
    await h.post([ev(2, { state: "working" }), ev(3, { state: "stalled" })]);
    assert.equal(alerts(h).length, 2);
    await h.srv.close(); h = await up(r);
    assert.equal(alerts(h).length, 2);
  } finally { await h.srv.close(); }
});

test("Y7 boot floor: ts == boot refused on GET /since; loopback /health unauth unchanged; flag off still throws", async () => {
  const r = rig(); const h = await up(r);
  try {
    const boot = r.clock.now() - 1;
    const g = await h.raw("GET", "/api/v3/since?cursor=0", "", { ts: new Date(boot).toISOString() });
    assert.deepEqual([g.status, g.json.error], [401, "before_boot"]);
    assert.equal((await h.get("/api/v3/health")).status, 200);
    const prev = process.env.UBUS_V3; delete process.env.UBUS_V3;
    try { const { HubServer } = await import("../src/v3/hub/server.js"); assert.throws(() => new HubServer(r.cfg, r.clock), /UBUS_V3/); }
    finally { process.env.UBUS_V3 = prev; }
  } finally { await h.srv.close(); }
});
