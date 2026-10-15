// The live page is the catalog page: it never calls the seven older tools; the current-tools page never calls scribe_catalog. Behavioural and on the built pages.
import test from "node:test";
import assert from "node:assert/strict";
import { createAdapter } from "../src/adapter.js";
import { createCurrentImpl, TOOLS } from "../src/adapter-current.js";
import { createCatalogImpl, CATALOG_ACTIONS, CATALOG_TOOLS } from "../src/adapter-catalog.js";
import { buildPage, CAPABILITIES, CAPABILITIES_CURRENT } from "../build.mjs";
import { makeMockMcp } from "./mock-scribe.mjs";
import { makeMockCatalog } from "./mock-catalog.mjs";
import { mockupData, payloads } from "./helpers.mjs";

const C = mockupData().consults;
// a recorder that accepts every tool name and answers like the matching mock, so nothing is refused for being "unknown"
function recorder() {
  const cur = makeMockMcp(payloads()), cat = makeMockCatalog(C), seen = [], actions = [];
  return { seen, actions, async callTool(s, t, args, o) { seen.push(t); if (args && args.action) actions.push(args.action); return t === "scribe_catalog" ? cat.callTool(s, t, args, o) : cur.callTool(s, t, args, o); } };
}
const drive = async a => {
  const r = await a.listDays({ from: "2026-09-09", to: "2026-10-13" });
  const cell = r.ok && r.data.cells[0];
  if (cell) { const l = await a.listConsults({ doctorId: cell.doctorId, date: cell.date }); if (l.ok && l.data[0]) { await a.getConsult(l.data[0].consult_uid); await a.getAudio(l.data[0].consult_uid); } }
  await a.getConsult("syn_c001"); await a.getConsult("syn_c0001");
};

test("current-tools adapter never calls scribe_catalog, and only its declared tools", async () => {
  const mcp = recorder();
  await drive(createAdapter(createCurrentImpl({ mcp })));
  assert.ok(mcp.seen.length > 5);
  assert.ok(!mcp.seen.includes("scribe_catalog"));
  assert.ok(mcp.seen.every(t => TOOLS.includes(t)), [...new Set(mcp.seen)].join());
});

test("catalog (live) adapter never calls any of the seven older tools, and only its declared actions", async () => {
  const mcp = recorder();
  await drive(createAdapter(createCatalogImpl({ mcp })));
  assert.ok(mcp.seen.length > 5);
  assert.ok(mcp.seen.every(t => t === "scribe_catalog"), [...new Set(mcp.seen)].join());
  assert.ok(mcp.actions.every(x => CATALOG_ACTIONS.includes(x)), [...new Set(mcp.actions)].join());
  for (const t of TOOLS) assert.ok(!mcp.seen.includes(t), t);
  assert.deepEqual(CATALOG_TOOLS.filter(t => TOOLS.includes(t)), [], "the two manifests share no tool");
});

test("sources: each adapter file names only its own tools", async () => {
  const { readFileSync } = await import("node:fs");
  const rd = f => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.doesNotMatch(rd("adapter-current.js").replace(/\/\/.*$/gm, ""), /scribe_catalog/);
  const cat = rd("adapter-catalog.js").replace(/\/\/.*$/gm, "");
  for (const t of TOOLS) assert.ok(!cat.includes(t), t);
  assert.doesNotMatch(rd("mcp-call.js"), /scribe_(reb_index|freescript|rubric|jev|list_encounters|encounter|stt_runs)/);
});

test("the two built pages differ in the build constant, manifests and tool lists, and nothing else", () => {
  const live = buildPage("catalog"), cat = buildPage("current");
  assert.notEqual(live, cat);
  const a = live.split("\n"), b = cat.split("\n");
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
  assert.deepEqual(diff, [['const ADAPTER = "catalog";', 'const ADAPTER = "current";']]);
  assert.notDeepEqual(CAPABILITIES, CAPABILITIES_CURRENT);
  assert.deepEqual(CAPABILITIES.mcp.servers[0].tools, CATALOG_TOOLS);
  assert.deepEqual(CAPABILITIES_CURRENT.mcp.servers[0].tools, TOOLS);
  assert.ok(TOOLS.length === 7 && CATALOG_TOOLS.length === 1);
});

test("the page picks its adapter only by the build constant (one line in main.js)", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.equal(main.split("\n").filter(l => /createCatalogImpl\(/.test(l)).length, 1);
  assert.match(main, /ADAPTER === "mockup" \? createFixtureImpl\(FIXTURE_DATA\) : ADAPTER === "catalog" \? createCatalogImpl\(\{ mcp \}\) : createCurrentImpl/);
});
