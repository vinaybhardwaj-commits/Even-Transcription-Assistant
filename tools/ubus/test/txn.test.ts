import assert from "node:assert/strict";
import { test } from "node:test";
import { caller, register, setup, type TestRig } from "./helpers.js";

function counts(rig: TestRig) {
  const db = rig.ubus.store.db;
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    messages: n("SELECT COUNT(*) AS n FROM messages"),
    deliveries: n("SELECT COUNT(*) AS n FROM deliveries"),
    acked: n("SELECT COUNT(*) AS n FROM deliveries WHERE COALESCE(acked_at,'') != ''"),
    requests: n("SELECT COUNT(*) AS n FROM requests"),
    answered: n("SELECT COUNT(*) AS n FROM requests WHERE state = 'answered'"),
    orphans: rig.ubus.store.orphanDeliveries().length,
  };
}

/** Make one store method throw once, then restore it. */
async function withThrow<T>(rig: TestRig, method: string, fn: () => Promise<T>): Promise<T> {
  const store = rig.ubus.store as unknown as Record<string, (...a: unknown[]) => unknown>;
  const orig = store[method]!;
  store[method] = () => {
    store[method] = orig;
    throw new Error(`injected ${method}`);
  };
  try {
    return await fn();
  } finally {
    store[method] = orig;
  }
}

async function rig3(): Promise<TestRig> {
  const rig = setup();
  for (const h of ["a-send", "b-recv", "c-recv"]) await register(rig.ubus, h);
  return rig;
}

test("TXN deliver: a throw at the message insert or the idempotency write leaves nothing behind", async () => {
  const rig = await rig3();
  try {
    for (const method of ["insertMessage", "putIdempotency"]) {
      const before = counts(rig);
      const res = await withThrow(rig, method, () =>
        rig.ubus.call("ubus_send", { to: ["b-recv", "c-recv"], subject: "s", body: "b", idempotency_key: `k-${method}` }, caller("a-send")),
      );
      assert.equal(res.ok, false);
      assert.deepEqual(counts(rig), before, method);
    }
    const ok = await rig.ubus.call("ubus_send", { to: ["b-recv", "c-recv"], subject: "s", body: "b" }, caller("a-send"));
    assert.equal(ok.ok, true);
    const after = counts(rig);
    assert.equal(after.messages, 1);
    assert.equal(after.deliveries, 2);
    assert.equal(after.orphans, 0);
  } finally {
    rig.cleanup();
  }
});

test("TXN deliver: a throw on the second recipient's delivery rolls the first back", async () => {
  const rig = await rig3();
  try {
    const before = counts(rig);
    const store = rig.ubus.store as unknown as Record<string, (...a: unknown[]) => unknown>;
    const orig = store.insertDelivery!;
    let n = 0;
    store.insertDelivery = function (this: unknown, ...a: unknown[]) {
      if (++n === 2) throw new Error("injected second delivery");
      return orig.apply(rig.ubus.store, a);
    };
    const res = await rig.ubus.call("ubus_send", { to: ["b-recv", "c-recv"], subject: "s", body: "b" }, caller("a-send"));
    store.insertDelivery = orig;
    assert.equal(res.ok, false);
    assert.deepEqual(counts(rig), before);
  } finally {
    rig.cleanup();
  }
});

test("TXN reply: a throw at the message insert or the ack leaves no message, no delivery, no ack", async () => {
  const rig = await rig3();
  try {
    const sent = await rig.ubus.call("ubus_send", { to: ["b-recv"], subject: "s", body: "b" }, caller("a-send"));
    const id = String(sent.id);
    for (const method of ["insertMessage", "markAck"]) {
      const before = counts(rig);
      const res = await withThrow(rig, method, () => rig.ubus.call("ubus_reply", { reply_to: id, body: "r" }, caller("b-recv")));
      assert.equal(res.ok, false, method);
      assert.deepEqual(counts(rig), before, method);
    }
    const ok = await rig.ubus.call("ubus_reply", { reply_to: id, body: "r" }, caller("b-recv"));
    assert.equal(ok.ok, true);
    const after = counts(rig);
    assert.equal(after.messages, 2);
    assert.equal(after.acked, 1);
    assert.equal(after.orphans, 0);
  } finally {
    rig.cleanup();
  }
});

test("TXN reply with a bad corr_id leaves no delivery behind and no ack", async () => {
  const rig = await rig3();
  try {
    const sent = await rig.ubus.call("ubus_send", { to: ["b-recv"], subject: "s", body: "b" }, caller("a-send"));
    const before = counts(rig);
    const res = await rig.ubus.call("ubus_reply", { reply_to: String(sent.id), body: "r", corr_id: "c-nope" }, caller("b-recv"));
    assert.equal(res.ok, false);
    assert.deepEqual(counts(rig), before);
  } finally {
    rig.cleanup();
  }
});

test("TXN request: a throw writing the request row rolls the message and deliveries back", async () => {
  const rig = await rig3();
  try {
    for (const method of ["insertRequest", "updateMessageCorr"]) {
      const before = counts(rig);
      const res = await withThrow(rig, method, () => rig.ubus.call("ubus_request", { to: "b-recv", subject: "s", body: "b" }, caller("a-send")));
      assert.equal(res.ok, false, method);
      assert.deepEqual(counts(rig), before, method);
    }
    const ok = await rig.ubus.call("ubus_request", { to: "b-recv", subject: "s", body: "b" }, caller("a-send"));
    assert.equal(ok.ok, true);
    const after = counts(rig);
    assert.deepEqual({ m: after.messages, d: after.deliveries, r: after.requests, o: after.orphans }, { m: 1, d: 1, r: 1, o: 0 });
    // Answering still works end to end.
    const inbox = await rig.ubus.call("ubus_inbox", {}, caller("b-recv"));
    const msg = (inbox.messages as Array<{ id: string }>)[0]!;
    const rep = await rig.ubus.call("ubus_reply", { reply_to: msg.id, body: "done", corr_id: ok.corr_id }, caller("b-recv"));
    assert.equal(rep.ok, true);
    assert.equal(counts(rig).answered, 1);
  } finally {
    rig.cleanup();
  }
});
