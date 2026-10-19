import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HubServer } from "../src/v3/hub/server.js";
import { alerts, cleanupAfter, ev, hb, KEYS, rig, up } from "./v3-hub-helpers.js";

cleanupAfter();

test("F1 captured POST replayed 1 h later (fresh clock, same nonce/sig) must be refused", async () => {
  const r = rig(); const h = await up(r);
  try {
    const body = JSON.stringify({ events: [ev(1)] });
    const ts = r.clock.iso(); const nonce = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    assert.equal((await h.raw("POST", "/api/v3/events", body, { ts, nonce })).status, 200);
    // same nonce inside the window: replay
    assert.equal((await h.raw("POST", "/api/v3/events", body, { ts, nonce })).status, 401);
    // an hour later the old ts is outside the skew window, and a fresh ts cannot be forged (sig covers ts)
    r.clock.advance(3_600_000);
    assert.equal((await h.raw("POST", "/api/v3/events", body, { ts, nonce })).status, 401);
    assert.equal((await h.raw("POST", "/api/v3/events", body, { signBody: body, ts: r.clock.iso(), nonce, key: "wrong" })).status, 401);
  } finally { await h.srv.close(); }
});

test("F2 a GET token is bound to ts/nonce/path: reuse and re-timestamping fail", async () => {
  const r = rig(); const h = await up(r);
  try {
    const ts = r.clock.iso(); const nonce = "f1e2d3c4b5a69788f1e2d3c4b5a69788";
    assert.equal((await h.raw("GET", "/api/v3/messages", "", { ts, nonce })).status, 200);
    assert.equal((await h.raw("GET", "/api/v3/messages", "", { ts, nonce })).status, 401);
    assert.equal((await h.raw("GET", "/api/v3/since?cursor=0", "", { signPath: "/api/v3/messages" })).status, 401);
    r.clock.advance(3 * 86_400_000);
    assert.equal((await h.raw("GET", "/api/v3/messages", "", { ts, nonce: "00112233445566778899aabbccddeeff" })).status, 401);
  } finally { await h.srv.close(); }
});

test("F3 phone-like digits in ts (Date.parse is lenient) must be rejected", async () => {
  const r = rig(); const h = await up(r);
  try { assert.equal((await h.post([ev(1, { ts: "Sun Oct 18 2026 9876543210" })])).json.stored, 0); } finally { await h.srv.close(); }
});

test("F4 phone-like meta key must be rejected", async () => {
  const r = rig(); const h = await up(r);
  try { assert.equal((await h.post([ev(1, { meta: { "9876543210": 1 } })])).json.stored, 0); } finally { await h.srv.close(); }
});

test("F5 long-digit numeric meta value (UHID-like) must be rejected", async () => {
  const r = rig(); const h = await up(r);
  try { assert.equal((await h.post([ev(1, { meta: { id: 9876543210 } })])).json.stored, 0); } finally { await h.srv.close(); }
});

test("F6 errored first seen via agent.seen then agent.state errored still alerts once", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1, { kind: "agent.seen", state: "errored", reason: "rate_limit" }), ev(2, { state: "errored", reason: "rate_limit" })]);
    assert.equal(h.srv.hub.messages.snapshot().messages.filter((m) => m.kind === "alert").length, 1);
  } finally { await h.srv.close(); }
});

test("F7 alert to a denied/unsendable owner leaves a trace (not silently dropped)", async () => {
  const r = rig(); writeFileSync(r.cfg.laneOwnersPath, JSON.stringify({ "bc-s6": "ehrc-kiosk1" }));
  const h = await up(r);
  try {
    await h.post([ev(1, { state: "errored", reason: "auth" })]);
    const trace = h.srv.hub.log.all().filter((x) => /alert/.test(x.kind) && !x.kind.startsWith("hub.ev."));
    assert.ok(trace.length > 0, "no alert and no alert-failure row");
  } finally { await h.srv.close(); }
});

test("F8 a seq consumed by a rejection answers with that rejection again, not a duplicate", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1, { meta: { x: "y".repeat(281) } })]);
    const res = await h.post([ev(1)]);
    assert.deepEqual(res.json.rejected, [{ seq: 1, rule: "too_long" }]);
    assert.equal(res.json.duplicates, 0);
    assert.equal(res.json.stored, 0);
    const again = await h.post([ev(2)]);
    assert.equal(again.json.stored, 1);
    assert.equal(again.json.ack_seq, 2);
  } finally { await h.srv.close(); }
});

for (const host of ["::ffff:0.0.0.0", "::0.0.0.0", "::ffff:0:0"]) {
  test(`F9 wildcard alias ${host} refused`, () => {
    const r = rig(); r.cfg.listen = { host, port: 0 };
    assert.throws(() => new HubServer(r.cfg, r.clock));
  });
}
