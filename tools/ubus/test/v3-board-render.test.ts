import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { renderRoute, listenBoard } from "../src/v3/board/server.js";
import { BODY_CLIP_CHARS } from "../src/v3/board/render.js";
import type { AgentState, BoardSource, BoardViews, MessageView } from "../src/v3/board/types.js";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const STATES: AgentState[] = ["working", "idle", "stalled", "errored", "finished", "offline"];

function agents(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `role${i}@node${i % 7}`,
    node: `node${i % 7}`,
    kind: "claude-code",
    lane: i % 2 ? `lane-${i}` : null,
    pane: null,
    model: "m",
    state: STATES[i % STATES.length],
    last_heartbeat: new Date(NOW - i * 1000).toISOString(),
  }));
}

function msg(over: Partial<MessageView>): MessageView {
  return {
    id: "m1", ts: "2026-10-18T09:00:00Z", from: "a", to: ["b"], kind: "msg", priority: "normal",
    subject: "s", body: "hi", body_ref: "", lane: null, states: { b: { state: "delivered", reason: "" } },
    ...over,
  };
}

function src(v: Partial<BoardViews>): BoardSource {
  return { views: async () => ({ agents: [], lanes: [], messages: [], ...v }) };
}

const ROUTES = ["/", "/fleet", "/lanes", "/messages", "/history"];

test("a) every view renders with 0, 1 and 300 agents", async () => {
  for (const n of [0, 1, 300]) {
    const v = {
      agents: agents(n),
      lanes: agents(n).map((a, i) => ({
        lane_id: `l${i}`, title: "t", brief_ref: ".bc/x.md", owner: "o", builder: null, refuter: null,
        branch: null, state: "building" as const, verdict_ref: null,
      })),
      messages: agents(n).map((_, i) => msg({ id: `m${i}` })),
    };
    for (const r of ROUTES) {
      const html = await renderRoute(src(v), r, new URLSearchParams(), NOW);
      assert.ok(html && html.includes("<!doctype html>"), `${r} n=${n}`);
      assert.match(html, /http-equiv="refresh" content="15;/);
      assert.match(html, /name="viewport"/);
      assert.match(html, /prefers-color-scheme:dark/);
    }
  }
  assert.equal(await renderRoute(src({}), "/nope", new URLSearchParams(), NOW), null);
});

test("b) script injection in a lane name is escaped", async () => {
  const evil = `<script>alert(1)</script>"'&`;
  const v = {
    agents: [{ ...agents(1)[0], lane: evil }],
    lanes: [{ lane_id: evil, title: evil, brief_ref: evil, owner: evil, builder: evil, refuter: evil, branch: evil, state: "pass" as const, verdict_ref: evil }],
    messages: [msg({ lane: evil, subject: evil, from: evil })],
  };
  for (const r of ["/fleet", "/lanes", "/messages"]) {
    const html = (await renderRoute(src(v), r, new URLSearchParams({ lane: evil }), NOW))!;
    assert.ok(!html.includes("<script>"), r);
    assert.ok(!html.includes("alert(1)</script>"), r);
  }
  const lanes = (await renderRoute(src(v), "/lanes", new URLSearchParams(), NOW))!;
  assert.ok(lanes.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("c) a 1000-char body is cut at 280 with an ellipsis", async () => {
  const html = (await renderRoute(src({ messages: [msg({ body: "x".repeat(1000) })] }), "/messages", new URLSearchParams(), NOW))!;
  assert.ok(html.includes("x".repeat(BODY_CLIP_CHARS) + "…"));
  assert.ok(!html.includes("x".repeat(BODY_CLIP_CHARS + 1)));
});

test("d) unacked orders sort first and are marked", async () => {
  const messages = [
    msg({ id: "new", ts: "2026-10-18T09:59:00Z", subject: "NEWCHAT" }),
    msg({ id: "ord", ts: "2026-10-18T01:00:00Z", kind: "order", subject: "OLDORDER", states: { b: { state: "read", reason: "" } } }),
    msg({ id: "acked", ts: "2026-10-18T09:00:00Z", kind: "order", subject: "ACKEDORDER", states: { b: { state: "acked", reason: "" } } }),
  ];
  const html = (await renderRoute(src({ messages }), "/messages", new URLSearchParams(), NOW))!;
  assert.ok(html.indexOf("OLDORDER") < html.indexOf("NEWCHAT"));
  assert.ok(html.indexOf("OLDORDER") < html.indexOf("ACKEDORDER"));
  assert.equal(html.match(/class="msg unacked"/g)?.length, 1);
  assert.equal(html.match(/UNACKED/g)?.length, 1);
  assert.match(html, /\.msg\.unacked\{border-color:var\(--err\)/);
});

test("message filters by agent, lane and state", async () => {
  const messages = [
    msg({ id: "1", subject: "ONE", from: "x", lane: "L1" }),
    msg({ id: "2", subject: "TWO", from: "y", lane: "L2", states: { b: { state: "acked", reason: "" } } }),
  ];
  const f = async (q: Record<string, string>) => (await renderRoute(src({ messages }), "/messages", new URLSearchParams(q), NOW))!;
  let html = await f({ agent: "x" });
  assert.ok(html.includes("ONE") && !html.includes("TWO"));
  html = await f({ lane: "L2" });
  assert.ok(html.includes("TWO") && !html.includes("ONE"));
  html = await f({ state: "acked" });
  assert.ok(html.includes("TWO") && !html.includes("ONE"));
});

test("e) no external URL in any rendered page", async () => {
  const v = { agents: agents(5), lanes: [], messages: [msg({})] };
  for (const r of ROUTES) {
    const html = (await renderRoute(src(v), r, new URLSearchParams(), NOW))!;
    assert.ok(!/https?:\/\//i.test(html), r);
    assert.ok(!/\/\/[a-z0-9.-]+\.[a-z]/i.test(html.replace(/<style>[\s\S]*?<\/style>/, "")), r);
    assert.ok(!/<(script|link|img|iframe)\b/i.test(html), r);
  }
});

test("server: binds loopback, serves pages, GET only, 404", async () => {
  const server = await listenBoard({ source: src({ agents: agents(2) }), port: 0 });
  try {
    const addr = server.address() as AddressInfo;
    assert.equal(addr.address, "127.0.0.1");
    const base = `http://127.0.0.1:${addr.port}`;
    const ok = await fetch(`${base}/fleet`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    assert.equal((await fetch(`${base}/fleet`, { method: "POST" })).status, 405);
  } finally {
    server.close();
  }
});

test("hub failure renders an unavailable page, not a crash", async () => {
  const bad: BoardSource = { views: async () => { throw new Error("down"); } };
  const html = (await renderRoute(bad, "/fleet", new URLSearchParams(), NOW))!;
  assert.match(html, /hub views unavailable/);
});
