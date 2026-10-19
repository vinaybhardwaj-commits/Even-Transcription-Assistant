import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Ubus } from "../src/bus.js";
import { caller, register, setup } from "./helpers.js";

type Rig = ReturnType<typeof setup>;
type R = Record<string, unknown>;
type Hubby = { hub(): { register(id: string): unknown; resolves(n: string): boolean } };

function on(rig: Rig): void {
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
}
function off(): void {
  delete process.env.UBUS_V3;
  delete process.env.UBUS_V3_DB;
  delete process.env.UBUS_V3_ALLOWLIST;
}
const hubOf = (u: Ubus) => (u as unknown as Hubby).hub();
const send = (rig: Rig, a: R, who = "worker") => rig.ubus.call("ubus_send", { subject: "s", body: "ids only", ...a }, caller(who)) as Promise<R>;
const inbox = (rig: Rig, who: string, a: R = {}) => rig.ubus.call("ubus_inbox", a, caller(who)) as Promise<R>;
const rows = (r: R) => r.messages as R[];

async function withRig(fn: (rig: Rig) => Promise<void>): Promise<void> {
  const rig = setup();
  on(rig);
  try {
    await register(rig.ubus, "worker");
    await register(rig.ubus, "plain-one");
    hubOf(rig.ubus).register("node-x");
    await fn(rig);
  } finally {
    off();
    rig.cleanup();
  }
}

test("R6-1: thread_id is shared across legs of a mixed send", async () => {
  await withRig(async (rig) => {
    const res = await send(rig, { to: ["plain-one", "node-x"] });
    assert.equal(res.ok, true, JSON.stringify(res));
    const a = rows(await inbox(rig, "plain-one"));
    const b = rows(await inbox(rig, "node-x"));
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].thread_id, b[0].thread_id);
    assert.equal(res.thread_id, a[0].thread_id);
  });
});

test("R6-2: merged inbox sorts by ts, then id; v1 order kept", async () => {
  await withRig(async (rig) => {
    await send(rig, { to: ["node-x"], subject: "v3-old" });
    rig.clock.advance(1000);
    await register(rig.ubus, "node-x");
    await send(rig, { to: ["node-x"], subject: "v1-first" });
    await send(rig, { to: ["node-x"], subject: "v1-second" });
    const got = rows(await inbox(rig, "node-x", { peek: true })).map((m) => m.subject);
    assert.deepEqual(got, ["v3-old", "v1-first", "v1-second"]);
  });
  await withRig(async (rig) => {
    await send(rig, { to: ["node-x"], subject: "v3-tie" });
    await register(rig.ubus, "node-x");
    await send(rig, { to: ["node-x"], subject: "v1-tie-a" });
    await send(rig, { to: ["node-x"], subject: "v1-tie-b" });
    const got = rows(await inbox(rig, "node-x", { peek: true })).map((m) => m.subject);
    // Equal ts: cross-source ties break on id ("ubus:" < "v3:"); each source keeps its own order.
    assert.deepEqual(got, ["v1-tie-a", "v1-tie-b", "v3-tie"]);
  });
});

test("R6-3: inbox limit applies once to the merged list and only returned mail is marked read", async () => {
  await withRig(async (rig) => {
    for (let i = 0; i < 3; i++) {
      await send(rig, { to: ["node-x"], subject: `a${i}` });
      rig.clock.advance(1000);
    }
    await register(rig.ubus, "node-x");
    for (let i = 0; i < 3; i++) {
      await send(rig, { to: ["node-x"], subject: `b${i}` });
      rig.clock.advance(1000);
    }
    const got = rows(await inbox(rig, "node-x", { limit: 2 }));
    assert.deepEqual(got.map((m) => m.subject), ["b1", "b2"]);
    const rest = rows(await inbox(rig, "node-x", { limit: 100 }));
    assert.deepEqual(rest.map((m) => m.subject), ["a0", "a1", "a2", "b0"]);
  });
});

test("R6-4: resolves() falls back to a live v1-registered agent", async () => {
  await withRig(async (rig) => {
    assert.equal(hubOf(rig.ubus).resolves("plain-one"), true);
    assert.equal(hubOf(rig.ubus).resolves("node-x"), true);
    assert.equal(hubOf(rig.ubus).resolves("nobody-here"), false);
  });
});

test("R6-5: a v3 failure in a mixed send surfaces per recipient and does not duplicate", async () => {
  await withRig(async (rig) => {
    const res = await send(rig, { to: ["plain-one", "node-x"], kind: "bogus-kind" });
    assert.equal(res.ok, true, JSON.stringify(res));
    const d = res.delivery as Array<{ to: string; status: string }>;
    assert.equal(d.find((x) => x.to === "node-x")?.status, "failed");
    assert.equal(d.find((x) => x.to === "plain-one")?.status !== "failed", true);
    assert.equal(rows(await inbox(rig, "plain-one")).length, 1);
    assert.equal(rows(await inbox(rig, "node-x")).length, 0);
  });
});

test("R6-6: mixed send is atomic when the v1 leg would throw", async () => {
  await withRig(async (rig) => {
    assert.equal((await send(rig, { to: ["plain-one", "node-x"], reply_to: "ubus:nope" })).ok, false);
    assert.equal((await send(rig, { to: ["plain-one", "node-x"], body: "x".repeat(20000) })).error, "too_large");
    assert.equal(rows(await inbox(rig, "plain-one")).length, 0);
    assert.equal(rows(await inbox(rig, "node-x")).length, 0);
    for (let i = 0; i < 60; i++) await send(rig, { to: ["plain-one"] });
    assert.equal((await send(rig, { to: ["plain-one", "node-x"] })).error, "rate_limited");
    assert.equal(rows(await inbox(rig, "node-x")).length, 0);
  });
});

test("R6-7: v3-only recipient is stored, and unknown names still report unknown_agent", async () => {
  await withRig(async (rig) => {
    const res = await send(rig, { to: ["node-x", "nobody-xyz"] });
    assert.equal(res.ok, true, JSON.stringify(res));
    const d = (res.delivery as Array<{ to: string; status: string }>).map((x) => `${x.to}:${x.status}`).sort();
    assert.deepEqual(d, ["nobody-xyz:unknown_agent", "node-x:stored"]);
    assert.equal(rows(await inbox(rig, "node-x")).length, 1);
  });
});

// ---- flag-on vs flag-off parity for local mail (oref A1-A11) ----

const strip = (v: unknown) => JSON.parse(JSON.stringify(v, (k, x) => (["id", "thread_id", "schema", "ts", "v1_id", "eta_id", "message_id", "address"].includes(k) ? undefined : x)));
const safe = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    return await p;
  } catch (e) {
    return { threw: String((e as Error).message ?? e) };
  }
};

async function parity(name: string, fn: (rig: Rig) => Promise<unknown>): Promise<void> {
  const res: unknown[] = [];
  for (const flag of [false, true]) {
    const rig = setup();
    try {
      await register(rig.ubus, "worker");
      await register(rig.ubus, "plain-one");
      await register(rig.ubus, "fable");
      if (flag) on(rig);
      res.push(strip(await fn(rig)));
    } finally {
      off();
      rig.cleanup();
    }
  }
  assert.deepEqual(res[1], res[0], `${name}: flag-on differs from flag-off`);
}
const statuses = (r: R) => (r.ok === false || r.threw ? r : { ok: r.ok, delivery: ((r.delivery as R[]) ?? []).map((d) => `${d.to}:${d.status}`).sort() });
const sendS = async (rig: Rig, a: R) => statuses((await safe(send(rig, a))) as R);

test("R6-8: local mail parity A1-A11 (flag on == flag off)", async () => {
  await parity("A1 unread count", async (rig) => {
    await send(rig, { to: ["plain-one"] });
    return rig.ubus.unreadSummary("plain-one").count;
  });
  await parity("A2 rate limit", async (rig) => {
    let last: unknown = {};
    for (let i = 0; i < 61; i++) last = await sendS(rig, { to: ["plain-one"] });
    return last;
  });
  await parity("A3 idempotency", async (rig) => {
    const a = await send(rig, { to: ["plain-one"], idempotency_key: "k1" });
    const b = await send(rig, { to: ["plain-one"], idempotency_key: "k1" });
    return { same: a.id === b.id, idem: b.idempotent ?? null, n: rows(await inbox(rig, "plain-one")).length };
  });
  await parity("A4 no subject", (rig) => sendS(rig, { to: ["plain-one"], subject: "" }));
  await parity("A4b over cap", (rig) => sendS(rig, { to: ["plain-one"], body: "x".repeat(20000) }));
  await parity("A4c long subject", (rig) => sendS(rig, { to: ["plain-one"], subject: "s".repeat(500) }));
  await parity("A5 wake", async (rig) => {
    const s = await sendS(rig, { to: ["plain-one"], wake: true });
    return { s, unread: rig.ubus.unreadSummary("plain-one").count };
  });
  await parity("A6 dup via group", async (rig) => {
    await send(rig, { to: ["fable", "group:eta-leads"] });
    return rows(await inbox(rig, "fable")).length;
  });
  await parity("A7 mixed bogus reply_to", async (rig) => ({ r: await sendS(rig, { to: ["plain-one", "consult-lead"], reply_to: "ubus:nope" }), n: rows(await inbox(rig, "plain-one")).length }));
  await parity("A8 mixed rate limited", async (rig) => {
    for (let i = 0; i < 60; i++) await send(rig, { to: ["consult-lead"] });
    return { r: await sendS(rig, { to: ["plain-one", "consult-lead"] }), n: rows(await inbox(rig, "plain-one")).length };
  });
  await parity("A9 inbox limit", async (rig) => {
    for (let i = 0; i < 6; i++) await send(rig, { to: ["plain-one"], subject: `m${i}` });
    return rows(await inbox(rig, "plain-one", { limit: 2 })).map((m) => m.subject);
  });
  await parity("A10 reply_to joins parent thread", async (rig) => {
    const p = await send(rig, { to: ["plain-one"] });
    const r = await send(rig, { to: ["plain-one"], reply_to: p.id });
    return r.thread_id === p.thread_id;
  });
  await parity("A11 thread readable by recipient", async (rig) => {
    const r = await send(rig, { to: ["plain-one"] });
    const t = (await safe(rig.ubus.call("ubus_thread", { thread_id: r.thread_id }, caller("plain-one")))) as R;
    return { ok: t.ok ?? t.threw, n: Array.isArray(t.messages) ? t.messages.length : null };
  });
  await parity("S8 ack unread local id", async (rig) => {
    const b = await send(rig, { to: ["plain-one"] });
    const r = (await safe(rig.ubus.call("ubus_ack", { ids: [b.id] }, caller("plain-one")))) as R;
    return { acked: (r.acked as unknown[] | undefined)?.length ?? 0, missing: (r.missing as unknown[] | undefined)?.length ?? 0 };
  });
});
