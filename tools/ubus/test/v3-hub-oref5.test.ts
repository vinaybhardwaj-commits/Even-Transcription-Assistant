// oref5 adversarial probes for R5 (never echo a rejected epoch/seq; rule id only). Independent signer via helpers.signA1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupAfter, ev, EPOCH, rig, up } from "./v3-hub-helpers.js";
cleanupAfter();

const M = "9876543"; // marker digits: must never come back or be logged
const BAD = [
  "a9876543" + "b".repeat(24),
  "A9876543" + "b".repeat(24),
  "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6\n" + M,
  "a" + M + "b".repeat(23),
  "a" + M + "b".repeat(25),
  M + "9".repeat(25),
  " a" + M + "b".repeat(23),
  "a" + "٩٨٧٦٥٤٣" + "b".repeat(24),
  "a" + M + "b".repeat(24).toUpperCase(),
];
const noMarker = (x: unknown, why: string) => assert.ok(!JSON.stringify(x).includes(M), `marker echoed/logged: ${why}`);

test("W1 every malformed string epoch: 200, epoch null, rule id only, nothing logged", async () => {
  const r = rig(); const h = await up(r); const n0 = h.srv.hub.log.all().length;
  try {
    for (const [i, bad] of BAD.entries()) {
      const res = await h.post([ev(i + 1, { epoch: bad })]);
      assert.equal(res.status, 200, bad);
      assert.equal(res.json.epoch, null);
      assert.deepEqual(res.json.rejected, [{ seq: i + 1, rule: "schema.epoch" }]);
      assert.equal(res.json.ack_seq, 0);
      noMarker(res.json, bad);
    }
    noMarker(h.srv.hub.log.all(), "log");
    assert.equal(h.srv.hub.log.all().length, n0);
  } finally { await h.srv.close(); }
});

test("W2 non-string epochs (number, array, object, bool) are answered without the value", async () => {
  const r = rig(); const h = await up(r);
  try {
    for (const bad of [98765432109, [M + "000"], { e: M }, true, null]) {
      const res = await h.post([ev(1, { epoch: bad })]);
      noMarker(res.json, String(bad));
      if (res.status === 200) { assert.equal(res.json.epoch, null); assert.deepEqual(res.json.rejected, [{ seq: 1, rule: "schema.epoch" }]); }
      else assert.deepEqual(res.json, { ok: false, error: "mixed_epoch" });
    }
    noMarker(h.srv.hub.log.all(), "log");
  } finally { await h.srv.close(); }
});

test("W3 body-level epoch: bad one never echoed, good one still echoed, ignored when events carry one", async () => {
  const r = rig(); const h = await up(r);
  try {
    const raw = (b: unknown) => h.raw("POST", "/api/v3/events", JSON.stringify(b));
    const a = await raw({ events: [], epoch: BAD[0] });
    assert.equal(a.status, 200); assert.equal(a.json.epoch, null); noMarker(a.json, "empty+bad body");
    const b = await raw({ events: [], epoch: 98765432109 });
    assert.equal(b.json.epoch, null); noMarker(b.json, "empty+numeric body");
    assert.equal((await h.post([ev(1)])).json.ack_seq, 1);
    const c = await raw({ events: [], epoch: EPOCH });
    assert.equal(c.json.epoch, EPOCH); assert.equal(c.json.ack_seq, 1);
    const d = await raw({ events: [ev(2)], epoch: BAD[0] });
    assert.equal(d.json.epoch, EPOCH); assert.equal(d.json.stored, 1); noMarker(d.json, "good events + bad body");
    const e = await raw({ events: [ev(3, { epoch: undefined })], epoch: BAD[0] });
    assert.equal(e.status, 400); noMarker(e.json, "epochless event + bad body");
  } finally { await h.srv.close(); }
});

test("W4 mixed batches with a bad epoch either side: 400, nothing stored, nothing echoed", async () => {
  const r = rig(); const h = await up(r); const n0 = h.srv.hub.log.all().length;
  try {
    for (const evs of [[ev(1, { epoch: BAD[0] }), ev(2)], [ev(1), ev(2, { epoch: BAD[3] })], [ev(1, { epoch: BAD[0] }), ev(2, { epoch: BAD[3] })]]) {
      const res = await h.post(evs);
      assert.equal(res.status, 400); assert.deepEqual(res.json, { ok: false, error: "mixed_epoch" });
    }
    assert.equal(h.srv.hub.log.all().length, n0);
  } finally { await h.srv.close(); }
});

test("W5 bad epoch and bad seq together, and bad seq under a good epoch: seq null, no digits", async () => {
  const r = rig(); const h = await up(r);
  try {
    const a = await h.post([{ ...ev(1, { epoch: BAD[0] }), seq: 98765432109 }]);
    assert.deepEqual(a.json.rejected, [{ seq: null, rule: "schema.epoch" }]); noMarker(a.json, "both");
    for (const s of [98765432109, "9876543", 9876543.5, -9876543]) {
      const b = await h.post([{ ...ev(1), seq: s }]);
      assert.deepEqual(b.json.rejected, [{ seq: null, rule: "schema.seq" }], String(s)); noMarker(b.json, String(s));
    }
    noMarker(h.srv.hub.log.all(), "log");
  } finally { await h.srv.close(); }
});

test("W6 bad epoch never registers: later good epoch is first-ever (no epoch_reset), ack correct", async () => {
  const r = rig(); const h = await up(r);
  try {
    await h.post([ev(1, { epoch: BAD[0] })]);
    const ok = await h.post([ev(1), ev(2)]);
    assert.equal(ok.json.epoch, EPOCH); assert.equal(ok.json.ack_seq, 2); assert.equal(ok.json.stored, 2);
    assert.ok(!h.srv.hub.log.all().some((x) => x.kind.includes("epoch")), "no epoch reset row");
  } finally { await h.srv.close(); }
});

test("W7 poison event with digits under good epoch: rule only, replayed rule only, log has no marker", async () => {
  const r = rig(); const h = await up(r);
  try {
    const p = ev(5, { meta: { n: 98765432109 } });
    const a = await h.post([p]); const b = await h.post([p]);
    assert.deepEqual(a.json.rejected, [{ seq: 5, rule: "meta.long_number" }]);
    assert.deepEqual(b.json.rejected, a.json.rejected);
    noMarker([a.json, b.json, h.srv.hub.log.all()], "poison");
  } finally { await h.srv.close(); }
});

test("W8 ingest() itself validates batchEpoch (defence in depth)", async () => {
  const r = rig(); const h = await up(r);
  try {
    const res = h.srv.ingest("t4", [], BAD[0]);
    assert.equal(res.epoch, null);
  } finally { await h.srv.close(); }
});
