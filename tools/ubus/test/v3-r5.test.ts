import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { caller, register, setup } from "./helpers.js";

type Rig = ReturnType<typeof setup>;
type Delivery = Array<{ to: string; status: string }>;

async function run(v3: boolean, to: string[], body: string): Promise<{ res: Record<string, unknown>; rig: Rig }> {
  const rig = setup();
  if (v3) {
    process.env.UBUS_V3 = "1";
    process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
    process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  }
  try {
    await register(rig.ubus, "worker");
    await register(rig.ubus, "plain-one");
    const res = await rig.ubus.call("ubus_send", { to, subject: "s", body }, caller("worker"));
    return { res, rig };
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
  }
}

const statuses = (res: Record<string, unknown>) => (res.delivery as Delivery).map((d) => `${d.to}:${d.status}`).sort();

async function same(to: string[], body = "ids only"): Promise<Rig[]> {
  const a = await run(false, to, body);
  const b = await run(true, to, body);
  try {
    assert.equal(b.res.ok, a.res.ok, JSON.stringify(b.res));
    if (a.res.ok) assert.deepEqual(statuses(b.res), statuses(a.res).map((s) => s), JSON.stringify(b.res));
    else assert.equal(b.res.error, a.res.error);
  } finally {
    a.rig.cleanup();
  }
  return [b.rig];
}

test("R5-1: bridged-only handle matches v1", async () => {
  const [rig] = await same(["consult-lead"]);
  rig.cleanup();
});

test("R5-2: group:eta-leads matches v1", async () => {
  const [rig] = await same(["group:eta-leads"]);
  rig.cleanup();
});

test("R5-3: 1500-char body is accepted for local and bridged recipients", async () => {
  for (const to of [["plain-one"], ["consult-lead"]]) {
    const { res, rig } = await run(true, to, "x".repeat(1500));
    try {
      assert.equal(res.ok, true, JSON.stringify(res));
    } finally {
      rig.cleanup();
    }
  }
});

test("R5-4: mixed local + bridged + group matches v1 statuses (local is v3-stored)", async () => {
  const a = await run(false, ["plain-one", "consult-lead", "group:eta-leads"], "ids only");
  const b = await run(true, ["plain-one", "consult-lead", "group:eta-leads"], "ids only");
  try {
    assert.equal(b.res.ok, true, JSON.stringify(b.res));
    const strip = (r: Record<string, unknown>) => statuses(r).filter((s) => !s.startsWith("plain-one:"));
    assert.deepEqual(strip(b.res), strip(a.res));
    assert.equal((b.res.delivery as Delivery).some((d) => d.to === "plain-one"), true);
  } finally {
    a.rig.cleanup();
    b.rig.cleanup();
  }
});

test("R5-5: PHI filter still applies under the shim", async () => {
  const { res, rig } = await run(true, ["plain-one"], "call 9000000001 back");
  try {
    assert.equal(res.ok, false, JSON.stringify(res));
  } finally {
    rig.cleanup();
  }
});

test("R5-6: inbox merges v3 and v1 mail", async () => {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  try {
    await register(rig.ubus, "worker");
    await register(rig.ubus, "plain-one");
    await rig.ubus.call("ubus_send", { to: ["plain-one"], subject: "a", body: "ids only" }, caller("worker"));
    await rig.ubus.call("ubus_request", { to: "plain-one", subject: "b", body: "ids only" }, caller("worker"));
    const inbox = await rig.ubus.call("ubus_inbox", {}, caller("plain-one"));
    assert.equal((inbox.messages as unknown[]).length, 2, JSON.stringify(inbox));
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
    rig.cleanup();
  }
});
