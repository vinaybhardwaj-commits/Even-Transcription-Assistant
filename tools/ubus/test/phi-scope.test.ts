import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSecretsOnly, filterText } from "../src/filter.js";
import { caller, register, setup } from "./helpers.js";

const NAME_NOTE = "Rule text: Rahul Sharma asked the doctor about the dosage rule for the tablet queue.";
const SECRET_NOTE = "use token=sk-SUPERSECRETTOKENVALUE999999 for the job";

async function rig(scope: "external_only" | "all") {
  const r = setup((cfg) => {
    cfg.filter.phiScope = scope;
  });
  await register(r.ubus, "alpha", { session: "cc:alpha" });
  await register(r.ubus, "beta", { session: "cc:beta" });
  await register(r.ubus, "grok:minibot", { runtime: "grok", session: "grok:minibot" }, "opd-bot");
  return r;
}

test("filterSecretsOnly skips PHI rules but keeps secrets", () => {
  assert.equal(filterText(NAME_NOTE).ok, false);
  assert.equal(filterSecretsOnly(NAME_NOTE).ok, true);
  assert.equal(filterSecretsOnly(SECRET_NOTE).ok, false);
});

test("external_only: internal-to-internal capitalized name passes", async () => {
  const r = await rig("external_only");
  try {
    const res = await r.ubus.call("ubus_send", { to: ["beta"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(res.ok, true, JSON.stringify(res));
  } finally {
    r.cleanup();
  }
});

test("external_only: same message to a grok handle is rejected", async () => {
  const r = await rig("external_only");
  try {
    const res = await r.ubus.call("ubus_send", { to: ["grok:minibot"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(res.error, "phi_rejected");
  } finally {
    r.cleanup();
  }
});

test("external_only: a secret is rejected to anyone", async () => {
  const r = await rig("external_only");
  try {
    for (const to of ["beta", "grok:minibot"]) {
      const res = await r.ubus.call("ubus_send", { to: [to], subject: "job", body: SECRET_NOTE }, caller("alpha"));
      assert.equal(res.error, "secret_rejected", to);
    }
  } finally {
    r.cleanup();
  }
});

test("external_only: a group with a grok member is rejected", async () => {
  const r = await rig("external_only");
  try {
    const res = await r.ubus.call("ubus_send", { to: ["group:host-owners"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(res.error, "phi_rejected");
  } finally {
    r.cleanup();
  }
});

test("phi_scope all restores the old behaviour", async () => {
  const r = await rig("all");
  try {
    const res = await r.ubus.call("ubus_send", { to: ["beta"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(res.error, "phi_rejected");
  } finally {
    r.cleanup();
  }
});

const HOUR = 60 * 60 * 1000;

test("external_only: a gone registered lead is bridged to ETA, so PHI is rejected", async () => {
  const r = await rig("external_only");
  try {
    await register(r.ubus, "gating-lead", { session: "cc:gating" });
    // Lead live: delivered to its inbox, internal, name-shaped text passes.
    const live = await r.ubus.call("ubus_send", { to: ["gating-lead"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(live.ok, true, JSON.stringify(live));
    r.clock.advance(25 * HOUR);
    await r.ubus.call("ubus_heartbeat", {}, caller("alpha"));
    // Lead now gone: planOne bridges to ETA (kind eta), so the PHI rules apply.
    const gone = await r.ubus.call("ubus_send", { to: ["gating-lead"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(gone.error, "phi_rejected", JSON.stringify(gone));
    const clean = await r.ubus.call("ubus_send", { to: ["gating-lead"], subject: "rule", body: "plain status update" }, caller("alpha"));
    assert.equal(clean.ok, true, JSON.stringify(clean));
  } finally {
    r.cleanup();
  }
});

test("external_only: PHI joining a thread that includes grok is rejected (thread_id and reply_to)", async () => {
  const r = await rig("external_only");
  try {
    const first = await r.ubus.call("ubus_send", { to: ["grok:minibot"], subject: "hello", body: "plain status update" }, caller("alpha"));
    assert.equal(first.ok, true, JSON.stringify(first));
    const byThread = await r.ubus.call(
      "ubus_send",
      { to: ["beta"], subject: "rule", body: NAME_NOTE, thread_id: first.thread_id },
      caller("alpha"),
    );
    assert.equal(byThread.error, "phi_rejected", JSON.stringify(byThread));
    const byReply = await r.ubus.call("ubus_send", { to: ["beta"], subject: "rule", body: NAME_NOTE, reply_to: first.id }, caller("alpha"));
    assert.equal(byReply.error, "phi_rejected", JSON.stringify(byReply));
    // A reply on the thread to an internal parent is also filtered once grok is a participant.
    const toBeta = await r.ubus.call("ubus_send", { to: ["beta"], subject: "x", body: "plain status update", thread_id: first.thread_id }, caller("alpha"));
    assert.equal(toBeta.ok, true, JSON.stringify(toBeta));
    const rep = await r.ubus.call("ubus_reply", { reply_to: toBeta.id, body: NAME_NOTE }, caller("beta"));
    assert.equal(rep.error, "phi_rejected", JSON.stringify(rep));
    // A fresh thread between internal agents is unaffected.
    const fresh = await r.ubus.call("ubus_send", { to: ["beta"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(fresh.ok, true, JSON.stringify(fresh));
  } finally {
    r.cleanup();
  }
});

test("external_only: ubus_thread redacts internal-scope messages for an external reader", async () => {
  const r = await rig("external_only");
  try {
    const internal = await r.ubus.call("ubus_send", { to: ["beta"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(internal.ok, true, JSON.stringify(internal));
    // alpha pulls grok into the same thread afterwards with clean text; the earlier PHI message must not leak.
    const join = await r.ubus.call(
      "ubus_send",
      { to: ["grok:minibot"], subject: "join", body: "plain status update", thread_id: internal.thread_id },
      caller("alpha"),
    );
    assert.equal(join.ok, true, JSON.stringify(join));
    const asGrok = await r.ubus.call("ubus_thread", { thread_id: internal.thread_id }, caller("grok:minibot", "opd-bot"));
    const text = JSON.stringify(asGrok);
    assert.equal(text.includes("Rahul Sharma"), false, text);
    assert.equal(text.includes("[redacted: internal-scope]"), true, text);
    assert.equal(text.includes("plain status update"), true, text);
    const asBeta = await r.ubus.call("ubus_thread", { thread_id: internal.thread_id }, caller("beta"));
    assert.equal(JSON.stringify(asBeta).includes("Rahul Sharma"), true);
  } finally {
    r.cleanup();
  }
});

const cf = (handle: string) => ({ ...caller(handle), via: "cloudflare" as const });

/** alpha sends internal-scope PHI to beta, then beta goes gone and someone else registers the handle. */
async function leakRig() {
  const r = await rig("external_only");
  const sent = await r.ubus.call("ubus_send", { to: ["beta"], subject: "rule", body: NAME_NOTE }, caller("alpha"));
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const own = await r.ubus.call("ubus_inbox", { peek: true, unread_only: false }, caller("beta"));
  assert.equal(JSON.stringify(own).includes("Rahul Sharma"), true, "internal reader sees the body");
  r.clock.advance(25 * HOUR);
  await r.ubus.call("ubus_heartbeat", {}, caller("alpha"));
  return { r, sent };
}

test("takeover of a gone handle by a grok on another machine: ubus_inbox redacts internal-scope bodies", async () => {
  const { r } = await leakRig();
  try {
    const reg = await register(r.ubus, "beta", { runtime: "grok", session: "grok:takeover" }, "opd-bot");
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const inbox = await r.ubus.call("ubus_inbox", { peek: true, unread_only: false }, caller("beta", "opd-bot"));
    const text = JSON.stringify(inbox);
    assert.equal(text.includes("Rahul Sharma"), false, text);
    assert.equal(text.includes("[redacted: internal-scope]"), true, text);
  } finally {
    r.cleanup();
  }
});

test("takeover of a gone handle via cloudflare: ubus_inbox redacts, and ubus_wait returns no bodies", async () => {
  const { r } = await leakRig();
  try {
    const reg = await r.ubus.call(
      "ubus_register",
      { handle: "beta", machine: "mini", runtime: "claude-code", session: "cf:takeover", owner: "fable", orchestrator: "fable" },
      cf("beta"),
    );
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const inbox = await r.ubus.call("ubus_inbox", { peek: true, unread_only: false }, cf("beta"));
    const text = JSON.stringify(inbox);
    assert.equal(text.includes("Rahul Sharma"), false, text);
    assert.equal(text.includes("[redacted: internal-scope]"), true, text);
    const wait = await r.ubus.call("ubus_wait", { timeout_s: 0 }, cf("beta"));
    assert.equal(JSON.stringify(wait).includes("Rahul"), false);
    assert.equal("body" in wait, false);
  } finally {
    r.cleanup();
  }
});

test("takeover of a requester handle: ubus_await redacts an internal-scope response body", async () => {
  const r = await rig("external_only");
  try {
    const req = await r.ubus.call("ubus_request", { to: "beta", subject: "q", body: "plain status update" }, caller("alpha"));
    assert.equal(req.ok, true, JSON.stringify(req));
    const rep = await r.ubus.call("ubus_reply", { reply_to: req.id, corr_id: req.corr_id, body: NAME_NOTE }, caller("beta"));
    assert.equal(rep.ok, true, JSON.stringify(rep));
    const own = await r.ubus.call("ubus_await", { corr_id: req.corr_id, timeout_s: 0 }, caller("alpha"));
    assert.equal(own.body, NAME_NOTE);
    r.clock.advance(25 * HOUR);
    await r.ubus.call("ubus_heartbeat", {}, caller("beta"));
    const reg = await r.ubus.call(
      "ubus_register",
      { handle: "alpha", machine: "mini", runtime: "claude-code", session: "cf:alpha", owner: "fable", orchestrator: "fable" },
      cf("alpha"),
    );
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const view = await r.ubus.call("ubus_await", { corr_id: req.corr_id, timeout_s: 0 }, cf("alpha"));
    assert.equal(view.state, "answered", JSON.stringify(view));
    assert.equal(JSON.stringify(view).includes("Rahul Sharma"), false, JSON.stringify(view));
    assert.equal(view.body, "[redacted: internal-scope]");
  } finally {
    r.cleanup();
  }
});

test("external_only: ubus_handoff is treated as external and runs the PHI rules", async () => {
  const r = await rig("external_only");
  try {
    const bad = await r.ubus.call("ubus_handoff", { project: "p", title: "rule", body: NAME_NOTE }, caller("alpha"));
    assert.equal(bad.error, "phi_rejected", JSON.stringify(bad));
    const ok = await r.ubus.call("ubus_handoff", { project: "p", title: "status", body: "plain status update" }, caller("alpha"));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally {
    r.cleanup();
  }
});

const PHI_SUBJECT = "Rahul Sharma dosage rule";

async function escRig(orchestrator: string, orchExtra: Record<string, unknown> = {}, orchMachine = "mini") {
  const r = setup((cfg) => {
    cfg.filter.phiScope = "external_only";
    cfg.escalation.digestAt = "23:59";
  });
  await register(r.ubus, "alpha", { session: "cc:alpha" });
  await register(r.ubus, "worker-a", { orchestrator });
  await register(r.ubus, orchestrator, orchExtra, orchMachine);
  const sent = await r.ubus.call("ubus_send", { to: ["worker-a"], subject: PHI_SUBJECT, body: "plain status update", wake: true }, caller("alpha"));
  assert.equal(sent.ok, true, JSON.stringify(sent));
  r.clock.advance(3600 * 1000);
  await r.ubus.call("ubus_heartbeat", {}, caller("alpha"));
  await r.ubus.call("ubus_heartbeat", {}, caller(orchestrator, orchMachine));
  r.ubus.sweep();
  return { r, sentId: String(sent.id) };
}

test("escalation to a grok orchestrator quotes ids only, never the PHI subject", async () => {
  const { r, sentId } = await escRig("grok:minibot", { runtime: "grok", session: "grok:minibot" }, "opd-bot");
  try {
    const rows = r.ubus.store.inbox("grok:minibot", { unreadOnly: false, limit: 50 }).filter((x) => x.message.fromHandle === "ubus-steward");
    assert.equal(rows.length >= 1, true, "escalation was sent");
    const text = JSON.stringify(rows.map((x) => x.message));
    assert.equal(text.includes("Rahul"), false, text);
    assert.equal(text.includes(sentId), true);
    const inbox = await r.ubus.call("ubus_inbox", { peek: true, unread_only: false }, caller("grok:minibot", "opd-bot"));
    assert.equal(JSON.stringify(inbox).includes("Rahul"), false);
  } finally {
    r.cleanup();
  }
});

test("escalation to an internal orchestrator quotes the subject but scopes it internal; a takeover reads it redacted", async () => {
  const { r } = await escRig("boss-y");
  try {
    const rows = r.ubus.store.inbox("boss-y", { unreadOnly: false, limit: 50 }).filter((x) => x.message.fromHandle === "ubus-steward");
    assert.equal(rows.length >= 1, true, "escalation was sent");
    assert.equal(rows[0]!.message.body.includes("Rahul"), true);
    assert.equal(JSON.parse(rows[0]!.message.phiJson).scope, "internal");
    r.clock.advance(25 * HOUR);
    await r.ubus.call("ubus_heartbeat", {}, caller("alpha"));
    const reg = await r.ubus.call(
      "ubus_register",
      { handle: "boss-y", machine: "mini", runtime: "claude-code", session: "cf:boss", owner: "fable", orchestrator: "fable" },
      cf("boss-y"),
    );
    assert.equal(reg.ok, true, JSON.stringify(reg));
    const inbox = await r.ubus.call("ubus_inbox", { peek: true, unread_only: false }, cf("boss-y"));
    assert.equal(JSON.stringify(inbox).includes("Rahul"), false, JSON.stringify(inbox));
  } finally {
    r.cleanup();
  }
});

test("ubus_escalate to next hop v posts to handoff under the full PHI filter", async () => {
  const r = await rig("external_only");
  try {
    await register(r.ubus, "fable");
    await register(r.ubus, "v");
    const bad = await r.ubus.call("ubus_escalate", { about: "rule", reason: NAME_NOTE, severity: "info" }, caller("fable"));
    assert.equal(bad.error, "phi_rejected", JSON.stringify(bad));
    assert.equal(r.handoff.records.length, 0);
    const ok = await r.ubus.call("ubus_escalate", { about: "rule", reason: "plain status update", severity: "info" }, caller("fable"));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  } finally {
    r.cleanup();
  }
});
