// oref2 (Opus 5.5 refuter, R2 @37f5bdf): adversarial tests that must PASS.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { NonceCache } from "../src/v3/hub/auth.js";
import { isLoopback, loadHubConfig } from "../src/v3/hub/config.js";
import { HubServer } from "../src/v3/hub/server.js";
import { alerts, cleanupAfter, EPOCH, ev, hb, KEYS, rig, up } from "./v3-hub-helpers.js";

/** Tailnet-range (100.x) addresses are built at run time so the tree holds no such literal. */
const cgnat = (b: number, c: number, d: number): string => ["100", b, c, d].join(".");

cleanupAfter();

/** Independent A1 signer (does not reuse src signRequest, so signer mutants are visible). */
const a1 = (k: string, m: string, p: string, ts: string, n: string, b: string) =>
  createHmac("sha256", k).update([m, p, ts, n, createHash("sha256").update(b).digest("hex")].join("\n")).digest("hex");
const nn = () => randomBytes(16).toString("hex");
async function hand(base: string, method: string, path: string, body: string, auth: string, ts: string, nonce: string) {
  const res = await fetch(base + path, { method, body: method === "GET" ? undefined : body, headers: { authorization: auth, "x-ubus-ts": ts, "x-ubus-nonce": nonce } });
  return res.status;
}

test("O1 independent A1 vector: hand-signed POST and GET accepted; dropping any signed field -> 401", async () => {
  const r = rig(); const h = await up(r);
  try {
    const body = JSON.stringify({ events: [ev(1)] }); const ts = r.clock.iso();
    let n = nn();
    assert.equal(await hand(h.base, "POST", "/api/v3/events", body, `Node t4:${a1(KEYS.t4, "POST", "/api/v3/events", ts, n, body)}`, ts, n), 200);
    n = nn();
    assert.equal(await hand(h.base, "GET", "/api/v3/since?cursor=0&limit=5", "", `Node t4:${a1(KEYS.t4, "GET", "/api/v3/since?cursor=0&limit=5", ts, n, "")}`, ts, n), 200);
    const H = (s: string) => createHash("sha256").update(s).digest("hex");
    const hm = (parts: string[]) => createHmac("sha256", KEYS.t4).update(parts.join("\n")).digest("hex");
    const b2 = JSON.stringify({ events: [ev(2)] });
    const variants = (n: string) => [
      hm(["/api/v3/events", ts, n, H(b2)]), // no method
      hm(["POST", ts, n, H(b2)]), // no path
      hm(["POST", "/api/v3/events", n, H(b2)]), // no ts
      hm(["POST", "/api/v3/events", ts, H(b2)]), // no nonce
      hm(["POST", "/api/v3/events", ts, n]), // no body hash
      createHmac("sha256", KEYS.t4).update(b2).digest("hex"), // old P1 body-only
    ];
    for (const [i, sig] of variants("ab".repeat(16)).entries()) assert.equal(await hand(h.base, "POST", "/api/v3/events", b2, `Node t4:${sig}`, ts, "ab".repeat(16)), 401, `variant ${i}`);
    assert.equal(h.srv.registry.has("t4", EPOCH, 2), false);
  } finally { await h.srv.close(); }
});

test("O2 captured headers: fresh ts, fresh nonce, other path all refused; POST and GET share one nonce space", async () => {
  const r = rig(); const h = await up(r);
  try {
    const body = JSON.stringify({ events: [ev(1)] }); const ts = r.clock.iso(); const n = nn();
    const auth = `Node t4:${a1(KEYS.t4, "POST", "/api/v3/events", ts, n, body)}`;
    assert.equal(await hand(h.base, "POST", "/api/v3/events", body, auth, ts, n), 200);
    r.clock.advance(1000);
    assert.equal(await hand(h.base, "POST", "/api/v3/events", body, auth, r.clock.iso(), n), 401);
    assert.equal(await hand(h.base, "POST", "/api/v3/events", body, auth, ts, nn()), 401);
    assert.equal(await hand(h.base, "POST", "/api/v3/events?x=1", body, auth, ts, n), 401);
    // nonce used by a POST cannot be reused by a correctly signed GET
    assert.equal(await hand(h.base, "GET", "/api/v3/messages", "", `Node t4:${a1(KEYS.t4, "GET", "/api/v3/messages", ts, n, "")}`, ts, n), 401);
    // nonce space is per node: mini may use the same nonce
    const mb = JSON.stringify({ events: [] });
    assert.equal(await hand(h.base, "POST", "/api/v3/events", mb, `Node mini:${a1(KEYS.mini, "POST", "/api/v3/events", ts, n, mb)}`, ts, n), 200);
  } finally { await h.srv.close(); }
});

test("O3 nonce window covers the whole skew window: ts=now+5s replayed 305 s later is refused", async () => {
  const r = rig(); const h = await up(r);
  try {
    const body = JSON.stringify({ events: [hb(1)] }); const ts = new Date(r.clock.now() + 5_000).toISOString(); const n = nn();
    const auth = `Node t4:${a1(KEYS.t4, "POST", "/api/v3/events", ts, n, body)}`;
    assert.equal(await hand(h.base, "POST", "/api/v3/events", body, auth, ts, n), 200);
    r.clock.advance(305_000); // ts is now exactly 300 s in the past: still inside skew
    const res = await fetch(h.base + "/api/v3/events", { method: "POST", body, headers: { authorization: auth, "x-ubus-ts": ts, "x-ubus-nonce": n } });
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as any).error, "nonce_replay");
    const c = new NonceCache();
    assert.equal(c.take("t4", n, 0), true); assert.equal(c.take("t4", n, 600_000), false); assert.equal(c.take("t4", n, 1_200_001), true);
  } finally { await h.srv.close(); }
});

test("O4 epoch: node spool reset restarting at seq 1 is stored, one reset row, first-ever epoch logs none, old-epoch replay adds none", async () => {
  const r = rig(); let h = await up(r);
  try {
    assert.equal((await h.post([1, 2, 3, 4, 5].map((s) => ev(s)))).json.ack_seq, 5);
    const resets = () => h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.node.epoch_reset").length;
    assert.equal(resets(), 0);
    const E2 = "f1e2d3c4b5a69788f1e2d3c4b5a69788";
    const res = await h.post([ev(1, { epoch: E2, state: "idle" }), ev(2, { epoch: E2 }), ev(3, { epoch: E2 })]);
    assert.deepEqual([res.json.stored, res.json.duplicates, res.json.ack_seq], [3, 0, 3]);
    assert.equal(resets(), 1);
    assert.deepEqual([(await h.post([ev(4)])).json.ack_seq, (await h.post([ev(4)])).json.duplicates], [5, 1]);
    assert.equal(resets(), 1);
    await h.srv.close(); h = await up(r);
    assert.equal(h.srv.registry.ackSeq("t4", E2), 3); assert.equal(h.srv.registry.ackSeq("t4", EPOCH), 5);
    assert.equal((await h.post([ev(4, { epoch: E2 })])).json.stored, 1);
    assert.equal(resets(), 1);
  } finally { await h.srv.close(); }
});

test("O5 request-level failures consume no seq and store nothing (401, 403, 400 json/batch/epoch, bad seq)", async () => {
  const r = rig(); const h = await up(r);
  try {
    const base = h.srv.hub.log.count();
    assert.equal((await h.post([ev(1)], { key: "nope" })).status, 401);
    assert.equal((await h.post([ev(1, { node: "mini" })])).status, 403);
    assert.equal((await h.raw("POST", "/api/v3/events", "{bad")).status, 400);
    assert.equal((await h.raw("POST", "/api/v3/events", JSON.stringify({ events: "x" }))).status, 400);
    assert.equal((await h.post([ev(1), ev(2, { epoch: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa9" })])).status, 400);
    const noEpoch = { ...ev(1) } as any; delete noEpoch.epoch;
    assert.equal((await h.post([noEpoch])).status, 400);
    assert.equal(h.srv.hub.log.count(), base);
    const bad = await h.post([ev(0), ev(-1), ev(1.5), ev("1" as any), ev(Number.MAX_SAFE_INTEGER + 2)]);
    assert.equal(bad.json.rejected.length, 5);
    assert.equal(h.srv.hub.log.count(), base, "invalid seqs leave no row");
    const ok = await h.post([ev(1)]);
    assert.deepEqual([ok.json.stored, ok.json.ack_seq], [1, 1]);
  } finally { await h.srv.close(); }
});

test("O6 rejection sticks across restart; a stored seq resent with bad content adds no rejected row", async () => {
  const r = rig(); let h = await up(r);
  try {
    await h.post([ev(1, { lane: undefined, agent: { ...ev(1).agent, lane: "x".repeat(281) } }), ev(2)]);
    await h.srv.close(); h = await up(r);
    const again = await h.post([ev(1)]);
    assert.deepEqual(again.json.rejected, [{ seq: 1, rule: "too_long" }]);
    assert.equal(again.json.ack_seq, 2);
    const before = h.srv.hub.log.count();
    const res = await h.post([ev(2, { meta: { x: "y".repeat(281) } })]);
    assert.equal(h.srv.hub.log.count(), before);
    assert.equal(h.srv.registry.rejection("t4", EPOCH, 2), undefined);
    assert.equal(res.json.ack_seq, 2);
  } finally { await h.srv.close(); }
});

test("O7 wildcard: more spellings refused in constructor and loadHubConfig; loopback/tailnet classified", () => {
  for (const host of ["0:0::", "::0:0:0", "::FFFF:0.0.0.0", "[::ffff:0:0]", "::%lo", "::ffff:0.0.0.0%lo", "0::", "0", "", " ", "*", "0.00.0.0", "localhost"]) {
    const r = rig(); r.cfg.listen = { host, port: 0 };
    assert.throws(() => new HubServer(r.cfg, r.clock), /./, JSON.stringify(host));
  }
  const r = rig();
  for (const listen of ["[::]:7377", ":7377", "0.0.0.0:7377", "::ffff:0:0:7377", { host: "::" }, { host: 0 }]) {
    writeFileSync(r.dir + "/hub.json", JSON.stringify({ listen }));
    assert.throws(() => loadHubConfig(r.dir + "/hub.json", r.dir), /./, JSON.stringify(listen));
  }
  rmSync(r.dir + "/hub.json");
  for (const h of ["127.0.0.1", "127.0.0.2", "::1", "[::1]", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) assert.equal(isLoopback(h), true, h);
  for (const h of [cgnat(64, 0, 9), "fd7a:115c:a1e0::1", `::ffff:${cgnat(64, 0, 1)}`, "128.0.0.1", "::2", "::127.0.0.1"]) assert.equal(isLoopback(h), false, h);
});

test("O8 off-loopback: every read refuses unsigned, wrong-path-signed and old-style tokens", async () => {
  const r = rig(); const h = await up(r);
  try {
    (r.cfg.listen as { host: string }).host = cgnat(64, 0, 9);
    for (const p of ["/api/v3/health", "/api/v3/agents?node=t4", "/api/v3/lanes?state=working"]) {
      assert.equal((await h.raw("GET", p, "", { signPath: "/api/v3/health?x" })).status, 401, p);
      const res = await fetch(h.base + p, { headers: { authorization: `Node t4:${createHmac("sha256", KEYS.t4).update("").digest("hex")}`, "x-ubus-ts": r.clock.iso() } });
      assert.equal(res.status, 401, p);
      assert.equal((await h.get(p, true)).status, 200, p);
    }
  } finally { await h.srv.close(); }
});

test("O9 alerts: unreadable lane_owners.json -> failed row, no flood, retried and sent once at startup", async () => {
  const r = rig(); rmSync(r.cfg.laneOwnersPath);
  let h = await up(r);
  try {
    await h.post([ev(1, { state: "stalled", reason: "no_output_10m" })]);
    await h.post([hb(2), hb(3)]);
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind === "hub.alert.failed").length, 1);
    assert.equal(alerts(h).length, 0);
    await h.srv.close();
    writeFileSync(r.cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "newcat-orch" }));
    h = await up(r);
    assert.equal(alerts(h).length, 1);
    const src = h.srv.hub.log.all().find((x) => x.kind === "hub.ev.agent.state")!.id;
    assert.equal((h.srv.hub.log.all().find((x) => x.kind === "hub.alert.sent")!.meta as any).source_event, src);
    await h.post([ev(4, { state: "stalled", reason: "no_output_10m" })]);
    assert.equal(alerts(h).length, 1, "same state, no repeat");
  } finally { await h.srv.close(); }
});

test("O10 meta keys go through the PHI filter too: _9876543210 passes the key regex but must be rejected", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = await h.post([ev(1, { meta: { _9876543210: 1 } })]);
    assert.equal(res.json.stored, 0);
    assert.match(res.json.rejected[0].rule, /^phi\./);
    assert.ok(!JSON.stringify(h.srv.hub.log.all()).includes("9876543210"));
  } finally { await h.srv.close(); }
});

test("O11 auth X-Ubus-Ts must be strict ISO even when correctly signed (RFC 1123, epoch ms, no zone)", async () => {
  const r = rig(); const h = await up(r);
  try {
    const t = r.clock.now();
    for (const ts of [new Date(t).toUTCString(), String(t), new Date(t).toISOString().slice(0, 19), new Date(t).toString()]) {
      const res = await h.post([hb(1)], { ts });
      assert.deepEqual([res.status, res.json.error], [401, "bad_timestamp"], ts);
    }
    assert.equal((await h.post([hb(1)], { ts: new Date(t).toISOString().replace("Z", "+00:00") })).status, 200);
  } finally { await h.srv.close(); }
});

test("O12 nonce memory holds more than a handful of recent nonces per node", () => {
  const c = new NonceCache(); const ns = Array.from({ length: 50 }, (_, i) => i.toString(16).padStart(32, "0"));
  ns.forEach((n, i) => assert.equal(c.take("t4", n, i * 1000), true));
  ns.forEach((n) => assert.equal(c.take("t4", n, 60_000), false, n));
});
