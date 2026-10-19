import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import DatabaseSync from "node:sqlite";
import { openHub, AllowList, checkFilter } from "../src/v3/hub.js";
import { acceptableTerm } from "../src/v3/filter.js";
import { caller, register, setup } from "./helpers.js";

function allowFile(terms: string[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "ubus-r4-"));
  const file = join(dir, "allowlist.json");
  writeFileSync(file, JSON.stringify({ terms }));
  return { dir, file };
}

test("R4-1: a mixed [v3, v1] ack with an allow-listed note acks both", async () => {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "worker");
    const sent = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/a.json" }, caller("worker"));
    assert.equal(sent.ok, true, JSON.stringify(sent));
    await rig.ubus.call("ubus_inbox", {}, caller("fable"));
    const req = await rig.ubus.call("ubus_request", { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" }, caller("worker"));
    const note = "Encounter Buddy flow ok, patient count fine, admitted list";
    const res = await rig.ubus.call("ubus_ack", { ids: [String(sent.id), String(req.id)], note }, caller("fable"));
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(res.acked, [String(sent.id), String(req.id)], JSON.stringify(res));
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
    rig.cleanup();
  }
});

test("R4-1: a bad note acks nothing in v3 or v1", async () => {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "worker");
    const sent = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/a.json" }, caller("worker"));
    await rig.ubus.call("ubus_inbox", {}, caller("fable"));
    const req = await rig.ubus.call("ubus_request", { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" }, caller("worker"));
    const bad = await rig.ubus.call("ubus_ack", { ids: [String(sent.id), String(req.id)], note: "call 9000000001 back" }, caller("fable"));
    assert.equal(bad.ok, false, JSON.stringify(bad));
    const good = await rig.ubus.call("ubus_ack", { ids: [String(sent.id), String(req.id)] }, caller("fable"));
    assert.deepEqual(good.acked, [String(sent.id), String(req.id)], "the failed ack must have left both untouched");
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
    rig.cleanup();
  }
});

test("R4-2: the log refuses explicit ids <= 0, however they are inserted", () => {
  const rig = setup();
  const hub = openHub({ dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allowlist.json") });
  try {
    hub.send({ to: ["fable"], subject: "x", body: "count=1" }, caller("fable"));
    const before = hub.log.count();
    hub.log.close?.();
    const db = new (DatabaseSync as unknown as { DatabaseSync: new (p: string) => { prepare(s: string): { run(...a: unknown[]): unknown }; close(): void } }).DatabaseSync(join(rig.dir, "v3", "eventlog.db"));
    try {
      for (const id of [0, -1, -5]) {
        assert.throws(() => db.prepare("INSERT INTO events (id, ts, actor, kind, subject_id, meta_json) VALUES (?, 'x', 'x', 'x', 'x', '{}')").run(id), `id ${id} accepted`);
        assert.throws(() => db.prepare("INSERT OR REPLACE INTO events (id, ts, actor, kind, subject_id, meta_json) VALUES (?, 'x', 'x', 'x', 'x', '{}')").run(id), `replace id ${id} accepted`);
      }
      // An omitted id still autoincrements.
      db.prepare("INSERT INTO events (ts, actor, kind, subject_id, meta_json) VALUES ('x', 'x', 'x', 'x', '{}')").run();
    } finally {
      db.close();
    }
    assert.ok(before > 0);
  } finally {
    rig.cleanup();
  }
});

test("R4-3: a phrase term containing a clinical word is rejected, every word checked", () => {
  assert.equal(acceptableTerm("patient Asha Verma"), false);
  assert.equal(acceptableTerm("Asha Verma, Fever ward"), false);
  assert.equal(acceptableTerm("Encounter Buddy"), true);
  const { dir, file } = allowFile(["patient Asha Verma", "Encounter Buddy"]);
  try {
    const allow = new AllowList(file);
    assert.equal(allow.terms().includes("patient Asha Verma"), false);
    assert.equal(checkFilter("patient Asha Verma admitted", allow).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R4-4: a key file under 16 bytes is refused, not replaced; refs are hmac:", () => {
  const rig = setup();
  try {
    const dir = join(rig.dir, "v3");
    mkdirSync(dir, { recursive: true });
    const keyPath = join(dir, "namekey");
    writeFileSync(keyPath, Buffer.from("short"), { mode: 0o600 });
    assert.throws(() => openHub({ dbPath: join(dir, "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allowlist.json") }), /16 bytes/);
    assert.equal(statSync(keyPath).size, 5, "the short key was replaced");
  } finally {
    rig.cleanup();
  }
});

test("M14: an existing key file is chmodded back to 0600 on open", () => {
  const rig = setup();
  try {
    const opts = { dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allowlist.json") };
    openHub(opts).close();
    const keyPath = join(rig.dir, "v3", "namekey");
    chmodSync(keyPath, 0o644);
    openHub(opts).close();
    assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  } finally {
    rig.cleanup();
  }
});

test("M6: the product's ref is case-folded", () => {
  const rig = setup();
  const hub = openHub({ dbPath: join(rig.dir, "v3", "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allowlist.json") });
  try {
    const a = hub.send({ to: ["Ghostly"], subject: "n", body: "count=1" }, caller("fable"));
    const b = hub.send({ to: ["gHOSTLY"], subject: "n", body: "count=1" }, caller("fable"));
    assert.deepEqual(a.to, b.to, JSON.stringify([a, b]));
    assert.match(String((a.to as string[])[0]), /^hmac:[0-9a-f]{16}$/);
  } finally {
    hub.close();
    rig.cleanup();
  }
});

test("M1: allow terms match whole words only", () => {
  const { dir, file } = allowFile(["Encounter Buddy"]);
  try {
    const allow = new AllowList(file);
    assert.equal(checkFilter("Encounter Buddy patient flow", allow).ok, true);
    assert.equal(checkFilter("Encounter Buddyzz patient flow", allow).ok, false, "a longer word must not ride on a term");
    assert.deepEqual(allow.matches("Encounter Buddyzz and xEncounter Buddy2"), [], "substring hits are not term matches");
    assert.deepEqual(allow.spans("Encounter Buddyzz"), []);
    assert.deepEqual(allow.matches("see Encounter Buddy now"), ["Encounter Buddy"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M12: the transcript rules still run after a name exemption", () => {
  const { dir, file } = allowFile(["Encounter Buddy"]);
  try {
    const allow = new AllowList(file);
    const v = checkFilter(`Encounter Buddy patient ${"क".repeat(40)}`, allow);
    assert.equal(v.ok, false, JSON.stringify(v));
    assert.match((v as { rule_id: string }).rule_id, /^transcript/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R5-1: with the flag on, an oversize note acks nothing in either store", async () => {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    await register(rig.ubus, "worker");
    const sent = await rig.ubus.call("ubus_send", { to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/a.json" }, caller("worker"));
    await rig.ubus.call("ubus_inbox", {}, caller("fable"));
    const req = await rig.ubus.call("ubus_request", { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" }, caller("worker"));
    const ids = [String(sent.id), String(req.id)];
    for (const ids2 of [ids, [ids[1]!], [ids[0]!]]) {
      const r = await rig.ubus.call("ubus_ack", { ids: ids2, note: "x".repeat(9000) }, caller("fable"));
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "too_large", JSON.stringify(r));
    }
    const good = await rig.ubus.call("ubus_ack", { ids }, caller("fable"));
    assert.deepEqual(good.acked, ids, "the oversize ack must have left both untouched");
  } finally {
    delete process.env.UBUS_V3;
    delete process.env.UBUS_V3_DB;
    delete process.env.UBUS_V3_ALLOWLIST;
    rig.cleanup();
  }
});

test("R5-2: an unreadable key file is never replaced", { skip: process.getuid?.() === 0 }, () => {
  const rig = setup();
  try {
    const dir = join(rig.dir, "v3");
    mkdirSync(dir, { recursive: true });
    const keyPath = join(dir, "namekey");
    writeFileSync(keyPath, Buffer.alloc(32, 7), { mode: 0o200 });
    assert.throws(() => openHub({ dbPath: join(dir, "eventlog.db"), clock: rig.clock, allowlistPath: join(rig.dir, "allowlist.json") }), /EACCES/);
    chmodSync(keyPath, 0o600);
    assert.equal(statSync(keyPath).size, 32);
  } finally {
    rig.cleanup();
  }
});

test("M22: phrase terms are split on punctuation, not just whitespace", () => {
  for (const t of ["Dr. Asha", "Patient-Asha", "asha_verma PATIENT", "(pt)"]) assert.equal(acceptableTerm(t), false, t);
  assert.equal(acceptableTerm("impatient-lane"), true);
});

/** Flag-on rig with one v3 message (already read by fable) and one v1 request for fable. */
async function ackRig(): Promise<{ rig: ReturnType<typeof setup>; v3: string; v1: string; state: () => Promise<string | undefined>; done: () => void }> {
  const rig = setup();
  process.env.UBUS_V3 = "1";
  process.env.UBUS_V3_DB = join(rig.dir, "v3", "eventlog.db");
  process.env.UBUS_V3_ALLOWLIST = join(rig.dir, "allowlist.json");
  await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
  await register(rig.ubus, "worker");
  // Straight to the v3 log: through the shim the alias would now route to v1's fable.
  const sent = (rig.ubus as unknown as { hub(): { send(a: object, c: unknown): Record<string, unknown> } })
    .hub()
    .send({ to: ["cc-air-work-local"], subject: "note", body: "count=1 path=~/dev/eta-lab/a.json" }, caller("worker"));
  await rig.ubus.call("ubus_inbox", {}, caller("fable"));
  const req = await rig.ubus.call("ubus_request", { to: "fable", subject: "need count", body: "path=~/dev/eta-lab/r.json count=1" }, caller("worker"));
  const v3 = String(sent.id);
  return {
    rig,
    v3,
    v1: String(req.id),
    state: async () => {
      const inbox = await rig.ubus.call("ubus_inbox", { unread_only: false }, caller("fable"));
      return (inbox.messages as Array<{ id: string; state: string }>).find((m) => String(m.id) === v3)?.state;
    },
    done: () => {
      delete process.env.UBUS_V3;
      delete process.env.UBUS_V3_DB;
      delete process.env.UBUS_V3_ALLOWLIST;
      rig.cleanup();
    },
  };
}

test("N4/N8/N9: size cap is checked before any write, at 8192 bytes, counted in bytes", async () => {
  const t = await ackRig();
  try {
    const eventsBefore = () => openCount(t.rig.dir);
    const n0 = eventsBefore();
    const cases: Array<[string, string[]]> = [
      ["x".repeat(8193), [t.v3, t.v1]],
      ["x".repeat(8193), [t.v1, t.v3]],
      ["x".repeat(8193), [t.v3]],
      ["x".repeat(8193), [t.v1]],
      ["é".repeat(4097), [t.v3, t.v1]], // 4097 chars but 8194 bytes
    ];
    for (const [note, ids] of cases) {
      const r = await rig_ack(t.rig, ids, note);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "too_large", JSON.stringify(r));
      assert.equal(await t.state(), "read", "v3 row moved although the ack was refused");
      assert.equal(eventsBefore(), n0, "the refused ack wrote v3 events");
    }
    // Exactly 8192 bytes is allowed, in ASCII and as multibyte.
    const ok = await rig_ack(t.rig, [t.v3, t.v1], "é".repeat(4096));
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(ok.acked, [t.v3, t.v1]);
  } finally {
    t.done();
  }
});

test("N12: the flag-on ack keeps the v1 secret rules and acks nothing", async () => {
  const t = await ackRig();
  try {
    const n0 = openCount(t.rig.dir);
    const fakeKey = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
    for (const ids of [[t.v3], [t.v1], [t.v3, t.v1], [t.v1, t.v3]]) {
      const r = await rig_ack(t.rig, ids, `rotate ${fakeKey} soon`);
      assert.equal(r.ok, false, JSON.stringify(r));
      assert.equal(r.error, "secret_rejected", JSON.stringify(r));
      assert.equal(await t.state(), "read");
      assert.equal(openCount(t.rig.dir), n0);
    }
    const good = await rig_ack(t.rig, [t.v3, t.v1]);
    assert.deepEqual(good.acked, [t.v3, t.v1]);
  } finally {
    t.done();
  }
});

function rig_ack(rig: ReturnType<typeof setup>, ids: string[], note?: string) {
  return rig.ubus.call("ubus_ack", note === undefined ? { ids } : { ids, note }, caller("fable"));
}

/** Event count straight from the v3 db file. */
function openCount(dir: string): number {
  const db = new (DatabaseSync as unknown as { DatabaseSync: new (p: string) => { prepare(s: string): { get(): { n: number } }; close(): void } }).DatabaseSync(join(dir, "v3", "eventlog.db"));
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
  } finally {
    db.close();
  }
}
