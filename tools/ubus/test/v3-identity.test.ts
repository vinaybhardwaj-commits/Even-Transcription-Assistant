import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openHub } from "../src/v3/hub.js";
import { caller, register, setup } from "./helpers.js";

test("a send to fable and one to cc-air-work-local land in the same inbox", async () => {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  writeFileSync(process.env.UBUS_V3_ALLOWLIST, JSON.stringify({ terms: ["Human RAG", "newcat"] }));
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const direct = await rig.ubus.call(
      "ubus_send",
      { to: ["fable"], subject: "one", body: "count=1 path=~/dev/eta-lab/a.json" },
      caller("fable"),
    );
    assert.equal(direct.ok, true, JSON.stringify(direct));
    const viaAlias = await rig.ubus.call(
      "ubus_send",
      { to: ["cc-air-work-local"], subject: "two", body: "count=2 path=~/dev/eta-lab/b.json" },
      caller("fable"),
    );
    assert.equal(viaAlias.ok, true, JSON.stringify(viaAlias));
    assert.equal((viaAlias.delivery as Array<{ to: string }>)[0]?.to, "fable");

    const inbox = await rig.ubus.call("ubus_inbox", {}, caller("fable"));
    assert.equal(inbox.ok, true, JSON.stringify(inbox));
    const messages = inbox.messages as Array<{ subject: string; from: { handle: string }; state: string }>;
    assert.equal(messages.length, 2, JSON.stringify(messages.map((m) => m.subject)));
    assert.deepEqual(messages.map((m) => m.subject).sort(), ["one", "two"]);
    assert.equal(messages.every((m) => typeof m.state === "string" && m.state.length > 0), true);
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
    rig.cleanup();
  }
});

test("alias resolution and alias collisions", () => {
  const rig = setup();
  try {
    const hub = openHub({ dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allow.json") });
    try {
      assert.equal(hub.identity.resolve("fable"), "fable");
      assert.equal(hub.identity.resolve("cc-air-work-local"), "fable");
      assert.equal(hub.identity.resolve("nobody"), undefined);
      assert.equal(hub.register("worker", ["wk"]).ok, true);

      const clashId = hub.register("cc-air-work-local");
      assert.equal(clashId.ok, false);
      assert.equal((clashId as { reason?: string }).reason, "alias_collision");

      const clashAlias = hub.register("other", ["wk"]);
      assert.equal(clashAlias.ok, false);
      assert.equal((clashAlias as { reason?: string }).reason, "alias_collision");
      assert.equal((clashAlias as { conflict?: { held_by?: string } }).conflict?.held_by, "worker");

      const clashOwn = hub.register("worker", ["worker2"]);
      assert.equal(clashOwn.ok, false);
      assert.equal((clashOwn as { conflict?: { name?: string; held_by?: string } }).conflict?.name, "worker");
      assert.equal((clashOwn as { conflict?: { held_by?: string } }).conflict?.held_by, "worker");

      const fresh = hub.register("worker2", ["w2"]);
      assert.equal(fresh.ok, true);
      assert.equal(hub.identity.resolve("w2"), "worker2");
      assert.equal(hub.identity.names().includes("cc-air-work-local"), true);
    } finally {
      hub.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("R2-4: ids and aliases collide case-insensitively with a lower-case canonical form", () => {
  const rig = setup();
  try {
    const hub = openHub({ dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allow.json") });
    try {
      const spoof = hub.register("Fable");
      assert.equal(spoof.ok, false, "Fable registered as a second identity next to fable");
      assert.equal((spoof as { reason?: string }).reason, "alias_collision");
      assert.equal(hub.identity.resolve("FABLE"), "fable");
      assert.equal(hub.identity.resolve("Fable"), "fable");

      assert.equal(hub.register("Worker", ["Wk-A"]).ok, true);
      assert.equal(hub.identity.resolve("WORKER"), "worker");
      assert.equal(hub.identity.resolve("wk-a"), "worker");

      const aliasClash = hub.register("other", ["ALIAS-TERM"]);
      assert.equal(aliasClash.ok, true, JSON.stringify(aliasClash));
      const caseClash = hub.register("zz", ["alias-term"]);
      assert.equal(caseClash.ok, false);
      assert.equal((caseClash as { reason?: string }).reason, "alias_collision");
      assert.equal((caseClash as { conflict?: { held_by?: string } }).conflict?.held_by, "other");
      const idClash = hub.register("ALIAS-TERM");
      assert.equal(idClash.ok, false);
      assert.equal((idClash as { reason?: string }).reason, "alias_collision");
    } finally {
      hub.close();
    }
  } finally {
    rig.cleanup();
  }
});
