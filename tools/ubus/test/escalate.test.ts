import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { test } from "node:test";
import { SqliteEtaAdapter } from "../src/adapters.js";
import { createUbus } from "../src/create.js";
import { caller, pane, register, setup, type TestRig } from "./helpers.js";

const S = 1000;

async function send(rig: TestRig, to: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await rig.ubus.call("ubus_send", { to: [to], subject: "needs action", body: "please look", wake: true, ...extra }, caller("sender-x"));
  assert.equal(res.ok, true, JSON.stringify(res));
  return String(res.id);
}

function steward(rig: TestRig, to: string) {
  return rig.ubus.store.inbox(to, { unreadOnly: false, limit: 50 }).filter((r) => r.message.fromHandle === "ubus-steward");
}

async function rigWith(...handles: Array<[string, Record<string, unknown>?]>): Promise<TestRig> {
  const rig = setup((cfg) => {
    cfg.escalation.digestAt = "23:59";
  });
  await register(rig.ubus, "sender-x");
  for (const [h, extra] of handles) await register(rig.ubus, h, extra ?? {});
  return rig;
}

function rows(rig: TestRig, stage: string): number {
  return rig.ubus.store.escalationCounts("1970-01-01T00:00:00.000Z")[stage] ?? 0;
}

test("E2 wake goes out after wake_after_s, not before, once per window", async () => {
  const rig = await rigWith(["worker-a"]);
  try {
    await send(rig, "worker-a");
    rig.herdr.agents = [pane("worker-a", "fable")];
    rig.clock.advance(299 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    rig.clock.advance(1 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    assert.equal(rig.herdr.nudges[0]?.name, "worker-a");
    assert.match(rig.herdr.nudges[0]!.text, /unread messages/);
    assert.equal(rows(rig, "wake"), 1);
    rig.clock.advance(100 * S);
    rig.ubus.sweep();
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    rig.clock.advance(200 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 2);
  } finally {
    rig.cleanup();
  }
});

test("E3 after escalate_after_s one batched ids-only message goes to the orchestrator", async () => {
  const rig = await rigWith(["worker-b", { orchestrator: "boss-y" }], ["boss-y"]);
  try {
    const long = "x".repeat(100);
    const m1 = await send(rig, "worker-b", { subject: long });
    const m2 = await send(rig, "worker-b");
    rig.herdr.agents = [pane("worker-b", "fable")];
    rig.clock.advance(1199 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "boss-y").length, 0);
    rig.clock.advance(1 * S);
    rig.ubus.sweep();
    const got = steward(rig, "boss-y");
    assert.equal(got.length, 1);
    const body = got[0]!.message.body;
    assert.ok(body.includes("worker-b") && body.includes(m1) && body.includes(m2));
    assert.ok(body.includes("age 20m"));
    assert.ok(body.includes(`"${"x".repeat(60)}"`) && !body.includes("x".repeat(61)));
    assert.ok(!body.includes("please look"));
    assert.equal(rows(rig, "escalate"), 2);
    rig.clock.advance(1300 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "boss-y").length, 1);
  } finally {
    rig.cleanup();
  }
});

test("E3 with no orchestrator of its own the owner, else gating-lead, hears", async () => {
  const rig = await rigWith(["worker-c", { orchestrator: "worker-c", owner: "worker-c" }]);
  try {
    await send(rig, "worker-c");
    rig.clock.advance(1200 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "gating-lead").length, 1);
  } finally {
    rig.cleanup();
  }
});

test("E1 FYI and low priority messages are never escalated", async () => {
  const rig = await rigWith(["worker-d"]);
  try {
    await send(rig, "worker-d", { wake: false });
    await send(rig, "worker-d", { priority: "low" });
    rig.herdr.agents = [pane("worker-d", "fable")];
    rig.clock.advance(3000 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    assert.equal(steward(rig, "fable").length, 0);
    assert.equal(rows(rig, "wake") + rows(rig, "escalate"), 0);
  } finally {
    rig.cleanup();
  }
});

test("E1 grok, gone, turn-based, poll and exempt recipients are left alone", async () => {
  const rig = await rigWith(
    ["gk-bot", { runtime: "grok", session: "grok:gk" }],
    ["cw-one", { runtime: "cowork", session: "cowork:one" }],
    ["gone-one"],
    ["exempt-one"],
  );
  rig.cfg.escalation.exemptHandles = ["exempt-one"];
  try {
    await send(rig, "gk-bot");
    await send(rig, "cw-one");
    await send(rig, "exempt-one");
    rig.herdr.agents = [pane("gk-bot", "fable"), pane("cw-one", "fable"), pane("exempt-one", "fable")];
    rig.clock.advance(1300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    assert.equal(rig.ubus.store.escalationCounts("1970-01-01T00:00:00.000Z").escalate ?? 0, 0);
    // A recipient that goes gone is not chased either.
    await send(rig, "gone-one");
    rig.clock.advance(13 * 3600 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    assert.equal(rig.ubus.store.escalationCounts("1970-01-01T00:00:00.000Z").escalate ?? 0, 0);
  } finally {
    rig.cleanup();
  }
});

test("E5 ack clears the watch at once", async () => {
  const rig = await rigWith(["worker-e"]);
  try {
    const id = await send(rig, "worker-e");
    rig.herdr.agents = [pane("worker-e", "fable")];
    rig.clock.advance(300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    const ack = await rig.ubus.call("ubus_ack", { ids: [id] }, caller("worker-e"));
    assert.equal(ack.ok, true);
    rig.clock.advance(1500 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    assert.equal(steward(rig, "fable").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("E1 an unanswered ubus_request is actionable without wake; an answer clears it", async () => {
  const rig = await rigWith(["worker-f"]);
  try {
    const req = await rig.ubus.call("ubus_request", { to: "worker-f", subject: "need a count", body: "please answer" }, caller("sender-x"));
    assert.equal(req.ok, true);
    rig.herdr.agents = [pane("worker-f", "fable")];
    rig.clock.advance(300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    const inbox = await rig.ubus.call("ubus_inbox", {}, caller("worker-f"));
    const msg = (inbox.messages as Array<{ id: string }>)[0]!;
    const reply = await rig.ubus.call("ubus_reply", { reply_to: msg.id, body: "done", corr_id: req.corr_id }, caller("worker-f"));
    assert.equal(reply.ok, true);
    rig.clock.advance(1500 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    assert.equal(steward(rig, "fable").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("E4 daily digest: one file with counts and ids, one message", async () => {
  const rig = await rigWith(["worker-g"], ["worker-h"]);
  try {
    const id1 = await send(rig, "worker-g", { subject: "secret subject text" });
    await send(rig, "worker-g");
    await send(rig, "worker-h");
    const local = new Date(rig.clock.now() + 600 * S);
    const hhmm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    rig.cfg.escalation.digestAt = hhmm;
    rig.ubus.sweep();
    assert.equal(existsSync(rig.cfg.escalation.digestDir), false);
    rig.clock.advance(601 * S);
    rig.ubus.sweep();
    const files = readdirSync(rig.cfg.escalation.digestDir);
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^UNACKED-\d{4}-\d{2}-\d{2}\.md$/);
    const text = readFileSync(`${rig.cfg.escalation.digestDir}/${files[0]}`, "utf8");
    assert.match(text, /\| worker-g \| 2 \|/);
    assert.match(text, /\| worker-h \| 1 \|/);
    assert.ok(text.includes(id1));
    assert.ok(!text.includes("secret subject text") && !text.includes("please look"));
    const msgs = steward(rig, "gating-lead");
    assert.equal(msgs.filter((m) => m.message.subject.startsWith("[ubus] unacked digest")).length, 1);
    assert.ok(msgs.some((m) => m.message.body.includes(files[0]!) && m.message.body.includes("worker-g 2")));
    rig.clock.advance(60 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "gating-lead").filter((m) => m.message.subject.startsWith("[ubus] unacked digest")).length, 1);
  } finally {
    rig.cleanup();
  }
});

test("E5 escalation.enabled=false does nothing and /health says so", async () => {
  const rig = await rigWith(["worker-i"]);
  rig.cfg.escalation.enabled = false;
  try {
    await send(rig, "worker-i");
    rig.herdr.agents = [pane("worker-i", "fable")];
    rig.clock.advance(3000 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    assert.equal(steward(rig, "fable").length, 0);
    assert.equal(rows(rig, "wake") + rows(rig, "escalate"), 0);
    assert.equal(rig.ubus.escalationStatus().enabled, false);
  } finally {
    rig.cleanup();
  }
});

test("E5 health counts the last hour; steward is hidden from the directory", async () => {
  const rig = await rigWith(["worker-j"]);
  try {
    await send(rig, "worker-j");
    rig.herdr.agents = [pane("worker-j", "fable")];
    rig.clock.advance(300 * S);
    rig.ubus.sweep();
    const st = rig.ubus.escalationStatus();
    assert.equal(st.enabled, true);
    assert.equal(st.last_hour.wake, 1);
    const dir = await rig.ubus.call("ubus_directory", { presence: "all" }, caller("sender-x"));
    assert.equal((dir.agents as Array<{ handle: string }>).some((a) => a.handle === "ubus-steward"), false);
  } finally {
    rig.cleanup();
  }
});

test("E2 a server restart inside the window does not wake twice", async () => {
  let rig = await rigWith(["worker-k"]);
  try {
    await send(rig, "worker-k");
    rig.herdr.agents = [pane("worker-k", "fable")];
    rig.clock.advance(300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    rig.ubus.close();
    const ubus = createUbus(rig.cfg, { clock: rig.clock, eta: new SqliteEtaAdapter(rig.cfg.eta.dbPath!), herdr: rig.herdr, openbot: rig.openbot, handoff: rig.handoff, whois: rig.whois, probe: rig.probe });
    rig = { ...rig, ubus, cleanup: () => { ubus.close(); rmSync(rig.dir, { recursive: true, force: true }); } };
    rig.clock.advance(130 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    rig.clock.advance(200 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 2);
  } finally {
    rig.cleanup();
  }
});

test("R2 mail older than the switch-on is never chased; new mail flows normally", async () => {
  const rig = await rigWith(["worker-l"]);
  rig.cfg.escalation.enabled = false;
  rig.ubus.sweep();
  try {
    await send(rig, "worker-l");
    await send(rig, "worker-l");
    rig.clock.advance(3600 * S);
    rig.cfg.escalation.enabled = true;
    rig.ubus.sweep();
    assert.ok(rig.ubus.store.getState("escalation_enabled_at"));
    rig.herdr.agents = [pane("worker-l", "fable")];
    rig.clock.advance(2000 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 0);
    assert.equal(rows(rig, "wake") + rows(rig, "escalate"), 0);
    rig.herdr.agents = [];
    await send(rig, "worker-l");
    rig.herdr.agents = [pane("worker-l", "fable")];
    rig.clock.advance(300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    rig.clock.advance(900 * S);
    rig.ubus.sweep();
    const got = steward(rig, "fable");
    assert.equal(got.length, 1);
    assert.equal(rows(rig, "escalate"), 1);
  } finally {
    rig.cleanup();
  }
});

test("R2 the digest counts older mail as before watch start", async () => {
  const rig = await rigWith(["worker-m"]);
  rig.cfg.escalation.enabled = false;
  rig.ubus.sweep();
  try {
    const old = await send(rig, "worker-m");
    rig.clock.advance(600 * S);
    rig.cfg.escalation.enabled = true;
    rig.ubus.sweep();
    await send(rig, "worker-m");
    const local = new Date(rig.clock.now() + 600 * S);
    rig.cfg.escalation.digestAt = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    rig.clock.advance(601 * S);
    rig.ubus.sweep();
    const f = readdirSync(rig.cfg.escalation.digestDir)[0]!;
    const text = readFileSync(`${rig.cfg.escalation.digestDir}/${f}`, "utf8");
    assert.match(text, /\| worker-m \| 1 \| 1 \|/);
    assert.match(text, /Before watch start: /);
    assert.ok(text.includes(old));
    assert.equal(rows(rig, "escalate"), 0);
  } finally {
    rig.cleanup();
  }
});

test("R2 a restart keeps the original enabled_at; off then on resets it", async () => {
  let rig = await rigWith(["worker-n"]);
  try {
    const first = rig.ubus.store.getState("escalation_enabled_at");
    assert.ok(first);
    rig.clock.advance(5000 * S);
    rig.ubus.close();
    const ubus = createUbus(rig.cfg, { clock: rig.clock, eta: new SqliteEtaAdapter(rig.cfg.eta.dbPath!), herdr: rig.herdr, openbot: rig.openbot, handoff: rig.handoff, whois: rig.whois, probe: rig.probe });
    rig = { ...rig, ubus, cleanup: () => { ubus.close(); rmSync(rig.dir, { recursive: true, force: true }); } };
    assert.equal(rig.ubus.store.getState("escalation_enabled_at"), first);
    rig.cfg.escalation.enabled = false;
    rig.ubus.sweep();
    assert.equal(rig.ubus.store.getState("escalation_enabled_at"), "");
    rig.clock.advance(60 * S);
    rig.cfg.escalation.enabled = true;
    rig.ubus.sweep();
    const again = rig.ubus.store.getState("escalation_enabled_at");
    assert.ok(again && again > first);
  } finally {
    rig.cleanup();
  }
});

test("R3/F1 a plain reply from the recipient clears the watch like an ack", async () => {
  const rig = await rigWith(["worker-q"]);
  try {
    const id = await send(rig, "worker-q");
    rig.herdr.agents = [pane("worker-q", "fable")];
    rig.clock.advance(300 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    const reply = await rig.ubus.call("ubus_reply", { reply_to: id, body: "on it" }, caller("worker-q"));
    assert.equal(reply.ok, true);
    rig.clock.advance(1500 * S);
    rig.ubus.sweep();
    assert.equal(rig.herdr.nudges.length, 1);
    assert.equal(rows(rig, "escalate"), 0);
    assert.equal(steward(rig, "fable").length, 0);
  } finally {
    rig.cleanup();
  }
});

test("R3/F2 a send that did not happen is recorded not_sent and retried next window", async () => {
  let rig = await rigWith(["worker-r"]);
  try {
    await send(rig, "worker-r");
    // Path 1: the steward row is missing.
    rig.ubus.store.archiveAgent("ubus-steward", rig.clock.iso());
    rig.clock.advance(1200 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "fable").length, 0);
    const first = (rig.ubus as any).store.db.prepare("SELECT outcome FROM escalations WHERE stage = 'escalate'").all() as Array<{ outcome: string }>;
    assert.equal(first.length, 1);
    assert.match(first[0]!.outcome, /^not_sent:no_sender_row/);
    assert.equal(rows(rig, "escalate"), 0);
    // Restart recreates the steward row; the next window sends.
    rig.ubus.close();
    const ubus = createUbus(rig.cfg, { clock: rig.clock, eta: new SqliteEtaAdapter(rig.cfg.eta.dbPath!), herdr: rig.herdr, openbot: rig.openbot, handoff: rig.handoff, whois: rig.whois, probe: rig.probe });
    rig = { ...rig, ubus, cleanup: () => { ubus.close(); rmSync(rig.dir, { recursive: true, force: true }); } };
    rig.clock.advance(1200 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "fable").length, 1);
    assert.equal(rows(rig, "escalate"), 1);
    const all = (rig.ubus as any).store.db.prepare("SELECT outcome FROM escalations WHERE stage = 'escalate' ORDER BY id").all() as Array<{ outcome: string }>;
    assert.match(all[all.length - 1]!.outcome, /^sent:fable/);
  } finally {
    rig.cleanup();
  }
});

test("R3/F2 the alerting guard is reported as not_sent:alerting", async () => {
  const rig = await rigWith(["worker-s"]);
  try {
    await send(rig, "worker-s");
    (rig.ubus as any).alerting = true;
    rig.clock.advance(1200 * S);
    rig.ubus.sweep();
    (rig.ubus as any).alerting = false;
    assert.equal(steward(rig, "fable").length, 0);
    const r = (rig.ubus as any).store.db.prepare("SELECT outcome FROM escalations WHERE stage = 'escalate'").all() as Array<{ outcome: string }>;
    assert.equal(r[0]?.outcome, "not_sent:alerting");
    rig.clock.advance(1200 * S);
    rig.ubus.sweep();
    assert.equal(steward(rig, "fable").length, 1);
  } finally {
    rig.cleanup();
  }
});
