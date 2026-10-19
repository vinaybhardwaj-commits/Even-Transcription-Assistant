import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { caller, register, setup } from "./helpers.js";
type Rig = ReturnType<typeof setup>;
type R = Record<string, unknown>;
const on = (rig: Rig) => { process.env.UBUS_V3 = "1"; process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db"); process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json"); };
const off = () => { delete process.env.UBUS_V3; delete process.env.UBUS_V3_DB; delete process.env.UBUS_V3_ALLOWLIST; };
const safe = async (p: Promise<unknown>): Promise<R> => { try { return (await p) as R; } catch (e) { return { threw: String((e as Error).message) }; } };
const send = (r: Rig, a: R, who = "worker") => safe(r.ubus.call("ubus_send", { subject: "s", body: "ids only", ...a }, caller(who)));
const inbox = async (r: Rig, who: string, a: R = {}) => (((await safe(r.ubus.call("ubus_inbox", { limit: 100, ...a }, caller(who)))).messages as R[]) ?? []);
const st = (r: R) => ((r.delivery as R[]) ?? []).map((d) => `${d.to}:${d.status}`).sort();
const H = 13 * 60 * 60 * 1000; // past STALE_GONE_MS
async function both(fn: (r: Rig) => Promise<void>) {
  for (const flag of [false, true]) {
    const r = setup(); if (flag) on(r);
    try { await register(r.ubus, "worker"); await fn(r); } finally { off(); r.cleanup(); }
  }
}

const conn = (who: string | undefined, sid: string) => ({ ...caller(who), sessionId: sid });
const regConn = (r: Rig, handle: string, sid: string) => r.ubus.call("ubus_register", { handle, machine: "mini", runtime: "claude-code", session: `s:${handle}` }, conn(undefined, sid));
// ---- leak: an unrelated agent registering a cb- name of a LIVE agent ----
test("C1 squatter registering cb-<live handle> cannot read that agent's mail", () => both(async (r) => {
  await register(r.ubus, "fable-deputy");
  const s = await send(r, { to: ["fable-deputy"] });
  assert.deepEqual(st(s), ["fable-deputy:stored"]);
  await register(r.ubus, "cb-fable-deputy", { session: "sess-squatter", machine: "air" }, "air");
  assert.equal((await inbox(r, "cb-fable-deputy", { peek: true })).length, 0, "cb- squatter reads a live distinct agent's inbox");
}));
test("C2 squatter's inbox read does not consume the victim's unread", () => both(async (r) => {
  await register(r.ubus, "fable-deputy");
  await send(r, { to: ["fable-deputy"] });
  await register(r.ubus, "cb-fable-deputy", { session: "sess-squatter" });
  await inbox(r, "cb-fable-deputy");
  assert.equal(r.ubus.unreadSummary("fable-deputy").count, 1, "victim's mail marked read by another agent");
}));
test("C3 cb-cb-x does not read cb-x's mail", () => both(async (r) => {
  await register(r.ubus, "cb-x");
  await send(r, { to: ["cb-x"] });
  await register(r.ubus, "cb-cb-x");
  assert.equal((await inbox(r, "cb-cb-x", { peek: true })).length, 0, "cb-cb-x reads cb-x");
}));
// ---- hostile names: no cross delivery ----
test("C4 x-cb / xcb- / CB-x / cb_x are not twins of x", () => both(async (r) => {
  await register(r.ubus, "x");
  for (const n of ["x-cb", "cb_x", "CB-x", "cbx", "cb--x"]) {
    const s = await send(r, { to: [n] });
    assert.equal(s.ok, false, `${n} -> ${JSON.stringify(st(s))}`);
  }
  assert.equal((await inbox(r, "x")).length, 0);
}));
test("C5 send to cb-cb-x with only cb-x live is unknown, not cb-x", () => both(async (r) => {
  await register(r.ubus, "x");
  const s = await send(r, { to: ["cb-cb-x"] });
  assert.equal(s.ok, false, JSON.stringify(st(s)));
}));
test("C6 handle 'cb-' sees its own mail", () => both(async (r) => {
  await register(r.ubus, "cb-");
  const s = await send(r, { to: ["cb-"] });
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal((await inbox(r, "cb-", { peek: true })).length, 1, "cb- handle loses its own mail");
  assert.equal(r.ubus.unreadSummary("cb-").count, 1);
}));

test("R9-C7 send to unregistered 'cb-' does not throw or hit another agent", () => both(async (r) => {
  await register(r.ubus, "cb");
  const s = await send(r, { to: ["cb-"] });
  assert.equal(s.ok, false, JSON.stringify(s));
}));
test("R9-P2 both X and cb-X live: send to X stores only under X", () => both(async (r) => {
  await register(r.ubus, "p"); await register(r.ubus, "cb-p");
  assert.deepEqual(st(await send(r, { to: ["p"] })), ["p:stored"]);
  assert.deepEqual(st(await send(r, { to: ["cb-p"] })), ["cb-p:stored"]);
}));
test("R9-twin delivery: X absent, cb-X live goes to cb-X; X a gone different agent stays unknown", () => both(async (r) => {
  await register(r.ubus, "cb-q");
  assert.deepEqual(st(await send(r, { to: ["q"] })), ["cb-q:stored"]);
  await register(r.ubus, "g");
  r.clock.advance(H); await register(r.ubus, "worker"); await register(r.ubus, "cb-g");
  assert.equal((await send(r, { to: ["g"] })).ok, false);
}));
test("R9-P8 wait as cb-X (same connection) wakes on send to X", () => both(async (r) => {
  await regConn(r, "cb-v", "c1"); await regConn(r, "v", "c1");
  const p = r.ubus.call("ubus_wait", { timeout_s: 3 }, conn("cb-v", "c1")) as Promise<R>;
  const t0 = Date.now();
  await send(r, { to: ["v"] });
  const w = await p;
  assert.ok(Date.now() - t0 < 2000, "not woken");
  assert.equal(w.count, 1);
}));
test("R9-P7 ack as X of mail under cb-X works for the same connection, not another", () => both(async (r) => {
  await regConn(r, "z", "c1"); await regConn(r, "cb-z", "c1");
  const s = await send(r, { to: ["cb-z"] });
  const bad = (await r.ubus.call("ubus_ack", { ids: [s.id] }, conn("z", "c2"))) as R;
  assert.deepEqual(bad.acked, [], "other connection acked");
  const a = (await r.ubus.call("ubus_ack", { ids: [s.id] }, conn("z", "c1"))) as R;
  assert.deepEqual(a.acked, [s.id], JSON.stringify(a));
}));
test("R9-P9/P16 mail to both X and cb-X (same connection): count and ids deduped", () => both(async (r) => {
  await regConn(r, "p", "c1"); await regConn(r, "cb-p", "c1");
  await send(r, { to: ["p", "cb-p"] });
  const u = r.ubus.unreadSummary("p");
  assert.equal(u.count, 1); assert.equal(u.ids.length, 1);
  assert.equal((((await r.ubus.call("ubus_inbox", { limit: 100 }, conn("p", "c1"))) as R).messages as R[]).length, 1);
}));
test("R9-P13 F2: different sender same key separate; retry echoes the first", async () => {
  const r = setup(); on(r);
  try {
    await register(r.ubus, "worker"); await register(r.ubus, "w2");
    const h = (r.ubus as unknown as { hub(): { register(id: string): unknown } }).hub(); h.register("node-x");
    const a = await send(r, { to: ["node-x"], idempotency_key: "k" });
    const b = await send(r, { to: ["node-x"], idempotency_key: "k" }, "w2");
    assert.notEqual(a.id, b.id);
    const c = await send(r, { to: ["node-x"], idempotency_key: "k" });
    assert.equal(c.id, a.id); assert.deepEqual(st(c), st(a));
  } finally { off(); r.cleanup(); }
});
test("R9-pairing symmetric: send to cb-cb-x with cb-x live is unknown", () => both(async (r) => {
  await register(r.ubus, "cb-x");
  assert.equal((await send(r, { to: ["cb-cb-x"] })).ok, false);
}));
