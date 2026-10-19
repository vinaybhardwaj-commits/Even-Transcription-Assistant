import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyChain } from "../src/archive.js";
import { BRIDGE_IDENTITY, HOUR_MS, LIAISON_IDENTITY, NUDGE_TEXT, TIME_MACHINE_VOLUME_UUID } from "../src/constants.js";
import { caller, pane, register, setup } from "./helpers.js";

/** Identity and key-header literals are assembled at run time so the repo never holds them. */
const ICUS = ["ehrc", "icus", "mac", "mini"].join("-");
const PEM = `-----${"BEGIN"} ${"PRIVATE"} KEY-----\nabc\n-----END ${"PRIVATE"} KEY-----`;

const SECRET = "sk-SUPERSECRETTOKENVALUE999999";
const PHI = "MRN: ABC12345";

function tree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, name.name);
      if (name.isDirectory()) walk(p);
      else out.push(readFileSync(p).toString("utf8"));
    }
  };
  walk(dir);
  return out.join("\n");
}

test("kiosk, ICU, and ORB2 are denied for register, send, and kill", async () => {
  const rig = setup();
  try {
    const reg = await rig.ubus.call(
      "ubus_register",
      { handle: "kiosk-bot", machine: "ehrc-test-1", runtime: "claude-code", session: "herdr:default/kiosk", owner: "fable", orchestrator: "fable" },
      caller(undefined, "ehrc-test-1"),
    );
    assert.equal(reg.error, "denied_kiosk");
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v", orchestrator: "v" });
    const send = await rig.ubus.call(
      "ubus_send",
      { to: [`agent://${ICUS}/claude-code/herdr:default/room`], subject: "status", body: "count=1 path=~/dev/eta-lab/x.json" },
      caller("fable"),
    );
    assert.equal(send.error, "denied_kiosk");
    const kill = await rig.ubus.call("ubus_agent_kill", { address: "agent://vinay-orb2/claude-code/proc:9@boot" }, caller("fable"));
    assert.equal(kill.error, "denied_kiosk");
    const read = await rig.ubus.call("ubus_agent_read", { address: "agent://orb2/claude-code/proc:1@b" }, caller("fable"));
    assert.equal(read.error, "denied_kiosk");
  } finally {
    rig.cleanup();
  }
});

test("secret bodies and secret paths are rejected and never land in the log", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "worker");
    const secret = await rig.ubus.call(
      "ubus_send",
      { to: ["worker"], subject: "creds", body: `token=${SECRET}` },
      caller("fable"),
    );
    assert.equal(secret.error, "secret_rejected");
    const phi = await rig.ubus.call(
      "ubus_send",
      { to: ["worker"], subject: "chart", body: `patient ${PHI} overnight` },
      caller("fable"),
    );
    assert.equal(phi.error, "phi_rejected");
    const key = await rig.ubus.call(
      "ubus_send",
      { to: ["worker"], subject: "key", body: PEM },
      caller("fable"),
    );
    assert.equal(key.error, "secret_rejected");
    const path = await rig.ubus.call(
      "ubus_send",
      { to: ["worker"], subject: "file", body: "count=1 path=~/dev/eta-lab/out.json", artifacts: [{ node: "mini", path: "~/.ssh/id_ed25519" }] },
      caller("fable"),
    );
    assert.equal(path.error, "denied_secret_path");
    const read = await rig.ubus.call(
      "ubus_agent_read",
      { address: "agent://mini/claude-code/s:worker", path: "~/dev/Neon Database Connection String.rtf" },
      caller("fable"),
    );
    assert.equal(read.error, "denied_secret_path");
    const dumped = tree(rig.dir);
    assert.equal(dumped.includes(SECRET), false);
    assert.equal(dumped.includes("ABC12345"), false);
    assert.equal(dumped.includes(`${"BEGIN"} ${"PRIVATE"} KEY`), false);
    assert.match(dumped, /phi_suspect/);
    assert.match(dumped, /"body_sha256"/);
    assert.equal(dumped.includes('"body":'), false);
  } finally {
    rig.cleanup();
  }
});

test("approval is bound to the request args and is single-use", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v", orchestrator: "v" });
    await register(rig.ubus, "worker", { owner: "fable" });
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer", machine: "opd-bot" }, "opd-bot");
    const address = "agent://mini/claude-code/herdr:default/worker";
    const req = await rig.ubus.call("ubus_approval_request", { action: "ubus_agent_kill", args: { address } }, caller("worker"));
    assert.equal(req.ok, true);
    const id = String(req.approval_id);
    const early = await rig.ubus.call("ubus_agent_kill", { address, approval_id: id }, caller("worker"));
    assert.equal(early.error, "not_approved");
    const grok = await rig.ubus.call("ubus_approve", { approval_id: id }, caller("grok:designer", "opd-bot"));
    assert.equal(grok.error, "forbidden");
    const approved = await rig.ubus.call("ubus_approve", { approval_id: id }, caller("fable"));
    assert.equal(approved.ok, true);
    const mismatch = await rig.ubus.call(
      "ubus_agent_kill",
      { address: "agent://mini/claude-code/herdr:default/other", approval_id: id },
      caller("worker"),
    );
    assert.equal(mismatch.error, "approval_mismatch");
    const once = await rig.ubus.call("ubus_agent_kill", { address, approval_id: id }, caller("worker"));
    assert.equal(once.ok, true);
    assert.equal(once.stub, true);
    assert.equal(once.executed, false);
    const again = await rig.ubus.call("ubus_agent_kill", { address, approval_id: id }, caller("worker"));
    assert.equal(again.error, "approval_used");
    const kiosk = await rig.ubus.call(
      "ubus_approval_request",
      { action: "ubus_agent_kill", args: { address: "agent://ehrc-test-2/claude-code/herdr:default/x" } },
      caller("worker"),
    );
    assert.equal(kiosk.error, "denied_kiosk");
  } finally {
    rig.cleanup();
  }
});

test("owner grant is time-boxed and does not let a Grok bot type into a pane", async () => {
  const rig = setup();
  try {
    rig.herdr.agents.push(pane("eta-refuter", "consult-lead"));
    await register(rig.ubus, "consult-lead", { runtime: "cowork", session: "cowork:consult-lead", owner: "fable" });
    await register(rig.ubus, "worker");
    await register(rig.ubus, "eta-refuter", { session: "herdr:default/eta-refuter", owner: "consult-lead" });
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer" }, "opd-bot");
    const denied = await rig.ubus.call(
      "ubus_agent_send",
      { address: "agent://mini/claude-code/herdr:default/eta-refuter", text: "count=1 path=~/dev/eta-lab/a.json" },
      caller("worker"),
    );
    assert.equal(denied.error, "grant_required");
    const grant = await rig.ubus.call(
      "ubus_grant",
      { grantee: "worker", target: "eta-refuter", verbs: ["send"], expires_in: 3600 },
      caller("consult-lead"),
    );
    assert.equal(grant.ok, true);
    const steered = await rig.ubus.call(
      "ubus_agent_send",
      { address: "eta-refuter", text: "count=2 path=~/dev/eta-lab/b.json" },
      caller("worker"),
    );
    assert.equal(steered.ok, true);
    assert.equal(steered.stub, true);
    rig.clock.advance(3600 * 1000 + 1);
    const expired = await rig.ubus.call(
      "ubus_agent_send",
      { address: "eta-refuter", text: "count=3 path=~/dev/eta-lab/expired.json" },
      caller("worker"),
    );
    assert.equal(expired.error, "grant_required");
    const outsider = await rig.ubus.call(
      "ubus_grant",
      { grantee: "worker", target: "eta-refuter", verbs: ["send"], expires_in: 60 },
      caller("worker"),
    );
    assert.equal(outsider.error, "forbidden");
    rig.herdr.nudges.length = 0;
    const grok = await rig.ubus.call(
      "ubus_agent_send",
      { address: "eta-refuter", text: "pane-secret-phrase count=9 path=~/dev/eta-lab/c.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal(grok.delivery, "lead_routed");
    assert.equal(grok.lead, "consult-lead");
    assert.equal(rig.herdr.nudges.some((n) => n.name === "eta-refuter"), false);
    const lead = await rig.ubus.call("ubus_inbox", { peek: true }, caller("consult-lead"));
    const messages = lead.messages as Array<{ for_pane: string; body: string }>;
    const routed = messages.find((m) => m.for_pane === "eta-refuter");
    assert.ok(routed);
    assert.match(routed.body, /pane-secret-phrase/);
    const logs = [join(rig.dir, "spool"), join(rig.dir, "audit")].map((d) => tree(d)).join("\n");
    assert.equal(logs.includes("pane-secret-phrase"), false);
    assert.equal(rig.herdr.nudges.map((n) => n.text).join("\n").includes("pane-secret-phrase"), false);
  } finally {
    rig.cleanup();
  }
});

test("Grok mail for a herdr pane is stored for the lead and does not nudge the pane", async () => {
  const rig = setup();
  try {
    rig.herdr.agents.push(pane("eta-refuter", "consult-lead", "mini", "idle"));
    await register(rig.ubus, "consult-lead", { runtime: "cowork", session: "cowork:consult-lead", owner: "fable" });
    await register(rig.ubus, "eta-refuter", { session: "herdr:default/eta-refuter", owner: "consult-lead" });
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer", machine: "opd-bot" }, "opd-bot");
    const sent = await rig.ubus.call(
      "ubus_send",
      { to: ["eta-refuter"], subject: "question", body: "count=2 path=~/dev/eta-lab/q.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal(sent.ok, true);
    const delivery = sent.delivery as Array<{ to: string; status: string; for_pane?: string }>;
    assert.equal(delivery.some((d) => d.to === "consult-lead" && d.status === "lead_routed" && d.for_pane === "eta-refuter"), true);
    const paneInbox = await rig.ubus.call("ubus_inbox", { peek: true }, caller("eta-refuter"));
    assert.equal((paneInbox.messages as unknown[]).length, 0);
    const leadInbox = await rig.ubus.call("ubus_inbox", { peek: true }, caller("consult-lead"));
    assert.equal((leadInbox.messages as unknown[]).length, 1);
    assert.equal(rig.herdr.nudges.some((n) => n.name === "eta-refuter"), false);
  } finally {
    rig.cleanup();
  }
});

test("a non-Grok message to an idle pane nudges with the fixed text only", async () => {
  const rig = setup();
  try {
    rig.herdr.agents.push(pane("eta-refuter", "consult-lead"));
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "eta-refuter", { session: "herdr:default/eta-refuter", owner: "consult-lead" });
    const body = "count=1 path=~/dev/eta-lab/n.json";
    const sent = await rig.ubus.call("ubus_send", { to: ["eta-refuter"], subject: "fyi", body }, caller("fable"));
    assert.equal(sent.ok, true);
    assert.equal(rig.herdr.nudges.length, 1);
    assert.equal(rig.herdr.nudges[0]?.text, NUDGE_TEXT);
    assert.equal(rig.herdr.nudges[0]?.text.includes(body), false);
  } finally {
    rig.cleanup();
  }
});

test("ETA round trip stays on one thread, Grok uses Liason, others use ubus-bridge", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer", machine: "opd-bot" }, "opd-bot");
    await register(rig.ubus, "cc-mini", { session: "cc:mini-1" });
    rig.eta.markRead(LIAISON_IDENTITY, "1", "read");
    const before = rig.eta.listReceipts();

    const sent = await rig.ubus.call(
      "ubus_send",
      { to: ["consult-lead"], subject: "need a read", body: "path=~/dev/eta-lab/out.json count=3" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal(sent.ok, true);
    const posts = rig.eta.listPosts();
    assert.equal(posts.length, 1);
    assert.equal(posts[0]?.identity, LIAISON_IDENTITY);
    assert.equal(posts[0]?.sender, LIAISON_IDENTITY);
    assert.equal(posts[0]?.recipient, "consult-lead");
    assert.equal(posts[0]?.wake, 0);
    assert.match(posts[0]?.subject || "", /^\[EXT\] \[ubus:designer\] /);
    assert.match(posts[0]?.body || "", new RegExp(String(sent.id)));

    rig.eta.inject({
      sender: "consult-lead",
      recipient: LIAISON_IDENTITY,
      subject: "Re: need a read",
      body: "ack count=1 path=~/dev/eta-lab/out.json",
      threadId: posts[0]!.threadId,
      replyTo: posts[0]!.id,
    });
    assert.equal(rig.ubus.pollEta(), 1);
    assert.deepEqual(rig.eta.listReceipts(), before);

    const inbox = await rig.ubus.call("ubus_inbox", { peek: true }, caller("grok:designer", "opd-bot"));
    const messages = inbox.messages as Array<{ id: string; thread_id: string; body: string; from: { handle: string } }>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.thread_id, sent.thread_id);
    assert.equal(messages[0]?.from.handle, "eta:consult-lead");
    assert.match(messages[0]?.body || "", /ack count=1/);

    const reply = await rig.ubus.call(
      "ubus_reply",
      { reply_to: messages[0]!.id, body: "ack id=back count=1 path=~/dev/eta-lab/out.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal(reply.ok, true);
    assert.equal(reply.thread_id, sent.thread_id);
    const inbound = rig.eta.listPosts().find((p) => p.sender === "consult-lead");
    const back = rig.eta.listPosts().at(-1);
    assert.equal(back?.identity, LIAISON_IDENTITY);
    assert.equal(back?.threadId, posts[0]?.threadId);
    assert.equal(back?.replyTo, inbound?.id);

    const other = await rig.ubus.call(
      "ubus_send",
      { to: ["consult-lead"], subject: "from claude", body: "count=4 path=~/dev/eta-lab/cc.json" },
      caller("cc-mini"),
    );
    assert.equal(other.ok, true);
    const bridged = rig.eta.listPosts().at(-1);
    assert.equal(bridged?.identity, BRIDGE_IDENTITY);
    assert.equal(bridged?.subject.startsWith("[EXT]"), false);
    assert.match(bridged?.subject || "", /^\[ubus:cc-mini\] /);

    rig.herdr.agents.push(pane("hist-bulk", "fable", "eta-lab-t4"));
    const panePost = await rig.ubus.call(
      "ubus_send",
      { to: ["hist-bulk"], subject: "build", body: "count=1 path=~/dev/eta-lab/hist.json" },
      caller("cc-mini"),
    );
    assert.equal(panePost.ok, true);
    assert.equal(rig.eta.listPosts().at(-1)?.recipient, "hist-bulk");
    assert.equal(rig.eta.listPosts().at(-1)?.identity, BRIDGE_IDENTITY);

    rig.eta.inject({
      sender: "fable",
      recipient: LIAISON_IDENTITY,
      subject: "[to:grok:designer] hello",
      body: "count=1 path=~/dev/eta-lab/hello.json",
    });
    const tagged = rig.ubus.pollEta();
    assert.equal(tagged >= 1, true);
    const again = await rig.ubus.call("ubus_inbox", { peek: true, unread_only: true }, caller("grok:designer", "opd-bot"));
    const taggedMsg = (again.messages as Array<{ subject: string }>).find((m) => m.subject.includes("[to:grok:designer]"));
    assert.ok(taggedMsg);
    assert.deepEqual(rig.eta.listReceipts(), before);
  } finally {
    rig.cleanup();
  }
});

test("Liason bridge budget queues a digest that carries ids only", async () => {
  const rig = setup((cfg) => {
    cfg.limits.bridgePerHour = 1;
  });
  try {
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer" }, "opd-bot");
    const first = await rig.ubus.call(
      "ubus_send",
      { to: ["consult-lead"], subject: "one", body: "ORIGINALBODY count=1 path=~/dev/eta-lab/1.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal((first.delivery as Array<{ status: string }>)[0]?.status, "bridged_eta");
    const second = await rig.ubus.call(
      "ubus_send",
      { to: ["consult-lead"], subject: "two", body: "ORIGINALBODY count=2 path=~/dev/eta-lab/2.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal((second.delivery as Array<{ status: string }>)[0]?.status, "queued_digest");
    assert.equal(rig.eta.listPosts().length, 1);
    rig.clock.advance(HOUR_MS + 1000);
    rig.ubus.sweep();
    const posts = rig.eta.listPosts();
    assert.equal(posts.length, 2);
    const digest = posts[1]!;
    assert.match(digest.subject, /\[ubus\] 1 messages for you/);
    assert.match(digest.body, /ids /);
    assert.equal(digest.body.includes("ORIGINALBODY"), false);
    assert.equal(digest.identity, LIAISON_IDENTITY);
  } finally {
    rig.cleanup();
  }
});

test("cold flush writes only when the Time Machine UUID matches", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "worker");
    await rig.ubus.call("ubus_send", { to: ["worker"], subject: "note", body: "count=1 path=~/dev/eta-lab/z.json" }, caller("fable"));
    rig.probe.set({ mounted: true, uuid: "00000000-0000-0000-0000-000000000000", writable: true });
    rig.ubus.archive.seal();
    const bad = rig.ubus.archive.flush({ force: true });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, "uuid_mismatch");
    assert.equal(existsSync(rig.cfg.coldRoot), false);
    assert.equal(rig.ubus.archive.listCold().length, 0);

    rig.probe.set({ mounted: true, uuid: TIME_MACHINE_VOLUME_UUID, writable: true });
    const good = rig.ubus.archive.flush({ force: true });
    assert.equal(good.ok, true);
    const files = rig.ubus.archive.listCold().filter((p) => p.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const chain = verifyChain(readFileSync(files[0]!, "utf8"));
    assert.equal(chain.ok, true, chain.error);
    const day = rig.ubus.archive.listCold().some((p) => p.includes("MANIFEST-2026-10-11.json"));
    assert.equal(day, true);
  } finally {
    rig.cleanup();
  }
});

test("an unmounted cold volume queues the spool and alerts MiniBot once until the repeat window", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await rig.ubus.call("ubus_send", { to: ["fable"], subject: "keep", body: "count=1 path=~/dev/eta-lab/keep.json" }, caller("fable"));
    rig.probe.set({ mounted: false, uuid: null, writable: false });
    rig.ubus.archive.seal();
    const first = rig.ubus.archive.flush({ force: true });
    assert.equal(first.reason, "unmounted");
    assert.equal(rig.ubus.archive.listCold().length, 0);
    assert.equal(rig.ubus.archive.status().degraded, true);
    const inbox = await rig.ubus.call("ubus_inbox", { peek: true }, caller("grok:minibot"));
    const messages = inbox.messages as Array<{ body: string; subject: string }>;
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.body, /spool \d+ bytes/);
    assert.match(messages[0]!.body, /segments pending/);
    assert.equal(rig.handoff.records.length, 1);
    assert.equal(rig.handoff.records[0]?.project, "ubus-archive");
    const second = rig.ubus.archive.flush();
    assert.equal(second.reason, "backoff");
    assert.equal(rig.handoff.records.length, 1);
    rig.clock.advance(6 * HOUR_MS + 1000);
    const third = rig.ubus.archive.flush({ force: true });
    assert.equal(third.reason, "unmounted");
    assert.equal(rig.handoff.records.length, 2);
    assert.equal(existsSync(rig.cfg.coldRoot), false);
  } finally {
    rig.cleanup();
  }
});

test("presence, rate limit, kill switch, and request correlation", async () => {
  const rig = setup((cfg) => {
    cfg.limits.sendsPerHour = 2;
  });
  try {
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer" }, "opd-bot");
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v", orchestrator: "v" });
    await register(rig.ubus, "worker", { orchestrator: "fable" });
    rig.clock.advance(10 * 60 * 1000);
    const dir = await rig.ubus.call("ubus_directory", { q: "designer" }, caller("fable"));
    const agents = dir.agents as Array<{ handle: string; presence: string }>;
    assert.equal(agents.find((a) => a.handle === "grok:designer")?.presence, "turn-based");
    rig.clock.advance(3 * 60 * 1000);
    const stale = await rig.ubus.call("ubus_directory", { q: "worker" }, caller("fable"));
    assert.equal((stale.agents as Array<{ handle: string; presence: string }>).find((a) => a.handle === "worker")?.presence, "stale");

    const a = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "a", body: "count=1 path=~/a" }, caller("worker"));
    const b = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "b", body: "count=1 path=~/b" }, caller("worker"));
    const c = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "c", body: "count=1 path=~/c" }, caller("worker"));
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(c.error, "rate_limited");

    const req = await rig.ubus.call("ubus_request", { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" }, caller("worker"));
    // worker already used 2 sends; request is another send
    assert.equal(req.error, "rate_limited");
    rig.clock.advance(HOUR_MS + 1);
    const req2 = await rig.ubus.call("ubus_request", { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" }, caller("worker"));
    assert.equal(req2.ok, true);
    const inbox = await rig.ubus.call("ubus_inbox", {}, caller("fable"));
    const msg = (inbox.messages as Array<{ id: string }>)[0]!;
    const reply = await rig.ubus.call("ubus_reply", { reply_to: msg.id, body: "count=4 path=~/dev/eta-lab/r.json", corr_id: req2.corr_id }, caller("fable"));
    assert.equal(reply.ok, true);
    const view = await rig.ubus.call("ubus_await", { corr_id: req2.corr_id, timeout_s: 0 }, caller("worker"));
    assert.equal(view.state, "answered");
    assert.equal(view.body, "count=4 path=~/dev/eta-lab/r.json");
    assert.equal(view.thread_id, req2.thread_id);

    writeFileSync(rig.cfg.stopFile, "stop\n");
    const paused = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "no", body: "count=1 path=~/no" }, caller("worker"));
    assert.equal(paused.error, "paused");
    const who = await rig.ubus.call("ubus_whoami", {}, caller("worker"));
    assert.equal(who.ok, true);
    const still = await rig.ubus.call("ubus_inbox", { peek: true }, caller("worker"));
    assert.equal(still.ok, true);

    const gated = await rig.ubus.call("ubus_broadcast", { group: "group:mini-panes", subject: "hi", body: "count=1 path=~/p" }, caller("grok:designer", "opd-bot"));
    assert.equal(gated.error, "paused");
  } finally {
    rig.cleanup();
  }
});

test("a tampered segment breaks the hash chain", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    rig.ubus.archive.seal();
    const good = rig.ubus.archive.flush({ force: true });
    assert.equal(good.ok, true);
    const file = rig.ubus.archive.listCold().find((p) => p.endsWith(".jsonl"));
    assert.ok(file);
    const text = readFileSync(file!, "utf8");
    assert.equal(verifyChain(text).ok, true);
    const broken = text.replace("ubus", "XXXX");
    assert.equal(verifyChain(broken).ok, false);
  } finally {
    rig.cleanup();
  }
});

test("grok broadcast into pane groups is owner-gated and wait is refused", async () => {
  const rig = setup();
  try {
    rig.herdr.agents.push(pane("eta-refuter", "consult-lead"));
    await register(rig.ubus, "grok:designer", { runtime: "grok", session: "grok:designer" }, "opd-bot");
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const gated = await rig.ubus.call(
      "ubus_broadcast",
      { group: "group:mini-panes", subject: "hi", body: "count=1 path=~/dev/eta-lab/g.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal(gated.error, "owner_gated");
    const wait = await rig.ubus.call("ubus_wait", { timeout_s: 0 }, caller("grok:designer", "opd-bot"));
    assert.equal(wait.error, "grok_no_poll");
    const all = await rig.ubus.call(
      "ubus_broadcast",
      { group: "group:all-agents", subject: "hi", body: "count=1 path=~/dev/eta-lab/g.json" },
      caller("grok:designer", "opd-bot"),
    );
    assert.equal(all.error, "forbidden");
    const ok = await rig.ubus.call(
      "ubus_broadcast",
      { group: "group:eta-leads", subject: "hi", body: "count=1 path=~/dev/eta-lab/g.json" },
      caller("fable"),
    );
    assert.equal(ok.ok, true);
  } finally {
    rig.cleanup();
  }
});
