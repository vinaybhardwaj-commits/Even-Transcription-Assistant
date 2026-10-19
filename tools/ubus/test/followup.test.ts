import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CommandEtaAdapter, FakeHandoff, FakeHerdr, FakeOpenBot, MapWhois } from "../src/adapters.js";
import { ScriptedProbe } from "../src/archive.js";
import { defaultConfig } from "../src/config.js";
import { BRIDGE_IDENTITY, LIAISON_IDENTITY, TIME_MACHINE_VOLUME_UUID } from "../src/constants.js";
import { createUbus } from "../src/create.js";
import { createHttpServer } from "../src/http.js";
import { ManualClock } from "../src/util.js";
import { caller, register, setup } from "./helpers.js";

const KIOSK_NOTE =
  "From Grok Bot for Vinay. From 10:30 IST you own kiosk repair and self-healing for today. Liason starts all rooms at 09:00. Bug Bot checks every 10 min from 09:01 and sends each downtime to you; attempt repair or self-heal and reply to bug-bot and grok-bot with the outcome. Three kiosks (OPD 5, OPD 7, Dietary) are offline and need on-site help. Full context: ETA bus post 11533.";

function auditLines(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("live bus.db recipients_json delivers inbound ETA posts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ubus-live-"));
  const clock = new ManualClock(Date.parse("2026-10-11T08:00:00.000Z"));
  const cfg = defaultConfig(dir);
  cfg.spoolDir = join(dir, "spool");
  cfg.auditPath = join(dir, "audit", "audit.jsonl");
  cfg.stopFile = join(dir, "STOP");
  cfg.dbPath = join(dir, "ubus.db");
  cfg.groupsFile = join(process.cwd(), "test", "fixtures", "groups.json");
  cfg.volumeMount = join(dir, "volume");
  cfg.coldRoot = join(dir, "volume", "cold", "ubus-log");
  cfg.expectedVolumeUuid = TIME_MACHINE_VOLUME_UUID;
  const busPath = join(dir, "bus.db");
  const db = new DatabaseSync(busPath);
  db.exec(`
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      sender TEXT NOT NULL,
      recipients_json TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT,
      reply_to TEXT,
      wake INTEGER NOT NULL DEFAULT 0,
      identity TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    `INSERT INTO posts (ts, sender, recipients_json, subject, body, thread_id, reply_to, wake, identity)
     VALUES (?, ?, ?, ?, ?, ?, '', 0, ?)`,
  );
  const ts = "2026-10-11T08:00:00.000Z";
  insert.run(ts, "consult-lead", JSON.stringify(["consult-lead", LIAISON_IDENTITY]), "[to:grok:designer] ping", "count=1 path=~/dev/eta-lab/live.json", "eta:live", "consult-lead");
  insert.run(ts, "gating-lead", JSON.stringify(["gating-lead"]), "[to:grok:designer] skip", "count=0 path=~/dev/eta-lab/skip.json", "eta:skip", "gating-lead");
  insert.run(ts, "fable", JSON.stringify(["fable", BRIDGE_IDENTITY]), "[to:cc-mini] bridge", "count=2 path=~/dev/eta-lab/bridge.json", "eta:bridge", "fable");
  db.close();

  const eta = new CommandEtaAdapter([], busPath);
  const tailed = eta.tail("0");
  assert.equal(tailed.length, 3);
  assert.equal(tailed[0]?.recipient, LIAISON_IDENTITY);
  assert.equal(tailed[1]?.recipient, "gating-lead");
  assert.equal(tailed[2]?.recipient, BRIDGE_IDENTITY);

  const ubus = createUbus(cfg, {
    clock,
    eta,
    herdr: new FakeHerdr(),
    openbot: new FakeOpenBot(),
    handoff: new FakeHandoff(),
    whois: new MapWhois(new Map()),
    probe: new ScriptedProbe({ mounted: true, uuid: TIME_MACHINE_VOLUME_UUID, writable: true }),
  });
  try {
    await register(ubus, "grok:designer", { runtime: "grok", session: "grok:designer", machine: "opd-bot" }, "opd-bot");
    await register(ubus, "cc-mini", { session: "cc:mini-1" });
    assert.equal(ubus.pollEta(), 2);
    const grok = await ubus.call("ubus_inbox", { peek: true }, caller("grok:designer", "opd-bot"));
    const grokMsgs = grok.messages as Array<{ subject: string; body: string }>;
    assert.equal(grokMsgs.length, 1);
    assert.match(grokMsgs[0]?.subject || "", /\[to:grok:designer\] ping/);
    assert.match(grokMsgs[0]?.body || "", /live\.json/);
    const cc = await ubus.call("ubus_inbox", { peek: true }, caller("cc-mini"));
    const ccMsgs = cc.messages as Array<{ subject: string }>;
    assert.equal(ccMsgs.some((m) => m.subject.includes("[to:cc-mini]")), true);
    assert.equal(ccMsgs.some((m) => m.subject.includes("skip")), false);
    assert.equal(grokMsgs.some((m) => m.subject.includes("skip")), false);
  } finally {
    ubus.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kiosk repair mail is delivered and identifier rejections name the rule", async () => {
  const rig = setup();
  try {
    await register(rig.ubus, "grok-bot", { runtime: "grok", session: "grok:grok-bot", machine: "opd-bot" }, "opd-bot");
    await register(rig.ubus, "vinay", { runtime: "cowork", session: "cowork:vinay", owner: "v" });
    const sent = await rig.ubus.call(
      "ubus_send",
      { to: ["vinay"], subject: "You own kiosk repair and self-healing for today.", body: KIOSK_NOTE },
      caller("grok-bot", "opd-bot"),
    );
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const inbox = await rig.ubus.call("ubus_inbox", { peek: true }, caller("vinay"));
    const messages = inbox.messages as Array<{ body: string }>;
    assert.match(messages[0]?.body || "", /OPD 5/);
    assert.match(messages[0]?.body || "", /11533/);

    const phi = await rig.ubus.call(
      "ubus_send",
      { to: ["vinay"], subject: "chart", body: "patient MRN: ABC12345 admitted" },
      caller("grok-bot", "opd-bot"),
    );
    assert.equal(phi.error, "phi_rejected");
    assert.equal(phi.rule, "phi.uhid_mrn");
    assert.equal(JSON.stringify(phi).includes("ABC12345"), false);
    const phone = await rig.ubus.call(
      "ubus_send",
      { to: ["vinay"], subject: "call", body: "ring +919876543210" },
      caller("grok-bot", "opd-bot"),
    );
    assert.equal(phone.error, "phi_rejected");
    assert.equal(phone.rule, "phi.phone_in");
    assert.equal(JSON.stringify(phone).includes("9876543210"), false);
    const dumped = readFileSync(rig.cfg.auditPath, "utf8") + "\n";
    assert.equal(dumped.includes("ABC12345"), false);
    assert.equal(dumped.includes("9876543210"), false);
    assert.match(dumped, /phi\.uhid_mrn/);
  } finally {
    rig.cleanup();
  }
});

test("not_registered heartbeats collapse to one audit line per minute", async () => {
  const rig = setup();
  const server = createHttpServer(rig.ubus, rig.cfg, { whois: rig.whois });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    "x-ubus-client": "ubus-mcp",
    "user-agent": "noisy-stdio/1",
  };
  const call = (name: string, id: number) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: name === "ubus_send" ? { to: ["vinay"], subject: "x", body: "y" } : {} } }),
    });
  try {
    await register(rig.ubus, "fable", { runtime: "cowork", session: "cowork:fable", owner: "v" });
    const okBeat = await rig.ubus.call("ubus_heartbeat", {}, caller("fable"));
    assert.equal(okBeat.ok, true);
    const before = auditLines(rig.cfg.auditPath);
    assert.equal(before.some((line) => line.tool === "ubus_heartbeat" && line.result === "ok" && line.count === undefined), true);

    const first = await call("ubus_heartbeat", 1);
    const second = await call("ubus_heartbeat", 2);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const open = auditLines(rig.cfg.auditPath).filter((line) => line.result === "not_registered");
    assert.equal(open.length, 0);
    rig.clock.advance(60_000);
    rig.ubus.sweep();
    const collapsed = auditLines(rig.cfg.auditPath).filter((line) => line.result === "not_registered");
    assert.equal(collapsed.length, 1);
    assert.equal(collapsed[0]?.tool, "ubus_heartbeat");
    assert.equal(collapsed[0]?.count, 2);
    assert.equal(collapsed[0]?.client, "ubus-mcp");
    assert.equal(collapsed[0]?.user_agent, "noisy-stdio/1");
    assert.equal(collapsed[0]?.auth_class, "");
    assert.match(String(collapsed[0]?.remote), /127\.0\.0\.1/);
    assert.equal(collapsed[0]?.via, "stdio");

    await call("ubus_send", 3);
    rig.clock.advance(60_000);
    rig.ubus.sweep();
    const both = auditLines(rig.cfg.auditPath).filter((line) => line.result === "not_registered");
    assert.equal(both.length, 2);
    assert.equal(both[1]?.tool, "ubus_send");
    assert.equal(both[1]?.count, 1);
    assert.equal(both[1]?.client, "ubus-mcp");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rig.cleanup();
  }
});
