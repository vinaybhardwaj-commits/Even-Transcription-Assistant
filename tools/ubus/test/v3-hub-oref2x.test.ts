// oref2 (Opus 5.5 refuter, R2 @37f5bdf): defect probes. Each FAILS on 37f5bdf on purpose.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { NonceCache } from "../src/v3/hub/auth.js";
import { alerts, cleanupAfter, ev, KEYS, rig, up } from "./v3-hub-helpers.js";

cleanupAfter();

const a1 = (k: string, m: string, p: string, ts: string, n: string, b: string) =>
  createHmac("sha256", k).update([m, p, ts, n, createHash("sha256").update(b).digest("hex")].join("\n")).digest("hex");

test("X1 captured GET /since replayed after a hub restart (inside 300 s) must be refused", async () => {
  const r = rig(); let h = await up(r);
  try {
    const ts = r.clock.iso(); const n = randomBytes(16).toString("hex"); const p = "/api/v3/since?cursor=0";
    const headers = { authorization: `Node t4:${a1(KEYS.t4, "GET", p, ts, n, "")}`, "x-ubus-ts": ts, "x-ubus-nonce": n };
    assert.equal((await fetch(h.base + p, { headers })).status, 200);
    await h.srv.close(); r.clock.advance(5_000); h = await up(r);
    assert.equal((await fetch(h.base + p, { headers })).status, 401, "nonce memory lost on restart");
  } finally { await h.srv.close(); }
});

test("X2 captured POST replayed after a hub restart must be refused at auth (not just deduped)", async () => {
  const r = rig(); let h = await up(r);
  try {
    const body = JSON.stringify({ events: [ev(1)] }); const ts = r.clock.iso(); const n = randomBytes(16).toString("hex");
    const init = { method: "POST", body, headers: { authorization: `Node t4:${a1(KEYS.t4, "POST", "/api/v3/events", ts, n, body)}`, "x-ubus-ts": ts, "x-ubus-nonce": n } };
    assert.equal((await fetch(h.base + "/api/v3/events", init)).status, 200);
    await h.srv.close(); h = await up(r);
    assert.equal((await fetch(h.base + "/api/v3/events", init)).status, 401);
  } finally { await h.srv.close(); }
});

test("X3 epoch is a string on the wire but bypasses the PHI filter: digits-only (phone-shaped) epoch is stored", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1, { epoch: "9876543210" })]);
    assert.ok(!JSON.stringify(h.srv.hub.log.all()).includes("9876543210"), "phone-shaped epoch stored in the log");
  } finally { await h.srv.close(); }
});

test("X4 a 10-digit seq is rejected (schema.seq) but the digit run is still written into the rejected row", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = await h.post([ev(9876543210)]);
    assert.equal(res.json.rejected[0].rule, "schema.seq");
    assert.ok(!JSON.stringify(h.srv.hub.log.all()).includes("9876543210"), "UHID/phone-shaped seq stored in hub.ev.rejected meta/subject");
  } finally { await h.srv.close(); }
});

test("X5 crash after the alert message is stored but before hub.alert.sent: restart must not alert twice", async () => {
  const r = rig(); let h = await up(r);
  try {
    const srv = h.srv as any; const store = srv.store.bind(srv);
    srv.store = (node: string, kind: string, ...rest: unknown[]) => (kind === "hub.alert.sent" ? 0 : store(node, kind, ...rest)); // process dies here
    await h.post([ev(1, { state: "errored", reason: "auth" })]);
    assert.equal(alerts(h).length, 1);
    await h.srv.close(); h = await up(r);
    assert.equal(alerts(h).length, 1, "duplicate alert after crash (at-least-once, not one transaction)");
  } finally { await h.srv.close(); }
});

test("X6 nonce cache cap evicts in-window nonces: a node busy for 600 s re-opens replay of its oldest request", () => {
  const c = new NonceCache(); const first = "0".repeat(32);
  c.take("t4", first, 0);
  for (let i = 1; i <= 20_000; i++) c.take("t4", i.toString(16).padStart(32, "0"), i * 25);
  assert.equal(c.take("t4", first, 500_001), false, "first nonce (still inside 600 s) accepted again");
});
