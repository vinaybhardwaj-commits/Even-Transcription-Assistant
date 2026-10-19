import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { all, get, openDb } from "../src/sqlite.js";
import { openHub, type Hub } from "../src/v3/hub.js";
import { caller, setup } from "./helpers.js";

function v3SourceDir(): string {
  const candidates = [join(process.cwd(), "src", "v3"), fileURLToPath(new URL("../../src/v3/", import.meta.url))];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, "src/v3 not found");
  return found;
}

test("v3 source contains no row-removal statements against the event table", () => {
  const dir = v3SourceDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 5, `expected the v3 modules, saw ${files.length}`);
  // Triggers may name the guarded statement (BEFORE UPDATE ON ...); a statement
  // that touches rows may not: `<verb> <table> SET` and `DELETE FROM`.
  const forbidden = /(\bUPDATE\s+[A-Za-z_."]+\s+SET\b)|(\bDELETE\s+FROM\b)/i;
  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    const hit = text.match(forbidden);
    assert.equal(hit, null, `${name} contains a forbidden statement: ${hit?.[0]}`);
  }
});

test("triggers abort any attempt to alter or remove event rows", () => {
  const rig = setup();
  try {
    const dbPath = join(rig.dir, "v3", "eventlog.db");
    const hub = openHub({ dbPath, clock: rig.clock, allowlistPath: join(rig.dir, "allowlist.json") });
    try {
      assert.equal(hub.send({ to: ["fable"], subject: "note", body: "count=1 path=~/dev/eta-lab/z.json" }, caller("fable")).ok, true);
    } finally {
      hub.close();
    }
    const db = openDb(dbPath);
    try {
      const triggers = all(db, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'events_%'").map((r) => String(r.name));
      assert.equal(triggers.includes("events_block_alter") && triggers.includes("events_block_remove"), true, JSON.stringify(triggers));
      const count = () => Number(String(get(db, "SELECT COUNT(*) AS n FROM events")?.n));
      const before = count();
      assert.throws(() => db.prepare("UPDATE events SET ts = 'tampered' WHERE id = 1").run(), "an event row was altered");
      assert.throws(() => db.prepare("DELETE FROM events WHERE id = 1").run(), "an event row was removed");
      const first = all(db, "SELECT id, ts FROM events ORDER BY id ASC");
      assert.ok(first.length >= 2, "expected events to inspect");
      const firstId = Number(first[0]?.id);
      assert.throws(
        () => db.prepare("INSERT INTO events (id, ts, actor, kind, subject_id, meta_json) VALUES (?, 'x', 'x', 'x', 'x', '{}')").run(firstId),
        "a rewound id was accepted",
      );
      assert.throws(
        () =>
          db
            .prepare("INSERT OR REPLACE INTO events (id, ts, actor, kind, subject_id, meta_json) VALUES (?, 'tampered', 'x', 'x', 'x', '{}')")
            .run(firstId),
        "INSERT OR REPLACE overwrote the past",
      );
      assert.deepEqual(all(db, "SELECT id, ts FROM events ORDER BY id ASC"), first, "the earlier rows changed");
      assert.equal(count(), before, "the event rows changed");
    } finally {
      db.close();
    }
  } finally {
    rig.cleanup();
  }
});

test("replaying events rebuilds identical views", () => {
  const rig = setup();
  try {
    const dbPath = join(rig.dir, "v3", "eventlog.db");
    const allowlistPath = join(rig.dir, "allowlist.json");
    let hub: Hub | null = openHub({ dbPath, clock: rig.clock, allowlistPath });
    try {
      assert.equal(hub.register("worker", ["wk-1"]).ok, true);
      assert.equal(hub.register("worker2").ok, true);
      const first = hub.send(
        { to: ["fable", "wk-1"], subject: "note", body: "count=1 path=~/dev/eta-lab/z.json" },
        caller("worker"),
      );
      assert.equal(first.ok, true);
      const second = hub.send(
        { to: ["fable"], subject: "second", body: "count=2 path=~/dev/eta-lab/y.json" },
        caller("worker"),
      );
      assert.equal(second.ok, true);
      const inbox = hub.inbox({ peek: true }, caller("fable"));
      assert.equal((inbox.messages as unknown[]).length, 2);
      const readBack = hub.inbox({}, caller("fable"));
      assert.equal((readBack.messages as unknown[]).length, 2);
      const acked = hub.ack(String(first.id), "fable");
      assert.equal(acked.ok, true, JSON.stringify(acked));
      const before = hub.views();
      const eventsBefore = hub.log.count();
      assert.ok(eventsBefore >= 5, `expected several events, saw ${eventsBefore}`);
      hub.close();
      hub = null;

      const reopened = openHub({ dbPath, clock: rig.clock, allowlistPath });
      try {
        assert.equal(reopened.log.count(), eventsBefore);
        assert.deepEqual(reopened.views(), before);
        assert.deepEqual(reopened.views(), before, "two replays of the same log agree");
      } finally {
        reopened.close();
      }
    } finally {
      hub?.close();
    }
  } finally {
    rig.cleanup();
  }
});
