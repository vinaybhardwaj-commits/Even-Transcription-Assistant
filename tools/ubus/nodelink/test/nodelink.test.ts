import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import { classifyTail, normaliseTail, parseEnvironKeys } from "../src/classify.js";
import { defaultConfig, readNodeKey, type NodelinkConfig } from "../src/config.js";
import { NodeLink } from "../src/nodelink.js";
import { Spool, mintEpoch } from "../src/spool.js";
import { HttpsTransport, PicoTransport, type SinceResult, type Transport } from "../src/transport.js";
import { realSources } from "../src/sources.js";
import { spawnSync } from "node:child_process";
import type { LaneRow, NodeEvent, PaneInfo, ProcInfo, Sources } from "../src/types.js";

const T0 = Date.parse("2026-10-18T08:00:00Z");
const SENTINELS = ["SECRET_ENV_VALUE_91", "PANE_TEXT_SENTINEL_77", "KEY_SENTINEL_deadbeef"];

class Clk {
  constructor(public ms = T0) {}
  now() { return this.ms; }
}

class FakeSources implements Sources {
  pr: ProcInfo[] = [];
  pn: PaneInfo[] = [];
  ln: LaneRow[] = [];
  tails = new Map<string, string>();
  fileMtime = new Map<string, number>();
  done = new Map<string, number>();
  relaunched: string[] = [];
  procs() { return this.pr; }
  panes() { return this.pn; }
  paneTail(p: PaneInfo) { return this.tails.get(p.paneId) ?? ""; }
  lanes() { return this.ln; }
  worktreeMtime(d: string): number | null | "unknown" { return this.fileMtime.get(d) ?? null; }
  doneMtime(d: string, l: string) { return this.done.get(`${d}/${l}`) ?? null; }
  relaunch(l: string) { this.relaunched.push(l); }
}

class FakeHub implements Transport {
  up = true;
  store = new Map<number, NodeEvent>();
  received: number[] = [];
  async postEvents(events: NodeEvent[]) {
    if (!this.up) throw new Error("down");
    for (const e of events) { this.received.push(e.seq); this.store.set(e.seq, e); }
    let a = 0;
    while (this.store.has(a + 1)) a++;
    return { ack_seq: a };
  }
  async since(): Promise<SinceResult> {
    if (!this.up) throw new Error("down");
    return { events: [{ id: "e1" }], next_cursor: null };
  }
}

function rig(patch?: (c: NodelinkConfig) => void) {
  const dir = mkdtempSync(join(tmpdir(), "nl-"));
  const cfg = { ...defaultConfig(), node: "asus", spoolDb: join(dir, "spool.db"), stateFile: join(dir, "state.json") };
  patch?.(cfg);
  const src = new FakeSources();
  const clock = new Clk();
  const hub = new FakeHub();
  const logs: string[] = [];
  const spool = new Spool(cfg.spoolDb);
  const link = new NodeLink(cfg, src, spool, hub, clock, { info: (m) => logs.push(m), warn: (m) => logs.push(m) });
  return { dir, cfg, src, clock, hub, logs, spool, link };
}
const all = (r: ReturnType<typeof rig>) => r.spool.pending(100000);
const proc = (pid: number, cwd: string, extra: Partial<ProcInfo> = {}): ProcInfo => ({ pid, comm: "claude", args: ["claude"], cwd, cpuMs: 0, startMs: T0 - 1000, bedrockEnv: false, ...extra });

test("a) lanes.tsv + panes register with no manual step", () => {
  const r = rig();
  r.src.ln = [
    { lane: "bc-s6", pane: "w4:p1", host: "Asus-Ubuntu", model: "ccbedrock:global.anthropic.claude-sonnet-5-5", startMs: T0 - 5000 },
    { lane: "bc-s7", pane: "w5:p1", host: "Asus-Ubuntu", model: null, startMs: T0 - 5000 },
    { lane: "other-host", pane: "w9:p1", host: "T4-Linux", model: null, startMs: null },
  ];
  r.src.pn = [
    { session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" },
    { session: "default", paneId: "w5:p1", cwd: "/wt/b", agentStatus: "idle" },
  ];
  r.src.pr = [proc(10, "/wt/a", { bedrockEnv: true }), proc(11, "/wt/b", { comm: "opencode", args: ["opencode", "-m", "bharatcode2/x"] })];
  r.link.scanOnce();
  const seen = all(r).filter((e) => e.kind === "agent.seen").map((e) => e.agent!);
  assert.deepEqual(seen.map((a) => a.id).sort(), ["bc-s6@asus", "bc-s7@asus"]);
  assert.equal(seen.find((a) => a.lane === "bc-s6")!.runtime, "bedrock");
  assert.equal(seen.find((a) => a.lane === "bc-s7")!.runtime, "bc2");
  assert.equal(seen.find((a) => a.lane === "bc-s6")!.pane, "w4:p1");
});

test("b) killed lane process -> errored within one scan, alert emitted, never relaunched by default", () => {
  const r = rig();
  r.src.ln = [{ lane: "bc-x", pane: "w4:p1", host: "asus", model: null, startMs: T0 }];
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
  r.src.pr = [proc(10, "/wt/a")];
  r.link.scanOnce();
  r.src.pr = [];
  r.clock.ms += 15_000;
  r.link.scanOnce();
  const ev = all(r);
  assert.ok(ev.some((e) => e.kind === "agent.state" && e.state === "errored" && e.reason === "proc_exited"));
  assert.equal(ev.filter((e) => e.kind === "alert").length, 1);
  assert.deepEqual(r.src.relaunched, []);
});

test("b2) auto_relaunch only when lane policy says so", () => {
  const r = rig((c) => { c.lanePolicy = { "bc-x": { auto_relaunch: true } }; });
  r.src.ln = [{ lane: "bc-x", pane: "w4:p1", host: "asus", model: null, startMs: T0 }];
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
  r.src.pr = [proc(10, "/wt/a")];
  r.link.scanOnce();
  r.src.pr = [];
  r.link.scanOnce();
  r.link.scanOnce();
  assert.deepEqual(r.src.relaunched, ["bc-x"]);
});

test("c) no output and no file change for 10 min -> stalled (and idle is never stalled)", () => {
  const r = rig();
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }, { session: "default", paneId: "w5:p1", cwd: "/wt/b", agentStatus: "idle" }];
  r.src.pr = [proc(10, "/wt/a"), proc(11, "/wt/b")];
  r.src.tails.set("w4:p1", "thinking...");
  r.link.scanOnce();
  for (let i = 0; i < 39; i++) { r.clock.ms += 15_000; r.link.scanOnce(); }
  assert.ok(!all(r).some((e) => e.state === "stalled"), "9m45s is not yet stalled");
  r.clock.ms += 15_000;
  r.link.scanOnce();
  const stalled = all(r).filter((e) => e.kind === "agent.state" && e.state === "stalled");
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].agent!.pid, 10);
  assert.equal(all(r).filter((e) => e.kind === "alert").length, 1);
  // new output recovers it
  r.src.tails.set("w4:p1", "more output");
  r.clock.ms += 15_000;
  r.link.scanOnce();
  assert.equal(r.link.table().find((a) => a.pid === 10)!.state, "working");
});

test("c2) a worktree file change keeps it from stalling", () => {
  const r = rig();
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
  r.src.pr = [proc(10, "/wt/a")];
  r.link.scanOnce();
  r.clock.ms += 9 * 60_000;
  r.src.fileMtime.set("/wt/a", r.clock.ms);
  r.link.scanOnce();
  r.clock.ms += 2 * 60_000;
  r.link.scanOnce();
  assert.ok(!all(r).some((e) => e.state === "stalled"));
});

test("finished: .done newer than lane start", () => {
  const r = rig();
  r.src.ln = [{ lane: "bc-x", pane: "w4:p1", host: "asus", model: null, startMs: T0 }];
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "idle" }];
  r.src.pr = [proc(10, "/wt/a")];
  r.src.done.set("/wt/a/bc-x", T0 - 5000);
  r.link.scanOnce();
  assert.ok(!all(r).some((e) => e.state === "finished"), "stale marker ignored");
  r.src.done.set("/wt/a/bc-x", T0 + 1000);
  r.link.scanOnce();
  assert.equal(all(r).filter((e) => e.kind === "lane.done").length, 1);
});

test("e) prose that mentions 503 / Permission required is not an error; real error lines are", () => {
  const prose = [
    "I looked at the logs and saw a 503 earlier, but it was retried fine.",
    "Permission required dialogs appear when the tool is not allow-listed.",
    "│ Error: 503 inside a box line │",
    "Error handling for 503 responses is described in the doc",
    "The rate limit docs say weekly limit resets on Monday",
  ].join("\n");
  assert.equal(classifyTail(prose), null);
  assert.equal(classifyTail("● thinking\n  ⎿  API Error: 503 Service Unavailable\n"), "http_503");
  assert.equal(classifyTail("API Error: 429 rate limit exceeded"), "rate_limit");
  assert.equal(classifyTail("Error: Failed to execute statement"), "stmt_failed");
  assert.equal(classifyTail("API Error: weekly limit reached"), "weekly_limit");
  assert.equal(classifyTail("API Error: 401 Unauthorized"), "auth");
  const r = rig();
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
  r.src.pr = [proc(10, "/wt/a")];
  r.src.tails.set("w4:p1", prose);
  r.link.scanOnce();
  assert.ok(!all(r).some((e) => e.state === "errored"));
  r.src.tails.set("w4:p1", prose + "\nAPI Error: 503 Service Unavailable");
  r.link.scanOnce();
  assert.ok(all(r).some((e) => e.state === "errored" && e.reason === "http_503"));
});

test("d) hub down 5 min with 200 events: none lost, order kept, ack_seq reached, survives restart", async () => {
  const r = rig();
  r.hub.up = false;
  for (let i = 0; i < 200; i++) {
    r.clock.ms += 1500;
    r.link.heartbeatOnce();
    if (i % 10 === 0) await r.link.flushOnce(); // failures with backoff
  }
  assert.equal(r.spool.stats().depth, 200);
  // restart: new Spool + NodeLink on the same db
  r.spool.close();
  const spool2 = new Spool(r.cfg.spoolDb);
  const link2 = new NodeLink(r.cfg, r.src, spool2, r.hub, r.clock, { info() {}, warn() {} });
  assert.equal(spool2.stats().lastSeq, 200);
  link2.heartbeatOnce();
  assert.equal(spool2.stats().lastSeq, 201, "seq is monotonic across restart");
  r.hub.up = true;
  r.clock.ms += 120_000;
  assert.equal(await link2.flushOnce(), true);
  assert.equal(r.hub.store.size, 201);
  assert.deepEqual(r.hub.received, Array.from({ length: 201 }, (_, i) => i + 1));
  assert.equal(spool2.stats().ackedSeq, 201);
  assert.equal(spool2.stats().depth, 0);
  assert.equal(spool2.cursor(), null); // hub returned no next_cursor
});

test("d2) duplicate delivery after a lost ack is idempotent at the hub and resumes", async () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.link.heartbeatOnce();
  await r.hub.postEvents(r.spool.pending(500)); // hub stored but ack lost
  await r.link.flushOnce();
  assert.equal(r.hub.store.size, 5);
  assert.equal(r.spool.stats().depth, 0);
});

test("f) no env value, pane text or key appears in any outbound event, log, or state file", async () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), "nlk-"));
  const keyFile = join(dir, "node.key");
  writeFileSync(keyFile, SENTINELS[2], { mode: 0o600 });
  const key = readNodeKey(keyFile);
  const bodies: string[] = [];
  const t = new HttpsTransport("http://hub", "asus", key, () => T0, async (_u, i) => {
    bodies.push(JSON.stringify(i.headers) + (i.body ?? ""));
    return { ok: true, status: 200, json: async () => ({ ack_seq: 99999 }) };
  });
  const link = new NodeLink(r.cfg, r.src, r.spool, t, r.clock, { info: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) });
  // env values only exist in the environ buffer; the parser must drop them
  const keys = parseEnvironKeys(Buffer.from(`CLAUDE_CODE_USE_BEDROCK=${SENTINELS[0]}\0PATH=/bin\0`));
  assert.ok(keys.has("CLAUDE_CODE_USE_BEDROCK"));
  assert.ok(![...keys].some((k) => k.includes(SENTINELS[0])));
  r.src.ln = [{ lane: "bc-x", pane: "w4:p1", host: "asus", model: "ccbedrock:m", startMs: T0 }];
  r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
  r.src.pr = [proc(10, "/wt/a", { bedrockEnv: true })];
  r.src.tails.set("w4:p1", `${SENTINELS[1]}\nAPI Error: 503 ${SENTINELS[1]}`);
  link.scanOnce();
  link.heartbeatOnce();
  r.src.pr = [];
  link.scanOnce();
  await link.flushOnce();
  const state = readFileSync(r.cfg.stateFile, "utf8");
  const blob = bodies.join("\n") + r.logs.join("\n") + state;
  assert.ok(blob.includes("http_503"), "rule id does travel");
  for (const s of SENTINELS) assert.ok(!blob.includes(s), `leaked ${s}`);
  assert.match(bodies[0], /Node asus:[0-9a-f]{64}/);
});

test("node.key must be 0600; PicoTransport is a stub", () => {
  const dir = mkdtempSync(join(tmpdir(), "nlk-"));
  const f = join(dir, "node.key");
  writeFileSync(f, "k", { mode: 0o644 });
  chmodSync(f, 0o644);
  assert.throws(() => readNodeKey(f), /0600/);
  chmodSync(f, 0o600);
  assert.equal(readNodeKey(f), "k");
  assert.throws(() => new PicoTransport().postEvents(), /not in P1/);
});

test("offline after 3 missed scans for non-lane agents", () => {
  const r = rig();
  r.src.pr = [proc(10, "/wt/a")];
  r.link.scanOnce();
  r.src.pr = [];
  for (let i = 0; i < 3; i++) r.link.scanOnce();
  assert.ok(all(r).some((e) => e.kind === "agent.gone"));
});

test("A1) every request, incl. GET, is signed over method/path+query/ts/nonce/sha256(body) with ISO ts and fresh nonce", async () => {
  const seen: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = [];
  const t = new HttpsTransport("http://hub:1", "t4", "k3y", () => T0, async (url, i) => {
    seen.push({ method: i.method, url, headers: i.headers, body: i.body });
    return { ok: true, status: 200, json: async () => ({ ack_seq: 0, events: [], next_cursor: null }) };
  });
  await t.postEvents([]);
  await t.since("c1", 50);
  await t.since(null, 50);
  assert.equal(seen.length, 3);
  const nonces = new Set<string>();
  for (const r of seen) {
    const u = new URL(r.url);
    assert.equal(r.headers["x-ubus-ts"], new Date(T0).toISOString());
    assert.match(r.headers["x-ubus-nonce"], /^[0-9a-f]{32}$/);
    nonces.add(r.headers["x-ubus-nonce"]);
    const want = createHmac("sha256", "k3y")
      .update([r.method, u.pathname + u.search, r.headers["x-ubus-ts"], r.headers["x-ubus-nonce"], createHash("sha256").update(r.body ?? "").digest("hex")].join("\n"))
      .digest("hex");
    assert.equal(r.headers.authorization, `Node t4:${want}`);
  }
  assert.equal(nonces.size, 3, "nonce is fresh per request");
  assert.equal(seen[1].method, "GET");
  assert.match(seen[1].url, /cursor=c1/);
});

test("A1) epoch: created with the spool, persisted, on every event, new spool = new epoch", () => {
  const r = rig();
  r.link.heartbeatOnce();
  r.link.heartbeatOnce();
  const ev = all(r);
  assert.match(ev[0].epoch, /^(?=[0-9a-f]*[a-f])[0-9a-f]{32}$/);
  assert.ok(!/\d{7}/.test(ev[0].epoch));
  assert.ok(ev.every((e) => e.epoch === ev[0].epoch));
  const e1 = r.spool.epoch();
  r.spool.close();
  const again = new Spool(r.cfg.spoolDb);
  assert.equal(again.epoch(), e1, "persisted across restart");
  assert.notEqual(new Spool(join(r.dir, "other.db")).epoch(), e1);
});

test("A1) hub epoch_reset alert in replies and /since rows does not stop the node", async () => {
  const r = rig();
  let n = 0;
  const hub: Transport = {
    async postEvents(evs) {
      n++;
      return { ack_seq: evs[evs.length - 1].seq, alert: "node.epoch_reset" } as never;
    },
    async since() {
      return { events: [{ id: "x1", kind: "alert", subject: "node.epoch_reset" }], next_cursor: null };
    },
  };
  const link = new NodeLink(r.cfg, r.src, r.spool, hub, r.clock, { info() {}, warn() {} });
  link.heartbeatOnce();
  assert.equal(await link.flushOnce(), true);
  link.heartbeatOnce();
  assert.equal(await link.flushOnce(), true);
  assert.equal(r.spool.stats().depth, 0);
  assert.ok(n >= 2);
});

// ---- R3 ---------------------------------------------------------------------

test("R3-1) the six refuter false positives are not errored; real runtime forms are", () => {
  for (const l of [
    "- HTTP 503 responses are now retried with backoff",
    "● Error: handling for the 401 path is now covered by a test",
    "  ⎿  Error: hub status 401",
    "error: expected 503, got 200 in transport.test",
    "> Error: rate limit docs say 429 is returned",
    "src/x.ts(3,1): error TS2345: Argument 'credentials' is not assignable",
    "1. Error: 503 from upstream",
  ]) assert.equal(classifyTail(`ctx\n${l}\nmore`), null, l);
  assert.equal(classifyTail("- HTTP 503 responses are now retried"), null);
  assert.equal(classifyTail("  ⎿  API Error: 503 {\"type\":\"error\"}"), "http_503");
  assert.equal(classifyTail("API Error (503) · Service Unavailable"), "http_503");
  assert.equal(classifyTail("API Error: 529 overloaded_error"), "model_unavailable");
  assert.equal(classifyTail("API Error: 429 rate_limit_error"), "rate_limit");
  assert.equal(classifyTail("Weekly limit reached ∙ resets Monday"), "weekly_limit");
  assert.equal(classifyTail("Error: Failed to execute statement"), "stmt_failed");
  assert.equal(classifyTail("ProviderError: 401 invalid api key"), "auth");
  assert.equal(classifyTail("API Error: 503\n? for shortcuts"), "http_503", "footer chrome after the error is fine");
});

test("R3-1) retrying / recovered errors are not errored; deep and boxed errors ignored", () => {
  assert.equal(classifyTail("  ⎿  API Error (503) · Retrying in 2s (attempt 1/10)"), null);
  assert.equal(classifyTail("  ⎿  API Error (503) · Retrying in 2s (attempt 1/10)\n● Done, wrote file.\n"), null);
  assert.equal(classifyTail("API Error: 503\n● next step done"), null);
  assert.equal(classifyTail("API Error: 503\n" + "ok\n".repeat(60)), null);
  assert.equal(classifyTail("x ╭ API Error: 503 inside box ╮"), null);
});

test("R3-2) a ticking spinner alone does not count as output; real shape fixtures", () => {
  const r = rig();
  r.src.pn = [{ session: "default", paneId: "w:p", cwd: "/a", agentStatus: "working" }];
  r.src.pr = [proc(1, "/a")];
  for (let s = 0; s <= 660; s += 15) {
    r.src.tails.set("w:p", `● Running tests\n\n✻ Thinking… (${s}s · ↓ ${(1.2 + s / 100).toFixed(1)}k tokens · esc to interrupt)\n╭──╮\n│ > │\n╰──╯\n  ? for shortcuts`);
    r.link.scanOnce();
    r.clock.ms += 15_000;
  }
  assert.equal(r.link.table()[0].state, "stalled");
  assert.equal(normaliseTail("✶ Pondering… (2m 3s · ↑ 3.4k tokens)\nreal line"), "real line");
  assert.equal(normaliseTail("· Cogitating… (45s)\nreal 12"), "real 12");
  assert.notEqual(normaliseTail("tests 5 passed"), normaliseTail("tests 6 passed"), "non-status digits still count as output");
  // real output still resets the clock
  r.src.tails.set("w:p", "● Wrote file\n✻ Thinking… (3s · esc to interrupt)");
  r.link.scanOnce();
  assert.equal(r.link.table()[0].state, "working");
});

/** Hub that, like the real one (A1), tracks seq per (node, epoch). */
class EpochHub implements Transport {
  store = new Set<string>();
  async postEvents(evs: NodeEvent[]) {
    for (const e of evs) this.store.add(`${e.epoch}/${e.seq}`);
    const ep = evs[0]?.epoch;
    let a = 0;
    while (this.store.has(`${ep}/${a + 1}`)) a++;
    return { ack_seq: a };
  }
  async since(): Promise<SinceResult> { return { events: [], next_cursor: null }; }
}

test("R3-3) D4: spool deleted mid-run -> new epoch, seq from 1 under it, nothing after the loss is lost, no (epoch,seq) reuse", async () => {
  const r = rig();
  const hub = new EpochHub();
  const link = new NodeLink(r.cfg, r.src, r.spool, hub, r.clock, { info() {}, warn() {} });
  for (let i = 0; i < 50; i++) link.heartbeatOnce();
  await link.flushOnce();
  const e1 = r.spool.epoch();
  assert.equal(hub.store.size, 50);
  rmSync(r.cfg.spoolDb); // db lost while the process keeps running
  for (let i = 0; i < 10; i++) link.heartbeatOnce();
  assert.equal(r.spool.resets, 1);
  const e2 = r.spool.epoch();
  assert.notEqual(e2, e1);
  assert.equal(await link.flushOnce(), true);
  assert.equal(hub.store.size, 60, "all 10 post-loss events stored");
  assert.ok(hub.store.has(`${e2}/1`) && hub.store.has(`${e2}/10`));
  assert.equal(r.spool.stats().depth, 0);
  // restart after loss also mints a new epoch
  r.spool.close();
  rmSync(r.cfg.spoolDb);
  assert.notEqual(new Spool(r.cfg.spoolDb).epoch(), e2);
});

test("R3-3) a stale ack from the old epoch cannot delete events of the new epoch; ack is clamped to what was sent", async () => {
  const r = rig();
  for (let i = 0; i < 3; i++) r.link.heartbeatOnce();
  const e1 = r.spool.epoch();
  rmSync(r.cfg.spoolDb);
  r.link.heartbeatOnce();
  r.spool.ack(99, e1);
  assert.equal(r.spool.stats().depth, 1);
  const sent: number[] = [];
  const t: Transport = { async postEvents(evs) { sent.push(...evs.map((e) => e.seq)); return { ack_seq: 9999 }; }, async since() { return { events: [], next_cursor: null }; } };
  const link = new NodeLink(r.cfg, r.src, r.spool, t, r.clock, { info() {}, warn() {} });
  await link.flushOnce();
  link.heartbeatOnce();
  await link.flushOnce();
  assert.deepEqual(sent, [1, 2], "event 2 was enqueued after an over-ack and is still sent");
});

test("R3-4) lane binds by (session, paneId) when two sessions share a pane id", () => {
  const r = rig((c) => { c.node = "mini"; });
  r.src.ln = [{ lane: "l1", pane: "w1:p1", host: "mini", model: null, startMs: T0 }];
  r.src.pn = [
    { session: "orch", paneId: "w1:p1", cwd: "/orch", agentStatus: "idle" },
    { session: "default", paneId: "w1:p1", cwd: "/lane", agentStatus: "working" },
  ];
  r.src.pr = [proc(1, "/orch"), proc(2, "/lane")];
  r.link.scanOnce();
  const l1 = r.link.table().find((a) => a.lane === "l1")!;
  assert.equal(l1.pid, 2);
  assert.equal(l1.state, "working");
  // an explicit session column wins
  const r2 = rig((c) => { c.node = "mini"; });
  r2.src.ln = [{ lane: "o1", pane: "w1:p1", host: "mini", model: null, startMs: T0, session: "orch" }];
  r2.src.pn = r.src.pn;
  r2.src.pr = r.src.pr;
  r2.link.scanOnce();
  assert.equal(r2.link.table().find((a) => a.lane === "o1")!.pid, 1);
});

test("R3-5) host match is exact or aliased: c3 is not c3x; M11 other-host lane with a live pane is skipped", () => {
  const r = rig((c) => { c.node = "c3"; });
  r.src.ln = [
    { lane: "mine", pane: "w1:p1", host: "c3", model: null, startMs: T0 },
    { lane: "theirs", pane: "w2:p1", host: "c3x", model: null, startMs: T0 },
    { lane: "far", pane: "w3:p1", host: "T4", model: null, startMs: T0 },
  ];
  r.src.pn = [1, 2, 3].map((n) => ({ session: "default", paneId: `w${n}:p1`, cwd: `/p${n}`, agentStatus: "idle" }));
  r.link.scanOnce();
  assert.deepEqual(r.link.table().filter((a) => a.lane).map((a) => a.lane), ["mine"]);
});

test("SHOULD) flushOnce has an in-flight guard", async () => {
  const r = rig();
  r.link.heartbeatOnce();
  let calls = 0, release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const t: Transport = { async postEvents(evs) { calls++; await gate; return { ack_seq: evs[evs.length - 1].seq }; }, async since() { return { events: [], next_cursor: null }; } };
  const link = new NodeLink(r.cfg, r.src, r.spool, t, r.clock, { info() {}, warn() {} });
  const a = link.flushOnce();
  assert.equal(await link.flushOnce(), false);
  release();
  assert.equal(await a, true);
  assert.equal(calls, 1);
});

test("SHOULD) key perms: 0640/0604/0660/0610, symlink to 0644 and empty file are refused; 0400/0600 pass", () => {
  const d = mkdtempSync(join(tmpdir(), "kp-"));
  const f = join(d, "k");
  writeFileSync(f, "x");
  for (const m of [0o644, 0o640, 0o604, 0o660, 0o610]) { chmodSync(f, m); assert.throws(() => readNodeKey(f), /0600/, m.toString(8)); }
  chmodSync(f, 0o600); assert.equal(readNodeKey(f), "x");
  chmodSync(f, 0o400); assert.equal(readNodeKey(f), "x");
  const g = join(d, "g"); writeFileSync(g, "y"); chmodSync(g, 0o644);
  symlinkSync(g, join(d, "ln"));
  assert.throws(() => readNodeKey(join(d, "ln")));
  writeFileSync(join(d, "e"), "  \n", { mode: 0o600 });
  assert.throws(() => readNodeKey(join(d, "e")), /empty/);
});

test("SHOULD) survivors: catch-up after reconnect, 1-scan blip is not offline, tail window bounded, capped scan never stalls", async () => {
  const r = rig();
  let calls = 0;
  r.hub.since = async () => { calls++; return { events: [{ id: "z" }], next_cursor: "c1" }; };
  r.link.heartbeatOnce();
  await r.link.flushOnce();
  assert.ok(calls >= 1);
  assert.equal(r.spool.cursor(), "c1");
  const q = rig();
  q.src.pr = [proc(1, "/a")];
  q.link.scanOnce();
  q.src.pr = [];
  q.link.scanOnce();
  q.link.scanOnce();
  assert.notEqual(q.link.table()[0].state, "offline", "2 missed scans is not offline");
  assert.equal(classifyTail("API Error: 503\n" + "ok\n".repeat(60)), null);
  // capped worktree scan: files unknown -> never stall
  const s = rig();
  s.src.worktreeMtime = () => "unknown";
  s.src.pn = [{ session: "default", paneId: "w:p", cwd: "/a", agentStatus: "working" }];
  s.src.pr = [proc(1, "/a")];
  s.src.tails.set("w:p", "static");
  for (let i = 0; i < 60; i++) { s.clock.ms += 15_000; s.link.scanOnce(); }
  assert.equal(s.link.table()[0].state, "working");
});

// ---- R4 ---------------------------------------------------------------------

test("R4-1) minted epochs are 32 lowercase hex, have a letter, no 7+ digit run", () => {
  for (let i = 0; i < 2000; i++) {
    const e = mintEpoch();
    assert.match(e, /^(?=[0-9a-f]*[a-f])[0-9a-f]{32}$/);
    assert.ok(!/\d{7}/.test(e), e);
  }
});

test("R4-2) hub rejected[] events go dead with their rule id, alert once, and never stall the queue", async () => {
  const r = rig();
  for (let i = 0; i < 5; i++) r.link.heartbeatOnce();
  const sent: number[][] = [];
  const hub: Transport = {
    async postEvents(evs) {
      sent.push(evs.map((e) => e.seq));
      const bad = evs.filter((e) => e.seq === 1);
      const have = evs.filter((e) => e.seq !== 1 && !(e.kind === "alert"));
      return { ack_seq: evs[evs.length - 1].seq, rejected: bad.map((e) => ({ seq: e.seq, rule: "schema.epoch" })), } as never;
    },
    async since() { return { events: [], next_cursor: null }; },
  };
  const link = new NodeLink(r.cfg, r.src, r.spool, hub, r.clock, { info() {}, warn() {} });
  assert.equal(await link.flushOnce(), true);
  assert.equal(r.spool.stats().depth, 0);
  assert.equal(r.spool.stats().dead, 1);
  const alerts = all(r);
  assert.equal(alerts.length, 0, "everything sent was acked");
  // the alert was queued then sent in the same drain loop
  const flat = sent.flat();
  assert.equal(flat.filter((q) => q === 1).length, 1, "dead event is never resent");
  assert.ok(flat.includes(6), "one alert event (seq 6) went out");
  const dead = r.spool.db.prepare("SELECT rule FROM dead").get() as { rule: string };
  assert.equal(dead.rule, "schema.epoch");
});

test("R4-2) a hub that rejects everything, including the alert, does not loop forever", async () => {
  const r = rig();
  r.link.heartbeatOnce();
  let posts = 0;
  const hub: Transport = {
    async postEvents(evs) { posts++; return { ack_seq: 0, rejected: evs.map((e) => ({ seq: e.seq, rule: "schema.epoch" })) }; },
    async since() { return { events: [], next_cursor: null }; },
  };
  const link = new NodeLink(r.cfg, r.src, r.spool, hub, r.clock, { info() {}, warn() {} });
  await link.flushOnce();
  await link.flushOnce();
  assert.ok(posts < 10, `posts=${posts}`);
  assert.equal(r.spool.stats().depth, 0);
});

const HUB_ROOT = process.env.HUB || process.cwd();
test("R4-3) EP2 real hub e2e: every event acked, spool depth 0", { timeout: 30000, skip: !existsSync(join(HUB_ROOT, "dist/src/v3/hub/index.js")) }, async () => {
  process.env.UBUS_V3 = "1";
  const { HubServer } = (await import(join(HUB_ROOT, "dist/src/v3/hub/index.js"))) as { HubServer: new (c: unknown) => { listen(): Promise<{ port: number }>; close(): Promise<void>; server?: { closeAllConnections?: () => void } } };
  const d = mkdtempSync(join(tmpdir(), "ep2-"));
  const kd = join(d, "nodes");
  mkdirSync(kd);
  writeFileSync(join(kd, "asus.key"), "testkey-not-real", { mode: 0o600 });
  const hub = new HubServer({ dbPath: join(d, "ev.db"), listen: { host: "127.0.0.1", port: 0 }, keyDir: kd, laneOwnersPath: join(d, "lo.json") });
  const { port } = await hub.listen();
  try {
    const r = rig();
    const t = new HttpsTransport(`http://127.0.0.1:${port}`, "asus", "testkey-not-real", () => Date.now());
    const link = new NodeLink(r.cfg, r.src, r.spool, t, { now: () => Date.now() }, { info() {}, warn() {} });
    r.src.ln = [{ lane: "bc-x", pane: "w4:p1", host: "asus", model: null, startMs: T0 }];
    r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
    r.src.pr = [proc(10, "/wt/a")];
    link.scanOnce();
    for (let i = 0; i < 3; i++) link.heartbeatOnce();
    r.src.pr = [];
    link.scanOnce(); // errored + alert
    // the hub refuses timestamps within 5 s of its own boot (before_boot)
    await new Promise((res) => setTimeout(res, 5500));
    const queued = r.spool.stats().lastSeq;
    assert.ok(queued >= 6);
    assert.equal(await link.flushOnce(), true);
    assert.equal(r.spool.stats().depth, 0, "hub acked everything");
    assert.equal(r.spool.stats().dead, 0, "hub rejected nothing");
    assert.equal(r.spool.stats().ackedSeq, queued);
  } finally {
    hub.server?.closeAllConnections?.();
    hub.close().catch(() => undefined);
  }
});

test("R4-4) genuine error followed by the borderless modern prompt is errored; opencode braille spinner stalls", () => {
  const foot = "\n────────────────────────\n> \n────────────────────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)";
  assert.equal(classifyTail("  ⎿  API Error: 529 overloaded_error" + foot), "model_unavailable");
  assert.equal(classifyTail("  ⎿  API Error: 529 overloaded_error\n❯ \n"), "model_unavailable");
  assert.equal(classifyTail("  ⎿  API Error: 529 overloaded_error\n> typed draft text"), null, "agent already moved on");
  const r = rig();
  r.src.pn = [{ session: "default", paneId: "w:p", cwd: "/a", agentStatus: "working" }];
  r.src.pr = [proc(1, "/a")];
  const B = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  for (let s = 0, k = 0; s <= 660; s += 15, k++) { r.src.tails.set("w:p", `build\n${B[k % 10]} Working...`); r.link.scanOnce(); r.clock.ms += 15_000; }
  assert.equal(r.link.table()[0].state, "stalled");
});

test("R4-5) the request timestamp is the local clock, unmodified (ISO)", async () => {
  let ts = "";
  const t = new HttpsTransport("http://h", "asus", "k", () => T0 + 7000, async (_u, i) => { ts = i.headers["x-ubus-ts"]; return { ok: true, status: 200, json: async () => ({ ack_seq: 0 }) }; });
  await t.postEvents([]);
  assert.equal(ts, new Date(T0 + 7000).toISOString());
});

test("R4 survivors) N1 decorated bullets/quotes before API Error; N6 digit mask; N9 inode swap; N11 ack clamp; N13 explicit session", async () => {
  for (const l of ["- API Error (401) when key expired", "* API Error: 503 is what users saw", "> API Error: 529 overloaded_error", "1. API Error: 503"]) assert.equal(classifyTail(`● Summary\n${l}`), null, l);
  assert.equal(normaliseTail("  ⎿  Running… (12s · esc to interrupt)"), normaliseTail("  ⎿  Running… (47s · esc to interrupt)"));
  assert.equal(normaliseTail("tokens used: 1200"), normaliseTail("tokens used: 3400"));
  // N9: a different file at the same path (inode swap) is a new spool
  const r = rig();
  r.link.heartbeatOnce();
  const e1 = r.spool.epoch();
  const other = join(r.dir, "other.db");
  new Spool(other).close();
  renameSync(other, r.cfg.spoolDb);
  const e2 = r.spool.epoch();
  assert.notEqual(e2, e1);
  assert.equal(r.spool.resets, 1);
  // N11: ack beyond what was sent is clamped in the stored ackedSeq
  r.link.heartbeatOnce();
  const t: Transport = { async postEvents() { return { ack_seq: 9999 }; }, async since() { return { events: [], next_cursor: null }; } };
  await new NodeLink(r.cfg, r.src, r.spool, t, r.clock, { info() {}, warn() {} }).flushOnce();
  assert.equal(r.spool.stats().ackedSeq, 1);
  // N13: explicit session that has no such pane must not bind to the same id in another session
  const q = rig((c) => { c.node = "mini"; });
  q.src.ln = [{ lane: "o1", pane: "w1:p1", host: "mini", model: null, startMs: T0, session: "orch" }];
  q.src.pn = [{ session: "default", paneId: "w1:p1", cwd: "/lane", agentStatus: "working" }];
  q.src.pr = [proc(2, "/lane")];
  q.link.scanOnce();
  assert.ok(!q.link.table().some((a) => a.lane === "o1"));
  // numeric next_cursor from the real hub is stored as text and does not loop
  const n = rig();
  let calls = 0;
  n.hub.since = async () => { calls++; return { events: [], next_cursor: 7 as never }; };
  n.link.heartbeatOnce();
  await n.link.flushOnce();
  assert.equal(n.spool.cursor(), "7");
  assert.equal(calls, 2);
});

// ---- R5 ---------------------------------------------------------------------

/** Fake hub that mimics the real one: rejected seqs are consumed, ack is contiguous. */
class RejHub implements Transport {
  seen = new Set<number>();
  sent: NodeEvent[] = [];
  constructor(private readonly bad: (e: NodeEvent) => boolean) {}
  async postEvents(evs: NodeEvent[]) {
    const rejected: Array<{ seq: number; rule: string }> = [];
    for (const e of evs) {
      this.sent.push(e);
      if (this.bad(e)) rejected.push({ seq: e.seq, rule: "phi.digits" });
      this.seen.add(e.seq);
    }
    let a = 0;
    while (this.seen.has(a + 1)) a++;
    return { ack_seq: a, rejected };
  }
  async since(): Promise<SinceResult> { return { events: [], next_cursor: null }; }
}

const alertsOf = (r: ReturnType<typeof rig>, reason: string) => all(r).filter((e) => e.kind === "alert" && e.reason === reason);

test("R5/R6) middle-of-batch rejection: no stall, order kept, one alert, nothing resent", async () => {
  const hub = new RejHub((e) => e.seq === 3);
  const r = rig();
  const link = new NodeLink(r.cfg, r.src, r.spool, hub, r.clock, { info() {}, warn() {} });
  for (let i = 0; i < 6; i++) link.heartbeatOnce();
  assert.ok(await link.flushOnce());
  const s = r.spool.stats();
  assert.equal(s.depth, 0);
  assert.equal(s.dead, 1);
  assert.equal(s.ackedSeq, 7);
  assert.deepEqual(hub.sent.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(hub.sent.filter((e) => e.reason === "hub_rejected").length, 1);
  assert.equal(hub.sent.at(-1)!.meta.dead_seq, 3);
  assert.equal(hub.sent.at(-1)!.meta.rule, "phi.digits");
});

test("R5/R7) rejected[] over HttpsTransport: junk ignored, rule text sanitised, foreign seq ignored by the node", async () => {
  let reply: unknown;
  const t = new HttpsTransport("http://h", "asus", "k", () => Date.now(), async () => ({ ok: true, status: 200, json: async () => reply }));
  reply = { ack_seq: 0, rejected: [{ seq: null, rule: "x" }, { seq: "2", rule: "x" }, null, { seq: 99, rule: "x" }, { seq: 1, rule: "bad rule <1234567>" }] };
  assert.deepEqual((await t.postEvents([])).rejected, [{ seq: 99, rule: "x" }, { seq: 1, rule: "rejected" }]);
  // end to end through the real transport: a rejection is matched by seq, not by position in the batch
  const r = rig();
  r.link.heartbeatOnce();
  r.link.heartbeatOnce();
  const bodies: NodeEvent[][] = [];
  const t2 = new HttpsTransport("http://h", "asus", "k", () => Date.now(), async (_u, i) => {
    const evs = (JSON.parse(i.body ?? "{}") as { events?: NodeEvent[] }).events ?? [];
    bodies.push(evs);
    return { ok: true, status: 200, json: async () => ({ ack_seq: evs.at(-1)!.seq, rejected: [{ seq: 2, rule: "schema.x" }, { seq: 999, rule: "x" }] }) };
  });
  const link = new NodeLink(r.cfg, r.src, r.spool, t2, r.clock, { info() {}, warn() {} });
  assert.ok(await link.flushOnce());
  assert.equal(r.spool.stats().dead, 1);
  const dead = r.spool.db.prepare("SELECT seq, rule FROM dead").all() as Array<{ seq: number; rule: string }>;
  assert.deepEqual(dead.map((d) => ({ ...d })), [{ seq: 2, rule: "schema.x" }]);
  assert.equal(alertsOf(r, "hub_rejected").length + bodies.flat().filter((e) => e.reason === "hub_rejected").length, 1);
});

test("R5/R3) real hub rejects a lane name with an 8-digit run: dead + one alert each, queue drains, ack = last seq", { timeout: 30000, skip: !existsSync(join(HUB_ROOT, "dist/src/v3/hub/index.js")) }, async () => {
  process.env.UBUS_V3 = "1";
  const { HubServer } = (await import(join(HUB_ROOT, "dist/src/v3/hub/index.js"))) as { HubServer: new (c: unknown) => { listen(): Promise<{ port: number }>; close(): Promise<void>; server?: { closeAllConnections?: () => void } } };
  const d = mkdtempSync(join(tmpdir(), "r3-"));
  const kd = join(d, "nodes");
  mkdirSync(kd);
  writeFileSync(join(kd, "asus.key"), "testkey-not-real", { mode: 0o600 });
  const hub = new HubServer({ dbPath: join(d, "ev.db"), listen: { host: "127.0.0.1", port: 0 }, keyDir: kd, laneOwnersPath: join(d, "lo.json") });
  const { port } = await hub.listen();
  try {
    const r = rig();
    const t = new HttpsTransport(`http://127.0.0.1:${port}`, "asus", "testkey-not-real", () => Date.now());
    const link = new NodeLink(r.cfg, r.src, r.spool, t, { now: () => Date.now() }, { info() {}, warn() {} });
    r.src.ln = [{ lane: "bc-20261018", pane: "w4:p1", host: "asus", model: null, startMs: T0 }];
    r.src.pn = [{ session: "default", paneId: "w4:p1", cwd: "/wt/a", agentStatus: "working" }];
    r.src.pr = [proc(10, "/wt/a")];
    link.scanOnce();
    link.heartbeatOnce();
    const before = r.spool.stats().lastSeq;
    await new Promise((res) => setTimeout(res, 5600)); // hub boot floor
    assert.equal(await link.flushOnce(), true, "drained");
    const s = r.spool.stats();
    assert.ok(s.dead >= 1, "something was rejected");
    assert.equal(s.depth, 0);
    assert.equal(s.ackedSeq, s.lastSeq);
    assert.equal(s.lastSeq - before, s.dead, "exactly one alert per dead event");
    assert.ok(await link.flushOnce());
    assert.equal(r.spool.stats().lastSeq, s.lastSeq, "no re-alert on a later flush");
  } finally {
    hub.server?.closeAllConnections?.();
    hub.close().catch(() => undefined);
  }
});

test("R5) flush failures log a rate-limited warn with the HTTP status and nothing else", async () => {
  const r = rig();
  r.link.heartbeatOnce();
  let status = 401;
  const t: Transport = { async postEvents() { throw new Error(`hub status ${status}`); }, async since() { return { events: [], next_cursor: null }; } };
  const link = new NodeLink(r.cfg, r.src, r.spool, t, r.clock, { info: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) });
  for (let i = 0; i < 5; i++) { r.clock.ms += 70_000 / 5; await link.flushOnce(); }
  const warns = r.logs.filter((l) => l.startsWith("flush failed"));
  assert.ok(warns.length >= 1 && warns.length <= 2, `warns=${warns.length}`);
  assert.match(warns[0], /status 401/);
  status = 503;
  r.clock.ms += 120_000;
  await link.flushOnce();
  assert.ok(r.logs.some((l) => /status 503/.test(l)));
  const t2: Transport = { async postEvents() { throw new Error("connect ECONNREFUSED 10.0.0.1:443"); }, async since() { return { events: [], next_cursor: null }; } };
  const l2 = new NodeLink(r.cfg, r.src, r.spool, t2, r.clock, { info: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) });
  r.clock.ms += 120_000;
  await l2.flushOnce();
  assert.ok(r.logs.some((l) => l.includes("network error")));
  assert.ok(!r.logs.some((l) => l.includes("10.0.0.1")), "raw error text is not logged");
});

test("R6-1) herdr ENOENT: error logged every scan, never swallowed, status reports herdr_missing", () => {
  const r = rig((c) => { c.herdrBin = "/nonexistent/herdr-xyz"; });
  const real = realSources(r.cfg);
  assert.deepEqual(real.panes(), []);
  assert.equal(real.herdrMissing!(), true);
  const errs: string[] = [];
  const src = new FakeSources();
  (src as Sources).herdrMissing = () => true;
  const link = new NodeLink(r.cfg, src, r.spool, r.hub, r.clock, { info() {}, warn() {}, error: (m) => errs.push(m) });
  link.scanOnce();
  link.scanOnce();
  assert.equal(errs.length, 2, "one error per scan interval");
  assert.match(errs[0], /herdr executable not found/);
  assert.equal(JSON.parse(readFileSync(r.cfg.stateFile, "utf8")).herdr_missing, true);
  // present binary (any exit code other than ENOENT) is not "missing"
  r.cfg.herdrBin = process.execPath;
  const ok = realSources(r.cfg);
  ok.panes();
  assert.equal(ok.herdrMissing!(), false);
});

test("R6) duplicate seq in rejected[] gives one alert; stepped-back clock does not stall flush; bad reply and lookalike messages", async () => {
  const r = rig();
  r.link.heartbeatOnce();
  const seq = r.spool.pending(1)[0].seq;
  let mode: "dup" | "fail" | "ok" = "dup";
  const t: Transport = {
    async postEvents(ev) {
      if (mode === "fail") throw new Error("hub reply without ack_seq");
      if (mode === "ok") return { ack_seq: ev[ev.length - 1].seq };
      return { ack_seq: ev[ev.length - 1].seq, rejected: [{ seq, rule: "r1" }, { seq, rule: "r1" }] };
    },
    async since() { return { events: [], next_cursor: null }; },
  };
  const link = new NodeLink(r.cfg, r.src, r.spool, t, r.clock, { info: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) });
  const before = r.spool.stats().lastSeq;
  await link.flushOnce();
  assert.equal(r.spool.stats().lastSeq - before, 1, "one alert for a duplicated rejected seq");
  // fail with a far-future retryAt, as after a forward-stepped clock, then step back
  mode = "fail";
  r.link.heartbeatOnce();
  r.clock.ms += 10 * 60_000;
  for (let i = 0; i < 8; i++) await link.flushOnce();
  assert.ok(r.logs.some((l) => l === `flush failed: bad reply (spool depth ${r.spool.stats().depth})`), "bad reply labelled with true depth");
  mode = "ok";
  r.clock.ms -= 5 * 60_000;
  assert.equal(await link.flushOnce(), true, "retry gap above 60 s is reset after a backward clock step");
  // a message that only contains a status does not pass the anchored matcher
  const t3: Transport = { async postEvents() { throw new Error("proxy said hub status 401 here"); }, async since() { return { events: [], next_cursor: null }; } };
  const l3 = new NodeLink(r.cfg, r.src, r.spool, t3, r.clock, { info: (m) => r.logs.push(m), warn: (m) => r.logs.push(m) });
  r.link.heartbeatOnce();
  r.clock.ms += 120_000;
  await l3.flushOnce();
  assert.ok(r.logs.some((l) => l.startsWith("flush failed: network error")));
});

// ---- R7: install script on a fake PATH layout -----------------------------
const INSTALL = join(process.cwd(), "nodelink", "install", "install-nodelink.sh");
function installRig(os: string, opts: { herdr?: boolean; homeName?: string } = {}) {
  const base = mkdtempSync(join(tmpdir(), "inst-"));
  const home = join(base, opts.homeName ?? "home");
  const bin = join(base, "weird", "cargo-bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  symlinkSync(process.execPath, join(bin, "node"));
  if (opts.herdr !== false) { writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); }
  const run = () => spawnSync("sh", [INSTALL], { env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, UBUS_INSTALL_OS: os }, encoding: "utf8" });
  return { base, home, bin, run };
}

test("R7-1) macOS install pins node and herdr from a dir outside the default PATH: plist args, PATH and herdrBin", () => {
  const r = installRig("Darwin");
  const p = r.run();
  assert.equal(p.status, 0, p.stderr);
  const plist = readFileSync(join(r.home, "Library/LaunchAgents/in.evenhc.ubus-nodelink.plist"), "utf8");
  assert.ok(plist.includes(`<string>${join(r.bin, "node")}</string>`), "absolute node in ProgramArguments");
  const path = /<key>PATH<\/key><string>([^<]*)<\/string>/.exec(plist)![1];
  assert.ok(path.split(":").includes(r.bin), "herdr/node dir is on the plist PATH");
  for (const d of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) assert.ok(path.split(":").includes(d), d);
  assert.ok(!/@[A-Z]+@/.test(plist.replace(/<!--[\s\S]*?-->/g, "")), "no placeholders left outside comments");
  const cfg = JSON.parse(readFileSync(join(r.home, ".ubus/nodelink.json"), "utf8"));
  assert.equal(cfg.herdrBin, join(r.bin, "herdr"));
  // and nodelink really finds it with that config
  const real = realSources({ ...defaultConfig(), herdrBin: cfg.herdrBin });
  real.panes();
  assert.equal(real.herdrMissing!(), false);
});

test("R7-2) install fails loudly and writes nothing when herdr is not found", () => {
  const r = installRig("Darwin", { herdr: false });
  const p = r.run();
  assert.equal(p.status, 1);
  assert.match(p.stderr, /herdr not found/);
  assert.equal(existsSync(join(r.home, "Library")), false);
  assert.equal(existsSync(join(r.home, ".ubus/nodelink.json")), false);
});

test("R7-3) Linux unit carries node and herdr dirs; existing config keys survive; old unit is backed up; odd HOME is rendered intact", () => {
  const r = installRig("Linux", { homeName: "h|o&me" });
  mkdirSync(join(r.home, ".ubus"), { recursive: true });
  writeFileSync(join(r.home, ".ubus/nodelink.json"), JSON.stringify({ node: "t4" }));
  assert.equal(r.run().status, 0);
  const unit = join(r.home, ".config/systemd/user/ubus-nodelink.service");
  const txt = readFileSync(unit, "utf8");
  assert.ok(txt.includes(`Environment=PATH=${r.bin}:`));
  assert.ok(txt.includes(join(r.home, ".local/bin")), "HOME with | and & rendered intact");
  assert.equal(JSON.parse(readFileSync(join(r.home, ".ubus/nodelink.json"), "utf8")).node, "t4");
  assert.equal(r.run().status, 0);
  assert.ok(existsSync(unit + ".bak"));
});

test("R7-4) unusable herdr (EACCES / directory) counts as missing, a non-zero exit does not; alert on each transition", () => {
  const r = rig();
  const dir = mkdtempSync(join(tmpdir(), "hd-"));
  r.cfg.herdrBin = dir;
  const bad = realSources(r.cfg);
  bad.panes();
  assert.equal(bad.herdrMissing!(), true);
  const nonzero = join(dir, "fail");
  writeFileSync(nonzero, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  r.cfg.herdrBin = nonzero;
  const ok = realSources(r.cfg);
  ok.panes();
  assert.equal(ok.herdrMissing!(), false);
  let missing = true;
  (r.src as Sources).herdrMissing = () => missing;
  const alerts = () => all(r).filter((e) => e.kind === "alert").map((e) => e.reason);
  r.link.scanOnce(); r.link.scanOnce();
  assert.deepEqual(alerts(), ["herdr_missing"], "one alert for the transition, not one per scan");
  missing = false;
  r.link.scanOnce(); r.link.scanOnce();
  assert.deepEqual(alerts(), ["herdr_missing", "herdr_recovered"]);
});
