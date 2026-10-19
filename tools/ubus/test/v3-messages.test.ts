import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { sha256 } from "../src/util.js";
import { CHAIN, SUBJECT_MAX_CHARS, openHub, type Hub } from "../src/v3/hub.js";
import type { EventInput } from "../src/v3/eventlog.js";
import { caller, register, setup, type TestRig } from "./helpers.js";

/** Mirrors the product export (UTF-8 bytes); kept literal so this file also compiles against the pre-R3 build. */
const BODY_MAX_BYTES = 280;

/** The contract under test: HMAC-SHA256 of the lower-cased name under the hub's 0600 key file, 16 hex. */
function refFor(dir: string): (name: string) => string {
  const key = readFileSync(join(dir, "v3", "namekey"));
  return (name: string) => `hmac:${createHmac("sha256", key).update(name.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

function hubFor(rig: TestRig): Hub {
  return openHub({
    dbPath: join(rig.dir, "v3", "eventlog.db"),
    clock: rig.clock,
    allowlistPath: join(rig.dir, "allowlist.json"),
  });
}

test("every message returned by inbox carries a per-recipient state", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const sent = hub.send({ to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/a.json" }, caller("fable"));
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const peeked = hub.inbox({ peek: true }, caller("fable"));
    assert.equal(peeked.ok, true);
    for (const m of peeked.messages as Array<Record<string, unknown>>) {
      assert.equal(typeof m.state, "string");
      assert.equal((CHAIN as readonly string[]).includes(String(m.state)), true, `bad state ${String(m.state)}`);
      assert.equal(m.delivery_status, m.state);
    }
    const read = hub.inbox({}, caller("fable"));
    for (const m of read.messages as Array<Record<string, unknown>>) {
      assert.equal((CHAIN as readonly string[]).includes(String(m.state)), true);
      assert.equal(m.state, "read");
      assert.equal(m.read, true);
    }
    assert.equal(hub.stateOf(String(sent.id), "fable")?.state, "read");
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("illegal state transitions are refused", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const sent = hub.send({ to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/b.json" }, caller("fable"));
    assert.equal(sent.ok, true);
    const mid = String(sent.id);
    assert.equal(hub.stateOf(mid, "fable")?.state, "stored");

    const skip = hub.done(mid, "fable");
    assert.equal(skip.ok, false, JSON.stringify(skip));
    assert.equal((skip as { error?: string }).error, "illegal_transition");
    assert.equal((skip as { from?: string }).from, "stored");
    assert.equal((skip as { to?: string }).to, "done");

    const ackEarly = hub.ack(mid, "fable");
    assert.equal(ackEarly.ok, false, JSON.stringify(ackEarly));
    assert.equal((ackEarly as { from?: string }).from, "stored");
    assert.equal(hub.stateOf(mid, "fable")?.state, "stored", "a refused transition changes nothing");

    hub.inbox({ peek: true }, caller("fable"));
    assert.equal(hub.stateOf(mid, "fable")?.state, "delivered");
    const doneEarly = hub.done(mid, "fable");
    assert.equal(doneEarly.ok, false, JSON.stringify(doneEarly));
    assert.equal((doneEarly as { from?: string }).from, "delivered");

    hub.inbox({}, caller("fable"));
    assert.equal(hub.stateOf(mid, "fable")?.state, "read");
    const ack = hub.ack(mid, "fable");
    assert.equal(ack.ok, true, JSON.stringify(ack));
    const done = hub.done(mid, "fable");
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(hub.stateOf(mid, "fable")?.state, "done");

    const reread = hub.inbox({}, caller("fable"));
    assert.equal((reread.messages as unknown[]).length, 0, "a done message no longer shows as unread");
    const extra = hub.done(mid, "fable");
    assert.equal(extra.ok, true, "the same terminal state is a no-op");
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("rejection reasons are machine-readable: too_long, unknown_agent, phi_filter", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const longSubject = hub.send({ to: ["fable"], subject: "s".repeat(SUBJECT_MAX_CHARS + 1), body: "count=1 path=~/x" }, caller("fable"));
    assert.equal(longSubject.ok, false);
    assert.equal(longSubject.reason, "too_long");
    assert.equal(longSubject.field, "subject");
    assert.equal(longSubject.limit, SUBJECT_MAX_CHARS);

    const longBody = hub.send({ to: ["fable"], subject: "note", body: "b".repeat(BODY_MAX_BYTES + 1) }, caller("fable"));
    assert.equal(longBody.ok, false);
    assert.equal(longBody.reason, "too_long");
    assert.equal(longBody.field, "body");
    assert.equal(longBody.limit, BODY_MAX_BYTES);

    const bodyRef = hub.send({ to: ["fable"], subject: "note", body: "", body_ref: "~/dev/eta-lab/big.txt" }, caller("fable"));
    assert.equal(bodyRef.ok, true, `body_ref should cover an empty body: ${JSON.stringify(bodyRef)}`);

    const ref = refFor(rig.dir);
    const unknown = hub.send({ to: ["ghost"], subject: "note", body: "count=1 path=~/x" }, caller("fable"));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error, "unknown_agent");
    assert.equal(unknown.reason, "unknown_agent");
    assert.deepEqual(unknown.to, [ref("ghost")], "an unknown name is echoed as an HMAC prefix only");

    const mixed = hub.send({ to: ["fable", "ghost"], subject: "note", body: "count=1 path=~/y" }, caller("fable"));
    assert.equal(mixed.ok, true, JSON.stringify(mixed));
    const delivery = mixed.delivery as Array<{ to: string; status: string; reason?: string }>;
    assert.deepEqual(
      delivery.map((d) => ({ to: d.to, status: d.status, reason: d.reason ?? null })),
      [
        { to: "fable", status: "stored", reason: null },
        { to: ref("ghost"), status: "rejected", reason: "unknown_agent" },
      ],
    );
    assert.equal(hub.stateOf(String(mixed.id), "ghost")?.state, "rejected");
    assert.equal(hub.stateOf(String(mixed.id), "ghost")?.reason, "unknown_agent");

    const phi = hub.send({ to: ["fable"], subject: "chart", body: "call 9000000001 back" }, caller("fable"));
    assert.equal(phi.ok, false);
    assert.equal(phi.error, "phi_filter");
    assert.equal(String(phi.reason).startsWith("phi_filter:"), true);
    assert.ok(Array.isArray(phi.spans));
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("the message model carries kind, priority and sla_s", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const sent = hub.send(
      { to: ["fable"], subject: "need", body: "count=1 path=~/dev/eta-lab/c.json", kind: "request", priority: "high", sla_s: 120 },
      caller("fable"),
    );
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const msg = hub.messages.message(String(sent.id));
    assert.ok(msg);
    assert.equal(msg.kind, "request");
    assert.equal(msg.priority, "high");
    assert.equal(msg.slaS, 120);
    assert.ok(msg.subject.length <= SUBJECT_MAX_CHARS);
    assert.equal(msg.threadId, sent.thread_id);

    const badKind = hub.send({ to: ["fable"], subject: "need", body: "count=1 path=~/x", kind: "nope" }, caller("fable"));
    assert.equal(badKind.ok, false);
    assert.equal(badKind.reason, "invalid");
    const badPriority = hub.send({ to: ["fable"], subject: "need", body: "count=1 path=~/x", priority: "urgent" }, caller("fable"));
    assert.equal(badPriority.ok, false);
    assert.equal(badPriority.reason, "invalid");
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("R2-1: the body limit holds with a body_ref, and inline body with body_ref is refused", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const withRef = hub.send(
      { to: ["fable"], subject: "s", body: "b".repeat(281), body_ref: "~/dev/x.json" },
      caller("fable"),
    );
    assert.equal(withRef.ok, false, "a 281-char body was accepted because a body_ref was attached");
    assert.equal(withRef.reason, "too_long");
    assert.equal(withRef.field, "body");

    const both = hub.send({ to: ["fable"], subject: "s", body: "short inline body", body_ref: "~/dev/x.json" }, caller("fable"));
    assert.equal(both.ok, false, "inline body together with body_ref must be refused");
    assert.equal(both.reason, "invalid");

    const exact = hub.send({ to: ["fable"], subject: "s", body: "b".repeat(BODY_MAX_BYTES) }, caller("fable"));
    assert.equal(exact.ok, true, JSON.stringify(exact));
    const refOnly = hub.send({ to: ["fable"], subject: "s", body: "", body_ref: "~/dev/x.json" }, caller("fable"));
    assert.equal(refOnly.ok, true, JSON.stringify(refOnly));
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("R2-2: message rows and recipient states land in one transaction; replay derives stored from meta.to", () => {
  const rig = setup();
  const dbPath = join(rig.dir, "v3", "eventlog.db");
  const allow = join(rig.dir, "allowlist.json");
  let hub: Hub | null = openHub({ dbPath, clock: rig.clock, allowlistPath: allow });
  try {
    const log = hub.log as unknown as { append: (e: EventInput) => number };
    const orig: (e: EventInput) => number = hub.log.append.bind(hub.log);
    log.append = (e: EventInput) => {
      if (e.kind === "recipient.state") throw new Error("simulated crash");
      return orig(e);
    };
    assert.throws(() => hub!.send({ to: ["fable"], subject: "note", body: "count=1 path=~/x" }, caller("fable")), /simulated crash/);
    log.append = orig;
    hub.close();
    hub = openHub({ dbPath, clock: rig.clock, allowlistPath: allow });
    assert.equal(hub.views().messages.length, 0, "the crashed send left a message row with no recipient state");

    // Even a log that stops right after message.sent replays its stored states.
    hub.log.append({
      ts: rig.clock.iso(),
      actor: "fable",
      kind: "message.sent",
      subjectId: "v3:CRASHPROOF",
      meta: {
        from: "fable",
        kind: "msg",
        priority: "normal",
        sla_s: 0,
        subject: "note",
        body: "count=1 path=~/x",
        body_ref: "",
        thread_id: "t-crashproof",
        to: ["fable"],
        allow_terms: [],
      },
    });
    hub.close();
    hub = openHub({ dbPath, clock: rig.clock, allowlistPath: allow });
    const views = hub.views();
    assert.equal(views.messages.length, 1);
    const states = views.states.find(([mid]) => mid === "v3:CRASHPROOF");
    assert.ok(states && states[1].length > 0, "stored was not derived from meta.to");
    assert.equal(states[1][0]?.[1].state, "stored");
    assert.equal(views.inbox.some(([handle, ids]) => handle === "fable" && ids.includes("v3:CRASHPROOF")), true);
  } finally {
    hub?.close();
    rig.cleanup();
  }
});

test("R2-5/R3-3: unknown to names become an HMAC ref from a 0600 key file, case-folded", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const keyPath = join(rig.dir, "v3", "namekey");
    const mode = statSync(keyPath).mode & 0o777;
    assert.equal(mode, 0o600, `key file mode is ${mode.toString(8)}, expected 600`);
    const ref = refFor(rig.dir);
    assert.equal(ref("GHOST"), ref("ghost"), "the ref must be case-folded");
    assert.equal(ref("9000000001") === `sha256:${sha256("9000000001").slice(0, 16)}`, false, "an unsalted digest is enumerable");

    const mixed = hub.send({ to: ["fable", "9000000001"], subject: "note", body: "count=1 path=~/x" }, caller("fable"));
    assert.equal(mixed.ok, true, JSON.stringify(mixed));
    assert.equal(JSON.stringify(hub.log.all()).includes("9000000001"), false, "raw unknown name written to the log");
    assert.equal(JSON.stringify(mixed).includes("9000000001"), false, "raw unknown name echoed in the response");
    const rejected = (mixed.delivery as Array<{ to: string; status: string }>).find((d) => d.status === "rejected");
    assert.ok(rejected, "no rejected delivery entry");
    assert.equal(rejected.to, ref("9000000001"));
    assert.match(rejected.to, /^hmac:[0-9a-f]{16}$/);
    assert.equal(hub.stateOf(String(mixed.id), "9000000001")?.state, "rejected");
    assert.equal(hub.stateOf(String(mixed.id), "9000000001")?.reason, "unknown_agent");

    const allUnknown = hub.send({ to: ["9000000001"], subject: "note", body: "count=1 path=~/x" }, caller("fable"));
    assert.equal(allUnknown.ok, false);
    assert.equal(allUnknown.error, "unknown_agent");
    assert.equal(JSON.stringify(allUnknown).includes("9000000001"), false, "raw unknown name echoed on failure");
    assert.deepEqual(allUnknown.to, [ref("9000000001")]);
    assert.equal(JSON.stringify(hub.log.all()).includes("9000000001"), false, "raw unknown name persisted");
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("R2-7/R3-5: ubus_ack under the flag acks v3 idempotently and falls through to v1 ids", async () => {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "worker");
    // Written straight to the v3 log: through the shim the alias would now route to v1's fable.
    const sent = (rig.ubus as unknown as { hub(): { send(a: object, c: unknown): Record<string, unknown> } })
      .hub()
      .send({ to: ["cc-air-work-local"], subject: "note", body: "count=1 path=~/dev/eta-lab/a.json" }, caller("worker"));
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const mid = String(sent.id);

    const early = await rig.ubus.call("ubus_ack", { ids: [mid] }, caller("fable"));
    assert.equal(early.ok, true, JSON.stringify(early));
    assert.deepEqual(early.missing, [mid], "a stored message cannot be acked yet");
    assert.deepEqual(early.acked, []);

    const inbox = await rig.ubus.call("ubus_inbox", {}, caller("fable"));
    assert.equal((inbox.messages as Array<{ state: string }>)[0]?.state, "read");

    const ack = await rig.ubus.call("ubus_ack", { ids: [mid] }, caller("fable"));
    assert.deepEqual(ack.acked, [mid], JSON.stringify(ack));
    const afterAck = await rig.ubus.call("ubus_inbox", { unread_only: false }, caller("fable"));
    assert.equal((afterAck.messages as Array<{ state: string }>)[0]?.state, "acked");

    // A repeat ack is idempotent: it reports acked and must not move the row to done.
    const repeat = await rig.ubus.call("ubus_ack", { ids: [mid] }, caller("fable"));
    assert.deepEqual(repeat.acked, [mid], JSON.stringify(repeat));
    const afterRepeat = await rig.ubus.call("ubus_inbox", { unread_only: false }, caller("fable"));
    assert.equal((afterRepeat.messages as Array<{ state: string }>)[0]?.state, "acked", "a repeat ack must not mark done");

    // A v1 id (request/reply/ETA mail) is not known to v3 and falls through to the v1 store.
    const req = await rig.ubus.call(
      "ubus_request",
      { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" },
      caller("worker"),
    );
    assert.equal(req.ok, true, JSON.stringify(req));
    const legacyAck = await rig.ubus.call("ubus_ack", { ids: [String(req.id)] }, caller("fable"));
    assert.equal(legacyAck.ok, true, JSON.stringify(legacyAck));
    assert.deepEqual(legacyAck.acked, [String(req.id)], JSON.stringify(legacyAck));

    const junk = await rig.ubus.call("ubus_ack", { ids: ["ubus:never-existed"] }, caller("fable"));
    assert.deepEqual(junk.missing, ["ubus:never-existed"], JSON.stringify(junk));
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
    rig.cleanup();
  }
});

test("R3-5: ack is idempotent in v3, unknown ids are flagged for fall-through, done only via done", () => {
  const rig = setup();
  const hub = hubFor(rig);
  try {
    const sent = hub.send({ to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/d.json" }, caller("fable"));
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const mid = String(sent.id);
    hub.inbox({}, caller("fable"));
    assert.equal(hub.stateOf(mid, "fable")?.state, "read");

    const first = hub.ackTool({ ids: [mid] }, caller("fable"));
    assert.deepEqual(first.acked, [mid], JSON.stringify(first));
    assert.equal(hub.stateOf(mid, "fable")?.state, "acked");
    const eventsAfterFirst = hub.log.count();

    const repeat = hub.ackTool({ ids: [mid] }, caller("fable"));
    assert.deepEqual(repeat.acked, [mid], JSON.stringify(repeat));
    assert.equal(hub.stateOf(mid, "fable")?.state, "acked", "a repeat ack must stay acked");
    assert.equal(hub.log.count(), eventsAfterFirst, "a repeat ack writes no event");

    const unknown = hub.ackTool({ ids: ["ubus:legacy-2"] }, caller("fable"));
    assert.deepEqual(unknown.unknown, ["ubus:legacy-2"], JSON.stringify(unknown));
    assert.deepEqual(unknown.missing, []);

    const done = hub.done(mid, "fable");
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(hub.stateOf(mid, "fable")?.state, "done");
    const afterDone = hub.ackTool({ ids: [mid] }, caller("fable"));
    assert.deepEqual(afterDone.acked, [mid], JSON.stringify(afterDone));
    assert.equal(hub.stateOf(mid, "fable")?.state, "done", "done only ever via done()");
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("R3-6: the body limit is exported as BODY_MAX_BYTES and counts UTF-8 bytes", async () => {
  const hub = (await import("../src/v3/hub.js")) as Record<string, unknown>;
  assert.equal(hub.BODY_MAX_BYTES, 280, "BODY_MAX_BYTES must be exported with the byte limit");
  assert.equal(hub.BODY_MAX_CHARS, undefined, "the old character-named export must be gone");

  const rig = setup();
  const instance = hubFor(rig);
  try {
    // 141 two-byte characters = 282 bytes > 280: the limit is bytes, not characters.
    const twoByte = "é".repeat(141);
    assert.ok(twoByte.length < BODY_MAX_BYTES, "precondition: fewer chars than the byte limit");
    const over = instance.send({ to: ["fable"], subject: "note", body: twoByte }, caller("fable"));
    assert.equal(over.ok, false, JSON.stringify(over));
    assert.equal(over.reason, "too_long");
    assert.equal(over.field, "body");
    assert.equal(over.got, 282);
    const under = instance.send({ to: ["fable"], subject: "note", body: "é".repeat(140) }, caller("fable"));
    assert.equal(under.ok, true, JSON.stringify(under));
  } finally {
    instance.close();
    rig.cleanup();
  }
});
