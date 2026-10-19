import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Ubus } from "../src/bus.js";
import { caller, register, setup } from "./helpers.js";
type Rig = ReturnType<typeof setup>;
type R = Record<string, unknown>;
const on = (rig: Rig) => { process.env.UBUS_V3 = "1"; process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db"); process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json"); };
const off = () => { delete process.env.UBUS_V3; delete process.env.UBUS_V3_DB; delete process.env.UBUS_V3_ALLOWLIST; };
const hubOf = (u: Ubus) => (u as unknown as { hub(): { register(id: string): unknown; inbox(a: R, c: unknown): R } }).hub();
const safe = async (p: Promise<unknown>): Promise<R> => { try { return (await p) as R; } catch (e) { return { threw: String((e as Error).message) }; } };
const send = (rig: Rig, a: R, who = "worker") => safe(rig.ubus.call("ubus_send", { subject: "s", body: "ids only", ...a }, caller(who)));
const inbox = async (rig: Rig, who: string, a: R = {}) => ((await rig.ubus.call("ubus_inbox", a, caller(who))) as R).messages as R[];
const v3n = (rig: Rig, who: string) => (hubOf(rig.ubus).inbox({ peek: true, limit: 100 }, caller(who)).messages as R[]).length;
async function rig(fn: (r: Rig) => Promise<void>) {
  const r = setup(); on(r);
  try { await register(r.ubus, "worker"); await register(r.ubus, "plain-one"); hubOf(r.ubus).register("node-x"); await fn(r); } finally { off(); r.cleanup(); }
}
const st = (r: R) => ((r.delivery as R[]) ?? []).map((d) => `${d.to}:${d.status}`).sort();

test("R7-ADV1 mixed idempotent retry: no v3 duplicate, statuses stable", () => rig(async (r) => {
  const a = await send(r, { to: ["plain-one", "node-x"], idempotency_key: "k" });
  const b = await send(r, { to: ["plain-one", "node-x"], idempotency_key: "k" });
  assert.equal(v3n(r, "node-x"), 1, "v3 duplicate on idempotent retry");
}));

test("R7-ADV1b mixed idempotent retry statuses stable", () => rig(async (r) => {
  const a = await send(r, { to: ["plain-one", "node-x"], idempotency_key: "k" });
  const b = await send(r, { to: ["plain-one", "node-x"], idempotency_key: "k" });
  assert.deepEqual(st(b), st(a), "retry statuses differ: " + JSON.stringify([st(a), st(b)]));
}));

test("R7-ADV4 alias of a v1-registered handle plus the handle: one copy", async () => {
  const r = setup(); on(r);
  try {
    await register(r.ubus, "worker"); await register(r.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const res = await send(r, { to: ["fable", "cc-air-work-local"] });
    assert.equal(res.ok, true);
    const n = (await inbox(r, "fable", { limit: 100 })).length;
    assert.equal(n, 1, `fable got ${n} copies; delivery ${JSON.stringify(st(res))}`);
  } finally { off(); r.cleanup(); }
});

test("R7-ADV5 alias mail to a v1 agent is counted in unreadSummary", async () => {
  const r = setup(); on(r);
  try {
    await register(r.ubus, "worker"); await register(r.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await send(r, { to: ["cc-air-work-local"] });
    assert.equal(r.ubus.unreadSummary("fable").count, 1);
  } finally { off(); r.cleanup(); }
});

test("R7-ADV6 pure-v3 failure has v1 error shape (no extra fields)", () => rig(async (r) => {
  const res = await send(r, { to: ["node-x"], kind: "bogus" });
  assert.equal(res.ok, false);
  assert.equal("reason" in res, false, JSON.stringify(res));
}));

test("R7-ADV8 mixed send with v3 throw after v1 commit: no throw, failed", () => rig(async (r) => {
  const h = hubOf(r.ubus) as unknown as { send: (...a: unknown[]) => R };
  const orig = h.send.bind(h);
  h.send = () => { throw new Error("boom"); };
  try {
    const res = await send(r, { to: ["plain-one", "node-x"] });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(st(res), ["node-x:failed", "plain-one:stored"]);
    assert.equal((await inbox(r, "plain-one")).length, 1);
  } finally { h.send = orig; }
}));

test("R7-ADV10 reply_to a v1 message, sent to a v3-only recipient, joins the parent thread", () => rig(async (r) => {
  const p = await send(r, { to: ["plain-one"] });
  const res = await send(r, { to: ["node-x"], reply_to: p.id });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.thread_id, p.thread_id);
}));

test("R7-ADV11 merged inbox mixed tail: only returned v1 mail is marked read", () => rig(async (r) => {
  await register(r.ubus, "node-x");
  const v3send = (subject: string) => (hubOf(r.ubus) as unknown as { send(a: R, c: unknown, l: R): R }).send({ to: ["node-x"], subject, body: "ids only" }, caller("worker"), {});
  await send(r, { to: ["node-x"], subject: "v1-a" }); r.clock.advance(10);
  v3send("v3-a"); r.clock.advance(10);
  await send(r, { to: ["node-x"], subject: "v1-b" }); r.clock.advance(10);
  v3send("v3-b"); r.clock.advance(10);
  const got = (await inbox(r, "node-x", { limit: 2 })).map((m) => m.subject);
  assert.deepEqual(got, ["v1-b", "v3-b"]);
  const rest = (await inbox(r, "node-x", { limit: 100 })).map((m) => m.subject);
  assert.deepEqual(rest, ["v1-a", "v3-a"]);
}));

test("R7-S8 ubus_ack with bad args has the same shape flag on and off", async () => {
  const r = setup();
  try {
    await register(r.ubus, "worker");
    const flagOff = (await r.ubus.call("ubus_ack", { id: "x" }, caller("worker"))) as R;
    on(r);
    const flagOn = (await r.ubus.call("ubus_ack", { id: "x" }, caller("worker"))) as R;
    assert.deepEqual(flagOn, flagOff);
  } finally { off(); r.cleanup(); }
});

// ---- R8 ----
test("R8-F1 alias of a bridge-only canonical is not rewritten: mail stays in v3", async () => {
  const r = setup(); on(r);
  try {
    await register(r.ubus, "worker");
    const res = await send(r, { to: ["cc-air-work-local"] });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.match(String(res.id), /^v3:/, JSON.stringify(res));
    assert.equal(st(res).some((x) => x.includes("bridged")), false, JSON.stringify(res));
    assert.equal(v3n(r, "cc-air-work-local"), 1);
  } finally { off(); r.cleanup(); }
});

test("R8-F1b duplicate v3-only recipients with no rewrite are echoed unchanged", () => rig(async (r) => {
  const res = await send(r, { to: ["node-x", "node-x"] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(((res.delivery as R[]) ?? []).map((d) => d.to), ["node-x", "node-x"], JSON.stringify(res));
}));

test("R8-F2 v3-only idempotent retry returns the first id and stores one copy", () => rig(async (r) => {
  const a = await send(r, { to: ["node-x"], idempotency_key: "k2" });
  const b = await send(r, { to: ["node-x"], idempotency_key: "k2" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(b.id, a.id);
  assert.equal(b.idempotent, true);
  assert.equal(v3n(r, "node-x"), 1);
  const c = await send(r, { to: ["node-x"], idempotency_key: "k3" });
  assert.notEqual(c.id, a.id);
  assert.equal(v3n(r, "node-x"), 2);
}));

test("R8-CB send to X delivers to live cb-X, and either name reads it (flag off too)", async () => {
  const r = setup();
  try {
    await register(r.ubus, "worker"); await register(r.ubus, "cb-fable-deputy");
    const res = await send(r, { to: ["fable-deputy"] });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(r.ubus.unreadSummary("cb-fable-deputy").count, 1);
    assert.equal((await inbox(r, "fable-deputy", { peek: true })).length, 0, "unregistered twin name reads nothing");
    assert.equal((await inbox(r, "cb-fable-deputy")).length, 1);
    assert.equal(r.ubus.unreadSummary("cb-fable-deputy").count, 0);
  } finally { r.cleanup(); }
});

test("R8-CB send to cb-X delivers to live X; both registered read each other's mail once", async () => {
  const r = setup(); on(r);
  try {
    await register(r.ubus, "worker");
    const c = { ...caller(undefined), sessionId: "conn-fd" };
    await r.ubus.call("ubus_register", { handle: "fable-deputy", machine: "mini", runtime: "claude-code", session: "s:fd" }, c);
    const res = await send(r, { to: ["cb-fable-deputy"] });
    assert.equal(res.ok, true, JSON.stringify(res));
    await r.ubus.call("ubus_register", { handle: "cb-fable-deputy", machine: "mini", runtime: "claude-code", session: "s:cbfd" }, c);
    await send(r, { to: ["fable-deputy", "cb-fable-deputy"] });
    const got = ((await r.ubus.call("ubus_inbox", { limit: 100 }, { ...caller("cb-fable-deputy"), sessionId: "conn-fd" })) as R).messages as R[];
    assert.equal(got.length, 2, "deduped by id");
    assert.equal((await inbox(r, "fable-deputy", { limit: 100 })).length, 0);
  } finally { off(); r.cleanup(); }
});
