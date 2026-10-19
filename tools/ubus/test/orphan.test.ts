import assert from "node:assert/strict";
import { test } from "node:test";
import { decideStop } from "../src/hooklib.js";
import { caller, pane, register, setup } from "./helpers.js";

const S = 1000;

test("orphan delivery: count 0, ids [], no stop block, no wake, no escalation; normal mail unchanged", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "sender-o");
    await register(rig.ubus, "worker-o");
    rig.ubus.store.insertDelivery({ messageId: "ubus:MISSING", toHandle: "worker-o", status: "stored", createdAt: rig.clock.iso(), forPane: "" });
    let sum = rig.ubus.unreadSummary("worker-o");
    assert.deepEqual({ count: sum.count, ids: sum.ids }, { count: 0, ids: [] });
    assert.equal(rig.ubus.store.unreadCount("worker-o"), 0);
    assert.equal(decideStop({ unread: sum, lastBlockAt: null, now: Date.now() }).block, false);
    rig.herdr.agents = [pane("worker-o", "fable")];
    rig.clock.advance(1300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    assert.equal(rig.ubus.store.escalationCounts("1970-01-01T00:00:00.000Z").wake ?? 0, 0);
    assert.equal(rig.ubus.store.escalationCounts("1970-01-01T00:00:00.000Z").escalate ?? 0, 0);

    const ok = await rig.ubus.call("ubus_send", { to: ["worker-o"], subject: "real", body: "real mail" }, caller("sender-o"));
    assert.equal(ok.ok, true);
    sum = rig.ubus.unreadSummary("worker-o");
    assert.deepEqual({ count: sum.count, ids: sum.ids }, { count: 1, ids: [String(ok.id)] });
    assert.equal(decideStop({ unread: sum, lastBlockAt: null, now: Date.now() }).block, true);
  } finally {
    rig.cleanup();
  }
});

test("sweep marks orphan deliveries read with a reason, keeps the row, and counts them", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "worker-p");
    rig.ubus.store.insertDelivery({ messageId: "ubus:GONE1", toHandle: "worker-p", status: "nudged", createdAt: rig.clock.iso(), forPane: "" });
    rig.ubus.store.insertDelivery({ messageId: "ubus:GONE2", toHandle: "worker-p", status: "stored", createdAt: rig.clock.iso(), forPane: "" });
    assert.equal(rig.ubus.orphanCount(), 0);
    rig.ubus.sweep();
    assert.equal(rig.ubus.orphanCount(), 2);
    assert.equal(rig.ubus.store.orphanDeliveries().length, 0);
    const rows = rig.ubus.store.inbox("worker-p", { unreadOnly: false, limit: 10 });
    assert.equal(rows.length, 0);
    rig.ubus.sweep();
    assert.equal(rig.ubus.orphanCount(), 2);
  } finally {
    rig.cleanup();
  }
});
