// oref4 adversarial probes for R4 (Y1 forward skew, Y2 epoch digit-run, no seq echo). Independent signer via helpers.signA1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { cleanupAfter, ev, KEYS, rig, signA1, up } from "./v3-hub-helpers.js";
import { EPOCH_RE } from "../src/v3/hub/validate.js";
import { authenticate, NonceCache, MAX_SKEW_MS, MAX_FORWARD_SKEW_MS } from "../src/v3/hub/auth.js";
import { HubServer } from "../src/v3/hub/server.js";
cleanupAfter();

const P = "/api/v3/since?cursor=0";
const capture = (nowMs: number, ahead: number) => {
  const ts = new Date(nowMs + ahead).toISOString(); const n = randomBytes(16).toString("hex");
  return { authorization: `Node t4:${signA1(KEYS.t4, "GET", P, ts, n, "")}`, "x-ubus-ts": ts, "x-ubus-nonce": n };
};

test("Z1 no capture at any forward offset 0..5000 replays across a restart after 0..5000 ms", async () => {
  for (const gap of [0, 1, 2_500, 4_999, 5_000]) for (const ahead of [0, 1, 2_500, 4_999, 5_000]) {
    const r = rig(); let h = await up(r);
    const hdr = capture(r.clock.now(), ahead);
    assert.equal((await fetch(h.base + P, { headers: hdr })).status, 200, `first use ahead=${ahead}`);
    await h.srv.close();
    r.clock.advance(gap);
    const srv = new HubServer(r.cfg, r.clock); const a = await srv.listen();
    try {
      // replay at every moment the stamp is still within the backward window
      for (const later of [0, 1, 5_000, 5_001, 200_000]) {
        if (later) r.clock.advance(later);
        const res = await fetch(`http://${a.host}:${a.port}${P}`, { headers: hdr });
        assert.equal(res.status, 401, `replayed: gap=${gap} ahead=${ahead} later=${later}`);
      }
    } finally { await srv.close(); }
  }
});

test("Z2 boot floor on POST: ts in (boot, boot+5000] refused before_boot, boot+5001 stored", async () => {
  const r = rig(); const srv = new HubServer(r.cfg, r.clock); const boot = r.clock.now(); const a = await srv.listen();
  try {
    const send = async (tsMs: number) => {
      const body = JSON.stringify({ events: [ev(1)] }); const ts = new Date(tsMs).toISOString(); const n = randomBytes(16).toString("hex");
      const res = await fetch(`http://${a.host}:${a.port}/api/v3/events`, { method: "POST", body, headers: { authorization: `Node t4:${signA1(KEYS.t4, "POST", "/api/v3/events", ts, n, body)}`, "x-ubus-ts": ts, "x-ubus-nonce": n } });
      return { status: res.status, json: (await res.json()) as any };
    };
    r.clock.advance(3_000);
    const early = await send(boot + 3_000);
    assert.deepEqual([early.status, early.json.error], [401, "before_boot"]);
    r.clock.advance(2_000);
    assert.equal((await send(boot + 5_000)).json.error, "before_boot");
    r.clock.advance(1);
    assert.equal((await send(boot + 5_001)).json.stored, 1);
  } finally { await srv.close(); }
});

test("Z3 skew constants and asymmetric boundary in authenticate()", () => {
  assert.equal(MAX_SKEW_MS, 300_000); assert.equal(MAX_FORWARD_SKEW_MS, 5_000);
  const r = rig(); const now = 1_000_000_000_000; let boot = now - 400_000;
  const chk = (off: number) => { const ts = new Date(now + off).toISOString(); const n = randomBytes(16).toString("hex");
    return authenticate(r.cfg.keyDir, { method: "GET", pathQuery: "/x", authorization: `Node t4:${signA1(KEYS.t4, "GET", "/x", ts, n, "")}`, ts, nonce: n, body: Buffer.alloc(0) }, now, new NonceCache(), boot); };
  assert.deepEqual(chk(5_000), { ok: true, node: "t4" }); assert.equal((chk(5_001) as any).reason, "bad_timestamp");
  assert.equal(chk(-300_000).ok, true); assert.equal((chk(-300_001) as any).reason, "bad_timestamp");
  boot = now - 100_000; assert.equal((chk(-100_000 + 5_000) as any).reason, "before_boot"); assert.equal(chk(-100_000 + 5_001).ok, true);
});

test("Z4 EPOCH_RE edge cases", () => {
  const ok = ["a" + "123456b".repeat(4) + "123", "abcdef".repeat(5) + "12", "f".repeat(32), "123456" + "a".repeat(20) + "654321"];
  const bad = ["1234567" + "a".repeat(25), "a".repeat(25) + "1234567", "a".repeat(12) + "9999999" + "b".repeat(13), "1".repeat(32),
    "a".repeat(32) + "\n", "A" + "a".repeat(31), "a" + "B".repeat(31), "a".repeat(31), "a".repeat(33), "g" + "a".repeat(31), " " + "a".repeat(31), "a".repeat(16) + "١".repeat(16)];
  for (const e of ok) assert.ok(EPOCH_RE.test(e), `should pass ${e}`);
  for (const e of bad) assert.ok(!EPOCH_RE.test(e), `should fail ${JSON.stringify(e)}`);
  assert.equal(ok.every((e) => e.length === 32), true);
});

test("Z5 no over-long seq is ever echoed, in any shape", async () => {
  const r = rig(); const h = await up(r);
  try {
    for (const s of [9876543210, -987654321, 12345678901234567890, 98765432.5, "9876543210", 1e10, 0]) {
      const res = await h.post([ev(s as number)]);
      assert.equal(res.status, 200);
      assert.deepEqual(res.json.rejected, [{ seq: null, rule: "schema.seq" }], String(s));
      assert.ok(!/98765|12345678901/.test(JSON.stringify(res.json)), JSON.stringify(res.json));
    }
    assert.equal(h.srv.hub.log.all().filter((x) => x.kind.includes("rejected")).length, 0);
  } finally { await h.srv.close(); }
});

test("Z6 a digit-run epoch is not echoed in the response epoch field (sender-only leak)", async () => {
  const r = rig(); const h = await up(r);
  try {
    const bad = "a9876543210" + "b".repeat(21);
    const res = await h.post([ev(1, { epoch: bad })]);
    assert.equal(res.json.rejected[0].rule, "schema.epoch");
    assert.ok(!JSON.stringify(res.json).includes("9876543210"), "response echoes bad epoch: " + JSON.stringify(res.json));
  } finally { await h.srv.close(); }
});

test("Z7 RESIDUAL (documented, P2): hub clock stepping backward across a restart reopens replay", async () => {
  const r = rig(); let h = await up(r);
  const hdr = capture(r.clock.now(), 5_000);
  assert.equal((await fetch(h.base + P, { headers: hdr })).status, 200);
  await h.srv.close();
  r.clock.advance(-10_000); // NTP step back on the hub
  h = await up(r); r.clock.advance(5_000); // hub clock catches up past the capture instant
  try { assert.equal((await fetch(h.base + P, { headers: hdr })).status, 200, "known residual: boot floor is not persisted"); } finally { await h.srv.close(); }
});
